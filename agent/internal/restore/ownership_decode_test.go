package restore

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/manager"
)

// The snapshot decoder must know the ownership facts.
//
// A fact travels on two delivery paths and
// only one of them learns about it (protocol, tls cert paths, target health, now
// ownership). The symptom here is the worst of the four: an agent that rebuilds
// its runtime from a snapshot WITHOUT the epoch resets its "highest seen" to
// nothing, and a demoted node that restarts during a partition would happily
// serve again — exactly the split brain §8 exists to prevent. The deadline
// matters too: a restored tunnel with no lease clock keeps serving past the
// authorisation the panel granted.

func TestSnapshotDecoderKnowsTheOwnershipFacts(t *testing.T) {
	// Unmarshal through the real wire decoder (desiredEnvelope → tunnelPayload →
	// decodeSnapshot), so the JSON tags are exercised and not just the mapping.
	const body = `{"data":{"snapshot":{"version":"tunex-v3","tunnels":[
		{"id":"tunex-42-relay","mode":"RELAY","ingress_port":19000,"next_hop":"10.0.0.1:443",
		 "protocol":"tcp","lb_strategy":"ROUND_ROBIN","revision":7,
		 "ownership_epoch":5,"lease_expires_at":"2026-10-04T05:00:30.000Z"}
	]}}}`

	var env desiredEnvelope
	if err := json.Unmarshal([]byte(body), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if env.Data == nil || env.Data.Snapshot == nil || env.Data.Snapshot.Tunnels == nil {
		t.Fatal("envelope shape not decoded")
	}
	snap, err := decodeSnapshot(env.Data.Snapshot.Version, *env.Data.Snapshot.Tunnels)
	if err != nil {
		t.Fatalf("decodeSnapshot: %v", err)
	}
	if len(snap.Tunnels) != 1 {
		t.Fatalf("tunnels = %d", len(snap.Tunnels))
	}
	cfg := snap.Tunnels[0]
	if cfg.OwnershipEpoch != 5 {
		t.Errorf("ownership_epoch = %d, want 5 (a dropped epoch resets the fence)", cfg.OwnershipEpoch)
	}
	if cfg.LeaseExpiresAt != "2026-10-04T05:00:30.000Z" {
		t.Errorf("lease_expires_at = %q, want it carried verbatim", cfg.LeaseExpiresAt)
	}
}

func TestSnapshotDecoderWithoutOwnershipFactsStaysUntracked(t *testing.T) {
	// An older panel: the fields are simply absent, and nothing may be invented
	// (epoch 0 + no deadline == "no ownership information", which is what makes
	// the Agent behave as an unfenced assignment).
	const body = `{"data":{"snapshot":{"version":"tunex-v3","tunnels":[
		{"id":"tunex-7-direct","mode":"DIRECT","ingress_port":19001,"remote_host":"10.0.0.2","remote_port":80,
		 "protocol":"tcp","revision":1}
	]}}}`
	var env desiredEnvelope
	if err := json.Unmarshal([]byte(body), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	snap, err := decodeSnapshot(env.Data.Snapshot.Version, *env.Data.Snapshot.Tunnels)
	if err != nil {
		t.Fatalf("decodeSnapshot: %v", err)
	}
	if cfg := snap.Tunnels[0]; cfg.OwnershipEpoch != 0 || cfg.LeaseExpiresAt != "" {
		t.Fatalf("ownership facts were invented: %+v", cfg)
	}
}

func TestOwnershipFactsSurviveTheCacheRoundTrip(t *testing.T) {
	// The last-known-good cache is a durable carrier of the CONFIG facts: a node
	// that restarts during a panel outage must still know which generation it was
	// authorised at, and until when.
	cache := LKG{Path: filepath.Join(t.TempDir(), "desired-lkg.json")}
	snap := &Snapshot{Version: "tunex-v3", Tunnels: []forwarder.TunnelConfig{{
		ID: "tunex-42-relay", Mode: forwarder.ModeRelay, IngressPort: 19000,
		NextHop: "10.0.0.1:443", Protocol: forwarder.ProtocolTCP, Revision: 7,
		OwnershipEpoch: 5, LeaseExpiresAt: "2026-10-04T05:00:30.000Z",
	}}}
	if err := cache.Save("agent-1", snap); err != nil {
		t.Fatalf("save: %v", err)
	}
	loaded, err := cache.Load("agent-1")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	cfg := loaded.Tunnels[0]
	if cfg.OwnershipEpoch != 5 || cfg.LeaseExpiresAt != "2026-10-04T05:00:30.000Z" {
		t.Fatalf("cached ownership facts were lost: %+v", cfg)
	}
}

func TestDeadlineParsingAcceptsWhatThePanelSends(t *testing.T) {
	// The panel sends Date.toISOString(); the agent must read it (and refuse to
	// guess anything else, which the ownership guard enforces).
	for _, raw := range []string{
		"2026-10-04T05:00:30.000Z",
		"2026-10-04T05:00:30Z",
		"2026-10-04T13:00:30+08:00",
	} {
		if _, err := time.Parse(time.RFC3339Nano, raw); err != nil {
			t.Errorf("%q is not RFC 3339: %v", raw, err)
		}
	}
}

// refusingGuard stands in for ownership.Guard: the restore package only needs to
// prove that the second panel-driven activation path passes through the gate.
type refusingGuard struct{ err error }

func (g refusingGuard) Admit(forwarder.TunnelConfig) error { return g.err }

func TestRestorePathIsOwnershipGated(t *testing.T) {
	// Regression rule: a fact with two delivery paths where only
	// one of them is checked is a fact that is wrong half the time. The restore
	// path applies configs straight into the manager, so the gate has to live
	// where BOTH paths pass — this test pins that it does.
	em := manager.NewEgressManager()
	tm := manager.NewTunnelManager(em, "127.0.0.1")
	tm.SetOwnershipGuard(refusingGuard{err: errors.New("ownership: stale_epoch: refused")})

	snap := &Snapshot{Version: "tunex-v3", Tunnels: []forwarder.TunnelConfig{{
		ID: "tunex-42-relay", Mode: forwarder.ModeRelay, IngressPort: freePort(t),
		NextHop: "10.0.0.1:443", Protocol: forwarder.ProtocolTCP, Revision: 7,
		OwnershipEpoch: 5,
	}}}
	failed, err := Apply(context.Background(), tm, em, snap)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if len(failed) != 1 || failed[0] != "tunex-42-relay" {
		t.Fatalf("failed = %v, want the refused tunnel", failed)
	}
	if tm.Len() != 0 {
		t.Fatalf("a refused restore bound %d tunnel(s)", tm.Len())
	}
}
