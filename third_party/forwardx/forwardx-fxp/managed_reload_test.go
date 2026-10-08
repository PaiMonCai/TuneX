package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
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

func TestManagedPrivateSnapshotRetriesAtomicReplacement(t *testing.T) {
	path := managedFile(t, managedFixture())
	before, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	// The reader's Lstat observed the old inode, but Open will see the new one.
	if err := os.Rename(path, path+".old"); err != nil {
		t.Fatal(err)
	}
	want := []byte(`{"managedReload":true,"candidate":"replacement"}`)
	if err := os.WriteFile(path, want, 0600); err != nil {
		t.Fatal(err)
	}
	got, err := readManagedPrivateSnapshot(path, before)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("complete atomic replacement rejected: %v", err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0644); err != nil {
			t.Fatal(err)
		}
		if _, err := readManagedPrivateSnapshot(path, before); err == nil {
			t.Fatal("replacement bypassed private permissions")
		}
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(path+".old", path); err == nil {
		if _, err := readManagedPrivateSnapshot(path, before); err == nil {
			t.Fatal("replacement bypassed no-follow check")
		}
	}
}

func TestManagedPrivateSnapshotReplacementAfterOpenIsBounded(t *testing.T) {
	for _, replaceEveryTime := range []bool{false, true} {
		t.Run(fmt.Sprintf("continuous=%v", replaceEveryTime), func(t *testing.T) {
			path := managedFile(t, managedFixture())
			before, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			var opened []*os.File
			want := []byte(`{"managedReload":true,"candidate":"after-open"}`)
			candidates := []string{path}
			for i := 1; i <= 3; i++ {
				candidate := fmt.Sprintf("%s.candidate-%d", path, i)
				if err := os.WriteFile(candidate, want, 0600); err != nil {
					t.Fatal(err)
				}
				candidates = append(candidates, candidate)
			}
			lstat := func(name string) (os.FileInfo, error) {
				if name == path {
					// Model the path already pointing at a replacement after
					// Open obtained its prior inode. Windows cannot rename an
					// open FD without share-delete, so inject exact observations.
					index := 1
					if replaceEveryTime {
						index = len(opened)
					}
					return os.Lstat(candidates[index])
				}
				return os.Lstat(name)
			}
			open := func(name string) (*os.File, error) {
				f, err := os.Open(candidates[len(opened)])
				if err == nil {
					opened = append(opened, f)
				}
				return f, err
			}
			got, err := readManagedPrivateSnapshotWith(path, before, lstat, open)
			if replaceEveryTime {
				if err != managedSnapshotError("identity") || len(opened) != 3 {
					t.Fatalf("retry unbounded or replacement accepted: attempts=%d err=%v", len(opened), err)
				}
			} else if err != nil || !bytes.Equal(got, want) || len(opened) != 2 {
				t.Fatalf("post-open replacement rejected: attempts=%d err=%v", len(opened), err)
			}
			for _, f := range opened {
				if _, err := f.Read(make([]byte, 1)); !errors.Is(err, os.ErrClosed) {
					t.Fatal("snapshot file descriptor leaked", err)
				}
			}
		})
	}
}

func TestManagedPrivateSnapshotOpenErrorRetriesAreNarrow(t *testing.T) {
	for _, failure := range []error{syscall.Errno(32), syscall.Errno(33), os.ErrPermission, os.ErrNotExist, io.ErrUnexpectedEOF} {
		for _, persistent := range []bool{false, true} {
			path := managedFile(t, managedFixture())
			info, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			open := func(name string) (*os.File, error) {
				calls++
				if persistent || calls == 1 {
					return nil, failure
				}
				return os.Open(name)
			}
			_, err = readManagedPrivateSnapshotWith(path, info, os.Lstat, open)
			if transientManagedSnapshotOpen(failure) {
				if persistent && (err != managedSnapshotError("open_sharing") || calls != 3) {
					t.Fatal("persistent sharing failure escaped bounded rejection", calls, err)
				}
				if !persistent && (err != nil || calls != 2) {
					t.Fatal("atomic-replacement sharing failure not recovered", calls, err)
				}
			} else if err == nil || calls != 1 {
				t.Fatal("non-transient failure was retried or accepted", calls, err)
			}
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
