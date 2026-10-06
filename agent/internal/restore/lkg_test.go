package restore

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/tunex/agent/internal/forwarder"
)

func snap(t *testing.T, version string, ids ...string) *Snapshot {
	t.Helper()
	out := &Snapshot{Version: version}
	for _, id := range ids {
		out.Tunnels = append(out.Tunnels, forwarder.TunnelConfig{
			ID: id, Mode: forwarder.ModeDirect, IngressPort: 20000, RemoteHost: "10.0.0.1",
			RemotePort: 80, Protocol: "tcp", Revision: 3,
		})
	}
	if out.Version == "" {
		out.Version = "v1"
	}
	return out
}

func TestLKGRoundTripAndPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "desired-lkg.json")
	cache := LKG{Path: path}
	if err := cache.Save("agent-1", snap(t, "v1", "tunex-1-direct")); err != nil {
		t.Fatalf("save: %v", err)
	}
	loaded, err := cache.Load("agent-1")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded.Tunnels) != 1 || loaded.Tunnels[0].ID != "tunex-1-direct" {
		t.Fatalf("round trip lost data: %+v", loaded)
	}
	if loaded.Version != "v1" {
		t.Fatalf("version must survive the round trip, got %q", loaded.Version)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("cache file must be owner-only, got %v", info.Mode().Perm())
	}
	dirInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("stat dir: %v", err)
	}
	if runtime.GOOS != "windows" && dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("cache dir must be owner-only, got %v", dirInfo.Mode().Perm())
	}
	// No credential-bearing field may appear in the file: the cache is desired
	// state, never identity material.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	for _, forbidden := range []string{"credential", "token", "Authorization"} {
		if strings.Contains(strings.ToLower(string(raw)), strings.ToLower(forbidden)) {
			t.Fatalf("cache must not contain %q: %s", forbidden, raw)
		}
	}
}

// A cache written by another agent must never be adopted: agent identity is
// immutable, and adopting another node's tunnels would create a second owner for
// the same ports.
func TestLKGRejectsAnotherAgentIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "desired-lkg.json")
	cache := LKG{Path: path}
	if err := cache.Save("agent-1", snap(t, "v1", "tunex-1-direct")); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := cache.Load("agent-2"); !errors.Is(err, ErrLKGIdentityMismatch) {
		t.Fatalf("expected identity mismatch, got %v", err)
	}
	if _, err := cache.Load(""); !errors.Is(err, ErrLKGIdentityMismatch) {
		t.Fatalf("an empty agent id must not match a stored cache, got %v", err)
	}
}

func TestLKGRejectsCorruptAndUnknownSchema(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "desired-lkg.json")
	cache := LKG{Path: path}

	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := cache.Load("agent-1"); !errors.Is(err, ErrLKGCorrupt) {
		t.Fatalf("bad JSON must be corrupt, got %v", err)
	}

	body, _ := json.Marshal(map[string]any{"schema_version": 99, "agent_id": "agent-1"})
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := cache.Load("agent-1"); !errors.Is(err, ErrLKGCorrupt) {
		t.Fatalf("unknown schema must be corrupt, got %v", err)
	}

	// A snapshot that does not satisfy the contract (unknown mode) is corrupt,
	// not a partial success.
	body, _ = json.Marshal(map[string]any{
		"schema_version": 1, "agent_id": "agent-1",
		"snapshot": map[string]any{"version": "v1", "tunnels": []map[string]any{{"id": "x", "mode": "UDP"}}},
	})
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := cache.Load("agent-1"); !errors.Is(err, ErrLKGCorrupt) {
		t.Fatalf("a non-TCP mode must be corrupt, got %v", err)
	}

	if _, err := cache.Load("agent-1"); errors.Is(err, ErrLKGEmpty) {
		t.Fatal("an existing but broken file is not 'empty'")
	}
}

// A symlinked cache path must not become an arbitrary read/write primitive.
func TestLKGRefusesSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	dir := t.TempDir()
	real := filepath.Join(dir, "elsewhere.json")
	if err := os.WriteFile(real, []byte("{}"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	link := filepath.Join(dir, "desired-lkg.json")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	cache := LKG{Path: link}
	if _, err := cache.Load("agent-1"); !errors.Is(err, ErrLKGCorrupt) {
		t.Fatalf("loading through a symlink must be refused, got %v", err)
	}
	if err := cache.Save("agent-1", snap(t, "v1", "a")); !errors.Is(err, ErrLKGCorrupt) {
		t.Fatalf("saving through a symlink must be refused, got %v", err)
	}
}

// An empty runtime must never overwrite an existing cache: an empty node is
// usually a transient, and the cache is the only copy of the truth left.
// Empty and nil are different answers, and the difference is the fix for the
// resurrection regression:
//
//	· an EMPTY snapshot means "this node runs nothing" and MUST be written, or the
//	  cache keeps advertising the forward the user just removed;
//	· nil means "we do not know" (a failed fetch) and must never overwrite the last
//	  state that actually worked.
func TestLKGEmptySnapshotIsATombstoneButNilIsNot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "desired-lkg.json")
	cache := LKG{Path: path}
	if err := cache.Save("agent-1", snap(t, "v1", "keep-me")); err != nil {
		t.Fatalf("save: %v", err)
	}

	// nil: refuse to write, keep what worked.
	if err := cache.Save("agent-1", nil); !errors.Is(err, ErrLKGEmpty) {
		t.Fatalf("a nil snapshot must not be written, got %v", err)
	}
	loaded, err := cache.Load("agent-1")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded.Tunnels) != 1 || loaded.Tunnels[0].ID != "keep-me" {
		t.Fatalf("a nil snapshot must leave the previous cache intact: %+v", loaded)
	}

	// empty: written, and it replaces what was there.
	if err := cache.Save("agent-1", &Snapshot{Version: "v1"}); err != nil {
		t.Fatalf("an empty snapshot is an authoritative answer and must be written: %v", err)
	}
	loaded, err = cache.Load("agent-1")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded.Tunnels) != 0 {
		t.Fatalf("the tombstone must replace the previous cache: %+v", loaded.Tunnels)
	}
}

func TestLKGDisabledAndMissing(t *testing.T) {
	disabled := LKG{}
	if _, err := disabled.Load("agent-1"); !errors.Is(err, ErrLKGDisabled) {
		t.Fatalf("no path must be disabled, got %v", err)
	}
	if err := disabled.Save("agent-1", snap(t, "v1", "a")); !errors.Is(err, ErrLKGDisabled) {
		t.Fatalf("no path must be disabled, got %v", err)
	}
	if err := disabled.Clear(); !errors.Is(err, ErrLKGDisabled) {
		t.Fatalf("no path must be disabled, got %v", err)
	}
	missing := LKG{Path: filepath.Join(t.TempDir(), "nope.json")}
	if _, err := missing.Load("agent-1"); !errors.Is(err, ErrLKGEmpty) {
		t.Fatalf("a missing file is empty, got %v", err)
	}
	// Clear on a missing file is a successful no-op.
	if err := missing.Clear(); err != nil {
		t.Fatalf("clear missing: %v", err)
	}
}

func TestLKGOversizedFileRejected(t *testing.T) {
	path := filepath.Join(t.TempDir(), "desired-lkg.json")
	cache := LKG{Path: path, MaxBytes: 32}
	if err := cache.Save("agent-1", snap(t, "v1", "a")); !errors.Is(err, ErrLKGCorrupt) {
		t.Fatalf("oversized payload must be refused, got %v", err)
	}
	if err := os.WriteFile(path, make([]byte, 64), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := cache.Load("agent-1"); !errors.Is(err, ErrLKGCorrupt) {
		t.Fatalf("oversized file must be corrupt, got %v", err)
	}
}
