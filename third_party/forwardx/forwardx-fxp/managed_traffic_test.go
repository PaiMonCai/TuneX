package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func trafficFixture(t *testing.T) *managedTraffic {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	s, err := newManagedTraffic(filepath.Join(dir, "snapshot.json"), strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func readManagedTraffic(t *testing.T, s *managedTraffic) managedTrafficSnapshot {
	t.Helper()
	body, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatal(err)
	}
	var result managedTrafficSnapshot
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestManagedTrafficCumulativeBothAndPrivateStableSnapshot(t *testing.T) {
	s := trafficFixture(t)
	now := time.Date(2026, 10, 7, 17, 0, 0, 0, time.UTC)
	for _, cfg := range []config{{Role: "entry", RuleID: 11, Protocol: "tcp"}, {Role: "entry", RuleID: 11, Protocol: "udp"}} {
		if err := s.record(cfg, 7, 13, 1, now); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.flush(); err != nil {
		t.Fatal(err)
	}
	result := readManagedTraffic(t, s)
	if result.Version != 1 || len(result.Samples) != 1 || result.Samples[0].Date != "2026-10-08" || result.Samples[0].BytesIn != "14" || result.Samples[0].BytesOut != "26" || result.Samples[0].Connections != "2" {
		t.Fatalf("both/daily cumulative mismatch: %+v", result)
	}
	// A changed runtime's new counter starts at zero, but its deltas must join
	// the same producer's retained rule totals, not replace the old observation.
	if err := s.record(config{Role: "entry", RuleID: 11}, 3, 5, 1, now); err != nil {
		t.Fatal(err)
	}
	if err := s.flush(); err != nil {
		t.Fatal(err)
	}
	result = readManagedTraffic(t, s)
	if result.Samples[0].BytesIn != "17" || result.Samples[0].BytesOut != "31" {
		t.Fatal("new runtime erased retained traffic")
	}
	if _, err := newManagedTraffic(s.path, strings.Repeat("b", 32)); err == nil {
		t.Fatal("new process overwrote old unacknowledged snapshot")
	}
	for _, file := range []string{"../snapshot.json", "relative.json"} {
		if _, err := newManagedTraffic(file, strings.Repeat("a", 32)); err == nil {
			t.Fatal("relative destination accepted")
		}
	}
}

func TestManagedTrafficBoundsAndExitSideCannotCharge(t *testing.T) {
	s := trafficFixture(t)
	now := time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)
	if err := s.record(config{Role: "exit", RuleID: 11}, 1, 1, 1, now); err == nil {
		t.Fatal("egress produced duplicate accounting")
	}
	if err := s.record(config{Role: "entry", RuleID: 11}, managedTrafficMaxValue, 0, 0, now); err != nil {
		t.Fatal(err)
	}
	if err := s.record(config{Role: "entry", RuleID: 11}, 1, 0, 0, now); err == nil {
		t.Fatal("counter overflow accepted")
	}
	for i := 12; i < 11+managedTrafficMaxSamples; i++ {
		if err := s.record(config{Role: "entry", RuleID: i}, 1, 0, 0, now); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.record(config{Role: "entry", RuleID: 10000}, 1, 0, 0, now); err == nil {
		t.Fatal("unbounded spool accepted")
	}
}

func TestManagedTrafficReporterFlushesFinalCounterWithoutPanelCredentials(t *testing.T) {
	s := trafficFixture(t)
	managedTrafficSink.Store(s)
	t.Cleanup(func() { managedTrafficSink.Store(nil) })
	s.run()
	counter := &trafficCounter{}
	stop := startTrafficReporter(config{Role: "entry", RuleID: 71}, counter)
	counter.in.Add(41)
	counter.out.Add(43)
	counter.connections.Add(1)
	stop()
	if err := s.close(); err != nil {
		t.Fatal(err)
	}
	result := readManagedTraffic(t, s)
	if len(result.Samples) != 1 || result.Samples[0].BytesIn != "41" || result.Samples[0].BytesOut != "43" || result.Samples[0].Connections != "1" {
		t.Fatalf("final counters lost: %+v", result)
	}
}
