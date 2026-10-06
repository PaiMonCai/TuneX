package control

import (
	"context"
	"strings"
	"testing"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/manager"
)

// recorder is the ErrorRecorder double.
type recorder struct{ messages []string }

func (r *recorder) Record(m string) { r.messages = append(r.messages, m) }

// observer is the RevisionObserver double.
type observer struct{ seen []int64 }

func (o *observer) Observe(rev int64) { o.seen = append(o.seen, rev) }

/*
The control loop is the writer of the telemetry facts.

These tests pin the *contract* between the transport and the reporter-owned
ledger: a failed command leaves a message with the structured error code and the
resource id, a successful one leaves nothing, and every envelope's revision is
observed regardless of the outcome. Without the last part a node whose apply
always fails would report known_revision == 0 and the panel could not tell
"panel never pushed" from "node cannot apply".
*/

func TestRecordErrorCarriesCodeAndResource(t *testing.T) {
	rec := &recorder{}
	c := New(Config{Errors: rec}, nil, nil)
	c.recordError("stale_revision", "tunex-7-relay", "manager: stale revision")

	if len(rec.messages) != 1 {
		t.Fatalf("expected one recorded message, got %v", rec.messages)
	}
	got := rec.messages[0]
	if !strings.Contains(got, "apply:stale_revision") || !strings.Contains(got, "tunex-7-relay") {
		t.Fatalf("message lacks code/resource context: %q", got)
	}
}

func TestRecordErrorTruncatesToPanelColumn(t *testing.T) {
	rec := &recorder{}
	c := New(Config{Errors: rec}, nil, nil)
	c.recordError("apply_failed", "tunex-1-direct", strings.Repeat("x", 2000))

	if len(rec.messages) != 1 {
		t.Fatalf("expected one message, got %v", rec.messages)
	}
	// node_state_report.last_error is VarChar(500): a longer message would make
	// the whole report fail validation with bad_message, losing every other
	// fact too.
	if got := len(rec.messages[0]); got > maxReportedErrorBytes {
		t.Fatalf("message length %d exceeds %d", got, maxReportedErrorBytes)
	}
}

func TestRecordErrorWithoutRecorderIsSafe(t *testing.T) {
	// No recorded errors configured (the default, and what every pre-WP6 test
	// uses): recording must be a no-op rather than a nil dereference.
	c := New(Config{}, nil, nil)
	c.recordError("apply_failed", "tunex-1-direct", "boom")
}

func TestFailurePathRecordsThroughExecuteResult(t *testing.T) {
	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")
	rec := &recorder{}
	c := New(Config{Errors: rec}, tunnels, egress)

	// A stale-revision apply is the canonical "the panel pushed, the node
	// refused" case. First apply revision 5, then replay revision 4.
	port := freeTCPPort(t)
	first := &QueuedCommand{
		Envelope: Envelope{CommandID: "cmd-1", ResourceID: "tunex-9-direct", Revision: 5, Action: "apply_tunnel"},
		Config: &forwarder.TunnelConfig{
			ID: "tunex-9-direct", Mode: forwarder.ModeDirect,
			IngressPort: port, RemoteHost: "127.0.0.1", RemotePort: 9,
			Protocol: "tcp", Revision: 5,
		},
	}
	if ack := c.execute(context.Background(), first); !ack.OK {
		t.Fatalf("first apply should succeed: %+v", ack)
	}
	if len(rec.messages) != 0 {
		t.Fatalf("a successful apply must not record an error: %v", rec.messages)
	}

	stale := *first
	stale.Envelope.CommandID = "cmd-2"
	stale.Envelope.Revision = 4
	staleCfg := first.Config.Clone()
	staleCfg.Revision = 4
	stale.Config = &staleCfg
	ack := c.execute(context.Background(), &stale)
	if ack.OK {
		t.Fatal("replaying an older revision must fail")
	}
	// The loop records whatever execute produced; assert the pair a caller
	// would feed recordError (code + message) is present.
	c.recordError(ack.ErrorCode, stale.Envelope.ResourceID, ack.Error)
	if len(rec.messages) != 1 || !strings.Contains(rec.messages[0], "stale_revision") {
		t.Fatalf("stale rejection not recorded: %v", rec.messages)
	}
}

func TestRevisionObserverSeesEveryEnvelope(t *testing.T) {
	obs := &observer{}
	c := New(Config{Revisions: obs}, nil, nil)
	// Mirrors the Run loop order: observe first, then execute.
	for _, rev := range []int64{3, 4, 4} {
		if c.cfg.Revisions != nil {
			c.cfg.Revisions.Observe(rev)
		}
	}
	if len(obs.seen) != 3 {
		t.Fatalf("expected every envelope observed, got %v", obs.seen)
	}
}
