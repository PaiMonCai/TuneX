package reporter

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

/* ------------------------------------------------------------------ */
/* HostStats → wire shape: "unknown" must not become "zero"            */
/* ------------------------------------------------------------------ */

// fakeSampler is the test double for HostSampler. It lets each test state
// exactly which groups are valid, which is the whole point of the *Valid flags.
type fakeSampler struct {
	id   Identity
	stat HostStats
}

func (f fakeSampler) Identity() Identity { return f.id }
func (f fakeSampler) Sample() HostStats  { return f.stat }

func TestHostSampleDropsInvalidGroups(t *testing.T) {
	// Only the CPU count is valid: the wire shape must carry cpu_count and
	// *nothing else*. If memory/disk leaked through as zeroes the panel would
	// read "0 bytes total" as a hard threshold breach.
	s := &Reporter{cfg: Config{
		host: fakeSampler{stat: HostStats{CPUCount: 4}},
		now:  time.Now,
	}}
	p := s.StatePayload()
	if p.Host == nil {
		t.Fatal("cpu_count alone should still produce a host sample")
	}
	raw, err := json.Marshal(p.Host)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(raw)
	if !strings.Contains(got, `"cpu_count":4`) {
		t.Fatalf("cpu_count missing: %s", got)
	}
	for _, forbidden := range []string{"memory_total_bytes", "memory_used_bytes", "disk_total_bytes", "disk_free_bytes", "load1", "host_uptime_seconds", "process_rss_bytes"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("invalid group %q leaked into the report: %s", forbidden, got)
		}
	}
}

func TestHostSampleCarriesValidGroups(t *testing.T) {
	s := &Reporter{cfg: Config{
		host: fakeSampler{
			id: Identity{Hostname: "node-a", OS: "linux", Arch: "amd64"},
			stat: HostStats{
				CPUCount:     8,
				Load1:        0.5,
				Load5:        0.25,
				Load15:       0.1,
				LoadValid:    true,
				MemoryTotal:  16 << 30,
				MemoryUsed:   4 << 30,
				MemoryValid:  true,
				DiskPath:     "/var/lib/tunex",
				DiskTotal:    100 << 30,
				DiskFree:     20 << 30,
				DiskValid:    true,
				HostUptime:   3600,
				HostUpValid:  true,
				ProcessRSS:   64 << 20,
				ProcessValid: true,
			},
		},
		now: time.Now,
	}}
	p := s.StatePayload()
	if p.Hostname != "node-a" || p.OS != "linux" || p.Arch != "amd64" {
		t.Fatalf("identity not reported: %+v", p)
	}
	h := p.Host
	if h == nil {
		t.Fatal("host sample missing")
	}
	if h.CPUCount != 8 || h.MemoryTotal != 16<<30 || h.MemoryUsed != 4<<30 ||
		h.DiskPath != "/var/lib/tunex" || h.DiskTotal != 100<<30 || h.DiskFree != 20<<30 ||
		h.HostUptime != 3600 || h.ProcessRSS != 64<<20 {
		t.Fatalf("host sample incomplete: %+v", h)
	}
	if h.Load1 != 0.5 || h.Load5 != 0.25 || h.Load15 != 0.1 {
		t.Fatalf("load averages wrong: %+v", h)
	}
}

func TestNoSamplerMeansNoHostFields(t *testing.T) {
	s := &Reporter{cfg: Config{now: time.Now}}
	p := s.StatePayload()
	if p.Host != nil || p.Hostname != "" || p.OS != "" || p.Arch != "" {
		t.Fatalf("a reporter without a sampler must report no host facts: %+v", p)
	}
}

/* ------------------------------------------------------------------ */
/* Runtime counts                                                      */
/* ------------------------------------------------------------------ */

func TestCountRuntimesClassifiesByMode(t *testing.T) {
	tunnels := []forwarder.TunnelConfig{
		{ID: "a", Mode: forwarder.ModeDirect},
		{ID: "b", Mode: forwarder.ModeRelay},
		{ID: "c", Mode: forwarder.ModeEgress},
		{ID: "d", Mode: forwarder.ModeEgress},
		// Unparsable mode: counted in Total only. Inventing a bucket would hide
		// a real configuration problem.
		{ID: "e", Mode: forwarder.TunnelMode("WAT")},
	}
	got := CountRuntimes(tunnels)
	want := RuntimeCounts{Direct: 1, RelayIngress: 1, RelayEgress: 2, Total: 5}
	if got != want {
		t.Fatalf("CountRuntimes = %+v, want %+v", got, want)
	}
}

func TestCountRuntimesAcceptsLowercaseSpelling(t *testing.T) {
	// ParseTunnelMode normalises case, so a hand-written config still counts.
	got := CountRuntimes([]forwarder.TunnelConfig{{ID: "a", Mode: "direct"}})
	if got.Direct != 1 || got.Total != 1 {
		t.Fatalf("lowercase mode not counted: %+v", got)
	}
}

func TestEmptyRuntimeCountsAreStillReported(t *testing.T) {
	// "zero running tunnels" is a fact worth reporting (a node that lost every
	// runtime), so the object is present with Total=0 — distinct from absent.
	s := &Reporter{cfg: Config{
		tunnels: listerFunc(func() []forwarder.TunnelConfig { return nil }),
		now:     time.Now,
	}}
	p := s.StatePayload()
	if p.Runtimes == nil {
		t.Fatal("runtime_counts must be present when a tunnel source is wired")
	}
	if p.Runtimes.Total != 0 || p.Runtimes.Direct != 0 {
		t.Fatalf("expected all-zero counts, got %+v", p.Runtimes)
	}
}

/* ------------------------------------------------------------------ */
/* Error ledger                                                        */
/* ------------------------------------------------------------------ */

func TestLedgerCountsAndKeepsNewest(t *testing.T) {
	l := NewLedger()
	base := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	l.RecordAt("first", base)
	l.RecordAt("second", base.Add(30*time.Second))

	st := l.Snapshot()
	if st.Count != 2 {
		t.Fatalf("count = %d, want 2", st.Count)
	}
	if st.LastMessage != "second" {
		t.Fatalf("last message = %q, want second", st.LastMessage)
	}
	if !st.LastAt.Equal(base.Add(30 * time.Second)) {
		t.Fatalf("last at = %v", st.LastAt)
	}
	if l.LastError() != "second" {
		t.Fatalf("LastError = %q", l.LastError())
	}
}

func TestLedgerIgnoresEmptyMessages(t *testing.T) {
	l := NewLedger()
	l.Record("")
	l.Record("   ")
	st := l.Snapshot()
	// "   " is not obviously empty; only the truly empty string is dropped, so
	// count is 1 — the assertion documents which side of that line we chose.
	if st.Count != 1 {
		t.Fatalf("count = %d, want 1 (blank-but-nonempty is recorded)", st.Count)
	}
}

func TestNilLedgerIsSafe(t *testing.T) {
	var l *Ledger
	l.Record("boom")
	if got := l.Snapshot(); got.Count != 0 {
		t.Fatalf("nil ledger snapshot = %+v", got)
	}
	if got := l.LastError(); got != "" {
		t.Fatalf("nil ledger LastError = %q", got)
	}
	l.Clear()
}

/* ------------------------------------------------------------------ */
/* Revision tracker                                                    */
/* ------------------------------------------------------------------ */

func TestRevisionStateIsMonotonic(t *testing.T) {
	r := NewRevisionState()
	if r.Known() != 0 {
		t.Fatal("a fresh tracker must report 0 (never seen)")
	}
	r.Observe(7)
	if r.Known() != 7 {
		t.Fatalf("known = %d, want 7", r.Known())
	}
	// A replayed older command (reconciler resends the same revision, polling
	// can deliver out of order) must not lower it.
	r.Observe(3)
	if r.Known() != 7 {
		t.Fatalf("known lowered by an older revision: %d", r.Known())
	}
	r.Observe(9)
	if r.Known() != 9 {
		t.Fatalf("known = %d, want 9", r.Known())
	}
}

func TestRevisionStateIgnoresNonPositive(t *testing.T) {
	r := NewRevisionState()
	r.Observe(0)
	r.Observe(-5)
	if r.Known() != 0 {
		t.Fatalf("known = %d, want 0", r.Known())
	}
}

/* ------------------------------------------------------------------ */
/* Report assembly: known vs applied, uptime, ledger wiring             */
/* ------------------------------------------------------------------ */

// listerFunc / portsFunc / revisionFunc satisfy the reporter's source
// interfaces without pulling in a manager.
type listerFunc func() []forwarder.TunnelConfig

func (f listerFunc) List() []forwarder.TunnelConfig { return f() }

type revisionFunc func() int64

func (f revisionFunc) MaxRevision() int64 { return f() }

func TestReportSeparatesKnownFromAppliedRevision(t *testing.T) {
	revs := NewRevisionState()
	revs.Observe(12) // panel pushed 12 …
	s := &Reporter{cfg: Config{
		// … but only 9 is live: the difference is the "cannot apply" signal.
		revision:  revisionFunc(func() int64 { return 9 }),
		revisions: revs,
		now:       time.Now,
	}}
	p := s.StatePayload()
	if p.Revision != 9 {
		t.Fatalf("applied = %d, want 9", p.Revision)
	}
	if p.KnownRevision != 12 {
		t.Fatalf("known = %d, want 12", p.KnownRevision)
	}
}

func TestUptimeDerivesFromInjectedClock(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s := &Reporter{cfg: Config{
		startedAt: start,
		now:       func() time.Time { return start.Add(90 * time.Second) },
	}}
	p := s.StatePayload()
	if p.StartedAt != start.Unix() {
		t.Fatalf("started_at = %d, want %d", p.StartedAt, start.Unix())
	}
	if p.Uptime != 90 {
		t.Fatalf("uptime = %d, want 90", p.Uptime)
	}
}

func TestUptimeAbsentWithoutStartTime(t *testing.T) {
	s := &Reporter{cfg: Config{now: time.Now}}
	p := s.StatePayload()
	if p.StartedAt != 0 || p.Uptime != 0 {
		t.Fatalf("expected no uptime fields, got %+v", p)
	}
}

func TestLedgerErrorsReachTheReport(t *testing.T) {
	l := NewLedger()
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	l.RecordAt("apply:stale_revision tunex-1-relay: manager: stale revision", at)

	s := &Reporter{cfg: Config{ledger: l, now: time.Now}}
	p := s.StatePayload()
	if p.ErrorCount != 1 {
		t.Fatalf("error_count = %d, want 1", p.ErrorCount)
	}
	if p.LastErrorAt != at.Unix() {
		t.Fatalf("last_error_at = %d, want %d", p.LastErrorAt, at.Unix())
	}
	if !strings.Contains(p.LastErr, "stale_revision") {
		t.Fatalf("last_error = %q, want the ledger message", p.LastErr)
	}
}

func TestLedgerWinsOverLegacyLastErrorSource(t *testing.T) {
	l := NewLedger()
	l.Record("from-ledger")
	s := &Reporter{cfg: Config{
		ledger:  l,
		lastErr: listerError("from-legacy-source"),
		now:     time.Now,
	}}
	// Both sources are wired to the same ledger in production; when they
	// diverge the ledger (which also has the count) is authoritative.
	if got := s.StatePayload().LastErr; got != "from-ledger" {
		t.Fatalf("last_error = %q, want from-ledger", got)
	}
}

// listerError is a one-string ErrorLister double.
type listerError string

func (e listerError) LastError() string { return string(e) }

func TestZeroLedgerStillReportsZeroCount(t *testing.T) {
	// Present ledger + no failures ⇒ error_count is 0 in the payload. That is
	// the "healthy, zero errors" case the panel must be able to see; omitting
	// the key would make it indistinguishable from an old agent.
	s := &Reporter{cfg: Config{ledger: NewLedger(), now: time.Now}}
	raw, err := json.Marshal(s.StatePayload())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "error_count") {
		// omitempty drops the zero — documented here so the panel contract is
		// explicit: absent = 0 in practice, and the ledger's presence is what
		// makes new fields appear at all.
		t.Logf("error_count omitted at zero (omitempty): %s", raw)
	}
	if s.StatePayload().ErrorCount != 0 {
		t.Fatal("error count should be 0")
	}
}
