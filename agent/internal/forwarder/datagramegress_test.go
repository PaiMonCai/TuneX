package forwarder

import (
	"bytes"
	"net"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// V5.1b WP5-B2 — datagram EGRESS (the exit half of a UDP relay).
//
// Contract: docs/v5-1b-datagram-contract-draft.md §9.1 (frozen 2026-10-05).
//
// These are REAL-network tests for the same reason the DIRECT ones are: the
// properties that matter here — "only the paired ingress may feed this exit",
// "the destination never arrives on the wire", "a reply comes back under the
// header it arrived with" — only exist on a socket. A mock can prove none of them.
// ---------------------------------------------------------------------------

// hopClient is a stand-in for the ingress: one socket, exactly like the real one,
// so the exit sees every mapping from a single source address.
func hopClient(t *testing.T, port int) *net.UDPConn {
	t.Helper()
	conn, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: port})
	if err != nil {
		t.Fatalf("dial egress: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func egressTestConfig(t *testing.T, port int, hopPeer string) TunnelConfig {
	t.Helper()
	return TunnelConfig{
		ID:         "relay-egress",
		Mode:       ModeEgress,
		Protocol:   ProtocolUDP,
		EgressPort: port,
		HopPeer:    hopPeer,
	}
}

func startEgress(t *testing.T, cfg TunnelConfig, sel TargetSelector, opts DatagramEgressOptions) *DatagramEgress {
	t.Helper()
	e, err := NewDatagramEgress(cfg, sel, opts)
	if err != nil {
		t.Fatalf("NewDatagramEgress: %v", err)
	}
	if err := e.Start(); err != nil {
		t.Fatalf("egress Start: %v", err)
	}
	t.Cleanup(func() { _ = e.Stop() })
	return e
}

// sendHop writes one hop packet and returns whether a reply arrived.
func sendHop(t *testing.T, c *net.UDPConn, id, gen uint32, payload []byte, wait time.Duration) (datagramHopHeader, []byte, bool) {
	t.Helper()
	wire, err := appendDatagramHop(nil, datagramHopHeader{MappingID: id, Generation: gen}, payload)
	if err != nil {
		t.Fatalf("appendDatagramHop: %v", err)
	}
	if _, err := c.Write(wire); err != nil {
		t.Fatalf("write hop packet: %v", err)
	}
	if err := c.SetReadDeadline(time.Now().Add(wait)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}
	buf := make([]byte, datagramHopMTU)
	n, err := c.Read(buf)
	if err != nil {
		if isTimeout(err) {
			return datagramHopHeader{}, nil, false
		}
		t.Fatalf("read hop reply: %v", err)
	}
	header, got, err := parseDatagramHop(buf[:n])
	if err != nil {
		t.Fatalf("reply is not a hop packet: %v", err)
	}
	return header, got, true
}

func TestDatagramEgressRoundTripEchoesHeaderAndReachesTarget(t *testing.T) {
	targetAddr, stopTarget := udpEchoTarget(t, "T")
	defer stopTarget()

	port := freeUDPPort(t)
	e := startEgress(t, egressTestConfig(t, port, "127.0.0.1"),
		staticSelector{t: Target{Host: "127.0.0.1", Port: targetPortOf(t, targetAddr)}},
		DatagramEgressOptions{})
	client := hopClient(t, port)

	header, payload, ok := sendHop(t, client, 1, 7, []byte("hello"), 2*time.Second)
	if !ok {
		t.Fatal("no reply came back through the exit")
	}
	// The reply carries the SAME hop identity: that is what lets the ingress
	// route it back to the client that asked.
	if header.MappingID != 1 || header.Generation != 7 {
		t.Fatalf("reply header = %+v, want {MappingID:1 Generation:7}", header)
	}
	if string(payload) != "T:hello" {
		t.Fatalf("reply payload = %q, want %q", payload, "T:hello")
	}

	stats := e.Stats()
	if stats.Mappings != 1 || stats.MappingsCreated != 1 {
		t.Fatalf("mapping facts = %+v, want 1 live / 1 created", stats)
	}
	if stats.PacketsIn != 1 || stats.BytesIn != int64(len("hello")) {
		t.Fatalf("inbound facts = %+v, want 1 packet / 5 bytes", stats)
	}
	if stats.PacketsOut != 1 || stats.BytesOut != int64(len("T:hello")) {
		t.Fatalf("outbound facts = %+v, want 1 packet / 7 bytes", stats)
	}
	if stats.Drops != 0 {
		t.Fatalf("drops = %d, want 0 on the happy path", stats.Drops)
	}
}

// The exit must refuse a source that is not the paired ingress: UDP has no
// handshake, so this is the only thing standing between the port and "anyone who
// finds it can reach the configured targets".
func TestDatagramEgressDropsUnattestedSource(t *testing.T) {
	targetAddr, stopTarget := udpEchoTarget(t, "T")
	defer stopTarget()

	port := freeUDPPort(t)
	// A peer address that is deliberately NOT this machine's source address.
	e := startEgress(t, egressTestConfig(t, port, "10.255.255.1"),
		staticSelector{t: Target{Host: "127.0.0.1", Port: targetPortOf(t, targetAddr)}},
		DatagramEgressOptions{})
	client := hopClient(t, port)

	if _, _, ok := sendHop(t, client, 1, 1, []byte("hello"), 300*time.Millisecond); ok {
		t.Fatal("an unattested source received a reply")
	}
	stats := e.Stats()
	if stats.DropsUnknownSource != 1 || stats.Drops != 1 {
		t.Fatalf("drops = %+v, want exactly one unknown-source drop", stats)
	}
	if stats.MappingsCreated != 0 {
		t.Fatalf("mappings created = %d, want 0: an unattested datagram must not build state", stats.MappingsCreated)
	}
}

// "No peer configured" must be a construction failure, never "accept anyone".
func TestDatagramEgressRefusesMissingHopPeer(t *testing.T) {
	cfg := egressTestConfig(t, freeUDPPort(t), "")
	if _, err := NewDatagramEgress(cfg, staticSelector{t: Target{Host: "127.0.0.1", Port: 9}}, DatagramEgressOptions{}); err == nil {
		t.Fatal("a datagram EGRESS without hop_peer was accepted")
	}
}

// "No target pool" is a construction failure too: the destination is never on the
// wire, so the pool is the only thing that could name one.
func TestDatagramEgressRefusesMissingSelector(t *testing.T) {
	cfg := egressTestConfig(t, freeUDPPort(t), "127.0.0.1")
	if _, err := NewDatagramEgress(cfg, nil, DatagramEgressOptions{}); err == nil {
		t.Fatal("a datagram EGRESS without a target selector was accepted")
	}
	if _, err := buildUDPDatagram(cfg, DatagramBuildDeps{}); err == nil {
		t.Fatal("buildUDPDatagram built an EGRESS runtime with no selector injected")
	}
}

func TestDatagramEgressDropsMalformedPacketsWithoutKillingTheRuntime(t *testing.T) {
	targetAddr, stopTarget := udpEchoTarget(t, "T")
	defer stopTarget()

	port := freeUDPPort(t)
	e := startEgress(t, egressTestConfig(t, port, "127.0.0.1"),
		staticSelector{t: Target{Host: "127.0.0.1", Port: targetPortOf(t, targetAddr)}},
		DatagramEgressOptions{})
	client := hopClient(t, port)

	for _, garbage := range [][]byte{
		[]byte("not-a-hop-packet"),
		{},
		append([]byte{'X', 'X', 'X', 'X'}, make([]byte, 16)...),
	} {
		if _, err := client.Write(garbage); err != nil {
			t.Fatalf("write garbage: %v", err)
		}
	}
	// The runtime must still serve a well-formed packet afterwards: a garbage
	// datagram is a drop, not a reason to stop listening.
	time.Sleep(50 * time.Millisecond)
	if _, payload, ok := sendHop(t, client, 1, 1, []byte("still-alive"), 2*time.Second); !ok {
		t.Fatal("the runtime stopped serving after malformed input")
	} else if string(payload) != "T:still-alive" {
		t.Fatalf("payload = %q", payload)
	}
	stats := e.Stats()
	if stats.DropsMalformed != 3 {
		t.Fatalf("malformed drops = %d, want 3", stats.DropsMalformed)
	}
}

// Mapping ids restart when the ingress restarts, so the newer generation must take
// the id over. Refusing the take-over would leave the exit permanently deaf.
func TestDatagramEgressNewerGenerationTakesOverTheMappingID(t *testing.T) {
	targetAddr, stopTarget := udpEchoTarget(t, "T")
	defer stopTarget()

	port := freeUDPPort(t)
	e := startEgress(t, egressTestConfig(t, port, "127.0.0.1"),
		staticSelector{t: Target{Host: "127.0.0.1", Port: targetPortOf(t, targetAddr)}},
		DatagramEgressOptions{})
	client := hopClient(t, port)

	if header, _, ok := sendHop(t, client, 5, 1, []byte("first"), 2*time.Second); !ok || header.Generation != 1 {
		t.Fatalf("first generation reply = %+v ok=%v", header, ok)
	}
	header, payload, ok := sendHop(t, client, 5, 2, []byte("second"), 2*time.Second)
	if !ok {
		t.Fatal("the new generation got no reply: the take-over did not happen")
	}
	if header.Generation != 2 {
		t.Fatalf("reply generation = %d, want 2 (replies must carry the live generation)", header.Generation)
	}
	if string(payload) != "T:second" {
		t.Fatalf("payload = %q, want %q", payload, "T:second")
	}
	stats := e.Stats()
	if stats.MappingsCreated != 2 {
		t.Fatalf("mappings created = %d, want 2 (the old one is closed, a new one built)", stats.MappingsCreated)
	}
	if stats.Mappings != 1 {
		t.Fatalf("live mappings = %d, want 1 (one id, one mapping)", stats.Mappings)
	}
}

// Over the ceiling, a datagram from an identity with no mapping is DROPPED — the
// runtime never evicts a live mapping to make room for an unverified one.
func TestDatagramEgressCeilingDropsNewMappingsWithoutEvicting(t *testing.T) {
	targetAddr, stopTarget := udpEchoTarget(t, "T")
	defer stopTarget()

	port := freeUDPPort(t)
	e := startEgress(t, egressTestConfig(t, port, "127.0.0.1"),
		staticSelector{t: Target{Host: "127.0.0.1", Port: targetPortOf(t, targetAddr)}},
		DatagramEgressOptions{MaxMappings: 1})
	client := hopClient(t, port)

	if _, _, ok := sendHop(t, client, 1, 1, []byte("a"), 2*time.Second); !ok {
		t.Fatal("the first mapping was not created")
	}
	if _, _, ok := sendHop(t, client, 2, 1, []byte("b"), 300*time.Millisecond); ok {
		t.Fatal("a datagram over the ceiling was served")
	}
	stats := e.Stats()
	if stats.DropsCeiling != 1 || stats.MappingsRejected != 1 {
		t.Fatalf("ceiling facts = %+v, want one ceiling drop", stats)
	}
	if stats.Mappings != 1 {
		t.Fatalf("live mappings = %d, want 1 (the live mapping must survive)", stats.Mappings)
	}
	// The surviving mapping still works: the ceiling must not break what is live.
	if _, payload, ok := sendHop(t, client, 1, 1, []byte("c"), 2*time.Second); !ok || string(payload) != "T:c" {
		t.Fatalf("the live mapping stopped working after a ceiling drop: ok=%v payload=%q", ok, payload)
	}
}

// A reply larger than the hop budget cannot be carried; it is dropped and counted
// rather than silently truncated into a shorter (wrong) answer.
func TestDatagramEgressDropsOversizeReplyInsteadOfTruncating(t *testing.T) {
	// A target that answers with a payload well past the hop budget.
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatalf("big-reply target listen: %v", err)
	}
	defer conn.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, datagramMaxPayload)
		for {
			if _, from, err := conn.ReadFromUDP(buf); err != nil {
				return
			} else {
				_, _ = conn.WriteToUDP(bytes.Repeat([]byte("x"), datagramHopMaxPayload+64), from)
			}
		}
	}()

	port := freeUDPPort(t)
	e := startEgress(t, egressTestConfig(t, port, "127.0.0.1"),
		staticSelector{t: Target{Host: "127.0.0.1", Port: conn.LocalAddr().(*net.UDPAddr).Port}},
		DatagramEgressOptions{})
	client := hopClient(t, port)

	if _, _, ok := sendHop(t, client, 1, 1, []byte("ask"), 500*time.Millisecond); ok {
		t.Fatal("an oversize reply was delivered")
	}
	stats := e.Stats()
	if stats.DropsMalformed == 0 {
		t.Fatalf("oversize reply was not counted as a drop: %+v", stats)
	}
}

// ---------------------------------------------------------------- factory -----

// The factory must route each ROLE to its own runtime. A role that resolves to the
// wrong constructor is the §4.1 mistake expressed as a map; here it is checked
// instead of being discovered as a wrong listener in production.
func TestBuildUDPDatagramRoutesByRole(t *testing.T) {
	targetAddr, stopTarget := udpEchoTarget(t, "T")
	defer stopTarget()
	sel := staticSelector{t: Target{Host: "127.0.0.1", Port: targetPortOf(t, targetAddr)}}
	deps := DatagramBuildDeps{SelectorFor: func(string) (TargetSelector, error) { return sel, nil }}

	direct := TunnelConfig{ID: "d", Mode: ModeDirect, Protocol: ProtocolUDP, IngressPort: freeUDPPort(t), RemoteHost: "127.0.0.1", RemotePort: targetPortOf(t, targetAddr)}
	if got, err := buildUDPDatagram(direct, deps); err != nil {
		t.Fatalf("DIRECT was refused: %v", err)
	} else if _, ok := got.(*DatagramForwarder); !ok {
		t.Fatalf("DIRECT resolved to %T, want the DIRECT datagram runtime", got)
	}

	egress := egressTestConfig(t, freeUDPPort(t), "127.0.0.1")
	if got, err := buildUDPDatagram(egress, deps); err != nil {
		t.Fatalf("EGRESS was refused: %v", err)
	} else if _, ok := got.(*DatagramEgress); !ok {
		t.Fatalf("EGRESS resolved to %T, want the datagram egress runtime", got)
	}

	relay := TunnelConfig{ID: "r", Mode: ModeRelay, Protocol: ProtocolUDP, IngressPort: freeUDPPort(t), NextHop: "127.0.0.1:1234"}
	if got, err := buildUDPDatagram(relay, deps); err != nil {
		t.Fatalf("RELAY was refused: %v", err)
	} else if _, ok := got.(*DatagramRelay); !ok {
		t.Fatalf("RELAY resolved to %T, want the datagram relay ingress runtime", got)
	}

	// Validate gates the same field the RELAY constructor needs, so a config
	// missing next_hop never reaches a builder at all.
	bare := relay.Clone()
	bare.NextHop = ""
	if err := bare.Validate(); err == nil {
		t.Fatal("Validate accepted udp RELAY without next_hop")
	}
}

// The panel will hand this exit the ingress's LEARNED hop endpoint (`ip:port`, as the
// ingress actually sends from). Attestation must therefore accept the endpoint form and
// pin the ADDRESS only: the port is ephemeral and changes when the ingress restarts, so
// pinning it would turn a normal restart into a permanent outage — while the property we
// need ("only the paired ingress may feed this exit") is a property of the address.
// A live mapping is stricter than the tunnel-level IP attestation: once the
// mapping exists, its generation is pinned to the source endpoint that created
// it. A second socket on the same (attested) IP must not be able to reuse the
// mapping id/generation and steal or inject into its reply path.
func TestDatagramEgressPinsLiveMappingToCreatingEndpoint(t *testing.T) {
	targetAddr, stopTarget := udpEchoTarget(t, "T")
	defer stopTarget()
	port := freeUDPPort(t)
	e := startEgress(t, egressTestConfig(t, port, "127.0.0.1"),
		staticSelector{t: Target{Host: "127.0.0.1", Port: targetPortOf(t, targetAddr)}},
		DatagramEgressOptions{})

	owner := hopClient(t, port)
	stranger := hopClient(t, port)

	if _, payload, ok := sendHop(t, owner, 9, 41, []byte("owner"), 2*time.Second); !ok {
		t.Fatal("owner mapping did not receive its first reply")
	} else if string(payload) != "T:owner" {
		t.Fatalf("owner payload = %q", payload)
	}

	wire, err := appendDatagramHop(nil, datagramHopHeader{MappingID: 9, Generation: 41}, []byte("hijack"))
	if err != nil {
		t.Fatalf("append hijack packet: %v", err)
	}
	if _, err := stranger.Write(wire); err != nil {
		t.Fatalf("write hijack packet: %v", err)
	}

	// The foreign source port is refused before the target write, so neither
	// socket receives a second reply.
	if err := stranger.SetReadDeadline(time.Now().Add(250 * time.Millisecond)); err != nil {
		t.Fatalf("set stranger deadline: %v", err)
	}
	buf := make([]byte, datagramHopMTU)
	if _, err := stranger.Read(buf); err == nil || !isTimeout(err) {
		t.Fatalf("same-IP foreign endpoint received a reply: err=%v", err)
	}
	if err := owner.SetReadDeadline(time.Now().Add(250 * time.Millisecond)); err != nil {
		t.Fatalf("set owner deadline: %v", err)
	}
	if _, err := owner.Read(buf); err == nil || !isTimeout(err) {
		t.Fatalf("foreign endpoint packet reached the target/reply path: err=%v", err)
	}

	stats := e.Stats()
	if stats.MappingsCreated != 1 || stats.Mappings != 1 {
		t.Fatalf("mapping facts = %+v, want the original mapping only", stats)
	}
	if stats.PacketsIn != 1 {
		t.Fatalf("packets in = %d, want only the owner's accepted packet", stats.PacketsIn)
	}
	if stats.DropsUnknownSource != 1 || stats.Drops != 1 {
		t.Fatalf("drops = %+v, want one endpoint-mismatch drop", stats)
	}
}

func TestDatagramEgressAttestsAnEndpointByItsAddress(t *testing.T) {
	targetAddr, stopTarget := udpEchoTarget(t, "T")
	defer stopTarget()
	sel := staticSelector{t: Target{Host: "127.0.0.1", Port: targetPortOf(t, targetAddr)}}

	// Accepted: the paired address, given as ip:port, with a port the client is NOT using.
	pairedPort := freeUDPPort(t)
	startEgress(t, egressTestConfig(t, pairedPort, "127.0.0.1:65000"), sel, DatagramEgressOptions{})
	pairedClient := hopClient(t, pairedPort)
	if _, payload, ok := sendHop(t, pairedClient, 1, 1, []byte("endpoint-form"), 2*time.Second); !ok {
		t.Fatal("an ip:port hop_peer rejected the paired ingress: the port must not be pinned")
	} else if string(payload) != "T:endpoint-form" {
		t.Fatalf("payload = %q", payload)
	}

	// Refused: a different address, same endpoint form.
	strangerPort := freeUDPPort(t)
	stranger := startEgress(t, egressTestConfig(t, strangerPort, "10.255.255.1:65000"), sel, DatagramEgressOptions{})
	strangerClient := hopClient(t, strangerPort)
	if _, _, ok := sendHop(t, strangerClient, 1, 1, []byte("nope"), 300*time.Millisecond); ok {
		t.Fatal("an unpaired address was accepted")
	}
	if stats := stranger.Stats(); stats.DropsUnknownSource != 1 || stats.MappingsCreated != 0 {
		t.Fatalf("unpaired-source facts = %+v, want exactly one unknown-source drop and no mapping", stats)
	}
}
