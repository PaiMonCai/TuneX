package linkrunner

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

func managedHelperConfig(t *testing.T, mode string) Config {
	t.Helper()
	cfg := testMode(t, exitConfig(t, "managed-helper", "tcp", freePort(t, "tcp"), 1), mode)
	var shape map[string]any
	if err := json.Unmarshal(cfg.RunnerConfig, &shape); err != nil {
		t.Fatal(err)
	}
	shape["managedReload"] = true
	setRunner(t, &cfg, shape)
	return cfg
}

func TestManagedStartupRequiresAppliedDigest(t *testing.T) {
	m := newTestManager(t, helperBinary(t), t.TempDir())
	cfg := managedHelperConfig(t, "managed-nostartack")
	o, err := m.Apply(cfg)
	if !errors.Is(err, ErrReadyTimeout) || o.Ready {
		t.Fatalf("bind-only startup advertised ready: %+v %v", o, err)
	}
}

func TestManagedAckTimeoutFailsClosedAndKeepsCommittedCache(t *testing.T) {
	dir := t.TempDir()
	m := newTestManager(t, helperBinary(t), dir)
	old := managedHelperConfig(t, "managed-noack")
	o, err := m.Apply(old)
	requireReady(t, o, err)
	p := m.running[old.ID]
	next := cloneConfig(old)
	next.Generation++
	var shape map[string]any
	_ = json.Unmarshal(next.RunnerConfig, &shape)
	shape["allowedBindings"] = []map[string]any{{"ruleId": 401, "protocol": "tcp", "targetIp": "127.0.0.1", "targetPort": 443}}
	setRunner(t, &next, shape)
	o, err = m.Apply(next)
	if !errors.Is(err, ErrReloadTimeout) || o.Ready || o.Generation != 2 {
		t.Fatalf("missing ACK not failed closed: %+v %v", o, err)
	}
	if _, err := os.Stat(p.path); !os.IsNotExist(err) {
		t.Fatal("secret config survived failed reload")
	}
	if m.records[old.ID].Config.ConfigDigest != old.ConfigDigest {
		t.Fatal("unacknowledged config committed")
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	restored := newTestManager(t, helperBinary(t), dir)
	observations, err := restored.Restore()
	if err != nil || len(observations) != 1 || !observations[0].Ready || observations[0].Generation != 2 || observations[0].ObservedGeneration != 1 {
		t.Fatalf("committed restore: %+v %v", observations, err)
	}
	if _, err := restored.Apply(old); !errors.Is(err, ErrStaleGeneration) {
		t.Fatal("failed reload lost durable generation fence", err)
	}
}

func TestManagedTransportClassifier(t *testing.T) {
	exit := json.RawMessage(`{"role":"exit","managedReload":true,"tunnelId":1,"key":"private","listenPort":80}`)
	sourcedExit := json.RawMessage(`{"role":"exit","managedReload":true,"tunnelId":1,"key":"private","listenPort":80,"clientSources":[{"version":1,"ruleId":2,"receiveProxy":false,"trustedCIDRs":[],"sendProxy":"v2"}]}`)
	if !managedCompatible(exit, sourcedExit) || !managedCompatible(sourcedExit, exit) {
		t.Fatal("source policy edit classified as shared exit restart")
	}
	old := json.RawMessage(`{"role":"entry-group","tunnelId":1,"managedReload":true,"entries":[{"ruleId":2,"key":"private","listenPort":80,"protocol":"both","targetPort":443}]}`)
	next := json.RawMessage(`{"role":"entry-group","tunnelId":1,"managedReload":true,"entries":[{"ruleId":2,"key":"private","listenPort":80,"protocol":"both","targetPort":444,"maxConnections":3},{"ruleId":3,"key":"private","listenPort":81,"protocol":"both"}]}`)
	if !managedCompatible(old, next) {
		t.Fatal("binding policy update classified as carrier restart")
	}
	if !managedCompatible(old, json.RawMessage(`{"role":"entry-group","tunnelId":1,"managedReload":true,"entries":[{"ruleId":2,"key":"private","listenPort":81,"protocol":"both"}]}`)) {
		t.Fatal("business port move classified as a shared carrier restart")
	}
	for _, raw := range []string{
		`{"role":"entry-group","tunnelId":1,"managedReload":true,"entries":[{"ruleId":2,"key":"changed","listenPort":80,"protocol":"both"}]}`,
		`{"role":"entry-group","tunnelId":1,"managedReload":true,"entries":[{"ruleId":2,"key":"private","listenPort":80,"protocol":"tcp"}]}`,
		`{"role":"entry-group","tunnelId":1,"managedReload":false,"entries":[{"ruleId":2,"key":"private","listenPort":80,"protocol":"both"}]}`,
	} {
		if managedCompatible(old, json.RawMessage(raw)) {
			t.Fatal("immutable transport accepted for managed update")
		}
	}
}

func TestManagedSnapshotLogsAreFixedAndSecretFree(t *testing.T) {
	p := &child{managed: true}
	_, _ = p.Write([]byte("2026/10/08 09:01:02 managed snapshot rejected code=open_sharing\n"))
	for _, line := range []string{
		"managed snapshot rejected code=" + fixtureKey,
		"managed snapshot rejected code=open_sharing path=" + fixtureKey,
		"managed snapshot rejected code=open_sharing\x00" + fixtureKey,
		"managed snapshot rejected code=open_unknown",
	} {
		_, _ = p.Write([]byte(line + "\n"))
	}
	if len(p.logs) != 1 || p.logs[0] != "managed snapshot rejected code=open_sharing" {
		t.Fatal("snapshot diagnostics retained non-whitelisted text", p.logs)
	}
}
