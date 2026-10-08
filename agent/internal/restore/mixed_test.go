package restore

import (
	"encoding/json"
	"testing"

	"github.com/tunex/agent/internal/forwarder"
)

func TestMixedRelaySnapshotPreservesBothPeerAndUnrelatedRules(t *testing.T) {
	const body = `{"data":{"snapshot":{"version":"tunex-v3","tunnels":[
	 {"id":"tunex-42-egress","mode":"EGRESS","egress_port":22000,"protocol":"both","revision":7,
	  "hop_peer":"10.0.0.1","targets":[{"host":"10.0.0.2","port":80}]},
	 {"id":"tunex-43-direct","mode":"DIRECT","ingress_port":21000,"protocol":"tcp","revision":2,
	  "remote_host":"10.0.0.2","remote_port":80}
	]}}}`
	var env desiredEnvelope
	if err := json.Unmarshal([]byte(body), &env); err != nil {
		t.Fatal(err)
	}
	snap, err := decodeSnapshot(env.Data.Snapshot.Version, *env.Data.Snapshot.Tunnels)
	if err != nil {
		t.Fatal("one both peer field poisoned whole restore", err)
	}
	if len(snap.Tunnels) != 2 || snap.Tunnels[0].Protocol != forwarder.ProtocolBoth || snap.Tunnels[0].HopPeer != "10.0.0.1" {
		t.Fatal("canonical peer/protocol lost", snap)
	}
	encoded, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	var cached Snapshot
	if err := json.Unmarshal(encoded, &cached); err != nil {
		t.Fatal(err)
	}
	if err := cached.Validate(); err != nil || cached.Tunnels[0].HopPeer != "10.0.0.1" {
		t.Fatal("LKG round trip", err)
	}
}
