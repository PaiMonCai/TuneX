package main

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func managedFixture() config {
	return normalizeConfig(config{Role: "exit", TunnelID: 71, ListenHost: "127.0.0.1", ListenPort: 30300, Protocol: "both", Key: "managed-private-fixture", RequireBindingAuth: true, AllowedBindings: []authorizedBinding{{RuleID: 101, Protocol: "tcp", TargetIP: "127.0.0.1", TargetPort: 443}, {RuleID: 102, Protocol: "udp", TargetIP: "127.0.0.1", TargetPort: 444}}, UDPTargets: []udpTarget{{RuleID: 102, TargetIP: "127.0.0.1", TargetPort: 444}}})
}

func managedFile(t *testing.T, cfg config) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(cfg)
	var shape map[string]any
	_ = json.Unmarshal(raw, &shape)
	shape["managedReload"] = true
	raw, _ = json.Marshal(shape)
	path := filepath.Join(dir, "private.json")
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestManagedRejectsInvalidWholeCandidateBeforeNormalization(t *testing.T) {
	for _, mutate := range []func(*config){
		func(c *config) {
			c.UDPTargets = append(c.UDPTargets, udpTarget{RuleID: 103, TargetIP: "127.0.0.1", TargetPort: 0})
		},
		func(c *config) { c.UDPTargets = append(c.UDPTargets, c.UDPTargets[0]) },
		func(c *config) { c.MaxConnections = -1 },
		func(c *config) { c.Protocol = "unknown" },
	} {
		cfg := managedFixture()
		mutate(&cfg)
		if _, digest, err := readManagedConfig(managedFile(t, cfg)); err == nil || digest == "" {
			t.Fatal("invalid candidate silently normalized/applied")
		}
	}
}

func TestManagedPrivateSourceBoundary(t *testing.T) {
	path := managedFile(t, managedFixture())
	if _, digest, err := readManagedConfig(path); err != nil || len(digest) != 64 {
		t.Fatal("valid private source rejected", err)
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(path, 0644)
		if _, _, err := readManagedConfig(path); err == nil {
			t.Fatal("public secret file accepted")
		}
		_ = os.Chmod(path, 0600)
	}
	link := filepath.Join(filepath.Dir(path), "link.json")
	if err := os.Symlink(path, link); err == nil {
		if _, _, err := readManagedConfig(link); err == nil {
			t.Fatal("symlink source accepted")
		}
	}
}

func TestManagedImmutableCarrierAndAtomicAuthorization(t *testing.T) {
	cfg := managedFixture()
	state := &managedExitState{}
	state.policy.Store(policyFor(cfg))
	managedExits.Store(exitIdentity(cfg), state)
	defer managedExits.Delete(exitIdentity(cfg))
	m := &managedRuntime{cfg: cfg, exit: state}
	for _, mutate := range []func(*config){func(c *config) { c.Key = "changed" }, func(c *config) { c.ListenPort++ }, func(c *config) { c.TunnelID++ }} {
		candidate := cfg
		mutate(&candidate)
		code, err := m.apply(candidate)
		if code != "immutable" || err != nil || state.policy.Load().cfg.Key != cfg.Key {
			t.Fatal("immutable carrier mutated", code, err)
		}
	}
	a, aPeer := net.Pipe()
	b, bPeer := net.Pipe()
	defer a.Close()
	defer aPeer.Close()
	defer b.Close()
	defer bPeer.Close()
	state.clients.Store(a, 101)
	state.clients.Store(b, 102)
	next := cfg
	next.AllowedBindings = append([]authorizedBinding(nil), cfg.AllowedBindings[1:]...)
	code, err := m.apply(next)
	if code != "" || err != nil {
		t.Fatal(code, err)
	}
	_ = aPeer.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := aPeer.Read(make([]byte, 1)); err == nil {
		t.Fatal("removed binding TCP survived")
	}
	if _, ok := state.clients.Load(b); !ok {
		t.Fatal("unchanged binding TCP removed")
	}
	if got := state.policy.Load().targets[102]; got.TargetPort != 444 {
		t.Fatal("unchanged UDP target lost")
	}
	hello := helloFrame{TunnelID: 71, RuleID: 101, Network: "tcp"}
	if authorizeHello(cfg, &hello) == nil {
		t.Fatal("removed rule authorized by stale config copy")
	}
}

func TestManagedChangedChildBindFailureCompensatesOldEntry(t *testing.T) {
	port := func() int {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		p := ln.Addr().(*net.TCPAddr).Port
		ln.Close()
		return p
	}
	a := normalizeConfig(config{Role: "entry", TunnelID: 71, RuleID: 101, ListenHost: "127.0.0.1", ListenPort: port(), Protocol: "tcp", Key: "private", ExitHost: "127.0.0.1", ExitPort: 30300, TargetIP: "127.0.0.1", TargetPort: 443})
	b := a
	b.RuleID = 102
	b.ListenPort = port()
	for b.ListenPort == a.ListenPort {
		b.ListenPort = port()
	}
	m := &managedRuntime{cfg: normalizeConfig(config{Role: "entry-group", TunnelID: 71, Entries: []config{a, b}}), entries: map[int]*managedEntry{}, failed: make(chan error, 4)}
	for _, cfg := range []config{a, b} {
		entry, err := prepareManagedEntry(cfg)
		if err != nil {
			t.Fatal(err)
		}
		m.entries[cfg.RuleID] = entry
		entry.start(m.failed)
	}
	defer func() {
		for _, entry := range m.entries {
			_ = entry.close()
		}
	}()
	oldB := m.entries[102]
	client, peer := net.Pipe()
	defer peer.Close()
	defer client.Close()
	oldB.clients.add(client)
	next := m.cfg
	next.Entries = append([]config(nil), m.cfg.Entries...)
	next.Entries[0].TargetPort = 444
	next.Entries[0].MaxConnections = 3
	failed := false
	m.prepare = func(cfg config) (*managedEntry, error) {
		if cfg.RuleID == 101 && cfg.TargetPort == 444 {
			failed = true
			return nil, errors.New("injected child bind failure")
		}
		return prepareManagedEntry(cfg)
	}
	code, err := m.apply(next)
	if !failed || code != "bind" || err != nil {
		t.Fatal("changed child failure not compensated", code, err)
	}
	if m.entries[102] != oldB || oldB.clients.closed {
		t.Fatal("compensation touched unchanged B runtime/clients")
	}
	if restored := m.entries[101]; restored == nil || restored.cfg.TargetPort != 443 {
		t.Fatal("old A configuration not restored")
	}
	if got := m.cfg.Entries[0].TargetPort; got != 443 {
		t.Fatal("failed candidate committed")
	}
}
