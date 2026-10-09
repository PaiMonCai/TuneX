package linkrunner

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestEncryptedCacheTombstoneAndMachineKey(t *testing.T) {
	dir := t.TempDir()
	m := newTestManager(t, helperBinary(t), dir)
	cfg := exitConfig(t, "removed", "tcp", freePort(t, "tcp"), 1)
	o, err := m.Apply(cfg)
	requireReady(t, o, err)
	data, err := os.ReadFile(filepath.Join(dir, "state.enc.json"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte(fixtureKey)) || bytes.Contains(data, []byte("runner_config")) {
		t.Fatal("unencrypted config in cache")
	}
	key, err := os.ReadFile(filepath.Join(dir, "machine.key"))
	if err != nil || len(key) != 32 {
		t.Fatalf("key: %d %v", len(key), err)
	}
	if runtime.GOOS != "windows" {
		for path, want := range map[string]os.FileMode{dir: 0o700, filepath.Join(dir, "machine.key"): 0o600, filepath.Join(dir, "state.enc.json"): 0o600, filepath.Join(dir, "runtime"): 0o700} {
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != want {
				t.Fatalf("mode %s: %v %v", path, info, err)
			}
		}
	}
	if _, err := m.Remove(cfg.ID, 4); err != nil {
		t.Fatal(err)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	r := newTestManager(t, helperBinary(t), dir)
	statuses, err := r.Restore()
	if err != nil || len(statuses) != 1 || statuses[0].State != "removed" {
		t.Fatalf("tombstone: %+v %v", statuses, err)
	}
	for _, generation := range []int64{1, 3, 4} {
		cfg.Generation = generation
		if _, err := r.Apply(cfg); !errors.Is(err, ErrStaleGeneration) {
			t.Fatalf("resurrected generation %d: %v", generation, err)
		}
	}
	cfg.Generation = 5
	o, err = r.Apply(cfg)
	requireReady(t, o, err)
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := New(helperBinary(t), dir, "different-agent"); !errors.Is(err, ErrAgentMismatch) {
		t.Fatalf("foreign agent: %v", err)
	}
	data, _ = os.ReadFile(filepath.Join(dir, "state.enc.json"))
	var env cacheEnvelope
	if json.Unmarshal(data, &env) != nil {
		t.Fatal("envelope")
	}
	env.Sealed[0] ^= 1
	data, _ = json.Marshal(env)
	if err := os.WriteFile(filepath.Join(dir, "state.enc.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(helperBinary(t), dir, "agent-one"); !errors.Is(err, ErrCache) {
		t.Fatalf("tampering accepted: %v", err)
	}
}

func TestCacheWriteFailureStopsAndFences(t *testing.T) {
	m := newTestManager(t, helperBinary(t), t.TempDir())
	cfg := exitConfig(t, "failclosed", "tcp", freePort(t, "tcp"), 1)
	o, err := m.Apply(cfg)
	requireReady(t, o, err)
	// A non-regular final target is rejected without replacing it.
	path := filepath.Join(m.cache.dir, "state.enc.json")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Remove(cfg.ID, 2); !errors.Is(err, ErrCache) {
		t.Fatal(err)
	}
	if o := m.Status()[0]; o.Ready || o.Generation != 2 {
		t.Fatalf("uncertain fence left process serving: %+v", o)
	}
	if _, err := m.Apply(cfg); !errors.Is(err, ErrCache) {
		t.Fatalf("unproven durability accepted command: %v", err)
	}
}

func TestMissingKeyDoesNotResetDurableFence(t *testing.T) {
	dir := t.TempDir()
	m := newTestManager(t, helperBinary(t), dir)
	if _, err := m.Remove("unknown", 10); err != nil {
		t.Fatal(err)
	}
	m.Close()
	if err := os.Remove(filepath.Join(dir, "machine.key")); err != nil {
		t.Fatal(err)
	}
	if _, err := New(helperBinary(t), dir, "agent-one"); !errors.Is(err, ErrCache) {
		t.Fatalf("lost key reset fence: %v", err)
	}
}

func TestCanonicalDigestMatchesCompilerFixture(t *testing.T) {
	raw := json.RawMessage(`{"z":"<&>\u2028","a":{"b":2,"a":1},"array":[null,true,"值"]}`)
	canonical, err := CanonicalRunnerConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	want := "{\"a\":{\"a\":1,\"b\":2},\"array\":[null,true,\"值\"],\"z\":\"<&>\u2028\"}"
	if string(canonical) != want {
		t.Fatalf("canonical: %s", canonical)
	}
	if _, err := CanonicalRunnerConfig(json.RawMessage(`{"n":1.5}`)); !errors.Is(err, ErrInvalidConfig) {
		t.Fatal(err)
	}
	if _, err := CanonicalRunnerConfig(json.RawMessage(`null null`)); !errors.Is(err, ErrInvalidConfig) {
		t.Fatal(err)
	}
	digest, _ := Digest(json.RawMessage("null"))
	if digest != "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b" {
		t.Fatal(digest)
	}
}

func TestExpiredAuthoritativeApplyFencesPreviousLiveRun(t *testing.T) {
	m := newTestManager(t, helperBinary(t), t.TempDir())
	cfg := exitConfig(t, "expired-update", "tcp", freePort(t, "tcp"), 1)
	o, err := m.Apply(cfg)
	requireReady(t, o, err)
	cfg.Generation = 2
	cfg.LeaseExpiresAt = time.Now().Add(-time.Second).Format(time.RFC3339Nano)
	o, err = m.Apply(cfg)
	if !errors.Is(err, ErrLeaseExpired) || o.Ready || o.Generation != 2 || o.State != "expired" {
		t.Fatalf("expired update: %+v %v", o, err)
	}
	cfg.Generation = 1
	if _, err := m.Apply(cfg); !errors.Is(err, ErrStaleGeneration) {
		t.Fatal(err)
	}
}
