package main

import (
	"errors"
	"testing"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
)

const owner = 1012587865151273

func whois(mut func(*tailcfg.Node), user tailcfg.UserID) *apitype.WhoIsResponse {
	n := &tailcfg.Node{
		StableID: "nPhone1CNTRL",
		Name:     "apollo-iphone.tail1234.ts.net.",
		User:     user,
		Hostinfo: (&tailcfg.Hostinfo{OS: "iOS"}).View(),
	}
	if mut != nil {
		mut(n)
	}
	return &apitype.WhoIsResponse{Node: n, UserProfile: &tailcfg.UserProfile{ID: user, LoginName: "owner@example.com"}}
}

func TestAdmitsTheOwnersOwnDevices(t *testing.T) {
	p, err := admitWho(whois(nil, owner), owner)
	if err != nil {
		t.Fatal(err)
	}
	want := peer{NodeID: "nPhone1CNTRL", UserID: "1012587865151273", LoginName: "owner@example.com", NodeName: "apollo-iphone.tail1234.ts.net", OS: "iOS"}
	if *p != want {
		t.Fatalf("got %+v, want %+v", *p, want)
	}
}

func TestRefusesOtherUsersTaggedAndSharedNodes(t *testing.T) {
	cases := map[string]*apitype.WhoIsResponse{
		"another user": whois(nil, 200995627934474),
		"tagged":       whois(func(n *tailcfg.Node) { n.Tags = []string{"tag:server"} }, owner),
		"shared in":    whois(func(n *tailcfg.Node) { n.Sharer = 42 }, owner),
		"unknown":      {},
	}
	for name, who := range cases {
		if p, err := admitWho(who, owner); err == nil {
			t.Errorf("%s: admitted %+v", name, p)
		}
	}
}

func TestCertDomainListed(t *testing.T) {
	if !certDomainListed("apollo-mac.tail0393de.ts.net", []string{"Apollo-Mac.tail0393de.ts.net."}) {
		t.Error("listed domain not found")
	}
	if certDomainListed("apollo-mac.tail0393de.ts.net", nil) {
		t.Error("no cert domains: HTTPS is off")
	}
}

func TestRecognisesTailnetsWithHTTPSOff(t *testing.T) {
	off := errors.New("500 Internal Server Error: your Tailscale account does not support getting TLS certs")
	if !isHTTPSOff(off) {
		t.Error("not recognised")
	}
	if isHTTPSOff(errors.New("context deadline exceeded")) || isHTTPSOff(nil) {
		t.Error("other errors are not HTTPS being off")
	}
}

func TestCertRetriesBackOff(t *testing.T) {
	d := time.Duration(0)
	for _, want := range []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 10 * time.Minute, 10 * time.Minute} {
		d = nextCertRetry(d)
		if d != want {
			t.Fatalf("got %v, want %v", d, want)
		}
	}
	if certAttemptDue(false, 29*time.Minute, 0) {
		t.Error("asked Tailscale for a certificate while HTTPS is off")
	}
	if !certAttemptDue(false, httpsOffRetry, 0) {
		t.Error("never checks again while HTTPS is off")
	}
	if !certAttemptDue(true, 0, 0) {
		t.Error("did not ask right away once HTTPS is on")
	}
	if certAttemptDue(true, time.Minute, 2*time.Minute) {
		t.Error("did not wait out the backoff")
	}
}
