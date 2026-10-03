package selfinfo

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/manager"
	"github.com/tunex/agent/internal/restore"
)

// The whitelist is the contract, so the tests pin what must NOT be reachable as
// much as what is: a node diagnostic that leaks config or credentials is worse
// than no diagnostic at all.

func managerWith(t *testing.T) (*manager.TunnelManager, int) {
	t.Helper()
	tm := manager.NewTunnelManager(manager.NewEgressManager(), "127.0.0.1")
	ln, err := os.CreateTemp(t.TempDir(), "port")
	if err != nil {
		t.Fatalf("temp: %v", err)
	}
	_ = ln.Close()
	port := freePort(t)
	cfg := forwarder.TunnelConfig{
		ID: "f1", Mode: forwarder.ModeDirect, IngressPort: port, ListenHost: "127.0.0.1",
		RemoteHost: "10.0.0.5", RemotePort: 8080, Protocol: "tcp", Revision: 3,
	}
	if _, err := tm.Apply(cfg); err != nil {
		t.Fatalf("apply: %v", err)
	}
	t.Cleanup(func() { tm.ShutdownAll(200 * time.Millisecond) })
	return tm, port
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func idFor(i int) string {
	return "egress-" + strconv.Itoa(i)
}

// renderAll is the "did any forbidden field appear" check: it serialises the
// whole fact object, so a newly added field cannot hide from it.
func renderAll(t *testing.T, facts Facts) string {
	t.Helper()
	out, err := json.Marshal(facts)
	if err != nil {
		t.Fatalf("marshal facts: %v", err)
	}
	return string(out)
}

func TestCollectReportsTheRunningRuntime(t *testing.T) {
	tm, port := managerWith(t)
	facts := Collect(Input{
		Version: "0.9.9", Role: "INGRESS", AgentID: "agent-x", NodeID: "hk-in-01",
		Tunnels: tm,
		Started: time.Now().Add(-90 * time.Second),
	})

	if facts.Version != "0.9.9" || facts.Role != "INGRESS" || facts.NodeID != "hk-in-01" {
		t.Fatalf("identity facts missing: %+v", facts)
	}
	if facts.Runtime.TunnelCount != 1 || len(facts.Runtime.Tunnels) != 1 {
		t.Fatalf("expected one running tunnel, got %+v", facts.Runtime)
	}
	got := facts.Runtime.Tunnels[0]
	if got.ID != "f1" || got.IngressPort != port || got.Revision != 3 {
		t.Fatalf("runtime fact mismatch: %+v", got)
	}
	if got.CrossesNode {
		t.Fatal("a DIRECT tunnel does not cross the node")
	}
	if len(facts.Runtime.ListenPorts) != 1 || facts.Runtime.ListenPorts[0] != port {
		t.Fatalf("listen ports must list what is bound, got %v", facts.Runtime.ListenPorts)
	}
	if facts.Process.UptimeSeconds < 80 || facts.Process.UptimeSeconds > 200 {
		t.Fatalf("uptime must reflect the process start, got %d", facts.Process.UptimeSeconds)
	}
	if facts.Process.GoVersion == "" || facts.Process.CPUCount == 0 || facts.Process.Goroutines == 0 {
		t.Fatalf("process facts incomplete: %+v", facts.Process)
	}
}

// The forbidden fields: a diagnostic must not become a config/credential reader.
func TestCollectNeverCarriesConfigurationOrCredentials(t *testing.T) {
	tm, _ := managerWith(t)
	facts := Collect(Input{
		Version: "1.0.0", Role: "INGRESS", AgentID: "agent-x", NodeID: "hk-in-01",
		Tunnels: tm,
		State:   LKGProbe{Cache: restore.LKG{Path: filepath.Join(t.TempDir(), "lkg.json")}, AgentID: "agent-x"},
	})
	rendered := renderAll(t, facts)
	// The scratch path embeds this test's name, which itself contains the words
	// being scanned for; normalise it so the check tests the DATA, not the path.
	if facts.StateDir.Path != "" {
		rendered = strings.ReplaceAll(rendered, facts.StateDir.Path, "<state-dir>")
	}

	// The tunnel's target address is panel-owned configuration; a node fact must
	// not republish it.
	if strings.Contains(rendered, "10.0.0.5") {
		t.Fatalf("a node fact leaked the configured target: %s", rendered)
	}
	for _, forbidden := range []string{"credential", "token", "password", "secret", "Authorization"} {
		if strings.Contains(strings.ToLower(rendered), strings.ToLower(forbidden)) {
			t.Fatalf("a node fact mentioned %q: %s", forbidden, rendered)
		}
	}
}

func TestCollectBoundsEveryList(t *testing.T) {
	tm := manager.NewTunnelManager(manager.NewEgressManager(), "127.0.0.1")
	// More tunnels than the cap allows to be reported.
	for i := 0; i < MaxTunnels+10; i++ {
		if _, err := tm.Apply(forwarder.TunnelConfig{
			ID: idFor(i), Mode: forwarder.ModeDirect, IngressPort: freePort(t), ListenHost: "127.0.0.1",
			RemoteHost: "127.0.0.1", RemotePort: 9, Protocol: "tcp", Revision: 1,
		}); err != nil {
			t.Fatalf("apply %d: %v", i, err)
		}
	}
	t.Cleanup(func() { tm.ShutdownAll(200 * time.Millisecond) })

	facts := Collect(Input{Version: "1", Role: "INGRESS", Tunnels: tm})
	if len(facts.Runtime.Tunnels) != MaxTunnels {
		t.Fatalf("tunnel facts must be capped at %d, got %d", MaxTunnels, len(facts.Runtime.Tunnels))
	}
	if !facts.Runtime.Truncated {
		t.Fatal("truncation must be visible, not silent")
	}
	if facts.Runtime.TunnelCount < MaxTunnels {
		t.Fatalf("the count must still be the real total, got %d", facts.Runtime.TunnelCount)
	}
	if len(facts.Runtime.ListenPorts) > MaxPorts {
		t.Fatalf("ports must be capped at %d", MaxPorts)
	}
}

func TestCollectWithoutAnyRuntimeIsStillAnAnswer(t *testing.T) {
	facts := Collect(Input{Version: "", Role: ""})
	if facts.Runtime.Tunnels == nil || facts.Runtime.ListenPorts == nil {
		t.Fatal("an empty node reports empty lists, not nil (a bundle must not distinguish 'not collected' from 'nothing running')")
	}
	if facts.Runtime.TunnelCount != 0 {
		t.Fatalf("expected zero tunnels, got %d", facts.Runtime.TunnelCount)
	}
}

// The cache is validated with the node's own identity: an id-less check would
// always report "invalid" and turn a healthy node into a false finding.
func TestStateProbeValidatesTheCacheWithTheAgentsOwnIdentity(t *testing.T) {
	dir := t.TempDir()
	cache := restore.LKG{Path: filepath.Join(dir, "desired-lkg.json")}
	snap := &restore.Snapshot{Version: "v1"}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	if err := cache.Save("agent-x", snap); err != nil {
		t.Fatalf("seed cache: %v", err)
	}

	withID, err := LKGProbe{Cache: cache, AgentID: "agent-x"}.Describe()
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	if !withID.CachePresent || !withID.CacheValid || !withID.DirExists {
		t.Fatalf("a valid cache for this agent must be reported as valid: %+v", withID)
	}
	if withID.Path == "" || withID.CacheModTime == "" {
		t.Fatalf("the probe must describe where the cache is: %+v", withID)
	}

	// Another agent's cache is present but NOT valid for this node.
	foreign, err := LKGProbe{Cache: cache, AgentID: "other-agent"}.Describe()
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	if !foreign.CachePresent || foreign.CacheValid {
		t.Fatalf("a cache bound to another agent must not validate here: %+v", foreign)
	}
}

func TestStateProbeReportsAbsenceAndNonRegularFiles(t *testing.T) {
	dir := t.TempDir()
	missing := LKGProbe{Cache: restore.LKG{Path: filepath.Join(dir, "nope.json")}, AgentID: "a"}
	got, err := missing.Describe()
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	if got.CachePresent || got.CacheValid {
		t.Fatalf("a missing cache is a fact, not an error: %+v", got)
	}
	if !got.Configured || !got.DirExists {
		t.Fatalf("the probe should still say where it looked: %+v", got)
	}

	// A symlink where the cache should be is a real finding: the agent refuses to
	// write through it.
	target := filepath.Join(dir, "real.json")
	if err := os.WriteFile(target, []byte("{}"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	link := filepath.Join(dir, "link.json")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	got, err = LKGProbe{Cache: restore.LKG{Path: link}, AgentID: "a"}.Describe()
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	if got.CachePresent || got.CacheValid {
		t.Fatalf("a non-regular cache path must not be reported as present: %+v", got)
	}
}

func TestCollectBoundsStringFacts(t *testing.T) {
	facts := Collect(Input{Version: strings.Repeat("v", 500), Role: strings.Repeat("r", 500), NodeID: strings.Repeat("n", 500)})
	if len(facts.Version) > MaxStringLen || len(facts.Role) > 32 || len(facts.NodeID) > MaxStringLen {
		t.Fatalf("string facts must be bounded: %+v", facts)
	}
}

func TestCollectUsesTheInjectedClock(t *testing.T) {
	fixed := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	facts := Collect(Input{
		Version: "1", Role: "INGRESS",
		Started: fixed.Add(-time.Hour),
		Now:     func() time.Time { return fixed },
	})
	if facts.Process.UptimeSeconds != 3600 {
		t.Fatalf("uptime must use the injected clock, got %d", facts.Process.UptimeSeconds)
	}
	if facts.Process.StartedAt != fixed.Add(-time.Hour).Format(time.RFC3339) {
		t.Fatalf("start time must be the real start: %s", facts.Process.StartedAt)
	}
}

func TestShuttingDownIsVisible(t *testing.T) {
	tm, _ := managerWith(t)
	tm.BeginShutdown()
	facts := Collect(Input{Version: "1", Role: "INGRESS", Tunnels: tm})
	if !facts.ShuttingDown {
		t.Fatal("a draining node must say so: the panel uses this to explain a missing listener")
	}
}
