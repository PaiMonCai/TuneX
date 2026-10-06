package reporter

import (
	"context"
	"testing"
	"time"
)

// The panel extends the placement lease when a node reports that it
// still serves a tunnel, and hands the refreshed deadline BACK in the answer to
// that very report. If the agent ignores the answer, every tunnel stops one TTL
// after its last config — a self-inflicted outage on a healthy node. These tests
// pin the delivery, and pin the shapes that must NOT be treated as an answer:
// an older panel, an empty list, and an unreadable body.

type recordingLeaseSink struct {
	calls  [][]LeaseRenewal
	at     []time.Time
	onCall func()
}

func (s *recordingLeaseSink) ObserveLeases(leases []LeaseRenewal, at time.Time) {
	s.calls = append(s.calls, leases)
	s.at = append(s.at, at)
	if s.onCall != nil {
		s.onCall()
	}
}

// answerReporter builds a reporter whose state report is answered with body.
func answerReporter(body string, sink LeaseSink) *Reporter {
	return New(
		Config{PanelURL: "http://panel.invalid", NodeID: "n1", Credential: "cred"},
		WithLeases(sink),
		WithPostResponse(func(context.Context, string, []byte, map[string]string) ([]byte, error) {
			return []byte(body), nil
		}),
	)
}

func TestStateReportAnswerDeliversLeaseRenewals(t *testing.T) {
	sink := &recordingLeaseSink{}
	r := answerReporter(`{"data":{"ok":true,"node_id":1,"reported_at":"2026-10-04T05:00:00.000Z","leases":[
		{"tunnel_id":42,"epoch":3,"lease_expires_at":"2026-10-04T05:00:30.000Z","revision":7}
	]}}`, sink)

	if err := r.ReportOnce(context.Background()); err != nil {
		t.Fatalf("ReportOnce: %v", err)
	}
	if len(sink.calls) != 1 {
		t.Fatalf("sink calls = %d, want 1", len(sink.calls))
	}
	got := sink.calls[0]
	if len(got) != 1 {
		t.Fatalf("leases = %+v, want one", got)
	}
	if got[0].TunnelRef != 42 || got[0].Epoch != 3 || got[0].Revision != 7 {
		t.Errorf("lease = %+v, want ref 42 epoch 3 revision 7", got[0])
	}
	if got[0].ExpiresAt != "2026-10-04T05:00:30.000Z" {
		t.Errorf("expires_at = %q, carried verbatim expected", got[0].ExpiresAt)
	}
	if sink.at[0].IsZero() {
		t.Error("the sink must be told WHEN the panel said it")
	}
}

func TestAbsentLeaseKeyIsNotAStatement(t *testing.T) {
	sink := &recordingLeaseSink{}
	// An older panel: no `leases` key at all. Nothing is said, so nothing may be
	// tracked or extended.
	answerReporter(`{"data":{"ok":true,"node_id":1}}`, sink).ReportOnce(context.Background())
	if len(sink.calls) != 0 {
		t.Fatalf("an absent leases key reached the sink: %+v", sink.calls)
	}
}

func TestEmptyLeaseListIsAnEmptyStatement(t *testing.T) {
	sink := &recordingLeaseSink{}
	// `leases: []` means "the panel has no ownership information for you": it
	// extends nothing (and the sink must not invent deadlines from it).
	answerReporter(`{"data":{"ok":true,"leases":[]}}`, sink).ReportOnce(context.Background())
	if len(sink.calls) != 1 || len(sink.calls[0]) != 0 {
		t.Fatalf("empty lease list = %+v, want one empty statement", sink.calls)
	}
}

func TestUnreadableAnswerIsIgnoredWithoutFailingTheReport(t *testing.T) {
	sink := &recordingLeaseSink{}
	r := answerReporter(`not json at all`, sink)
	if err := r.ReportOnce(context.Background()); err != nil {
		t.Fatalf("a bad answer must not fail an accepted report: %v", err)
	}
	if len(sink.calls) != 0 {
		t.Fatalf("garbage reached the sink: %+v", sink.calls)
	}
}

func TestBadLeaseEntriesAreSkippedNotFatal(t *testing.T) {
	sink := &recordingLeaseSink{}
	// One good entry, one with a nonsense type, one with no deadline: a lease row
	// is evidence about ONE tunnel, and an unreadable row must not blind the node
	// to the other transitions in the same answer.
	answerReporter(`{"data":{"leases":[
		{"tunnel_id":42,"epoch":3,"lease_expires_at":"2026-10-04T05:00:30.000Z","revision":7},
		{"tunnel_id":"not-a-number","epoch":3,"lease_expires_at":"x"},
		{"tunnel_id":43,"epoch":4,"lease_expires_at":""}
	]}}`, sink).ReportOnce(context.Background())

	if len(sink.calls) != 1 || len(sink.calls[0]) != 1 || sink.calls[0][0].TunnelRef != 42 {
		t.Fatalf("leases = %+v, want only the readable entry", sink.calls)
	}
}

func TestLegacyHeartbeatDoesNotTouchTheLeaseSink(t *testing.T) {
	sink := &recordingLeaseSink{}
	// The legacy heartbeat's answer has no lease contract; only the state report
	// carries ownership facts.
	r := New(
		Config{PanelURL: "http://panel.invalid", NodeID: "n1"},
		WithLeases(sink),
		WithPostResponse(func(context.Context, string, []byte, map[string]string) ([]byte, error) {
			return []byte(`{"data":{"leases":[{"tunnel_id":1,"epoch":1,"lease_expires_at":"2026-10-04T05:00:30.000Z"}]}}`), nil
		}),
	)
	r.send(context.Background())
	if len(sink.calls) != 0 {
		t.Fatalf("the legacy heartbeat fed the lease sink: %+v", sink.calls)
	}
}

func TestErrorOnlyPostHookStillWorks(t *testing.T) {
	// Existing tests (and any embedder) use the error-only shape; it must keep
	// compiling and behaving, with the answer simply unavailable.
	called := 0
	r := New(
		Config{PanelURL: "http://panel.invalid", NodeID: "n1", Credential: "cred"},
		WithLeases(&recordingLeaseSink{}),
		WithPost(func(_ context.Context, _ string, _ []byte, _ map[string]string) error {
			called++
			return nil
		}),
	)
	if err := r.ReportOnce(context.Background()); err != nil {
		t.Fatalf("ReportOnce: %v", err)
	}
	if called != 1 {
		t.Fatalf("post calls = %d, want 1", called)
	}
}
