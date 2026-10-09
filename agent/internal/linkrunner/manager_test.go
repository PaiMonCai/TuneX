package linkrunner

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const fixtureKey = "9b913c504edee09c1c90e7806967d8af98744df47d58341a40fa216d3c4d5314aa"

// A real subprocess fallback with the identical -config-only invocation. This
// is also used to force missing readiness, fatal output, delayed exit and an
// ignored stop signal that production FXP cannot deterministically reproduce.
func TestMain(m *testing.M) {
	if len(os.Args) == 3 && os.Args[1] == "-config" {
		helperMain(os.Args[2])
		return
	}
	os.Exit(m.Run())
}

func helperMain(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		os.Exit(2)
	}
	var c struct {
		Role    string `json:"role"`
		Tunnel  int64  `json:"tunnelId"`
		Port    int    `json:"listenPort"`
		Host    string `json:"listenHost"`
		Key     string `json:"key"`
		Mode    string `json:"testMode"`
		Managed bool   `json:"managedReload"`
	}
	if json.Unmarshal(data, &c) != nil {
		os.Exit(2)
	}
	if c.Mode == "secretfail" {
		fmt.Fprintln(os.Stderr, string(data))
		fmt.Fprintln(os.Stderr, c.Key)
		os.Exit(7)
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(c.Host, fmt.Sprint(c.Port)))
	if err != nil {
		os.Exit(3)
	}
	defer ln.Close()
	if c.Mode != "nomarkers" {
		fmt.Fprintf(os.Stderr, "exit tcp listening on :%d tunnel=%d\n", c.Port, c.Tunnel)
	}
	if c.Managed && c.Mode != "managed-nostartack" {
		fmt.Fprintf(os.Stderr, "managed applied sha256=%x\n", sha256.Sum256(data))
	}
	if c.Mode == "exitlater" {
		time.Sleep(250 * time.Millisecond)
		os.Exit(9)
	}
	if c.Mode == "ignorestop" {
		signal.Ignore(os.Interrupt, syscall.SIGTERM)
		for {
			time.Sleep(time.Hour)
		}
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
}

func binaryForTest(t *testing.T) string {
	t.Helper()
	if path := os.Getenv("TUNEX_TEST_FXP_BINARY"); path != "" {
		return path
	}
	path, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func helperBinary(t *testing.T) string {
	t.Helper()
	path, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func newTestManager(t *testing.T, binary, dir string) *Manager {
	t.Helper()
	m, err := New(binary, dir, "agent-one")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := m.Close(); err != nil {
			t.Error(err)
		}
	})
	return m
}

func freePort(t *testing.T, network string) int {
	t.Helper()
	if network == "udp" {
		c, err := net.ListenPacket("udp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		p := c.LocalAddr().(*net.UDPAddr).Port
		c.Close()
		return p
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return p
}

func exitConfig(t *testing.T, id, protocol string, port int, generation int64) Config {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"role": "exit", "tunnelId": int64(91), "listenPort": port, "udpListenPort": port, "listenHost": "127.0.0.1", "protocol": protocol, "key": fixtureKey})
	if err != nil {
		t.Fatal(err)
	}
	digest, err := Digest(raw)
	if err != nil {
		t.Fatal(err)
	}
	c := Config{ID: id, LinkID: 91, WorkspaceID: 5, NodeID: 7, Role: "egress", Generation: generation, LeaseExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano), ConfigDigest: digest, RunnerConfig: raw, RuntimeIDs: []string{id + "-" + protocol}}
	for _, p := range []string{"tcp", "udp"} {
		if protocol == p || protocol == "both" {
			c.Ports = append(c.Ports, Port{p, "127.0.0.1", port})
		}
	}
	return c
}

func testMode(t *testing.T, cfg Config, mode string) Config {
	t.Helper()
	var v map[string]any
	if json.Unmarshal(cfg.RunnerConfig, &v) != nil {
		t.Fatal("bad fixture")
	}
	v["testMode"] = mode
	cfg.RunnerConfig, _ = json.Marshal(v)
	cfg.ConfigDigest, _ = Digest(cfg.RunnerConfig)
	return cfg
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}

func requireReady(t *testing.T, o Observation, err error) {
	t.Helper()
	if err != nil || !o.Ready || o.PID == 0 || o.ObservedGeneration == 0 {
		t.Fatalf("observation=%+v error=%v", o, err)
	}
}

func TestRealFXPLifecycleSharedProtocolsRestartDeleteReuse(t *testing.T) {
	binary := binaryForTest(t)
	if os.Getenv("TUNEX_TEST_FXP_BINARY") == "" {
		t.Skip("set TUNEX_TEST_FXP_BINARY for real TCP/UDP FXP acceptance")
	}
	dir := t.TempDir()
	m := newTestManager(t, binary, dir)
	port := freePort(t, "tcp")
	a := exitConfig(t, "tcp-slot", "tcp", port, 1)
	o, err := m.Apply(a)
	requireReady(t, o, err)
	firstPID := o.PID
	b := exitConfig(t, "udp-slot", "udp", port, 1)
	o, err = m.Apply(b)
	requireReady(t, o, err)
	udpPID := o.PID
	// Separate placements share the numeric port using distinct protocols.
	a.Generation = 2
	o, err = m.Apply(a)
	requireReady(t, o, err)
	if o.PID == firstPID || o.Generation != 2 || o.ObservedGeneration != 2 {
		t.Fatalf("restart did not replace child: %+v", o)
	}
	for _, s := range m.Status() {
		if s.ID == b.ID && (!s.Ready || s.PID != udpPID) {
			t.Fatalf("TCP update disturbed UDP: %+v", s)
		}
	}
	if _, err := m.Remove(a.ID, 1); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale remove: %v", err)
	}
	if _, err := m.Remove(a.ID, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Apply(a); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("equal generation resurrected tombstone: %v", err)
	}
	c := exitConfig(t, "new-slot", "tcp", port, 1)
	o, err = m.Apply(c)
	requireReady(t, o, err)
	if _, err := m.Remove(c.ID, 1); err != nil {
		t.Fatal(err)
	}
	a.Generation = 3
	o, err = m.Apply(a)
	requireReady(t, o, err)
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if files, _ := os.ReadDir(filepath.Join(dir, "runtime")); len(files) != 0 {
		t.Fatalf("plaintext config files remain: %v", files)
	}
}

func TestRealFXPEntryGroupWaitsForEveryBinding(t *testing.T) {
	if os.Getenv("TUNEX_TEST_FXP_BINARY") == "" {
		t.Skip("real FXP required")
	}
	m := newTestManager(t, binaryForTest(t), t.TempDir())
	p1, p2 := freePort(t, "tcp"), freePort(t, "udp")
	for p2 == p1 {
		p2 = freePort(t, "udp")
	}
	entries := []map[string]any{}
	ports := []Port{{"tcp", "127.0.0.1", p1}, {"udp", "127.0.0.1", p2}}
	for i, p := range ports {
		entries = append(entries, map[string]any{"role": "entry", "tunnelId": 91, "ruleId": 101 + i, "listenHost": p.Host, "listenPort": p.Port, "protocol": p.Protocol, "exitHost": "127.0.0.1", "exitPort": 60001, "targetIp": "127.0.0.1", "targetPort": 60002, "key": fixtureKey})
	}
	raw, _ := json.Marshal(map[string]any{"role": "entry-group", "tunnelId": 91, "entries": entries})
	digest, _ := Digest(raw)
	cfg := Config{ID: "group", LinkID: 91, WorkspaceID: 5, NodeID: 7, Role: "ingress", Generation: 1, LeaseExpiresAt: time.Now().Add(time.Minute).Format(time.RFC3339Nano), ConfigDigest: digest, RunnerConfig: raw, Ports: ports, RuntimeIDs: []string{"tcp-binding", "udp-binding"}}
	o, err := m.Apply(cfg)
	requireReady(t, o, err)
	if len(o.Logs) != 2 {
		t.Fatalf("not all binding markers observed: %+v", o)
	}
	// A collision in a later entry must not leave the earlier entry listening.
	occupied, err := net.ListenPacket("udp", fmt.Sprintf("127.0.0.1:%d", freePort(t, "udp")))
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	entries[1]["listenPort"] = occupied.LocalAddr().(*net.UDPAddr).Port
	cfg.Generation = 2
	cfg.Ports[1].Port = occupied.LocalAddr().(*net.UDPAddr).Port
	cfg.RunnerConfig, _ = json.Marshal(map[string]any{"role": "entry-group", "tunnelId": 91, "entries": entries})
	cfg.ConfigDigest, _ = Digest(cfg.RunnerConfig)
	o, err = m.Apply(cfg)
	if err == nil || !o.Ready || o.State != "rolled_back" || o.Generation != 2 || o.ObservedGeneration != 1 {
		t.Fatalf("group bind failure did not roll back: %+v %v", o, err)
	}
}

func TestRollbackFencesFailedGenerationAcrossRestart(t *testing.T) {
	m := newTestManager(t, helperBinary(t), t.TempDir())
	cfg := exitConfig(t, "slot", "tcp", freePort(t, "tcp"), 1)
	o, err := m.Apply(cfg)
	requireReady(t, o, err)
	oldPID := o.PID
	bad := testMode(t, cfg, "secretfail")
	bad.Generation = 2
	o, err = m.Apply(bad)
	if !errors.Is(err, ErrProcessExited) || !o.Ready || o.State != "rolled_back" || o.Generation != 2 || o.ObservedGeneration != 1 || o.PID == oldPID {
		t.Fatalf("rollback: %+v %v", o, err)
	}
	encoded, _ := json.Marshal(o)
	if bytes.Contains(encoded, []byte(fixtureKey)) || strings.Contains(fmt.Sprint(err), fixtureKey) {
		t.Fatal("child secrets leaked")
	}
	if _, err := m.Apply(cfg); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("old apply not fenced: %v", err)
	}
	dir := m.cache.dir
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := newTestManager(t, helperBinary(t), dir)
	statuses, err := reopened.Restore()
	if err != nil || len(statuses) != 1 || !statuses[0].Ready || statuses[0].Generation != 2 || statuses[0].ObservedGeneration != 1 {
		t.Fatalf("restore rollback: %+v %v", statuses, err)
	}
	if _, err := reopened.Remove(cfg.ID, 1); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("restore lost highest fence: %v", err)
	}
}

func TestLeaseExpiryRenewalAndExpiredRestore(t *testing.T) {
	dir := t.TempDir()
	m := newTestManager(t, helperBinary(t), dir)
	cfg := exitConfig(t, "leased", "tcp", freePort(t, "tcp"), 1)
	// Leave enough budget for the real subprocess startup timeout, not just
	// its usual unloaded latency. Renewal must survive the ORIGINAL deadline.
	originalDeadline := time.Now().Add(startupTimeout + time.Second)
	cfg.LeaseExpiresAt = originalDeadline.Format(time.RFC3339Nano)
	o, err := m.Apply(cfg)
	requireReady(t, o, err)
	pid := o.PID
	renewedDeadline := originalDeadline.Add(2 * time.Second)
	cfg.LeaseExpiresAt = renewedDeadline.Format(time.RFC3339Nano)
	o, err = m.Apply(cfg)
	requireReady(t, o, err)
	if o.PID != pid {
		t.Fatal("same-generation renewal restarted child")
	}
	m.mu.Lock()
	leasedChild := m.running[cfg.ID]
	m.mu.Unlock()
	originalTimer := time.NewTimer(time.Until(originalDeadline.Add(100 * time.Millisecond)))
	defer originalTimer.Stop()
	select {
	case <-leasedChild.done:
		t.Fatal("renewal did not extend the original lease")
	case <-originalTimer.C:
	}
	if !m.Status()[0].Ready {
		t.Fatal("renewed child did not remain ready after the original deadline")
	}
	expiryTimer := time.NewTimer(time.Until(renewedDeadline) + 2*stopTimeout)
	defer expiryTimer.Stop()
	select {
	case <-leasedChild.done:
	case <-expiryTimer.C:
		t.Fatal("renewed lease did not stop its child")
	}
	if s := m.Status()[0]; s.Ready || s.State != "expired" {
		t.Fatalf("expired lease observation: %+v", s)
	}
	waitFor(t, func() bool {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.Ports[0].Port))
		if err != nil {
			return false
		}
		ln.Close()
		return true
	})
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	r := newTestManager(t, helperBinary(t), dir)
	statuses, err := r.Restore()
	if !errors.Is(err, ErrLeaseExpired) || statuses[0].Ready || statuses[0].State != "expired" {
		t.Fatalf("expired restored: %+v %v", statuses, err)
	}
	cfg.Generation = 0
	if _, err := r.Apply(cfg); !errors.Is(err, ErrInvalidConfig) {
		t.Fatal(err)
	}
}

func TestLeaseWatchNotBlockedByOtherPlacementStartup(t *testing.T) {
	m := newTestManager(t, helperBinary(t), t.TempDir())
	a := exitConfig(t, "lease", "tcp", freePort(t, "tcp"), 1)
	o, err := m.Apply(a)
	requireReady(t, o, err)
	m.mu.Lock()
	leasedChild := m.running[a.ID]
	m.mu.Unlock()
	b := testMode(t, exitConfig(t, "slow", "tcp", freePort(t, "tcp"), 1), "nomarkers")
	finished := make(chan error, 1)
	go func() { _, err := m.Apply(b); finished <- err }()
	// A bound socket without a readiness marker proves the other Apply is in
	// startup holding m.mu. Do not spend a short lease on subprocess launch:
	// loaded CI hosts can take longer to launch than the former 400ms budget.
	waitFor(t, func() bool {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", b.Ports[0].Port), 50*time.Millisecond)
		if err != nil {
			return false
		}
		conn.Close()
		return true
	})
	select {
	case err := <-finished:
		t.Fatalf("slow startup completed before lease watch was tested: %v", err)
	default:
	}
	// Arm the real child watcher only after both subprocesses have started.
	// This private timer seam does not weaken public lease-regression checks.
	if !leasedChild.renew(time.Now().Add(200 * time.Millisecond)) {
		t.Fatal("ready child could not arm its lease watcher")
	}
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-leasedChild.done:
	case err := <-finished:
		t.Fatalf("another startup completed before the leased child stopped: %v", err)
	case <-timer.C:
		t.Fatal("another startup blocked the lease watcher")
	}
	// Checking the socket bypasses the manager mutex held by slow startup.
	ln, bindErr := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", a.Ports[0].Port))
	if bindErr != nil {
		t.Fatal("another startup extended the old lease", bindErr)
	}
	ln.Close()
	select {
	case err := <-finished:
		t.Fatalf("slow startup did not overlap lease expiry: %v", err)
	default:
	}
	if err := <-finished; !errors.Is(err, ErrReadyTimeout) {
		t.Fatalf("missing readiness marker should time out: %v", err)
	}
}

func TestPassiveIngressAndIdentityContentBoundaries(t *testing.T) {
	m := newTestManager(t, helperBinary(t), t.TempDir())
	digest, _ := Digest(json.RawMessage("null"))
	cfg := Config{ID: "passive", LinkID: 91, WorkspaceID: 5, NodeID: 7, Role: "ingress", Generation: 1, LeaseExpiresAt: time.Now().Add(time.Minute).Format(time.RFC3339Nano), RunnerConfig: json.RawMessage("null"), ConfigDigest: digest}
	o, err := m.Apply(cfg)
	if err != nil || o.Ready || o.PID != 0 || o.State != "passive" {
		t.Fatalf("passive config: %+v %v", o, err)
	}
	for _, mutate := range []func(*Config){func(c *Config) { c.WorkspaceID++ }, func(c *Config) { c.NodeID++ }, func(c *Config) { c.LinkID++ }} {
		bad := cloneConfig(cfg)
		mutate(&bad)
		bad.Generation++
		if _, err := m.Apply(bad); !errors.Is(err, ErrIdentityMismatch) {
			t.Fatalf("identity replacement allowed: %v", err)
		}
	}
	bad := cloneConfig(cfg)
	bad.RuntimeIDs = []string{"unexpected"}
	if _, err := m.Apply(bad); !errors.Is(err, ErrInvalidConfig) {
		t.Fatal(err)
	}
	if _, err := m.Remove(cfg.ID, 1); err != nil {
		t.Fatal(err)
	}
	cfg.Generation = 2
	if _, err := m.Apply(cfg); err != nil {
		t.Fatal(err)
	}
}

func TestGenerationDigestPortsAndConcurrentApply(t *testing.T) {
	m := newTestManager(t, helperBinary(t), t.TempDir())
	cfg := exitConfig(t, "concurrent", "tcp", freePort(t, "tcp"), 1)
	var wg sync.WaitGroup
	failures := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			o, err := m.Apply(cfg)
			if err != nil || !o.Ready {
				failures <- fmt.Errorf("%v %+v", err, o)
			}
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	if len(m.Status()) != 1 {
		t.Fatal("concurrent writes produced duplicate runtimes")
	}
	bad := cloneConfig(cfg)
	bad.ConfigDigest = strings.Repeat("0", 64)
	if _, err := m.Apply(bad); !errors.Is(err, ErrDigestMismatch) {
		t.Fatal(err)
	}
	bad = cloneConfig(cfg)
	bad.RuntimeIDs = []string{"replacement"}
	if _, err := m.Apply(bad); !errors.Is(err, ErrGenerationConflict) {
		t.Fatal(err)
	}
	bad = cloneConfig(cfg)
	bad.Ports[0].Port++
	if _, err := m.Apply(bad); !errors.Is(err, ErrInvalidConfig) {
		t.Fatal(err)
	}
	bad = cloneConfig(cfg)
	bad.LeaseExpiresAt = time.Now().Add(10 * time.Second).Format(time.RFC3339Nano)
	if _, err := m.Apply(bad); !errors.Is(err, ErrLeaseRegression) {
		t.Fatal(err)
	}
	other := exitConfig(t, "collision", "tcp", cfg.Ports[0].Port, 1)
	if _, err := m.Apply(other); !errors.Is(err, ErrPortConflict) {
		t.Fatal(err)
	}
}

func TestExitDetectionReadinessAndBoundedKill(t *testing.T) {
	m := newTestManager(t, helperBinary(t), t.TempDir())
	cfg := testMode(t, exitConfig(t, "exit", "tcp", freePort(t, "tcp"), 1), "exitlater")
	o, err := m.Apply(cfg)
	requireReady(t, o, err)
	waitFor(t, func() bool {
		s := m.Status()[0]
		return s.State == "exited" && !s.Ready && strings.Contains(s.LastError, "code=9")
	})
	cfg = testMode(t, exitConfig(t, "stubborn", "tcp", freePort(t, "tcp"), 1), "ignorestop")
	o, err = m.Apply(cfg)
	requireReady(t, o, err)
	started := time.Now()
	if _, err := m.Remove(cfg.ID, 1); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("stop unbounded: %v", elapsed)
	}
	cfg = testMode(t, exitConfig(t, "unready", "tcp", freePort(t, "tcp"), 1), "nomarkers")
	o, err = m.Apply(cfg)
	if !errors.Is(err, ErrReadyTimeout) || o.Ready {
		t.Fatalf("exec.Start/bind alone claimed ready: %+v %v", o, err)
	}
}

func TestBoundedLogsNeverRetainArbitraryOutput(t *testing.T) {
	lane := listener{"exit", "tcp", 10001, 91, 0}
	p := &child{expected: map[listener]int{lane: 1}, remaining: 1, ready: make(chan struct{})}
	p.Write([]byte(strings.Repeat(fixtureKey, 200) + "\n"))
	p.Write([]byte("invalid config key=" + fixtureKey + "\n"))
	p.Write([]byte("exit tcp listening on :10001 tunnel=91 secret=" + fixtureKey + "\n"))
	if len(p.logs) != 0 || p.remaining != 1 {
		t.Fatal("untrusted output retained or used for readiness")
	}
	p.Write([]byte("2026/10/07 12:01:01.123456 exit tcp listening on :10001 tunnel=91\n"))
	if p.remaining != 0 || len(p.logs) != 1 {
		t.Fatal("expected readiness marker missing")
	}
	for i := 0; i < 100; i++ {
		p.logLocked("safe event")
	}
	if len(p.logs) != maxLogLines {
		t.Fatal("log ring not bounded")
	}
	if runtime.GOOS != "windows" && runtime.GOOS != "linux" {
		t.Log("platform outside requested acceptance targets")
	}
}
