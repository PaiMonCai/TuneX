package manager

import (
	"net"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

// ---------------------------------------------------------------------------
// UDP DIRECT through the single TunnelManager.
//
// These tests exist for the same reason single_manager_guard_test.go does: the
// datagram runtime must be owned by the existing registry, revision ledger, port
// guard and shutdown path. A UDP tunnel that needed its own manager would show up
// here as a second registry, and a UDP tunnel whose in-flight work is invisible
// to the shutdown report would show up as "0 forced, 0 remaining".
// ---------------------------------------------------------------------------

// freeUDPPort reserves a UDP port by binding and releasing it.
func freeUDPPort(t *testing.T) int {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Skipf("reserve udp port: %v", err)
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).Port
}

// udpLabeledTarget is the datagram twin of labeledServer: every datagram is
// answered with "srv:" + label, so a reply proves WHICH target served it.
func udpLabeledTarget(t *testing.T, label string) (port int, served func() int, stop func()) {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatalf("udp target listen: %v", err)
	}
	// atomic because the target's reader goroutine and the test goroutine both
	// touch it (the -race detector is right to care).
	var count atomic.Int64
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		buf := make([]byte, 65535)
		for {
			_, from, err := conn.ReadFromUDP(buf)
			if err != nil {
				return
			}
			count.Add(1)
			if _, err := conn.WriteToUDP([]byte("srv:"+label), from); err != nil {
				return
			}
		}
	}()
	return conn.LocalAddr().(*net.UDPAddr).Port,
		func() int { return int(count.Load()) },
		func() {
			_ = conn.Close()
			<-closed
		}
}

func udpClient(t *testing.T, addr string) *net.UDPConn {
	t.Helper()
	raddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		t.Fatalf("resolve %s: %v", addr, err)
	}
	conn, err := net.DialUDP("udp", nil, raddr)
	if err != nil {
		t.Fatalf("dial udp %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func udpRoundTrip(t *testing.T, client *net.UDPConn, payload string) string {
	t.Helper()
	if _, err := client.Write([]byte(payload)); err != nil {
		t.Fatalf("send: %v", err)
	}
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 2048)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatalf("read reply: %v", err)
	}
	return string(buf[:n])
}

func udpExpectNoReply(t *testing.T, client *net.UDPConn) {
	t.Helper()
	_ = client.SetReadDeadline(time.Now().Add(250 * time.Millisecond))
	buf := make([]byte, 2048)
	if n, err := client.Read(buf); err == nil {
		t.Fatalf("expected no reply, got %q", buf[:n])
	}
}

func udpDirectCfg(id string, port, targetPort int, revision int64) forwarder.TunnelConfig {
	return forwarder.TunnelConfig{
		ID:          id,
		Mode:        forwarder.ModeDirect,
		IngressPort: port,
		RemoteHost:  "127.0.0.1",
		RemotePort:  targetPort,
		Protocol:    forwarder.ProtocolUDP,
		Revision:    revision,
	}
}

func udpPoll(t *testing.T, timeout time.Duration, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out after %s waiting for %s", timeout, what)
}

// A udp DIRECT tunnel runs through Apply/ReplaceListener like any other tunnel,
// and a target change retargets it IN PLACE: the listener is not rebuilt (the
// live mapping proves it) and existing mappings keep the target they were
// created with while new ones take the new target.
func TestApplyUDPDirectForwardsAndRetargetsWithoutRebuildingTheListener(t *testing.T) {
	aPort, aServed, stopA := udpLabeledTarget(t, "a")
	defer stopA()
	bPort, _, stopB := udpLabeledTarget(t, "b")
	defer stopB()

	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	defer tm.StopAll()

	port := freeUDPPort(t)
	id := "tunex-1-direct"
	cfg := udpDirectCfg(id, port, aPort, 1)
	if _, err := tm.Apply(cfg); err != nil {
		t.Fatalf("Apply(udp DIRECT): %v", err)
	}
	if !tm.UsedPorts()[port] {
		t.Fatalf("the udp listener did not reserve port %d", port)
	}

	client := udpClient(t, addrFor(port))
	if got := udpRoundTrip(t, client, "one"); got != "srv:a" {
		t.Fatalf("reply = %q, want srv:a", got)
	}

	// The registry answers the datagram question with the datagram facts.
	// The forward-direction counter is written AFTER the datagram reaches the
	// target (counting is a write-side, delivered-only fact), and the target's
	// reply can overtake that bookkeeping — so the reply being back is not yet
	// proof the counter has landed. Poll rather than assume an order that does
	// not exist.
	udpPoll(t, 3*time.Second, func() bool {
		stats, ok := tm.DatagramStats(id)
		return ok && stats.PacketsIn == 1 && stats.PacketsOut == 1
	}, "the delivered counters of both directions")
	stats, ok := tm.DatagramStats(id)
	if !ok {
		t.Fatal("DatagramStats must report this tunnel as a datagram one")
	}
	if stats.Mappings != 1 {
		t.Fatalf("mappings = %d, want 1", stats.Mappings)
	}
	if live, ok := tm.LiveMappings(id); !ok || live != 1 {
		t.Fatalf("LiveMappings = %d/%v, want 1/true", live, ok)
	}
	// The connection question must not be answered with a silent 0 for a tunnel
	// that IS holding work (§4.4.1).
	if live := tm.LiveConns(id); live != 1 {
		t.Fatalf("LiveConns = %d, want the mapping count (1) rather than 0", live)
	}
	// And the delivered bytes are visible through the legacy byte accessor too.
	if bytes := tm.Stats(id); bytes != int64(len("one")+len("srv:a")) {
		t.Fatalf("Stats = %d, want the delivered bytes of both directions", bytes)
	}
	diag := tm.DiagnosticsByTunnel()[id]
	if diag.Protocol != "udp" || diag.Mappings != 1 || diag.IdleTimeoutSeconds == 0 {
		t.Fatalf("diag = %+v, want the frozen udp facts", diag)
	}
	if diag.PacketsIn != 1 {
		t.Fatalf("diag packets_in = %d, want 1", diag.PacketsIn)
	}

	// Hot target change: same port, new revision, new target.
	next := cfg.Clone()
	next.RemotePort = bPort
	next.Revision = 2
	if _, err := tm.ReplaceListener(next); err != nil {
		t.Fatalf("ReplaceListener(retarget): %v", err)
	}
	if !tm.UsedPorts()[port] {
		t.Fatal("a retarget must not move the port")
	}
	if live, _ := tm.LiveMappings(id); live != 1 {
		t.Fatalf("mappings after retarget = %d, want the existing one kept (a rebuild would have dropped it)", live)
	}
	if got := udpRoundTrip(t, client, "two"); got != "srv:a" {
		t.Fatalf("existing mapping reply after retarget = %q, want srv:a", got)
	}
	fresh := udpClient(t, addrFor(port))
	if got := udpRoundTrip(t, fresh, "three"); got != "srv:b" {
		t.Fatalf("new mapping reply after retarget = %q, want srv:b", got)
	}
	if aServed() != 2 {
		t.Fatalf("old target served %d datagrams, want 2 (the mapping kept it)", aServed())
	}
	// The registry now describes the config the node actually runs.
	if got, _ := tm.Get(id); got.RemotePort != bPort || got.Revision != 2 {
		t.Fatalf("registered config = %+v, want the new target at revision 2", got)
	}
}

// udp may not be relayed or egressed in this build, and the refusal must happen
// before anything is reserved: a config that validates and then fails at a
// runtime that does not exist is worse than a refusal.
func TestUDPRefusedOnRelayAndEgressLeavesNoPortReserved(t *testing.T) {
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	defer tm.StopAll()

	// Both datagram relay roles are supported, so "refused because the role is closed" is
	// no longer the trigger. What is still refused is a config that cannot work: the
	// hop has no handshake to imply its fields, so a missing one is a hard error.
	// The invariant this test guards is unchanged — a REFUSED apply must leave no
	// tunnel registered and no port reserved.
	relayBare := forwarder.TunnelConfig{
		ID: "tunex-9-relay-bare", Mode: forwarder.ModeRelay, IngressPort: freeUDPPort(t),
		Protocol: forwarder.ProtocolUDP, Revision: 1,
	}
	if _, err := tm.Apply(relayBare); err == nil {
		t.Fatal("udp RELAY without next_hop must be refused: there is nowhere to send client datagrams")
	}

	egressBare := forwarder.TunnelConfig{
		ID: "tunex-9-egress-bare", Mode: forwarder.ModeEgress, EgressPort: freeUDPPort(t),
		Targets:  []forwarder.Target{{Host: "127.0.0.1", Port: 3040}},
		Protocol: forwarder.ProtocolUDP, Revision: 1,
	}
	if _, err := tm.Apply(egressBare); err == nil {
		t.Fatal("udp EGRESS without hop_peer must be refused: the exit cannot attest a peer it was not told about")
	}

	if tm.Len() != 0 {
		t.Fatalf("a refused apply must not register a tunnel, got %d", tm.Len())
	}
	if ports := tm.UsedPorts(); len(ports) != 0 {
		t.Fatalf("a refused apply must not reserve a port, got %v", ports)
	}

	// Positive direction: supplying the field the hop
	// needs makes the same role apply — and then it DOES hold its port.
	relayOK := relayBare.Clone()
	relayOK.NextHop = "127.0.0.1:3040"
	if _, err := tm.Apply(relayOK); err != nil {
		t.Fatalf("udp RELAY with next_hop must apply: %v", err)
	}
	if tm.Len() != 1 {
		t.Fatalf("an accepted apply must register exactly one tunnel, got %d", tm.Len())
	}
	if ports := tm.UsedPorts(); len(ports) != 1 {
		t.Fatalf("an accepted datagram relay must reserve its port, got %v", ports)
	}
}

// Independent TCP and UDP rules may share a numeric port. The reported guard
// must preserve both socket protocols while its flat view reports their union.
func TestTCPAndUDPShareAPortNumber(t *testing.T) {
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	defer tm.StopAll()

	port := freePort(t)
	tcpCfg := forwarder.TunnelConfig{
		ID: "tunex-tcp-direct", Mode: forwarder.ModeDirect, IngressPort: port,
		RemoteHost: "127.0.0.1", RemotePort: 9000, Protocol: forwarder.ProtocolTCP, Revision: 1,
	}
	if _, err := tm.Apply(tcpCfg); err != nil {
		t.Fatalf("Apply(tcp DIRECT): %v", err)
	}

	udpCfg := udpDirectCfg("tunex-udp-direct", port, 3040, 1)
	if _, err := tm.Apply(udpCfg); err != nil {
		t.Fatalf("a UDP rule must share a TCP rule's numeric port: %v", err)
	}

	byProto := tm.UsedPortsByProtocol()
	if !byProto["tcp"][port] {
		t.Fatalf("the tcp namespace must own %d, got %v", port, byProto)
	}
	if !byProto["udp"][port] {
		t.Fatalf("the udp namespace must also own %d, got %v", port, byProto)
	}
	if !tm.UsedPorts()[port] {
		t.Fatal("the flat view must still report the number as bound")
	}
}

// A datagram tunnel's in-flight work must reach the closing report. Reporting
// "0 remaining, 0 forced" while a UDP tunnel was relaying is the failure mode
// §4.4.2 names.
func TestShutdownAllReportsDroppedMappings(t *testing.T) {
	targetPort, _, stopTarget := udpLabeledTarget(t, "shut")
	defer stopTarget()

	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	port := freeUDPPort(t)
	if _, err := tm.Apply(udpDirectCfg("tunex-shut-direct", port, targetPort, 1)); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	client := udpClient(t, addrFor(port))
	if got := udpRoundTrip(t, client, "one"); got != "srv:shut" {
		t.Fatalf("reply = %q", got)
	}

	report := tm.ShutdownAll(time.Second)
	if report.Listeners != 1 {
		t.Fatalf("listeners = %d, want 1 (phase 1 closed the datagram listener's admission)", report.Listeners)
	}
	if report.ForcedMappings != 1 {
		t.Fatalf("forced mappings = %d, want 1 — a dropped mapping must be reported, not hidden", report.ForcedMappings)
	}
	if report.RemainingConns != 0 {
		t.Fatalf("remaining conns = %d, want 0", report.RemainingConns)
	}
	if tm.Len() != 0 {
		t.Fatalf("the shutdown must empty the registry, got %d", tm.Len())
	}
}

// A protocol change on the SAME port changes the listener's transport, so it can
// never be absorbed as a target swap: the node must end up with the socket kind
// the config names, not a UDP socket described as TCP (or the reverse).
func TestUDPProtocolChangeOnTheSamePortRebuildsTheListener(t *testing.T) {
	tcpTarget, stopTCP := echoServer(t)
	defer stopTCP()
	tcpPort, _, stopUDP := udpLabeledTarget(t, "u")
	defer stopUDP()

	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	defer tm.StopAll()

	_, tcpTargetPort, err := net.SplitHostPort(tcpTarget)
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	port := freePort(t)
	tcpCfg := forwarder.TunnelConfig{
		ID: "tunex-switch-direct", Mode: forwarder.ModeDirect, IngressPort: port,
		RemoteHost: "127.0.0.1", RemotePort: atoi(t, tcpTargetPort),
		Protocol: forwarder.ProtocolTCP, Revision: 1,
	}
	if _, err := tm.Apply(tcpCfg); err != nil {
		t.Fatalf("Apply(tcp): %v", err)
	}
	if conn, err := net.DialTimeout("tcp", addrFor(port), time.Second); err != nil {
		t.Fatalf("the tcp listener is not serving: %v", err)
	} else {
		_ = conn.Close()
	}

	// Same id, same port, same port number — only the protocol changes.
	next := udpDirectCfg("tunex-switch-direct", port, tcpPort, 2)
	if _, err := tm.ReplaceListener(next); err != nil {
		t.Fatalf("ReplaceListener(protocol change): %v", err)
	}

	client := udpClient(t, addrFor(port))
	if got := udpRoundTrip(t, client, "switched"); got != "srv:u" {
		t.Fatalf("after the switch the listener must speak udp, got %q", got)
	}
	if conn, err := net.DialTimeout("tcp", addrFor(port), 300*time.Millisecond); err == nil {
		_ = conn.Close()
		t.Fatal("a TCP listener is still bound on the port after switching to udp")
	}
	byProto := tm.UsedPortsByProtocol()
	if !byProto["udp"][port] || byProto["tcp"][port] {
		t.Fatalf("after the switch the guard must say udp only, got %v", byProto)
	}
}

func atoi(t *testing.T, s string) int {
	t.Helper()
	n, err := strconv.Atoi(s)
	if err != nil {
		t.Fatalf("atoi %q: %v", s, err)
	}
	return n
}
