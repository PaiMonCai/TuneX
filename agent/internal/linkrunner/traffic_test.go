package linkrunner

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Leave the existing -config-only helper/TestMain untouched. This separate
// subprocess fixture understands ingress and the optional traffic CLI contract.
func init() {
	if len(os.Args) < 3 || os.Args[1] != "-config" {
		return
	}
	data, err := os.ReadFile(os.Args[2])
	if err != nil {
		return
	}
	var header struct {
		Mode string `json:"testMode"`
	}
	if json.Unmarshal(data, &header) != nil || header.Mode != "traffic-helper" {
		return
	}
	trafficHelperMain(data)
	os.Exit(0)
}

func trafficHelperMain(data []byte) {
	producer, path := "", ""
	if len(os.Args) == 7 && os.Args[3] == "-managed-traffic" && os.Args[5] == "-managed-traffic-producer" {
		path, producer = os.Args[4], os.Args[6]
		if os.Getenv("AUTH_SECRET") != "" || os.Getenv("NODE_CREDENTIAL") != "" || !filepath.IsAbs(path) || !trafficHex(producer, 32) {
			os.Exit(40)
		}
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			os.Exit(41)
		}
		initial, _ := json.Marshal(trafficSnapshot{1, producer, []trafficCounter{}})
		if atomicPrivateWrite(path, initial) != nil {
			os.Exit(42)
		}
	}
	checkManifest := func(raw []byte) {
		if producer == "" {
			return
		}
		var shape runnerShape
		if json.Unmarshal(raw, &shape) != nil {
			os.Exit(43)
		}
		cache, records, err := openCache(filepath.Dir(filepath.Dir(os.Args[2])), "agent-one")
		if err != nil {
			os.Exit(44)
		}
		m := &Manager{cache: cache, records: records, traffic: &trafficStore{dir: filepath.Dir(path)}}
		manifest, err := m.readTrafficManifestLocked(producer)
		if err != nil {
			os.Exit(45)
		}
		known := map[int64]bool{}
		for _, rule := range manifest.Rules {
			known[rule.ForwardID] = true
		}
		for _, entry := range shape.Entries {
			if !known[entry.RuleID] {
				os.Exit(46)
			}
		}
	}
	checkManifest(data)
	var shape runnerShape
	_ = json.Unmarshal(data, &shape)
	lanes := shape.Entries
	if shape.Role == "exit" {
		lanes = []runnerShape{shape}
	}
	for _, lane := range lanes {
		for _, protocol := range []string{"tcp", "udp"} {
			if lane.Protocol != protocol && lane.Protocol != "both" {
				continue
			}
			rule := ""
			if lane.Role == "entry" {
				rule = fmt.Sprintf(" rule=%d", lane.RuleID)
			}
			fmt.Fprintf(os.Stderr, "%s %s listening on :%d tunnel=%d%s\n", lane.Role, protocol, lane.ListenPort, lane.TunnelID, rule)
		}
	}
	if managedConfig(data) {
		fmt.Fprintf(os.Stderr, "managed applied sha256=%x\n", sha256.Sum256(data))
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	last := sha256.Sum256(data)
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			raw, err := os.ReadFile(os.Args[2])
			if err != nil {
				continue
			}
			next := sha256.Sum256(raw)
			if next == last {
				continue
			}
			checkManifest(raw) // Must be durable BEFORE the child sees the proposal.
			last = next
			if bytes.Contains(raw, []byte(`"testReject":true`)) {
				fmt.Fprintf(os.Stderr, "managed rejected sha256=%x code=bind\n", next)
			} else {
				fmt.Fprintf(os.Stderr, "managed applied sha256=%x\n", next)
			}
		}
	}
}

func trafficIngress(t *testing.T, generation int64, rules ...int64) Config {
	t.Helper()
	cfg := Config{ID: "traffic-ingress", LinkID: 91, WorkspaceID: 5, NodeID: 7, Role: "ingress", Generation: generation, LeaseExpiresAt: time.Now().Add(time.Minute).Format(time.RFC3339Nano)}
	entries := []map[string]any{}
	seenPorts := map[int]bool{}
	for _, rule := range rules {
		port := freePort(t, "tcp")
		for seenPorts[port] {
			port = freePort(t, "tcp")
		}
		seenPorts[port] = true
		entries = append(entries, map[string]any{"role": "entry", "tunnelId": 91, "ruleId": rule, "listenHost": "127.0.0.1", "listenPort": port, "protocol": "both", "key": fixtureKey, "exitHost": "127.0.0.1", "exitPort": 60001, "targetIp": "127.0.0.1", "targetPort": 60002})
		cfg.Ports = append(cfg.Ports, Port{"tcp", "127.0.0.1", port}, Port{"udp", "127.0.0.1", port})
		cfg.RuntimeIDs = append(cfg.RuntimeIDs, fmt.Sprintf("rule-%d-tcp", rule), fmt.Sprintf("rule-%d-udp", rule))
	}
	setRunner(t, &cfg, map[string]any{"role": "entry-group", "tunnelId": 91, "managedReload": true, "testMode": "traffic-helper", "entries": entries})
	return cfg
}

func enabledTrafficManager(t *testing.T, dir string) *Manager {
	t.Helper()
	m := newTestManager(t, helperBinary(t), dir)
	if err := m.EnableTraffic(); err != nil {
		t.Fatal(err)
	}
	return m
}

func persistTrafficFixture(t *testing.T, m *Manager, cfg Config, id string, counters ...trafficCounter) string {
	t.Helper()
	if _, _, err := validateConfig(&cfg); err != nil {
		t.Fatal(err)
	}
	r := record{ID: cfg.ID, LinkID: cfg.LinkID, WorkspaceID: cfg.WorkspaceID, NodeID: cfg.NodeID, Role: cfg.Role, Highest: cfg.Generation, Config: &cfg, State: "cached", Fingerprint: fingerprint(cfg)}
	if err := m.saveRecordLocked(r); err != nil {
		t.Fatal(err)
	}
	manifest := trafficManifest{Version: 1, ProducerID: id, PlacementID: cfg.ID, LinkID: cfg.LinkID, WorkspaceID: cfg.WorkspaceID, NodeID: cfg.NodeID, Role: cfg.Role, Last: []trafficCounter{}}
	if err := addTrafficRules(&manifest, cfg); err != nil {
		t.Fatal(err)
	}
	if err := m.writeTrafficManifestLocked(manifest); err != nil {
		t.Fatal(err)
	}
	writeTrafficSnapshot(t, m, id, counters...)
	return id
}

func writeTrafficSnapshot(t *testing.T, m *Manager, producer string, counters ...trafficCounter) {
	t.Helper()
	if counters == nil {
		counters = []trafficCounter{}
	}
	data, err := json.Marshal(trafficSnapshot{1, producer, counters})
	if err != nil {
		t.Fatal(err)
	}
	if err := atomicPrivateWrite(m.traffic.path(producer, trafficSnapshotSuffix), data); err != nil {
		t.Fatal(err)
	}
}

func trafficTotals(id int64, in string) trafficCounter {
	return trafficCounter{id, "2026-10-07", in, "3", "2"}
}
func assertTrafficFiles(t *testing.T, m *Manager, id string, want bool) {
	t.Helper()
	for _, suffix := range []string{trafficManifestSuffix, trafficSnapshotSuffix} {
		_, err := os.Lstat(m.traffic.path(id, suffix))
		if want && err != nil || !want && !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("producer file presence=%t err=%v", want, err)
		}
	}
}

func TestTrafficPrivateSpoolWireAndIdentity(t *testing.T) {
	m := enabledTrafficManager(t, t.TempDir())
	cfg := trafficIngress(t, 4, 101)
	id := persistTrafficFixture(t, m, cfg, strings.Repeat("a", 32), trafficTotals(101, "10"))
	samples, err := m.TrafficSamples()
	if err != nil || len(samples) != 1 {
		t.Fatalf("samples=%+v err=%v", samples, err)
	}
	want := TrafficSample{id, 91, 5, 7, 101, 4, cfg.ConfigDigest, "2026-10-07", "10", "3", "2"}
	if samples[0] != want {
		t.Fatalf("wrong metadata: %+v", samples)
	}
	data, _ := json.Marshal(samples[0])
	var wire map[string]any
	_ = json.Unmarshal(data, &wire)
	fields := []string{"producer_id", "link_id", "workspace_id", "node_id", "forward_id", "generation", "config_digest", "date", "bytes_in", "bytes_out", "connections"}
	if len(wire) != len(fields) {
		t.Fatal("wire fields changed", wire)
	}
	for _, field := range fields {
		if _, ok := wire[field]; !ok {
			t.Fatal("missing field", field)
		}
	}
	for _, field := range []string{"bytes_in", "bytes_out", "connections"} {
		if _, ok := wire[field].(string); !ok {
			t.Fatal("counter not a string")
		}
	}
	manifestData, _ := os.ReadFile(m.traffic.path(id, trafficManifestSuffix))
	if bytes.Contains(manifestData, []byte(fixtureKey)) || bytes.Contains(manifestData, []byte("config_digest")) || bytes.Contains(manifestData, []byte("runner_config")) {
		t.Fatal("manifest not private/encrypted")
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(m.traffic.dir)
		if info.Mode().Perm() != 0o700 {
			t.Fatal("spool directory permissions")
		}
		entries, _ := os.ReadDir(m.traffic.dir)
		for _, entry := range entries {
			info, _ := entry.Info()
			if info.Mode().Perm() != 0o600 {
				t.Fatal("spool file permissions")
			}
		}
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	foreign, err := New(helperBinary(t), m.cache.dir, "foreign-agent")
	if foreign != nil || !errors.Is(err, ErrAgentMismatch) {
		t.Fatal("foreign agent accepted", err)
	}
}

func TestTrafficOptInAndEgressEnvironment(t *testing.T) {
	t.Setenv("NODE_CREDENTIAL", "fixture-node-credential")
	t.Setenv("AUTH_SECRET", "fixture-auth-secret")
	for _, enabled := range []bool{false, true} {
		t.Run(fmt.Sprintf("enabled-%t", enabled), func(t *testing.T) {
			m := newTestManager(t, helperBinary(t), t.TempDir())
			if enabled {
				if err := m.EnableTraffic(); err != nil {
					t.Fatal(err)
				}
			}
			cfg := trafficIngress(t, 1, 101)
			if enabled {
				cfg = testMode(t, exitConfig(t, "traffic-egress", "tcp", freePort(t, "tcp"), 1), "traffic-helper")
			}
			o, err := m.Apply(cfg)
			requireReady(t, o, err)
			p := m.running[cfg.ID]
			if len(p.cmd.Args) != 3 || p.trafficProducer != "" {
				t.Fatal("unexpected traffic CLI", p.cmd.Args)
			}
			foundNode := false
			for _, env := range p.cmd.Env {
				name, _, _ := strings.Cut(env, "=")
				if strings.EqualFold(name, "AUTH_SECRET") {
					t.Fatal("AUTH_SECRET inherited")
				}
				if strings.EqualFold(name, "NODE_CREDENTIAL") {
					foundNode = true
				}
			}
			if foundNode == enabled {
				t.Fatal("NODE_CREDENTIAL filtering/compatibility changed")
			}
			if !enabled {
				if _, err := os.Lstat(filepath.Join(m.cache.dir, "traffic")); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("disabled collector created spool", err)
				}
			}
		})
	}
	m := newTestManager(t, helperBinary(t), t.TempDir())
	if _, err := m.Restore(); err != nil {
		t.Fatal(err)
	}
	if err := m.EnableTraffic(); !errors.Is(err, ErrTrafficStarted) {
		t.Fatal("opt-in after empty Restore accepted", err)
	}
}

func TestTrafficHistoryReaddAndMaximumManifest(t *testing.T) {
	m := enabledTrafficManager(t, t.TempDir())
	cfg := trafficIngress(t, 1, 101)
	id := persistTrafficFixture(t, m, cfg, strings.Repeat("a", 32))
	manifest, err := m.readTrafficManifestLocked(id)
	if err != nil {
		t.Fatal(err)
	}
	later := trafficIngress(t, 2, 102)
	if err := addTrafficRules(&manifest, later); err != nil {
		t.Fatal(err)
	}
	later = trafficIngress(t, 3, 101)
	if err := addTrafficRules(&manifest, later); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Rules) != 2 || manifest.Rules[0].Generation != 1 || manifest.Rules[0].ConfigDigest != cfg.ConfigDigest {
		t.Fatal("re-added rule rebased", manifest.Rules)
	}
	// Worst-case valid IDs/counters plus all historical rule metadata must fit
	// the declared 1 MiB encrypted-manifest limit, not an arbitrary half-limit.
	manifest.Rules = make([]trafficRule, maxTrafficSamples)
	counters := make([]trafficCounter, maxTrafficSamples)
	for i := range counters {
		forward := maxTrafficSafe - int64(i)
		manifest.Rules[i] = trafficRule{forward, 1, cfg.ConfigDigest}
		counters[i] = trafficCounter{forward, "2026-10-07", "9007199254740991", "0", "9007199254740991"}
	}
	if err := m.writeTrafficManifestLocked(manifest); err != nil {
		t.Fatal(err)
	}
	writeTrafficSnapshot(t, m, id, counters...)
	samples, err := m.TrafficSamples()
	if err != nil || len(samples) != maxTrafficSamples {
		t.Fatal("valid maximum manifest rejected", len(samples), err)
	}
	if err := addTrafficRules(&manifest, cfg); !errors.Is(err, ErrTraffic) {
		t.Fatal("historical rule cap not enforced", err)
	}
	if err := m.AckTraffic(samples); err != nil {
		t.Fatal("full 2048-sample ACK rejected", err)
	}
	assertTrafficFiles(t, m, id, false)
}

func TestTrafficInvalidSnapshotsNeverDiscard(t *testing.T) {
	cases := map[string]func(*trafficSnapshot){
		"version":            func(s *trafficSnapshot) { s.Version = 2 },
		"wrong producer":     func(s *trafficSnapshot) { s.ProducerID = strings.Repeat("b", 32) },
		"unknown rule":       func(s *trafficSnapshot) { s.Samples[0].ForwardID = 999 },
		"unsafe rule":        func(s *trafficSnapshot) { s.Samples[0].ForwardID = maxTrafficSafe + 1 },
		"bad date":           func(s *trafficSnapshot) { s.Samples[0].Date = "2026-02-30" },
		"negative":           func(s *trafficSnapshot) { s.Samples[0].BytesIn = "-1" },
		"leading zero":       func(s *trafficSnapshot) { s.Samples[0].BytesIn = "01" },
		"unsafe counter":     func(s *trafficSnapshot) { s.Samples[0].Connections = "9007199254740992" },
		"combined unsafe":    func(s *trafficSnapshot) { s.Samples[0].BytesIn = "9007199254740991" },
		"duplicate rule day": func(s *trafficSnapshot) { s.Samples = append(s.Samples, s.Samples[0]) },
		"null samples":       func(s *trafficSnapshot) { s.Samples = nil },
		"sample bound": func(s *trafficSnapshot) {
			for len(s.Samples) <= maxTrafficSamples {
				s.Samples = append(s.Samples, s.Samples[0])
			}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			m := enabledTrafficManager(t, t.TempDir())
			id := persistTrafficFixture(t, m, trafficIngress(t, 1, 101), strings.Repeat("a", 32), trafficTotals(101, "10"))
			snapshot := trafficSnapshot{1, id, []trafficCounter{trafficTotals(101, "10")}}
			mutate(&snapshot)
			data, _ := json.Marshal(snapshot)
			if err := atomicPrivateWrite(m.traffic.path(id, trafficSnapshotSuffix), data); err != nil {
				t.Fatal(err)
			}
			if samples, err := m.TrafficSamples(); !errors.Is(err, ErrTraffic) || samples != nil {
				t.Fatal("invalid snapshot accepted", samples, err)
			}
			if err := m.AckTraffic(nil); !errors.Is(err, ErrTraffic) {
				t.Fatal("invalid snapshot acknowledged", err)
			}
			assertTrafficFiles(t, m, id, true)
		})
	}
	for _, data := range []string{`{`, `{"version":1,"version":1}`, `{"version":1,"producer_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","samples":[],"unexpected":1}`, `{"version":1,"producer_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","samples":[]} {}`, `{"version":1,"producer_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","samples":[{"forward_id":101,"date":"2026-10-07","bytes_in":1,"bytes_out":"0","connections":"0"}]}`, strings.Repeat("x", maxTrafficFileBytes+1)} {
		t.Run(fmt.Sprintf("malformed-%d-%x", len(data), sha256.Sum256([]byte(data))), func(t *testing.T) {
			m := enabledTrafficManager(t, t.TempDir())
			id := persistTrafficFixture(t, m, trafficIngress(t, 1, 101), strings.Repeat("a", 32))
			if os.WriteFile(m.traffic.path(id, trafficSnapshotSuffix), []byte(data), 0o600) != nil {
				t.Fatal("write malformed fixture")
			}
			if _, err := m.TrafficSamples(); !errors.Is(err, ErrTraffic) {
				t.Fatal(err)
			}
			assertTrafficFiles(t, m, id, true)
		})
	}
}

func TestTrafficManifestMismatchReplayAndUnreadable(t *testing.T) {
	for _, kind := range []string{"node", "workspace", "link", "placement", "role", "generation", "digest", "tamper", "rename", "missing snapshot", "snapshot directory", "symlink", "ancestor symlink"} {
		t.Run(kind, func(t *testing.T) {
			m := enabledTrafficManager(t, t.TempDir())
			id := persistTrafficFixture(t, m, trafficIngress(t, 1, 101), strings.Repeat("a", 32), trafficTotals(101, "10"))
			manifest, err := m.readTrafficManifestLocked(id)
			if err != nil {
				t.Fatal(err)
			}
			snapshotPath := m.traffic.path(id, trafficSnapshotSuffix)
			switch kind {
			case "node":
				manifest.NodeID++
			case "workspace":
				manifest.WorkspaceID++
			case "link":
				manifest.LinkID++
			case "placement":
				manifest.PlacementID = "../../escape"
			case "role":
				manifest.Role = "egress"
			case "generation":
				manifest.Rules[0].Generation++
			case "digest":
				manifest.Rules[0].ConfigDigest = "BAD"
			case "tamper":
				data, _ := os.ReadFile(m.traffic.path(id, trafficManifestSuffix))
				data[len(data)/2] ^= 1
				_ = os.WriteFile(m.traffic.path(id, trafficManifestSuffix), data, 0o600)
			case "rename":
				_ = os.Rename(m.traffic.path(id, trafficManifestSuffix), m.traffic.path(strings.Repeat("b", 32), trafficManifestSuffix))
			case "missing snapshot":
				_ = os.Remove(snapshotPath)
			case "snapshot directory":
				_ = os.Remove(snapshotPath)
				_ = os.Mkdir(snapshotPath, 0o700)
			case "symlink":
				outside := filepath.Join(t.TempDir(), "outside.json")
				_ = os.WriteFile(outside, []byte("outside"), 0o600)
				_ = os.Remove(snapshotPath)
				if err := os.Symlink(outside, snapshotPath); err != nil {
					t.Skip("symlink unavailable", err)
				}
			case "ancestor symlink":
				moved := m.traffic.dir + "-old"
				if err := os.Rename(m.traffic.dir, moved); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(moved, m.traffic.dir); err != nil {
					t.Skip("symlink unavailable", err)
				}
			}
			if kind == "node" || kind == "workspace" || kind == "link" || kind == "placement" || kind == "role" || kind == "generation" || kind == "digest" {
				if err := m.writeTrafficManifestLocked(manifest); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := m.TrafficSamples(); !errors.Is(err, ErrTraffic) {
				t.Fatal("foreign/unreadable spool accepted", err)
			}
			if err := m.AckTraffic(nil); !errors.Is(err, ErrTraffic) {
				t.Fatal("unreadable spool silently removed", err)
			}
		})
	}
}

func TestTrafficMonotonicCheckpointSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	m := enabledTrafficManager(t, dir)
	id := persistTrafficFixture(t, m, trafficIngress(t, 1, 101), strings.Repeat("a", 32), trafficTotals(101, "20"))
	if _, err := m.TrafficSamples(); err != nil {
		t.Fatal(err)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	m = enabledTrafficManager(t, dir)
	writeTrafficSnapshot(t, m, id, trafficTotals(101, "19"))
	if _, err := m.TrafficSamples(); !errors.Is(err, ErrTraffic) {
		t.Fatal("replayed total accepted", err)
	}
	assertTrafficFiles(t, m, id, true)
	writeTrafficSnapshot(t, m, id)
	if _, err := m.TrafficSamples(); !errors.Is(err, ErrTraffic) {
		t.Fatal("lost rule/day accepted", err)
	}
	writeTrafficSnapshot(t, m, id, trafficTotals(101, "21"), trafficCounter{101, "2026-10-08", "1", "1", "1"})
	if samples, err := m.TrafficSamples(); err != nil || len(samples) != 2 {
		t.Fatal(samples, err)
	}
}

func TestTrafficAckExactStalePartialRepeatedAndOverlappingIDs(t *testing.T) {
	m := enabledTrafficManager(t, t.TempDir())
	cfg := trafficIngress(t, 1, 101)
	a := persistTrafficFixture(t, m, cfg, strings.Repeat("a", 32), trafficTotals(101, "10"))
	b := persistTrafficFixture(t, m, cfg, strings.Repeat("b", 32), trafficTotals(101, "10"))
	samples, err := m.TrafficSamples()
	if err != nil || len(samples) != 2 {
		t.Fatal(samples, err)
	}
	if samples[0].ForwardID != samples[1].ForwardID || samples[0].ProducerID == samples[1].ProducerID {
		t.Fatal("producer IDs conflated")
	}
	writeTrafficSnapshot(t, m, a, trafficTotals(101, "11"), trafficCounter{101, "2026-10-08", "1", "1", "1"})
	if err := m.AckTraffic(samples[:1]); err != nil {
		t.Fatal(err)
	} // Stale ACK of A.
	assertTrafficFiles(t, m, a, true)
	assertTrafficFiles(t, m, b, true)
	current, err := m.TrafficSamples()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.AckTraffic(current[:1]); err != nil {
		t.Fatal(err)
	} // Partial day coverage.
	assertTrafficFiles(t, m, a, true)
	bad := current[0]
	bad.ConfigDigest = strings.Repeat("0", 64)
	if err := m.AckTraffic([]TrafficSample{bad}); !errors.Is(err, ErrTrafficAck) {
		t.Fatal("wrong digest ACK accepted", err)
	}
	bad = current[0]
	bad.BytesIn = "999"
	if err := m.AckTraffic([]TrafficSample{bad}); !errors.Is(err, ErrTrafficAck) {
		t.Fatal("future total ACK accepted", err)
	}
	if err := m.AckTraffic([]TrafficSample{current[0], current[0]}); !errors.Is(err, ErrTrafficAck) {
		t.Fatal("duplicate ACK accepted", err)
	}
	if err := m.AckTraffic(current); err != nil {
		t.Fatal(err)
	}
	assertTrafficFiles(t, m, a, false)
	assertTrafficFiles(t, m, b, false)
	if err := m.AckTraffic(current); err != nil {
		t.Fatal("repeat ACK not idempotent", err)
	}
}

func TestTrafficActiveEmptyAndExpiredProducerNotReclaimed(t *testing.T) {
	m := enabledTrafficManager(t, t.TempDir())
	id := persistTrafficFixture(t, m, trafficIngress(t, 1, 101), strings.Repeat("a", 32))
	done := make(chan struct{})
	m.running["fake"] = &child{trafficProducer: id, done: done, expired: true}
	if err := m.AckTraffic(nil); err != nil {
		t.Fatal(err)
	}
	assertTrafficFiles(t, m, id, true)
	writeTrafficSnapshot(t, m, id, trafficTotals(101, "10"))
	samples, err := m.TrafficSamples()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.AckTraffic(samples); err != nil {
		t.Fatal(err)
	}
	assertTrafficFiles(t, m, id, true)
	close(done)
	delete(m.running, "fake")
	if err := m.AckTraffic(samples); err != nil {
		t.Fatal(err)
	}
	assertTrafficFiles(t, m, id, false)
}

func TestTrafficInterruptedAckRecovery(t *testing.T) {
	for _, kind := range []string{"intent", "snapshot removed", "newer snapshot"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			m := enabledTrafficManager(t, dir)
			id := persistTrafficFixture(t, m, trafficIngress(t, 1, 101), strings.Repeat("a", 32), trafficTotals(101, "10"))
			if _, err := m.TrafficSamples(); err != nil {
				t.Fatal(err)
			}
			manifest, err := m.readTrafficManifestLocked(id)
			if err != nil {
				t.Fatal(err)
			}
			manifest.Discard = true
			if err := m.writeTrafficManifestLocked(manifest); err != nil {
				t.Fatal(err)
			}
			if kind == "snapshot removed" {
				_ = os.Remove(m.traffic.path(id, trafficSnapshotSuffix))
			}
			if kind == "newer snapshot" {
				writeTrafficSnapshot(t, m, id, trafficTotals(101, "11"))
			}
			if err := m.Close(); err != nil {
				t.Fatal(err)
			}
			reopened := newTestManager(t, helperBinary(t), dir)
			err = reopened.EnableTraffic()
			if kind == "newer snapshot" {
				if !errors.Is(err, ErrTraffic) {
					t.Fatal("newer snapshot erased", err)
				}
				assertTrafficFiles(t, reopened, id, true)
			} else {
				if err != nil {
					t.Fatal(err)
				}
				assertTrafficFiles(t, reopened, id, false)
			}
		})
	}
}

func TestTrafficEnabledLifecycleMappingEnvironmentAndRestart(t *testing.T) {
	t.Setenv("NODE_CREDENTIAL", "must-not-reach-child")
	t.Setenv("AUTH_SECRET", "must-not-reach-child-either")
	dir := t.TempDir()
	m := enabledTrafficManager(t, dir)
	cfg := trafficIngress(t, 1, 101, 102)
	firstDigest := cfg.ConfigDigest
	o, err := m.Apply(cfg)
	requireReady(t, o, err)
	firstPID := o.PID
	producer := m.running[cfg.ID].trafficProducer
	if !trafficHex(producer, 32) {
		t.Fatal("not a fresh crypto producer")
	}
	if err := m.EnableTraffic(); !errors.Is(err, ErrTrafficStarted) {
		t.Fatal("late opt-in accepted", err)
	}
	writeTrafficSnapshot(t, m, producer, trafficTotals(101, "10"), trafficTotals(102, "20"))
	// Add a rule and modify an existing binding. The helper verifies that every
	// candidate rule already has a durable manifest when it reads the new file.
	var shape map[string]any
	_ = json.Unmarshal(cfg.RunnerConfig, &shape)
	newCfg := trafficIngress(t, 2, 103)
	var newShape map[string]any
	_ = json.Unmarshal(newCfg.RunnerConfig, &newShape)
	entries := shape["entries"].([]any)
	entries[0].(map[string]any)["targetPort"] = 60003
	shape["entries"] = append(entries, newShape["entries"].([]any)[0])
	cfg.Ports = append(cfg.Ports, newCfg.Ports...)
	cfg.RuntimeIDs = append(cfg.RuntimeIDs, newCfg.RuntimeIDs...)
	cfg.Generation = 2
	setRunner(t, &cfg, shape)
	secondDigest := cfg.ConfigDigest
	o, err = m.Apply(cfg)
	requireReady(t, o, err)
	if o.PID != firstPID {
		t.Fatal("managed update changed producer process")
	}
	writeTrafficSnapshot(t, m, producer, trafficTotals(101, "11"), trafficTotals(102, "21"), trafficTotals(103, "3"))
	samples, err := m.TrafficSamples()
	if err != nil || len(samples) != 3 {
		t.Fatal(samples, err)
	}
	for _, s := range samples {
		if s.ForwardID == 103 {
			if s.Generation != 2 || s.ConfigDigest != secondDigest {
				t.Fatal("new rule wrong origin", s)
			}
		} else if s.Generation != 1 || s.ConfigDigest != firstDigest {
			t.Fatal("existing rule rebased", s)
		}
	}
	// Delete A; its historical counters/mapping must survive the live update.
	entries = shape["entries"].([]any)
	shape["entries"] = entries[1:]
	cfg.Ports = cfg.Ports[2:]
	cfg.RuntimeIDs = cfg.RuntimeIDs[2:]
	cfg.Generation = 3
	setRunner(t, &cfg, shape)
	o, err = m.Apply(cfg)
	requireReady(t, o, err)
	after, err := m.TrafficSamples()
	if err != nil || !reflect.DeepEqual(after, samples) {
		t.Fatal("removed rule lost", after, err)
	}
	if err := m.AckTraffic(after); err != nil {
		t.Fatal(err)
	}
	assertTrafficFiles(t, m, producer, true)
	if _, err := m.Remove(cfg.ID, 3); err != nil {
		t.Fatal(err)
	}
	assertTrafficFiles(t, m, producer, true)
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	m = enabledTrafficManager(t, dir)
	again, err := m.TrafficSamples()
	if err != nil || !reflect.DeepEqual(again, samples) {
		t.Fatal("restart lost deletion traffic", again, err)
	}
	// Reactivation creates another producer even for overlapping forward IDs.
	cfg.Generation = 4
	o, err = m.Apply(cfg)
	requireReady(t, o, err)
	newProducer := m.running[cfg.ID].trafficProducer
	if newProducer == producer {
		t.Fatal("producer reused after restart")
	}
	writeTrafficSnapshot(t, m, newProducer, trafficTotals(102, "2"))
	if all, err := m.TrafficSamples(); err != nil || len(all) != 4 {
		t.Fatal(all, err)
	}
	if err := m.AckTraffic(samples); err != nil {
		t.Fatal(err)
	}
	assertTrafficFiles(t, m, producer, false)
	assertTrafficFiles(t, m, newProducer, true)
}

func TestTrafficRejectedCandidateKeepsConservativeMapping(t *testing.T) {
	m := enabledTrafficManager(t, t.TempDir())
	cfg := trafficIngress(t, 1, 101)
	o, err := m.Apply(cfg)
	requireReady(t, o, err)
	producer := m.running[cfg.ID].trafficProducer
	var shape map[string]any
	_ = json.Unmarshal(cfg.RunnerConfig, &shape)
	addition := trafficIngress(t, 2, 102)
	var extra map[string]any
	_ = json.Unmarshal(addition.RunnerConfig, &extra)
	entry := extra["entries"].([]any)[0].(map[string]any)
	entry["testReject"] = true
	shape["entries"] = append(shape["entries"].([]any), entry)
	cfg.Ports = append(cfg.Ports, addition.Ports...)
	cfg.RuntimeIDs = append(cfg.RuntimeIDs, addition.RuntimeIDs...)
	cfg.Generation = 2
	setRunner(t, &cfg, shape)
	o, err = m.Apply(cfg)
	if !errors.Is(err, ErrReloadRejected) || !o.Ready || o.State != "rolled_back" {
		t.Fatal(o, err)
	}
	manifest, err := m.readTrafficManifestLocked(producer)
	if err != nil || len(manifest.Rules) != 2 {
		t.Fatal("proposal mapping lost", manifest, err)
	}
	if manifest.Rules[1].Generation != 2 || manifest.Rules[1].ConfigDigest != cfg.ConfigDigest {
		t.Fatal("proposal mapped to rollback")
	}
}

func TestTrafficBackpressureAndCorruptActiveSpoolFailClosed(t *testing.T) {
	t.Run("full", func(t *testing.T) {
		m := enabledTrafficManager(t, t.TempDir())
		cfg := trafficIngress(t, 1, 101)
		for i := 0; i < maxTrafficProducers; i++ {
			persistTrafficFixture(t, m, cfg, fmt.Sprintf("%032x", i+1), trafficTotals(101, "1"))
		}
		if o, err := m.Apply(cfg); !errors.Is(err, ErrTraffic) || o.Ready {
			t.Fatal("full spool launched unaccounted child", o, err)
		}
		ids, _, err := m.traffic.inventory()
		if err != nil || len(ids) != maxTrafficProducers {
			t.Fatal("backpressure evicted producer", len(ids), err)
		}
	})
	t.Run("active corruption", func(t *testing.T) {
		m := enabledTrafficManager(t, t.TempDir())
		cfg := trafficIngress(t, 1, 101)
		o, err := m.Apply(cfg)
		requireReady(t, o, err)
		id := m.running[cfg.ID].trafficProducer
		if os.WriteFile(m.traffic.path(id, trafficSnapshotSuffix), []byte("not-json"), 0o600) != nil {
			t.Fatal("write")
		}
		if _, err := m.TrafficSamples(); !errors.Is(err, ErrTraffic) {
			t.Fatal(err)
		}
		if m.Status()[0].Ready {
			t.Fatal("corrupt spool still forwarding")
		}
		assertTrafficFiles(t, m, id, true)
	})
}

func TestTrafficAtomicReplacementRetryAndSnapshotLimit(t *testing.T) {
	m := enabledTrafficManager(t, t.TempDir())
	id := persistTrafficFixture(t, m, trafficIngress(t, 1, 101), strings.Repeat("a", 32), trafficTotals(101, "1"))
	// Identical atomic replacements must never look like missing/partial JSON.
	done := make(chan error, 1)
	go func() {
		for i := 0; i < 80; i++ {
			data, _ := json.Marshal(trafficSnapshot{1, id, []trafficCounter{trafficTotals(101, "1")}})
			if err := atomicPrivateWrite(m.traffic.path(id, trafficSnapshotSuffix), data); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	for i := 0; i < 80; i++ {
		if _, err := m.TrafficSamples(); err != nil {
			t.Fatal("atomic replacement misread", err)
		}
		if i%5 == 0 {
			if err := m.AckTraffic(nil); err != nil {
				t.Fatal("ACK scan raced atomic replacement", err)
			}
		}
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	counters := make([]trafficCounter, maxTrafficSamples)
	for i := range counters {
		counters[i] = trafficCounter{101, time.Date(2026, 10, 7+i, 0, 0, 0, 0, time.UTC).Format("2006-01-02"), strconv.Itoa(i + 1), "0", "0"}
	}
	// Preserve the already-checkpointed first day's totals while adding dates.
	counters[0] = trafficTotals(101, "1")
	writeTrafficSnapshot(t, m, id, counters...)
	if samples, err := m.TrafficSamples(); err != nil || len(samples) != maxTrafficSamples {
		t.Fatal("valid sample bound rejected", len(samples), err)
	}
}

func TestTrafficPinnedHandleSurvivesConcurrentReplacement(t *testing.T) {
	m := enabledTrafficManager(t, t.TempDir())
	id := persistTrafficFixture(t, m, trafficIngress(t, 1, 101), strings.Repeat("a", 32), trafficTotals(101, "1"))
	path := m.traffic.path(id, trafficSnapshotSuffix)
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	f, err := openTrafficFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	updated, _ := json.Marshal(trafficSnapshot{1, id, []trafficCounter{trafficTotals(101, "2")}})
	// Start replacement while the handle is pinned. Some Windows MoveFileEx
	// implementations still defer replacement until readers close, even with
	// FILE_SHARE_DELETE; the production writer already retries that condition.
	replaced := make(chan error, 1)
	go func() { replaced <- atomicPrivateWrite(path, updated) }()
	data, err := io.ReadAll(f)
	if err != nil || !bytes.Equal(data, original) {
		t.Fatal("pinned snapshot changed during rename", err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-replaced; err != nil {
		t.Fatal("concurrent replacement failed", err)
	}
	current, err := readTrafficFile(path)
	if err != nil || !bytes.Equal(current, updated) {
		t.Fatal("replacement not readable", err)
	}
}

func TestTrafficKernelOpenDoesNotFollowSymlink(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(out, []byte("private outside content"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "linked.json")
	if err := os.Symlink(out, path); err != nil {
		t.Skip("symlink unavailable", err)
	}
	f, err := openTrafficFile(path)
	if err != nil {
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err == nil && info.Mode().IsRegular() {
		t.Fatal("kernel open followed symlink target")
	}
}
