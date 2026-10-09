package linkrunner

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func persistEpochSnapshot(t *testing.T, m *Manager, id string, version int, rows ...trafficCounter) {
	t.Helper()
	if rows == nil {
		rows = []trafficCounter{}
	}
	body, err := json.Marshal(trafficSnapshot{version, id, rows})
	if err != nil {
		t.Fatal(err)
	}
	if err := atomicPrivateWrite(m.traffic.path(id, trafficSnapshotSuffix), body); err != nil {
		t.Fatal(err)
	}
}

func TestTrafficPreparedEpochCrashRecovery(t *testing.T) {
	for _, tc := range []struct {
		name                            string
		oldVersion                      int
		nextExists, nextNonzero, reject bool
	}{
		{"before_request", 2, false, false, false},
		{"before_seal", 2, true, false, false},
		{"after_seal", 3, true, false, false},
		{"after_record_before_agent_commit", 3, true, true, false},
		{"sealed_successor_missing", 3, false, false, true},
		{"unsealed_successor_nonzero", 2, true, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			m := enabledTrafficManager(t, dir)
			cfg := trafficIngress(t, 1, 101)
			oldID := strings.Repeat("a", 32)
			nextID := strings.Repeat("b", 32)
			persistTrafficFixture(t, m, cfg, oldID, trafficTotals(101, "10"))
			old, err := m.readTrafficManifestLocked(oldID)
			if err != nil {
				t.Fatal(err)
			}
			old.Version = 2
			if err := m.writeTrafficManifestLocked(old); err != nil {
				t.Fatal(err)
			}
			persistEpochSnapshot(t, m, oldID, tc.oldVersion, trafficTotals(101, "10"))
			next := old
			next.ProducerID = nextID
			next.PreparedFrom = oldID
			next.Last = []trafficCounter{}
			if err := m.writeTrafficManifestLocked(next); err != nil {
				t.Fatal(err)
			}
			if tc.nextExists {
				rows := []trafficCounter{}
				if tc.nextNonzero {
					rows = append(rows, trafficTotals(101, "7"))
				}
				persistEpochSnapshot(t, m, nextID, 2, rows...)
			}
			// Reopen like a killed Agent; every identity and preparation must come
			// from authenticated disk, not a surviving in-memory pending map.
			if err := m.Close(); err != nil {
				t.Fatal(err)
			}
			reopened := newTestManager(t, helperBinary(t), dir)
			err = reopened.EnableTraffic()
			if tc.reject {
				if !errors.Is(err, ErrTraffic) {
					t.Fatal("unexplained loss accepted", err)
				}
				assertTrafficFiles(t, m, oldID, true)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			samples, err := reopened.TrafficSamples()
			if err != nil {
				t.Fatal(err)
			}
			want := 1
			if tc.nextNonzero {
				want = 2
			}
			if len(samples) != want {
				t.Fatal("tail counters lost", samples)
			}
			if err := reopened.AckTraffic(samples); err != nil {
				t.Fatal(err)
			}
			assertTrafficFiles(t, reopened, oldID, false)
			assertTrafficFiles(t, reopened, nextID, false)
		})
	}
}

func TestTrafficEpoch500Rules30DaysExactACKAndReplay(t *testing.T) {
	m := enabledTrafficManager(t, t.TempDir())
	ids := make([]int64, 500)
	for i := range ids {
		ids[i] = int64(i + 1)
	}
	cfg := trafficIngress(t, 1, ids...)
	var total uint64
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	for day := 0; day < 30; day++ {
		id := fmt.Sprintf("%032x", day+1)
		rows := make([]trafficCounter, 500)
		for i := range rows {
			rows[i] = trafficCounter{ids[i], start.AddDate(0, 0, day).Format("2006-01-02"), "7", "11", "1"}
		}
		persistTrafficFixture(t, m, cfg, id, rows...)
		manifest, err := m.readTrafficManifestLocked(id)
		if err != nil {
			t.Fatal(err)
		}
		manifest.Version = 2
		if err := m.writeTrafficManifestLocked(manifest); err != nil {
			t.Fatal(err)
		}
		persistEpochSnapshot(t, m, id, 3, rows...)
		samples, err := m.TrafficSamples()
		if err != nil || len(samples) != 500 {
			t.Fatal("bounded epoch lost", len(samples), err)
		}
		for _, s := range samples {
			in, _ := trafficDecimal(s.BytesIn)
			out, _ := trafficDecimal(s.BytesOut)
			total += in + out
		}
		if err := m.AckTraffic(samples[:499]); err != nil {
			t.Fatal(err)
		}
		assertTrafficFiles(t, m, id, true)
		if err := m.AckTraffic(samples); err != nil {
			t.Fatal(err)
		}
		if err := m.AckTraffic(samples); err != nil {
			t.Fatal(err)
		}
		assertTrafficFiles(t, m, id, false)
		files, bytes, err := m.traffic.inventory()
		if err != nil || len(files) != 0 || bytes != 0 {
			t.Fatal("retired mapping/spool retained", len(files), bytes, err)
		}
	}
	if total != 270000 {
		t.Fatal("replay or reclaim changed daily facts", total)
	}
}

func TestTrafficStatusReceiptDoesNotSubstituteForReadiness(t *testing.T) {
	m := enabledTrafficManager(t, t.TempDir())
	cfg := trafficIngress(t, 1, 101)
	id := persistTrafficFixture(t, m, cfg, strings.Repeat("a", 32), trafficTotals(101, "10"))
	samples, err := m.TrafficSamples()
	if err != nil {
		t.Fatal(err)
	}
	m.traffic.started[cfg.ID] = time.Now().Add(-2 * time.Minute)
	status := m.Status()[0]
	if status.Ready || status.TrafficStatus.State != "backlogged" || status.TrafficStatus.ProducerCount != 1 {
		t.Fatal("backlog projection", status)
	}
	if err := m.AckTraffic(samples); err != nil {
		t.Fatal(err)
	}
	status = m.Status()[0]
	if status.Ready || status.TrafficStatus.State != "idle" {
		t.Fatal("storage ACK fabricated runtime readiness", status)
	}
	assertTrafficFiles(t, m, id, false)
	m.traffic.blocked = true
	if status = m.Status()[0]; status.TrafficStatus.State != "blocked" {
		t.Fatal("capacity failure hidden", status)
	}
}

func TestTrafficStatusEmptyProducerIsNotAnUploadBacklog(t *testing.T) {
	m := enabledTrafficManager(t, t.TempDir())
	cfg := trafficIngress(t, 1, 101)
	persistTrafficFixture(t, m, cfg, strings.Repeat("a", 32))
	if samples, err := m.TrafficSamples(); err != nil || len(samples) != 0 {
		t.Fatal("empty producer yielded samples", samples, err)
	}
	m.traffic.started[cfg.ID] = time.Now().Add(-2 * time.Minute)
	status := m.Status()[0].TrafficStatus
	if status.State != "collecting" || status.SampleCount != 0 || status.LastAckAt != nil {
		t.Fatal("silence fabricated an upload backlog or acknowledgement", status)
	}
}

func TestTrafficVersion2DowngradeAndUnexplainedMissingRowRejected(t *testing.T) {
	m := enabledTrafficManager(t, t.TempDir())
	cfg := trafficIngress(t, 1, 101)
	id := persistTrafficFixture(t, m, cfg, strings.Repeat("a", 32), trafficTotals(101, "10"))
	manifest, err := m.readTrafficManifestLocked(id)
	if err != nil {
		t.Fatal(err)
	}
	manifest.Version = 2
	if err := m.writeTrafficManifestLocked(manifest); err != nil {
		t.Fatal(err)
	}
	persistEpochSnapshot(t, m, id, 2, trafficTotals(101, "10"))
	if _, err := m.TrafficSamples(); err != nil {
		t.Fatal(err)
	}
	persistEpochSnapshot(t, m, id, 3)
	if _, err := m.TrafficSamples(); !errors.Is(err, ErrTraffic) {
		t.Fatal("sealed flag bypassed missing-row protection", err)
	}
	persistEpochSnapshot(t, m, id, 1, trafficTotals(101, "10"))
	if _, err := m.TrafficSamples(); !errors.Is(err, ErrTraffic) {
		t.Fatal("v2 downgraded to legacy", err)
	}
	if body, err := os.ReadFile(m.traffic.path(id, trafficManifestSuffix)); err != nil || strings.Contains(string(body), cfg.ConfigDigest) {
		t.Fatal("manifest exposed metadata", err)
	}
}
