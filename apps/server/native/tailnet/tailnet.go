// Package main is the Go half of Apollo's desktop tailnet addon: a Tailscale node
// embedded in the server process (tsnet, userspace networking: no system Tailscale, no
// VPN interface), and the listener that publishes Apollo on it.
//
// It is built with -buildmode=c-archive and linked into a Node-API addon (napi/addon.c).
// Every call goes through ApolloTailnetCall(method, argsJSON), which returns a malloc'd
// JSON string the caller releases with ApolloTailnetFree. Errors come back as
// {"error": "..."}.
//
// The listener admits only the owner's own devices: before the TLS handshake it asks
// the node who is connecting, and drops anything not signed in as the same Tailscale
// user as this node, tagged, or shared in from another tailnet. Admitted connections are
// relayed to Apollo's localhost port; the relay's local port maps back to the device
// (method "peer"), so the HTTP layer can bind sessions to it.
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
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
)

func main() {}

// handshakeTimeout drops connections that do not finish TLS in time.
const handshakeTimeout = 10 * time.Second

// certTimeout bounds getting the node's HTTPS certificate from Let's Encrypt (through
// Tailscale), which takes about half a minute the first time.
const certTimeout = 3 * time.Minute

// connLogMax caps connections.log; past it the file starts over.
const connLogMax = 256 << 10

type peer struct {
	NodeID    string `json:"nodeId"`
	UserID    string `json:"userId"`
	LoginName string `json:"loginName"`
	NodeName  string `json:"nodeName"`
	OS        string `json:"os"`
}

type status struct {
	// NoState (not started), NeedsLogin, NeedsMachineAuth, Starting, Running, Stopped.
	State     string  `json:"state"`
	AuthURL   *string `json:"authUrl"`
	NodeID    *string `json:"nodeId"`
	UserID    *string `json:"userId"`
	LoginName *string `json:"loginName"`
	DNSName   *string `json:"dnsName"`
	// Listening is true once Apollo is published on the tailnet.
	Listening bool    `json:"listening"`
	Error     *string `json:"error"`
}

type startArgs struct {
	Dir          string `json:"dir"`
	Hostname     string `json:"hostname"`
	Port         int    `json:"port"`
	UpstreamPort int    `json:"upstreamPort"`
}

var (
	mu       sync.Mutex
	srv      *tsnet.Server
	cfg      startArgs
	pub      *publisher
	lastErr  string
	lastKick time.Time

	peersMu sync.Mutex
	// Relay connections to Apollo, by their local port: who is on the other end.
	peers = map[int]peer{}
)

// ---- C entry points ---------------------------------------------------------

//export ApolloTailnetFree
func ApolloTailnetFree(p *C.char) { C.free(unsafe.Pointer(p)) }

//export ApolloTailnetCall
func ApolloTailnetCall(cMethod, cArgs *C.char) *C.char {
	method, args := C.GoString(cMethod), []byte(C.GoString(cArgs))
	switch method {
	case "start":
		var a startArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return result(nil, err)
		}
		return result(start(a))
	case "status":
		mu.Lock()
		defer mu.Unlock()
		return result(statusLocked(context.Background(), true))
	case "stop":
		mu.Lock()
		defer mu.Unlock()
		stopLocked()
		return result(struct{}{}, nil)
	case "logout":
		return result(struct{}{}, logout())
	case "savedHostname":
		var a struct {
			Dir string `json:"dir"`
		}
		if err := json.Unmarshal(args, &a); err != nil {
			return result(nil, err)
		}
		name, err := savedHostname(a.Dir)
		return result(map[string]*string{"hostname": nonEmpty(name)}, err)
	case "peer":
		var a struct {
			Port int `json:"port"`
		}
		if err := json.Unmarshal(args, &a); err != nil {
			return result(nil, err)
		}
		peersMu.Lock()
		p, ok := peers[a.Port]
		peersMu.Unlock()
		if !ok {
			return result(nil, nil)
		}
		return result(p, nil)
	}
	return result(nil, fmt.Errorf("unknown method %q", method))
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

// ---- node lifecycle ---------------------------------------------------------

func start(a startArgs) (*status, error) {
	if a.Dir == "" || a.Port <= 0 || a.UpstreamPort <= 0 {
		return nil, errors.New("dir, port and upstreamPort are required")
	}
	mu.Lock()
	defer mu.Unlock()
	if srv != nil && cfg != a {
		stopLocked()
	}
	if srv == nil {
		if err := os.MkdirAll(a.Dir, 0o700); err != nil {
			return nil, err
		}
		s := &tsnet.Server{Dir: a.Dir, Hostname: a.Hostname, Logf: logger.Discard, UserLogf: logger.Discard}
		// Start does not wait for login: with no auth key the node goes to NeedsLogin and
		// asks control for an interactive login URL.
		if err := s.Start(); err != nil {
			s.Close()
			return nil, fmt.Errorf("could not start the Tailscale node: %w", err)
		}
		srv, cfg, lastErr = s, a, ""
		lastKick = time.Now()
		pub = newPublisher(s, a)
		go pub.run()
	}
	// Give control a moment to answer with a login URL or a running session.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		st, err := statusLocked(ctx, false)
		if err != nil {
			return nil, err
		}
		settled := (st.State == "Running" && st.Listening) || (st.State == "NeedsLogin" && st.AuthURL != nil) ||
			st.State == "NeedsMachineAuth" || st.Error != nil
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
			return nil, errors.New("the Tailscale node stopped while starting")
		}
	}
}

func stopLocked() {
	if pub != nil {
		pub.close()
		pub = nil
	}
	if srv != nil {
		srv.Close()
		srv = nil
	}
	cfg = startArgs{}
}

// savedHostname is the machine name a node in dir last announced (the Hostname of its
// current profile's prefs), or "" when dir holds no signed-in node. It only reads the
// state file: nothing is created, and no key material leaves this function.
func savedHostname(dir string) (string, error) {
	if dir == "" {
		return "", errors.New("dir is required")
	}
	bs, err := os.ReadFile(filepath.Join(dir, "tailscaled.state"))
	if errors.Is(err, os.ErrNotExist) || (err == nil && len(bs) == 0) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var state map[ipn.StateKey][]byte // tsnet's FileStore format: values are base64 in JSON.
	if err := json.Unmarshal(bs, &state); err != nil {
		return "", fmt.Errorf("reading node state: %w", err)
	}
	// Where the node's prefs are: the profile tailscaled starts with (on Windows, the
	// server-mode one), or the single pre-profiles key of old state files.
	var prefsKey ipn.StateKey
	for _, k := range []ipn.StateKey{ipn.CurrentProfileStateKey, ipn.ServerModeStartKey} {
		if v := state[k]; len(v) > 0 {
			prefsKey = ipn.StateKey(v)
			break
		}
	}
	if prefsKey == "" {
		prefsKey = ipn.LegacyGlobalDaemonStateKey
	}
	raw := state[prefsKey]
	if len(raw) == 0 {
		return "", nil
	}
	var prefs struct{ Hostname string }
	if err := json.Unmarshal(raw, &prefs); err != nil {
		return "", fmt.Errorf("reading node prefs: %w", err)
	}
	return prefs.Hostname, nil
}

// logout signs the node out of the tailnet and forgets its state.
func logout() error {
	mu.Lock()
	defer mu.Unlock()
	dir := cfg.Dir
	if srv != nil {
		if lc, err := srv.LocalClient(); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			_ = lc.Logout(ctx) // Best effort: the state is deleted below either way.
			cancel()
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
	// A login URL can expire, leaving NeedsLogin without one: ask for a new one (every 10s at most).
	if kick && st.BackendState == "NeedsLogin" && st.AuthURL == "" && time.Since(lastKick) > 10*time.Second {
		lastKick = time.Now()
		_ = lc.StartLoginInteractive(sctx)
	}
	out := toStatus(st)
	if pub != nil {
		out.Listening = pub.listening()
		if e := pub.err(); e != "" {
			out.Error = &e
		}
	}
	if out.Error == nil && lastErr != "" {
		out.Error = &lastErr
	}
	return out, nil
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

// ---- the listener -------------------------------------------------------------

type publisher struct {
	srv  *tsnet.Server
	args startArgs

	mu     sync.Mutex
	ln     net.Listener
	conns  map[net.Conn]struct{}
	done   bool
	failed string
	quit   chan struct{}
}

func newPublisher(s *tsnet.Server, a startArgs) *publisher {
	return &publisher{srv: s, args: a, conns: map[net.Conn]struct{}{}, quit: make(chan struct{})}
}

func (p *publisher) listening() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.ln != nil
}

func (p *publisher) err() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.failed
}

func (p *publisher) setErr(e string) {
	p.mu.Lock()
	p.failed = e
	p.mu.Unlock()
}

// logf records a connection event in <state dir>/connections.log (the node's own logs are
// discarded), so a refused or failed device can be explained afterwards.
func (p *publisher) logf(format string, args ...any) {
	path := p.args.Dir + "/connections.log"
	if info, err := os.Stat(path); err == nil && info.Size() > connLogMax {
		os.Remove(path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, args...))
}

// run waits for the node to be signed in, gets its HTTPS certificate, then listens until
// closed. Apollo's address only shows (Listening) once the certificate is in hand: the
// first certificate takes about half a minute, longer than a device waits for TLS.
func (p *publisher) run() {
	lc, err := p.srv.LocalClient()
	if err != nil {
		p.setErr(err.Error())
		return
	}
	for {
		select {
		case <-p.quit:
			return
		case <-time.After(500 * time.Millisecond):
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		st, err := lc.StatusWithoutPeers(ctx)
		cancel()
		if err != nil || st.BackendState != "Running" || st.Self == nil {
			continue
		}
		domain := strings.TrimSuffix(st.Self.DNSName, ".")
		if domain == "" {
			continue
		}
		cctx, ccancel := context.WithTimeout(context.Background(), certTimeout)
		_, _, err = lc.CertPair(cctx, domain)
		ccancel()
		if err != nil {
			p.setErr("could not get the tailnet HTTPS certificate (is HTTPS enabled for your tailnet?): " + err.Error())
			p.logf("certificate for %s failed: %v", domain, err)
			select {
			case <-p.quit:
				return
			case <-time.After(30 * time.Second):
			}
			continue
		}
		p.logf("certificate for %s ready", domain)
		ln, err := p.srv.Listen("tcp", ":"+strconv.Itoa(p.args.Port))
		if err != nil {
			p.setErr("could not listen on the tailnet: " + err.Error())
			return
		}
		p.mu.Lock()
		if p.done {
			p.mu.Unlock()
			ln.Close()
			return
		}
		p.ln, p.failed = ln, ""
		p.mu.Unlock()
		p.logf("listening on %s:%d", domain, p.args.Port)
		owner := st.Self.UserID
		cert := &tls.Config{GetCertificate: lc.GetCertificate, MinVersion: tls.VersionTLS12}
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go p.handle(c, int64(owner), cert)
		}
	}
}

func (p *publisher) close() {
	p.mu.Lock()
	if p.done {
		p.mu.Unlock()
		return
	}
	p.done = true
	close(p.quit)
	ln, conns := p.ln, p.conns
	p.ln, p.conns = nil, map[net.Conn]struct{}{}
	p.mu.Unlock()
	if ln != nil {
		ln.Close()
	}
	for c := range conns {
		c.Close()
	}
}

func (p *publisher) track(c net.Conn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.done {
		c.Close()
		return false
	}
	p.conns[c] = struct{}{}
	return true
}

func (p *publisher) untrack(c net.Conn) {
	p.mu.Lock()
	delete(p.conns, c)
	p.mu.Unlock()
	c.Close()
}

// admit returns the device behind a connection if it is one of the owner's own.
func (p *publisher) admit(ctx context.Context, remote string, owner int64) (*peer, error) {
	lc, err := p.srv.LocalClient()
	if err != nil {
		return nil, err
	}
	who, err := lc.WhoIs(ctx, remote)
	if err != nil {
		return nil, err
	}
	return admitWho(who, owner)
}

// admitWho admits a device only if it is the owner's own: signed in as `owner`,
// carrying no tags (tagged nodes act for no user) and not shared in from another tailnet.
func admitWho(who *apitype.WhoIsResponse, owner int64) (*peer, error) {
	if who == nil || who.Node == nil || who.UserProfile == nil {
		return nil, errors.New("unknown device")
	}
	n := who.Node
	switch {
	case len(n.Tags) > 0:
		return nil, errors.New("a tagged node")
	case n.Sharer != 0:
		return nil, errors.New("shared in from another tailnet")
	case int64(n.User) != owner || int64(who.UserProfile.ID) != owner:
		return nil, errors.New("signed in as someone else")
	}
	hostOS := ""
	if n.Hostinfo.Valid() {
		hostOS = n.Hostinfo.OS()
	}
	return &peer{
		NodeID:    string(n.StableID),
		UserID:    strconv.FormatInt(int64(who.UserProfile.ID), 10),
		LoginName: who.UserProfile.LoginName,
		NodeName:  strings.TrimSuffix(n.Name, "."),
		OS:        hostOS,
	}, nil
}

func (p *publisher) handle(raw net.Conn, owner int64, cert *tls.Config) {
	if !p.track(raw) {
		return
	}
	defer p.untrack(raw)
	ctx, cancel := context.WithTimeout(context.Background(), handshakeTimeout)
	defer cancel()
	who, err := p.admit(ctx, raw.RemoteAddr().String(), owner)
	if err != nil {
		p.logf("refused %s: %v", raw.RemoteAddr(), err)
		return
	}
	secure := tls.Server(raw, cert)
	if err := secure.HandshakeContext(ctx); err != nil {
		p.logf("%s (%s): TLS failed: %v", who.NodeName, raw.RemoteAddr(), err)
		return
	}
	upstream, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p.args.UpstreamPort)), 5*time.Second)
	if err != nil {
		p.logf("%s: could not reach Apollo on port %d: %v", who.NodeName, p.args.UpstreamPort, err)
		return
	}
	p.logf("%s (%s): connected", who.NodeName, raw.RemoteAddr())
	if !p.track(upstream) {
		return
	}
	defer p.untrack(upstream)
	port := upstream.LocalAddr().(*net.TCPAddr).Port
	// Registered before any byte reaches Apollo, so the request always finds its device.
	peersMu.Lock()
	peers[port] = *who
	peersMu.Unlock()
	defer func() {
		peersMu.Lock()
		delete(peers, port)
		peersMu.Unlock()
	}()
	done := make(chan struct{}, 2)
	go func() { io.Copy(upstream, secure); closeWrite(upstream); done <- struct{}{} }()
	go func() { io.Copy(secure, upstream); secure.CloseWrite(); done <- struct{}{} }()
	<-done
	<-done
}

func closeWrite(c net.Conn) {
	if w, ok := c.(interface{ CloseWrite() error }); ok {
		w.CloseWrite()
	}
}
