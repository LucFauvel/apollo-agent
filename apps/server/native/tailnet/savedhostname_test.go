package main

import (
	"os"
	"path/filepath"
	"testing"

	"tailscale.com/ipn"
	"tailscale.com/ipn/store"
	"tailscale.com/types/logger"
)

// writeState writes dir/tailscaled.state the way tsnet does, through Tailscale's FileStore.
func writeState(t *testing.T, dir string, entries map[ipn.StateKey][]byte) {
	t.Helper()
	st, err := store.NewFileStore(logger.Discard, filepath.Join(dir, "tailscaled.state"))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range entries {
		if err := st.WriteState(k, v); err != nil {
			t.Fatal(err)
		}
	}
}

func prefsWithHostname(name string) []byte {
	p := ipn.NewPrefs()
	p.Hostname = name
	return p.ToBytes()
}

func TestSavedHostnameReadsTheCurrentProfile(t *testing.T) {
	dir := t.TempDir()
	writeState(t, dir, map[ipn.StateKey][]byte{
		ipn.CurrentProfileStateKey: []byte("profile-cafe"),
		"profile-cafe":             prefsWithHostname("apollo-mac-lan"),
		"profile-beef":             prefsWithHostname("apollo-other"),
	})
	got, err := savedHostname(dir)
	if err != nil || got != "apollo-mac-lan" {
		t.Fatalf("savedHostname = %q, %v; want apollo-mac-lan", got, err)
	}
}

func TestSavedHostnameReadsLegacyState(t *testing.T) {
	dir := t.TempDir()
	writeState(t, dir, map[ipn.StateKey][]byte{ipn.LegacyGlobalDaemonStateKey: prefsWithHostname("apollo-old")})
	if got, err := savedHostname(dir); err != nil || got != "apollo-old" {
		t.Fatalf("savedHostname = %q, %v; want apollo-old", got, err)
	}
}

func TestSavedHostnameWithoutANodeIsEmptyAndWritesNothing(t *testing.T) {
	dir := t.TempDir()
	if got, err := savedHostname(dir); err != nil || got != "" {
		t.Fatalf("savedHostname = %q, %v; want empty", got, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "tailscaled.state")); !os.IsNotExist(err) {
		t.Fatalf("savedHostname created a state file (%v)", err)
	}
	// A store created but never signed in (no profile yet).
	writeState(t, dir, map[ipn.StateKey][]byte{"_machinekey": []byte("x")})
	if got, err := savedHostname(dir); err != nil || got != "" {
		t.Fatalf("savedHostname = %q, %v; want empty", got, err)
	}
}

func TestSavedHostnameRejectsACorruptStateFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tailscaled.state"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := savedHostname(dir); err == nil {
		t.Fatal("want an error for a corrupt state file")
	}
}
