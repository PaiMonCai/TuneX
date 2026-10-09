package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func rotatingTrafficFixture(t *testing.T) *managedTraffic {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 32)
	s, err := newManagedTrafficVersion(filepath.Join(dir, id+".snapshot.json"), id, 2)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.enableRotation(filepath.Join(dir, "rotation.json")); err != nil {
		t.Fatal(err)
	}
	return s
}

func readEpochFixture(t *testing.T, path string) managedTrafficSnapshot {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot managedTrafficSnapshot
	if err := json.Unmarshal(body, &snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestManagedTrafficRotation500Rules30DaysWithChurn(t *testing.T) {
	s := rotatingTrafficFixture(t)
	var bytesIn, bytesOut, connections uint64
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, managedTrafficZone)
	for day := 0; day < 30; day++ {
		for rule := 1; rule <= 500; rule++ {
			// Half stay bound, half are replaced daily. Accounting rotation must
			// bound both rule/day history and retired business identities.
			id := rule
			if rule > 250 {
				id += day * 500
			}
			cfg := config{Role: "entry", RuleID: id, Protocol: "both"}
			if err := s.record(cfg, 7, 11, 1, start.AddDate(0, 0, day)); err != nil {
				t.Fatal(err)
			}
			if err := s.record(cfg, 13, 17, 0, start.AddDate(0, 0, day)); err != nil {
				t.Fatal(err)
			}
		}
		oldPath, oldID := s.path, s.producer
		if err := s.rotate(managedTrafficRotation{1, oldID, fmt.Sprintf("%032x", day+1)}); err != nil {
			t.Fatal(err)
		}
		sealed := readEpochFixture(t, oldPath)
		if sealed.Version != 3 || sealed.ProducerID != oldID || len(sealed.Samples) != 500 {
			t.Fatalf("final epoch incorrect: %+v", sealed)
		}
		for _, sample := range sealed.Samples {
			if sample.Date != start.AddDate(0, 0, day).Format("2006-01-02") {
				t.Fatal("date changed during seal")
			}
			in, _ := strconv.ParseUint(sample.BytesIn, 10, 64)
			out, _ := strconv.ParseUint(sample.BytesOut, 10, 64)
			n, _ := strconv.ParseUint(sample.Connections, 10, 64)
			bytesIn += in
			bytesOut += out
			connections += n
		}
		// This simulates exact persisted ACK; unacknowledged files were never
		// modified. Agent/HTTP tests exercise the actual ACK and ordered unlink.
		if err := os.Remove(oldPath); err != nil {
			t.Fatal(err)
		}
		if len(s.values) != 0 {
			t.Fatal("retired rule/day memory retained in live epoch")
		}
		files, _ := os.ReadDir(filepath.Dir(s.path))
		if len(files) != 1 {
			t.Fatal("spool grows after final ACK", len(files))
		}
	}
	if bytesIn != 300000 || bytesOut != 420000 || connections != 15000 {
		t.Fatal("lost or duplicated payload", bytesIn, bytesOut, connections)
	}
}

func TestManagedTrafficRotationConcurrentDeltasAndDuplicateRequest(t *testing.T) {
	s := rotatingTrafficFixture(t)
	now := time.Now()
	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 1000; i++ {
				if err := s.record(config{Role: "entry", RuleID: 1}, 3, 5, 1, now); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	var request managedTrafficRotation
	for i := 1; i <= 10; i++ {
		request = managedTrafficRotation{1, s.producer, fmt.Sprintf("%032x", i)}
		if err := s.rotate(request); err != nil {
			t.Fatal(err)
		}
	}
	wg.Wait()
	if err := s.flush(); err != nil {
		t.Fatal(err)
	}
	before := readManagedTraffic(t, s)
	if err := s.rotate(request); err != nil {
		t.Fatal(err)
	}
	after := readManagedTraffic(t, s)
	rawBefore, _ := json.Marshal(before)
	rawAfter, _ := json.Marshal(after)
	if string(rawBefore) != string(rawAfter) {
		t.Fatal("duplicate control reset current counters")
	}
	var in, out, n uint64
	files, _ := os.ReadDir(filepath.Dir(s.path))
	for _, file := range files {
		if !strings.HasSuffix(file.Name(), ".snapshot.json") {
			continue
		}
		snap := readEpochFixture(t, filepath.Join(filepath.Dir(s.path), file.Name()))
		for _, row := range snap.Samples {
			a, _ := strconv.ParseUint(row.BytesIn, 10, 64)
			b, _ := strconv.ParseUint(row.BytesOut, 10, 64)
			c, _ := strconv.ParseUint(row.Connections, 10, 64)
			in += a
			out += b
			n += c
		}
	}
	if in != 24000 || out != 40000 || n != 8000 {
		t.Fatal("rotation lost concurrent deltas", in, out, n)
	}
}

func TestManagedTrafficRotationRejectsOverwriteAndMalformedControl(t *testing.T) {
	s := rotatingTrafficFixture(t)
	if err := s.record(config{Role: "entry", RuleID: 1}, 7, 9, 1, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := s.flush(); err != nil {
		t.Fatal(err)
	}
	next := strings.Repeat("b", 32)
	occupied := filepath.Join(filepath.Dir(s.path), next+".snapshot.json")
	if err := os.WriteFile(occupied, []byte("must survive"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.rotate(managedTrafficRotation{1, s.producer, next}); err == nil {
		t.Fatal("existing epoch overwritten")
	}
	if current := readManagedTraffic(t, s); current.Version != 2 || current.Samples[0].BytesIn != "7" {
		t.Fatal("failed rotation sealed or erased old totals")
	}
	body, _ := os.ReadFile(occupied)
	if string(body) != "must survive" {
		t.Fatal("occupied destination changed")
	}
	for _, body := range []string{
		`{"version":1,"version":1,"producer_id":"` + s.producer + `","next_producer_id":"` + next + `"}`,
		`{"version":1,"producer_id":"` + s.producer + `","next_producer_id":"../../escape"}`,
		`{"version":1,"producer_id":"` + s.producer + `","next_producer_id":"` + next + `","unknown":true}`,
		`{"version":1,"producer_id":"` + s.producer + `","next_producer_id":"` + next + `"} {}`,
	} {
		if err := os.WriteFile(s.rotationPath, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readManagedRotation(s.rotationPath); err == nil {
			t.Fatal("malformed rotation accepted")
		}
	}
}

func TestManagedTrafficRotationRejectsSymlinkAndPublicControl(t *testing.T) {
	s := rotatingTrafficFixture(t)
	body, err := json.Marshal(managedTrafficRotation{1, s.producer, strings.Repeat("b", 32)})
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(filepath.Dir(s.rotationPath), "private-control.json")
	if err := os.WriteFile(target, body, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readManagedRotation(target); err != nil {
		t.Fatal("valid private control rejected", err)
	}
	if err := os.Symlink(target, s.rotationPath); err != nil {
		if runtime.GOOS != "windows" {
			t.Fatal(err)
		}
		t.Log("Windows symlink creation requires service-account privilege; Linux CI covers this case")
	} else {
		if _, err := readManagedRotation(s.rotationPath); err == nil {
			t.Fatal("symlink control followed")
		}
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(target, 0644); err != nil {
			t.Fatal(err)
		}
		if _, err := readManagedRotation(target); err == nil {
			t.Fatal("public-readable control accepted")
		}
	}
}
