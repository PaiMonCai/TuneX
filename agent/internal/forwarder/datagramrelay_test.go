package forwarder

import (
	"strings"
	"bytes"
	"net"
	"strconv"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// V5.1b WP5-B2 — datagram RELAY ingress (the client-facing half of the hop).
//
// Contract: docs/v5-1b-datagram-contract-draft.md §9.1 (frozen 2026-10-05).
//
// The peer here is a FAKE egress: a bare UDP socket that parses hop packets and
// answers only when the test tells it to. That is deliberate — the properties that
// matter on this half are about what the ingress puts ON the wire and what it does
// with what comes back (mapping isolation, the generation check, the ceiling), and
// those are only observable from the other end of a real socket.
// ---------------------------------------------------------------------------

// fakeEgress is a stand-in for the exit: it reads hop packets and can answer them.
type fakeEgress struct {
	conn     *net.UDPConn
	received chan receivedHop
}

type receivedHop struct {
	header  datagramHopHeader
	payload []byte
	from    *net.UDPAddr
}

func startFakeEgress(t *testing.T) *fakeEgress {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatalf("fake egress listen: %v", err)
	}
	f := &fakeEgress{conn: conn, received: make(chan receivedHop, 16)}
	go func() {
		buf := make([]byte, datagramHopMTU)
		for {
			n, from, err := conn.ReadFromUDP(buf)
			if err != nil {
				return
			}
			header, payload, err := parseDatagramHop(buf[:n])
			if err != nil {
				continue // not a hop packet; the tests only assert on real ones
			}
			cp := make([]byte, len(payload))
			copy(cp, payload)
			select {
			case f.received <- receivedHop{header: header, payload: cp, from: from}:
			default:
			}
		}
	}()
	t.Cleanup(func() { _ = conn.Close() })
	return f
}

func (f *fakeEgress) addr() string { return f.conn.LocalAddr().String() }

// next returns the next hop packet, or fails the test.
func (f *fakeEgress) next(t *testing.T, wait time.Duration) receivedHop {
	t.Helper()
	select {
	case got := <-f.received:
		return got
	case <-time.After(wait):
		t.Fatal("the ingress sent no hop packet")
		return receivedHop{}
	}
}

// reply answers a hop packet with the given generation (the header it was asked to
// echo unless the test overrides it).
func (f *fakeEgress) reply(t *testing.T, to *net.UDPAddr, id, generation uint32, payload []byte) {
	t.Helper()
	wire, err := appendDatagramHop(nil, datagramHopHeader{MappingID: id, Generation: generation}, payload)
	if err != nil {
		t.Fatalf("appendDatagramHop: %v", err)
	}
	if _, err := f.conn.WriteToUDP(wire, to); err != nil {
		t.Fatalf("fake egress reply: %v", err)
	}
}

func relayTestConfig(t *testing.T, ingressPort int, nextHop string) TunnelConfig {
	t.Helper()
	return TunnelConfig{
		ID:          "relay-ingress",
		Mode:        ModeRelay,
		Protocol:    ProtocolUDP,
		IngressPort: ingressPort,
		NextHop:     nextHop,
	}
}

func startRelay(t *testing.T, cfg TunnelConfig, opts DatagramRelayOptions) *DatagramRelay {
	t.Helper()
	r, err := NewDatagramRelay(cfg, opts)
	if err != nil {
		t.Fatalf("NewDatagramRelay: %v", err)
	}
	if err := r.Start(); err != nil {
		t.Fatalf("relay Start: %v", err)
	}
	t.Cleanup(func() { _ = r.Stop() })
	return r
}

func TestDatagramRelayCarriesClientDatagramToHopAndBack(t *testing.T) {
	egress := startFakeEgress(t)
	port := freeUDPPort(t)
	r := startRelay(t, relayTestConfig(t, port, egress.addr()), DatagramRelayOptions{})
	client := datagramClient(t, net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))

	if _, err := client.Write([]byte("hello")); err != nil {
		t.Fatalf("client write: %v", err)
	}
	got := egress.next(t, 2*time.Second)
	if string(got.payload) != "hello" {
		t.Fatalf("hop payload = %q, want hello", got.payload)
	}
	if got.header.Generation == 0 {
		t.Fatal("the hop packet carried generation 0, which the contract keeps outside the id space")
	}
	if got.header.MappingID == 0 {
		t.Fatal("the hop packet carried mapping id 0, which the allocator must never hand out")
	}

	// The exit answers the mapping it was given; the client must get it.
	egress.reply(t, got.from, got.header.MappingID, got.header.Generation, []byte("T:hello"))
	if reply := readDatagram(t, client); reply != "T:hello" {
		t.Fatalf("client received %q, want T:hello", reply)
	}

	stats := r.Stats()
	if stats.Mappings != 1 || stats.MappingsCreated != 1 {
		t.Fatalf("mapping facts = %+v, want 1 live / 1 created", stats)
	}
	if stats.PacketsIn != 1 || stats.PacketsOut != 1 {
		t.Fatalf("packet facts = %+v, want 1 in / 1 out", stats)
	}
	if stats.Drops != 0 {
		t.Fatalf("drops = %d, want 0 on the happy path", stats.Drops)
	}
}

// The whole reason the hop header carries a mapping id: with ONE socket toward the
// exit, two clients are only distinguishable by that id. A reply must go to the
// client whose mapping it names — never to "whoever asked last".
func TestDatagramRelayKeepsTwoClientsIsolated(t *testing.T) {
	egress := startFakeEgress(t)
	port := freeUDPPort(t)
	startRelay(t, relayTestConfig(t, port, egress.addr()), DatagramRelayOptions{})

	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	alice := datagramClient(t, addr)
	bob := datagramClient(t, addr)

	if _, err := alice.Write([]byte("from-alice")); err != nil {
		t.Fatalf("alice write: %v", err)
	}
	first := egress.next(t, 2*time.Second)
	if _, err := bob.Write([]byte("from-bob")); err != nil {
		t.Fatalf("bob write: %v", err)
	}
	second := egress.next(t, 2*time.Second)

	if first.header.MappingID == second.header.MappingID {
		t.Fatalf("two clients shared mapping id %d: one socket cannot demultiplex that", first.header.MappingID)
	}
	// Answer Bob first and Alice second, so "last writer wins" routing would fail.
	egress.reply(t, second.from, second.header.MappingID, second.header.Generation, []byte("for-bob"))
	egress.reply(t, first.from, first.header.MappingID, first.header.Generation, []byte("for-alice"))

	if got := readDatagram(t, bob); got != "for-bob" {
		t.Fatalf("bob received %q, want for-bob", got)
	}
	if got := readDatagram(t, alice); got != "for-alice" {
		t.Fatalf("alice received %q, want for-alice", got)
	}
}

// A reply carrying another generation belongs to a previous incarnation of this
// runtime. Ids restart, so delivering it could hand one client another client's
// data — it must be dropped.
func TestDatagramRelayDropsReplyFromAnotherGeneration(t *testing.T) {
	egress := startFakeEgress(t)
	port := freeUDPPort(t)
	r := startRelay(t, relayTestConfig(t, port, egress.addr()), DatagramRelayOptions{})
	client := datagramClient(t, net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))

	if _, err := client.Write([]byte("hello")); err != nil {
		t.Fatalf("client write: %v", err)
	}
	got := egress.next(t, 2*time.Second)
	egress.reply(t, got.from, got.header.MappingID, got.header.Generation+1, []byte("stale"))

	expectNoReply(t, client, 400*time.Millisecond)
	if stats := r.Stats(); stats.DropsUnknownSource != 1 {
		t.Fatalf("stale-generation reply was not dropped and counted: %+v", stats)
	}
}

// A reply for a mapping that no longer exists (expired, or never ours) has nobody
// to go to; it is dropped rather than guessed at.
func TestDatagramRelayDropsReplyForUnknownMapping(t *testing.T) {
	egress := startFakeEgress(t)
	port := freeUDPPort(t)
	r := startRelay(t, relayTestConfig(t, port, egress.addr()), DatagramRelayOptions{})
	client := datagramClient(t, net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))

	if _, err := client.Write([]byte("hello")); err != nil {
		t.Fatalf("client write: %v", err)
	}
	got := egress.next(t, 2*time.Second)
	egress.reply(t, got.from, got.header.MappingID+999, got.header.Generation, []byte("ghost"))

	expectNoReply(t, client, 400*time.Millisecond)
	if stats := r.Stats(); stats.DropsUnknownSource != 1 {
		t.Fatalf("unknown-mapping reply was not dropped and counted: %+v", stats)
	}
}

// A datagram the hop cannot carry is dropped at the ingress and COUNTED: the
// ceiling is a named user-visible boundary, not a silent truncation.
func TestDatagramRelayDropsDatagramLargerThanTheHopBudget(t *testing.T) {
	egress := startFakeEgress(t)
	port := freeUDPPort(t)
	r := startRelay(t, relayTestConfig(t, port, egress.addr()), DatagramRelayOptions{})
	client := datagramClient(t, net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))

	if _, err := client.Write(bytes.Repeat([]byte("x"), datagramHopMaxPayload+1)); err != nil {
		t.Fatalf("client write: %v", err)
	}
	select {
	case got := <-egress.received:
		t.Fatalf("an oversized datagram was put on the hop with payload length %d", len(got.payload))
	case <-time.After(400 * time.Millisecond):
	}
	if stats := r.Stats(); stats.DropsCeiling != 1 || stats.MappingsCreated != 0 {
		t.Fatalf("oversize facts = %+v, want one ceiling drop and no mapping", stats)
	}
}

func TestDatagramRelayCeilingDropsNewClientWithoutEvicting(t *testing.T) {
	egress := startFakeEgress(t)
	port := freeUDPPort(t)
	r := startRelay(t, relayTestConfig(t, port, egress.addr()), DatagramRelayOptions{MaxMappings: 1})
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	alice := datagramClient(t, addr)
	bob := datagramClient(t, addr)

	if _, err := alice.Write([]byte("a")); err != nil {
		t.Fatalf("alice write: %v", err)
	}
	first := egress.next(t, 2*time.Second)
	if _, err := bob.Write([]byte("b")); err != nil {
		t.Fatalf("bob write: %v", err)
	}
	select {
	case got := <-egress.received:
		t.Fatalf("a datagram over the ceiling reached the hop (payload %q)", got.payload)
	case <-time.After(400 * time.Millisecond):
	}

	stats := r.Stats()
	if stats.DropsCeiling != 1 || stats.MappingsRejected != 1 || stats.Mappings != 1 {
		t.Fatalf("ceiling facts = %+v, want one rejection over a live mapping", stats)
	}
	// The live mapping still works.
	if _, err := alice.Write([]byte("still")); err != nil {
		t.Fatalf("alice write: %v", err)
	}
	again := egress.next(t, 2*time.Second)
	if again.header.MappingID != first.header.MappingID {
		t.Fatalf("the live mapping's id changed: %d -> %d", first.header.MappingID, again.header.MappingID)
	}
}

// A no-op retarget succeeds; a real change of the hop is refused with the swap
// sentinel, which the manager reads as "rebuild this runtime". Every mapping
// shares one socket toward the exit, so "live mappings keep the old hop" is not a
// promise this runtime can keep.
func TestDatagramRelayRetargetOnlyAcceptsANoOp(t *testing.T) {
	egress := startFakeEgress(t)
	port := freeUDPPort(t)
	r := startRelay(t, relayTestConfig(t, port, egress.addr()), DatagramRelayOptions{})

	if err := r.Retarget(egress.addr()); err != nil {
		t.Fatalf("retargeting to the same hop must be a no-op, got %v", err)
	}
	if err := r.Retarget("127.0.0.1:1"); err != ErrUpstreamNotSwappable {
		t.Fatalf("a real hop change must answer ErrUpstreamNotSwappable, got %v", err)
	}
	if err := r.Retarget("not-an-address"); err == nil {
		t.Fatal("a malformed hop address was accepted")
	}
}

func TestDatagramRelayRefusesMissingOrMalformedNextHop(t *testing.T) {
	for _, nextHop := range []string{"", "   ", "127.0.0.1", "127.0.0.1:not-a-port"} {
		cfg := relayTestConfig(t, freeUDPPort(t), nextHop)
		if _, err := NewDatagramRelay(cfg, DatagramRelayOptions{}); err == nil {
			t.Fatalf("next_hop %q was accepted", nextHop)
		}
	}
}

// The two halves of WP5-B2 must COMPOSE: a datagram from a client goes through a
// real ingress runtime and a real exit runtime (both with real sockets, in this
// process) to a real UDP target and back. Everything else in this file tests one
// half against a fake peer; this is the test that would catch the two halves each
// being "correct" about a hop header the other one spells differently.
func TestDatagramRelayAndEgressComposeEndToEnd(t *testing.T) {
	targetAddr, stopTarget := udpEchoTarget(t, "T")
	defer stopTarget()
	targetPort := targetPortOf(t, targetAddr)

	// The exit: listens on UDP, accepts hop packets from this machine, sends to
	// the pooled target.
	egressPort := freeUDPPort(t)
	egress, err := NewDatagramEgress(
		egressTestConfig(t, egressPort, "127.0.0.1"),
		staticSelector{t: Target{Host: "127.0.0.1", Port: targetPort}},
		DatagramEgressOptions{})
	if err != nil {
		t.Fatalf("NewDatagramEgress: %v", err)
	}
	if err := egress.Start(); err != nil {
		t.Fatalf("egress Start: %v", err)
	}
	defer func() { _ = egress.Stop() }()

	// The ingress: listens for clients, carries their mappings to the exit.
	ingressPort := freeUDPPort(t)
	relay := startRelay(t, relayTestConfig(t, ingressPort, net.JoinHostPort("127.0.0.1", strconv.Itoa(egressPort))), DatagramRelayOptions{})

	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(ingressPort))
	alice := datagramClient(t, addr)
	bob := datagramClient(t, addr)

	// Two clients, so the mapping id has to survive the whole round trip rather
	// than "working" because there is only one client.
	if _, err := alice.Write([]byte("alice")); err != nil {
		t.Fatalf("alice write: %v", err)
	}
	if got := readDatagram(t, alice); got != "T:alice" {
		t.Fatalf("alice received %q, want T:alice", got)
	}
	if _, err := bob.Write([]byte("bob")); err != nil {
		t.Fatalf("bob write: %v", err)
	}
	if got := readDatagram(t, bob); got != "T:bob" {
		t.Fatalf("bob received %q, want T:bob", got)
	}

	// Both ends agree that there are two mappings in flight and nothing was lost.
	if got := relay.LiveMappings(); got != 2 {
		t.Fatalf("ingress live mappings = %d, want 2", got)
	}
	if got := egress.LiveMappings(); got != 2 {
		t.Fatalf("exit live mappings = %d, want 2", got)
	}
	ingressStats, egressStats := relay.Stats(), egress.Stats()
	if ingressStats.Drops != 0 || egressStats.Drops != 0 {
		t.Fatalf("drops on the happy path: ingress=%+v exit=%+v", ingressStats, egressStats)
	}
	if ingressStats.PacketsIn != 2 || egressStats.PacketsIn != 2 {
		t.Fatalf("packet counts disagree: ingress=%+v exit=%+v", ingressStats, egressStats)
	}
	if ingressStats.PacketsOut != 2 || egressStats.PacketsOut != 2 {
		t.Fatalf("reply counts disagree: ingress=%+v exit=%+v", ingressStats, egressStats)
	}
}

// The runtime must satisfy the datagram contract, not the stream one: a caller
// asking how much work is in flight must ask LiveMappings.
func TestDatagramRelayReportsMappingsNotConnections(t *testing.T) {
	egress := startFakeEgress(t)
	port := freeUDPPort(t)
	r := startRelay(t, relayTestConfig(t, port, egress.addr()), DatagramRelayOptions{})
	client := datagramClient(t, net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))

	if got := r.LiveMappings(); got != 0 {
		t.Fatalf("live mappings before traffic = %d, want 0", got)
	}
	if _, err := client.Write([]byte("hello")); err != nil {
		t.Fatalf("client write: %v", err)
	}
	_ = egress.next(t, 2*time.Second)
	if got := r.LiveMappings(); got != 1 {
		t.Fatalf("live mappings after one client = %d, want 1", got)
	}
}

// Both new runtimes must be Diagnosticians: the manager collects per-tunnel facts by
// interface assertion, so a runtime without it reports nothing at all — a tunnel that
// is silently dropping everything then looks exactly like an idle one. That is
// precisely how the multi-homed attestation bug hid on the first real G1B run.
func TestDatagramRelayAndEgressReportProtocolDiagnostics(t *testing.T) {
	egress := startFakeEgress(t)
	port := freeUDPPort(t)
	relay := startRelay(t, relayTestConfig(t, port, egress.addr()), DatagramRelayOptions{})
	client := datagramClient(t, net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))

	if _, err := client.Write([]byte("hello")); err != nil {
		t.Fatalf("client write: %v", err)
	}
	got := egress.next(t, 2*time.Second)
	egress.reply(t, got.from, got.header.MappingID, got.header.Generation, []byte("T:hello"))
	_ = readDatagram(t, client)

	var d DatagramRuntime = relay
	diag, ok := d.(Diagnostician).ProtocolDiagnostics()
	if !ok {
		t.Fatal("the relay reports no protocol diagnostics")
	}
	if diag.Protocol != "udp" {
		t.Fatalf("diag protocol = %q, want udp", diag.Protocol)
	}
	if diag.Mappings != 1 || diag.PacketsIn != 1 || diag.PacketsOut != 1 {
		t.Fatalf("relay diag = %+v, want one live mapping and one packet each way", diag)
	}
	if diag.IdleTimeoutSeconds <= 0 {
		t.Fatalf("relay diag reports no idle timeout: %+v", diag)
	}
}

// The relay must publish the endpoint the kernel actually chose for the hop: that is
// the only address the exit can attest. On a multi-homed node it is NOT the node's
// configured connect_ip — the first real G1B run failed precisely because the panel
// told the exit the ingress-network address while the hop left from the egress one.
func TestDatagramRelayPublishesItsHopEndpoint(t *testing.T) {
	egress := startFakeEgress(t)
	port := freeUDPPort(t)
	relay := startRelay(t, relayTestConfig(t, port, egress.addr()), DatagramRelayOptions{})

	diag, ok := relay.ProtocolDiagnostics()
	if !ok {
		t.Fatal("the relay reports no diagnostics")
	}
	if diag.HopLocalAddr == "" {
		t.Fatal("the relay does not publish its hop endpoint: the exit would have nothing to attest")
	}
	if !strings.Contains(diag.HopLocalAddr, ":") {
		t.Fatalf("hop endpoint %q is not an ip:port endpoint", diag.HopLocalAddr)
	}
	// And it must agree with the address a client datagram actually leaves from.
	client := datagramClient(t, net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if _, err := client.Write([]byte("hello")); err != nil {
		t.Fatalf("client write: %v", err)
	}
	got := egress.next(t, 2*time.Second)
	if want := got.from.String(); want != diag.HopLocalAddr {
		t.Fatalf("published hop endpoint %q != the source the exit sees (%q)", diag.HopLocalAddr, want)
	}
}
