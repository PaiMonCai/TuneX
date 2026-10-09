package forwarder

import (
	"net"
	"reflect"
	"testing"
	"time"
)

func TestDatagramEgressSelectionIsStickyAndNeverClaimsRelayClientIP(t *testing.T) {
	a, stopA := udpEchoTarget(t, "A")
	defer stopA()
	b, stopB := udpEchoTarget(t, "B")
	defer stopB()
	targets := []Target{{Host: "127.0.0.1", Port: targetPortOf(t, a)}, {Host: "127.0.0.1", Port: targetPortOf(t, b)}}
	sel := &sourceRecordingSelector{targets: targets}
	port := freeUDPPort(t)
	e := startEgress(t, egressTestConfig(t, port, "127.0.0.1"), sel, DatagramEgressOptions{IdleTimeout: time.Minute})
	c := hopClient(t, port)
	check := func(id, gen uint32, want string) {
		t.Helper()
		header, payload, ok := sendHop(t, c, id, gen, []byte("?"), 2*time.Second)
		if !ok || header.MappingID != id || header.Generation != gen || string(payload) != want+":?" {
			t.Fatalf("mapping %d/%d reply = %+v %q, ok = %v", id, gen, header, payload, ok)
		}
	}
	check(1, 1, "A")
	check(1, 1, "A") // live mapping must not select again
	check(2, 1, "B")
	check(1, 2, "A")                         // a new generation is a new selection
	e.sweep(time.Now().Add(2 * time.Minute)) // deterministic idle expiry
	check(1, 2, "B")                         // expired mapping is recreated with current selection
	sources, calls, outcomes := sel.snapshot()
	if !reflect.DeepEqual(sources, []string{"", "", "", ""}) || calls != 0 {
		t.Fatalf("UDP selection sources = %v, legacy calls = %d; relay IP must not be supplied", sources, calls)
	}
	want := []selectionOutcome{{targets[0], true}, {targets[1], true}, {targets[0], true}, {targets[1], true}}
	if !reflect.DeepEqual(outcomes, want) {
		t.Fatalf("real UDP reply outcomes = %+v, want %+v", outcomes, want)
	}
	if stats := e.Stats(); stats.MappingsCreated != 4 || stats.MappingsExpired != 2 || stats.Mappings != 1 {
		t.Fatalf("mapping facts = %+v", stats)
	}
}

func TestDatagramEgressEmptyPoolCanFillWithoutRebinding(t *testing.T) {
	a, stop := udpEchoTarget(t, "A")
	defer stop()
	sel := &sourceRecordingSelector{}
	port := freeUDPPort(t)
	e := startEgress(t, egressTestConfig(t, port, "127.0.0.1"), sel, DatagramEgressOptions{})
	c := hopClient(t, port)
	if _, _, ok := sendHop(t, c, 1, 1, []byte("?"), 150*time.Millisecond); ok {
		t.Fatal("empty pool unexpectedly answered")
	}
	if stats := e.Stats(); stats.Mappings != 0 || stats.MappingsRejected != 1 {
		t.Fatalf("empty pool mapping facts = %+v", stats)
	}
	sel.mu.Lock()
	sel.targets = []Target{{Host: "127.0.0.1", Port: targetPortOf(t, a)}}
	sel.mu.Unlock()
	if _, payload, ok := sendHop(t, c, 1, 1, []byte("?"), 2*time.Second); !ok || string(payload) != "A:?" {
		t.Fatalf("filled pool reply = %q, ok = %v", payload, ok)
	}
}

func TestDatagramEgressReportsSuccessOnlyAfterActualTargetReply(t *testing.T) {
	target, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	selected := Target{Host: "127.0.0.1", Port: target.LocalAddr().(*net.UDPAddr).Port}
	sel := &sourceRecordingSelector{targets: []Target{selected}}
	port := freeUDPPort(t)
	startEgress(t, egressTestConfig(t, port, "127.0.0.1"), sel, DatagramEgressOptions{})
	c := hopClient(t, port)
	wire, _ := appendDatagramHop(nil, datagramHopHeader{MappingID: 1, Generation: 1}, []byte("?"))
	if _, err := c.Write(wire); err != nil {
		t.Fatal(err)
	}
	_ = target.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 128)
	_, from, err := target.ReadFromUDP(buf)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, outcomes := sel.snapshot(); len(outcomes) != 0 {
		t.Fatalf("UDP connect/write must not claim target reachability: %+v", outcomes)
	}
	if _, err := target.WriteToUDP([]byte("reply"), from); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.Read(buf); err != nil {
		t.Fatal(err)
	}
	if _, _, outcomes := sel.snapshot(); !reflect.DeepEqual(outcomes, []selectionOutcome{{selected, true}}) {
		t.Fatalf("real target reply did not resolve probe: %+v", outcomes)
	}
}

func TestDatagramEgressResolutionFailureReportsProbeFailure(t *testing.T) {
	// Invalid port fails synchronously without relying on DNS timing.
	selected := Target{Host: "127.0.0.1", Port: 65536}
	sel := &sourceRecordingSelector{targets: []Target{selected}}
	port := freeUDPPort(t)
	e := startEgress(t, egressTestConfig(t, port, "127.0.0.1"), sel, DatagramEgressOptions{})
	c := hopClient(t, port)
	if _, _, ok := sendHop(t, c, 1, 1, []byte("?"), 150*time.Millisecond); ok {
		t.Fatal("invalid target unexpectedly answered")
	}
	if _, _, outcomes := sel.snapshot(); !reflect.DeepEqual(outcomes, []selectionOutcome{{selected, false}}) {
		t.Fatalf("resolution failure outcomes = %+v", outcomes)
	}
	if stats := e.Stats(); stats.Mappings != 0 || stats.DropsSendError != 1 {
		t.Fatalf("resolution failure mapping facts = %+v", stats)
	}
}
