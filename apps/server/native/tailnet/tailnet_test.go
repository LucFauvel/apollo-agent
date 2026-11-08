package main

import (
	"testing"

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
