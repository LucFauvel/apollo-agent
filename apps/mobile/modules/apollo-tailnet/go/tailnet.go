// Package main is the Go half of the apollo-tailnet Expo module: an embedded
// Tailscale node (tsnet) plus a loopback TCP forwarder that only talks to one
// verified peer, over TLS. It is built with -buildmode=c-archive and called
// from Swift through the C functions exported below.
//
// Every exported function takes C strings and returns a malloc'd JSON string
// that the caller must release with ApolloTailnetFree. Errors come back as
// {"error": "..."}.
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
)

func main() {}

type status struct {
	State     string  `json:"state"`
	AuthURL   *string `json:"authUrl"`
	NodeID    *string `json:"nodeId"`
	UserID    *string `json:"userId"`
	LoginName *string `json:"loginName"`
	DNSName   *string `json:"dnsName"`
}

var (
	mu       sync.Mutex
	srv      *tsnet.Server
	srvDir   string
	fwd      *forwarder
	lastKick time.Time // last time we asked control for a fresh login URL
)

// ---- C entry points ---------------------------------------------------------

//export ApolloTailnetFree
func ApolloTailnetFree(p *C.char) { C.free(unsafe.Pointer(p)) }

//export ApolloTailnetStart
func ApolloTailnetStart(cDir, cHost *C.char) *C.char {
	return result(start(C.GoString(cDir), C.GoString(cHost)))
}

//export ApolloTailnetStatus
func ApolloTailnetStatus() *C.char {
	mu.Lock()
	defer mu.Unlock()
	return result(statusLocked(context.Background(), true))
}

//export ApolloTailnetStop
func ApolloTailnetStop() *C.char {
	mu.Lock()
	defer mu.Unlock()
	stopLocked()
	return result(struct{}{}, nil)
}

//export ApolloTailnetLogout
func ApolloTailnetLogout(cDir *C.char) *C.char {
	return result(struct{}{}, logout(C.GoString(cDir)))
}

//export ApolloTailnetForward
func ApolloTailnetForward(cHost *C.char, port C.int, cNode, cUser *C.char) *C.char {
	return result(forward(C.GoString(cHost), int(port), C.GoString(cNode), C.GoString(cUser)))
}

//export ApolloTailnetStopForward
func ApolloTailnetStopForward() *C.char {
	mu.Lock()
	defer mu.Unlock()
	if fwd != nil {
		fwd.close()
		fwd = nil
	}
	return result(struct{}{}, nil)
}

func result(v any, err error) *C.char {
	var b []byte
	if err != nil {
		b, _ = json.Marshal(map[string]string{"error": err.Error()})
	} else {
		b, _ = json.Marshal(v)
	}
	return C.CString(string(b))
}

// ---- server lifecycle -------------------------------------------------------

func start(dir, hostname string) (*status, error) {
	if dir == "" {
		return nil, errors.New("state directory is required")
	}
	mu.Lock()
	defer mu.Unlock()
	if srv != nil && srvDir != dir {
		stopLocked()
	}
	if srv == nil {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
		s := &tsnet.Server{
			Dir:      dir,
			Hostname: hostname,
			Logf:     logger.Discard,
			UserLogf: logger.Discard,
		}
		// Start does not wait for login: with no auth key it puts the backend
		// in NeedsLogin and asks control for an interactive login URL.
		if err := s.Start(); err != nil {
			s.Close()
			return nil, fmt.Errorf("tsnet start: %w", err)
		}
		srv, srvDir = s, dir
		lastKick = time.Now()
	}
	// Give control a moment to hand back either a login URL or a running
	// session, so the first call usually has something to show.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		st, err := statusLocked(ctx, false)
		if err != nil {
			return nil, err
		}
		settled := st.State == "Running" || (st.State == "NeedsLogin" && st.AuthURL != nil) || st.State == "NeedsMachineAuth"
		if settled || ctx.Err() != nil {
			return st, nil
		}
		mu.Unlock()
		select {
		case <-ctx.Done():
		case <-time.After(200 * time.Millisecond):
		}
		mu.Lock()
		if srv == nil {
			return nil, errors.New("tailnet stopped while starting")
		}
	}
}

func stopLocked() {
	if fwd != nil {
		fwd.close()
		fwd = nil
	}
	if srv != nil {
		srv.Close()
		srv, srvDir = nil, ""
	}
}

func logout(dir string) error {
	mu.Lock()
	defer mu.Unlock()
	if srv != nil {
		if lc, err := srv.LocalClient(); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			// Best effort: if control is unreachable the node key is still deleted
			// below, which leaves this phone logged out either way.
			_ = lc.Logout(ctx)
			cancel()
		}
		if dir == "" {
			dir = srvDir
		}
	}
	stopLocked()
	if dir == "" {
		return nil
	}
	return os.RemoveAll(dir)
}

func statusLocked(ctx context.Context, kick bool) (*status, error) {
	if srv == nil {
		return &status{State: "NoState"}, nil
	}
	lc, err := srv.LocalClient()
	if err != nil {
		return nil, err
	}
	sctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	st, err := lc.StatusWithoutPeers(sctx)
	if err != nil {
		return nil, err
	}
	// After a URL expires (or the user cancelled) control may leave us in
	// NeedsLogin with no URL; ask for a new one, at most every 10s.
	if kick && st.BackendState == "NeedsLogin" && st.AuthURL == "" && time.Since(lastKick) > 10*time.Second {
		lastKick = time.Now()
		_ = lc.StartLoginInteractive(sctx)
	}
	return toStatus(st), nil
}

func toStatus(st *ipnstate.Status) *status {
	out := &status{State: st.BackendState, AuthURL: nonEmpty(st.AuthURL)}
	if self := st.Self; self != nil && st.BackendState != "NeedsLogin" {
		out.NodeID = nonEmpty(string(self.ID))
		if self.UserID != 0 {
			out.UserID = nonEmpty(strconv.FormatInt(int64(self.UserID), 10))
			if u, ok := st.User[self.UserID]; ok {
				out.LoginName = nonEmpty(u.LoginName)
			}
		}
		out.DNSName = nonEmpty(strings.TrimSuffix(self.DNSName, "."))
	}
	return out
}

func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ---- verified forwarder -----------------------------------------------------

type forwardKey struct {
	host   string
	port   int
	nodeID string
	userID string
}

type forwarder struct {
	key   forwardKey
	ln    net.Listener
	srv   *tsnet.Server
	mu    sync.Mutex
	conns map[net.Conn]struct{}
	done  bool
}

func forward(host string, port int, nodeID, userID string) (map[string]int, error) {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "" || port <= 0 || port > 65535 || nodeID == "" || userID == "" {
		return nil, errors.New("host, port, expectedNodeId and expectedUserId are required")
	}
	if _, err := strconv.ParseInt(userID, 10, 64); err != nil {
		return nil, errors.New("expectedUserId must be a decimal user ID")
	}
	mu.Lock()
	defer mu.Unlock()
	if srv == nil {
		return nil, errors.New("tailnet is not started")
	}
	key := forwardKey{host, port, nodeID, userID}
	// A listener whose accept loop died (iOS reclaims a suspended app's listening
	// sockets) is replaced rather than handed out again.
	if fwd != nil && fwd.key == key && fwd.srv == srv && !fwd.closed() {
		return map[string]int{"localPort": fwd.ln.Addr().(*net.TCPAddr).Port}, nil
	}
	if fwd != nil {
		fwd.close()
		fwd = nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	f := &forwarder{key: key, ln: ln, srv: srv, conns: map[net.Conn]struct{}{}}
	fwd = f
	go f.serve()
	return map[string]int{"localPort": ln.Addr().(*net.TCPAddr).Port}, nil
}

func (f *forwarder) track(c net.Conn) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.done {
		c.Close()
		return false
	}
	f.conns[c] = struct{}{}
	return true
}

func (f *forwarder) untrack(c net.Conn) {
	f.mu.Lock()
	delete(f.conns, c)
	f.mu.Unlock()
	c.Close()
}

func (f *forwarder) close() {
	f.mu.Lock()
	f.done = true
	conns := f.conns
	f.conns = map[net.Conn]struct{}{}
	f.mu.Unlock()
	f.ln.Close()
	for c := range conns {
		c.Close()
	}
}

func (f *forwarder) closed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.done
}

func (f *forwarder) serve() {
	for {
		c, err := f.ln.Accept()
		if err != nil {
			// Nothing will accept on this port again: let forward() replace it.
			f.mu.Lock()
			f.done = true
			f.mu.Unlock()
			return
		}
		go f.handle(c)
	}
}

func (f *forwarder) handle(local net.Conn) {
	if !f.track(local) {
		return
	}
	defer f.untrack(local)
	remote, err := f.dialVerified()
	if err != nil {
		return
	}
	if !f.track(remote) {
		return
	}
	defer f.untrack(remote)
	done := make(chan struct{}, 2)
	go func() { io.Copy(remote, local); closeWrite(remote); done <- struct{}{} }()
	go func() { io.Copy(local, remote); closeWrite(local); done <- struct{}{} }()
	<-done
	<-done
}

func closeWrite(c net.Conn) {
	switch c := c.(type) {
	case *tls.Conn:
		c.CloseWrite()
	case interface{ CloseWrite() error }:
		c.CloseWrite()
	}
}

// dialVerified dials the server over the tailnet, checks with the local
// tailscaled who is on the other end, and only then starts TLS.
func (f *forwarder) dialVerified() (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	addr := net.JoinHostPort(f.key.host, strconv.Itoa(f.key.port))
	raw, err := f.srv.Dial(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	if err := f.verifyPeer(ctx, raw.RemoteAddr().String()); err != nil {
		raw.Close()
		return nil, err
	}
	tc := tls.Client(raw, &tls.Config{ServerName: f.key.host, MinVersion: tls.VersionTLS12})
	if err := tc.HandshakeContext(ctx); err != nil {
		raw.Close()
		return nil, err
	}
	return tc, nil
}

func (f *forwarder) verifyPeer(ctx context.Context, remote string) error {
	lc, err := f.srv.LocalClient()
	if err != nil {
		return err
	}
	who, err := lc.WhoIs(ctx, remote)
	if err != nil {
		return err
	}
	if who.Node == nil || who.UserProfile == nil {
		return errors.New("peer unknown")
	}
	n := who.Node
	switch {
	case string(n.StableID) != f.key.nodeID:
		return errors.New("peer is not the paired server node")
	case strconv.FormatInt(int64(who.UserProfile.ID), 10) != f.key.userID:
		return errors.New("peer belongs to another user")
	case len(n.Tags) > 0:
		return errors.New("peer is a tagged node")
	case n.Sharer != 0:
		return errors.New("peer is shared in from another tailnet")
	}
	return nil
}
