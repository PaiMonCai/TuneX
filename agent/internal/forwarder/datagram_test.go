package forwarder

import (
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// UDP DIRECT datagram runtime.
//
// These are real-network tests of the datagram runtime contract
// (the project's rule for data-plane capability: a mock cannot prove a data
// plane). Every test drives a real UDP client through the runtime's listener to a
// real UDP echo target, because the properties that matter here — one mapping per
// source address, replies routed back to the right client, a socket that survives
// a garbage datagram — only exist on a socket.
// ---------------------------------------------------------------------------

// --- helpers ---------------------------------------------------------------

// freeUDPPort reserves a UDP port by binding and releasing it.
func freeUDPPort(t *testing.T) int {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatalf("reserve udp port: %v", err)
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).Port
}

// udpEchoTarget starts a UDP server that answers every datagram with
// "label:" + payload, so a reply proves both which target produced it and that
// the payload survived the tunnel unchanged.
func udpEchoTarget(t *testing.T, label string) (addr string, stop func()) {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatalf("udp echo listen: %v", err)
	}
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		buf := make([]byte, datagramMaxPayload)
		for {
			n, from, err := conn.ReadFromUDP(buf)
			if err != nil {
				return
			}
			reply := append([]byte(label+":"), buf[:n]...)
			if _, err := conn.WriteToUDP(reply, from); err != nil {
				return
			}
		}
	}()
	return conn.LocalAddr().String(), func() {
		_ = conn.Close()
		<-closed
	}
}

// datagramClient returns a connected UDP client: one source port, i.e. one
// mapping for as long as the test keeps using it.
func datagramClient(t *testing.T, target string) *net.UDPConn {
	t.Helper()
	raddr, err := net.ResolveUDPAddr("udp", target)
	if err != nil {
		t.Fatalf("resolve %s: %v", target, err)
	}
	conn, err := net.DialUDP("udp", nil, raddr)
	if err != nil {
		t.Fatalf("dial udp %s: %v", target, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// sendRecv sends one datagram and returns the reply as a string.
func sendRecv(t *testing.T, client *net.UDPConn, payload []byte) string {
	t.Helper()
	if _, err := client.Write(payload); err != nil {
		t.Fatalf("send: %v", err)
	}
	return readDatagram(t, client)
}

// readDatagram reads one datagram, failing the test on error.
func readDatagram(t *testing.T, client *net.UDPConn) string {
	t.Helper()
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, datagramMaxPayload)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatalf("read reply: %v", err)
	}
	return string(buf[:n])
}

// expectNoReply asserts that nothing arrives within d. UDP has no "closed", so a
// dropped datagram and a slow one look the same from here — which is exactly why
// the runtime must also COUNT the drop (asserted separately).
func expectNoReply(t *testing.T, client *net.UDPConn, d time.Duration) {
	t.Helper()
	_ = client.SetReadDeadline(time.Now().Add(d))
	buf := make([]byte, 2048)
	if n, err := client.Read(buf); err == nil {
		t.Fatalf("expected no reply, got %q", buf[:n])
	} else if !isTimeout(err) {
		t.Fatalf("expected a read timeout, got %v", err)
	}
}

func isTimeout(err error) bool {
	var nerr net.Error
	return errors.As(err, &nerr) && nerr.Timeout()
}

func udpDirectConfig(id string, ingress, targetPort int) TunnelConfig {
	return TunnelConfig{
		ID:          id,
		Mode:        ModeDirect,
		IngressPort: ingress,
		RemoteHost:  "127.0.0.1",
		RemotePort:  targetPort,
		Protocol:    ProtocolUDP,
		ListenHost:  "127.0.0.1",
		Revision:    1,
	}
}

// startDatagram builds and starts a datagram runtime on a free UDP port with the
// given target, failing the test on error.
func startDatagram(t *testing.T, id string, targetPort int, opts DatagramOptions) *DatagramForwarder {
	t.Helper()
	d, err := NewDatagram(udpDirectConfig(id, freeUDPPort(t), targetPort), opts)
	if err != nil {
		t.Fatalf("NewDatagram: %v", err)
	}
	if err := d.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = d.Stop() })
	return d
}

func targetPortOf(t *testing.T, addr string) int {
	t.Helper()
	_, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("split %s: %v", addr, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("port %q: %v", portStr, err)
	}
	return port
}

// --- tests -----------------------------------------------------------------

// A real UDP round trip through the ingress listener, and the facts it must
// leave behind: one mapping, one delivered packet in each direction.
func TestDatagramDirectRoundTripAndFacts(t *testing.T) {
	target, stopTarget := udpEchoTarget(t, "tgt")
	defer stopTarget()

	d := startDatagram(t, "tunex-1-direct", targetPortOf(t, target), DatagramOptions{})
	client := datagramClient(t, d.cfg.ListenAddr())

	if got := sendRecv(t, client, []byte("ping")); got != "tgt:ping" {
		t.Fatalf("reply = %q, want tgt:ping", got)
	}

	wantReply := int64(len("tgt:ping"))
	stats := waitForStats(t, d, func(s DatagramStats) bool {
		return s.Mappings == 1 && s.MappingsCreated == 1 &&
			s.PacketsIn == 1 && s.BytesIn == int64(len("ping")) &&
			s.PacketsOut == 1 && s.BytesOut == wantReply
	}, "one mapping and one delivered packet in each direction")
	if stats.Drops != 0 {
		t.Fatalf("drops = %d, want 0 on a clean round trip", stats.Drops)
	}
	if stats.LastActivityAt == 0 {
		t.Fatal("last_activity_at must be set once a datagram has been delivered")
	}

	// A second datagram from the SAME source reuses the mapping: no growth.
	if got := sendRecv(t, client, []byte("pong")); got != "tgt:pong" {
		t.Fatalf("second reply = %q, want tgt:pong", got)
	}
	if stats := d.Stats(); stats.Mappings != 1 || stats.MappingsCreated != 1 {
		t.Fatalf("same source must reuse its mapping, got %d live / %d created", stats.Mappings, stats.MappingsCreated)
	}

	// A DIFFERENT source port is a different client, i.e. a second mapping, and
	// the two must not be confused: each reply goes back to its own sender.
	second := datagramClient(t, d.cfg.ListenAddr())
	if got := sendRecv(t, second, []byte("second")); got != "tgt:second" {
		t.Fatalf("second client reply = %q, want tgt:second", got)
	}
	if got := sendRecv(t, client, []byte("first-again")); got != "tgt:first-again" {
		t.Fatalf("first client reply after the second joined = %q", got)
	}
	// Four datagrams have been sent in total (ping, pong, second, first-again),
	// all of them delivered.
	stats = waitForStats(t, d, func(s DatagramStats) bool { return s.Mappings == 2 && s.PacketsIn == 4 },
		"two mappings and four delivered datagrams")
	if stats.Mappings != 2 {
		t.Fatalf("mappings = %d, want 2 (two source ports, two mappings)", stats.Mappings)
	}
}

// A listener that cannot come up must fail closed: the second Start is honest
// about the state it is in, and a bind that the kernel refuses must not leave a
// runtime reporting Running.
func TestDatagramStartFailsClosedOnABusyPort(t *testing.T) {
	target, stopTarget := udpEchoTarget(t, "busy")
	defer stopTarget()

	d := startDatagram(t, "tunex-busy-direct", targetPortOf(t, target), DatagramOptions{})
	if err := d.Start(); err != ErrAlreadyStarted {
		t.Fatalf("second Start = %v, want ErrAlreadyStarted", err)
	}

	// A second runtime on the same port: the kernel is the final judge, and the
	// runtime must report the failure rather than come up "running" with no
	// socket behind it.
	other, err := NewDatagram(udpDirectConfig("tunex-busy-2-direct", d.cfg.IngressPort, targetPortOf(t, target)), DatagramOptions{})
	if err != nil {
		t.Fatalf("NewDatagram: %v", err)
	}
	if err := other.Start(); err == nil {
		_ = other.Stop()
		t.Fatal("binding a busy udp port must fail")
	}
	if other.Running() {
		t.Fatal("a runtime whose bind failed must not report Running")
	}

	// The original listener is untouched by the neighbour's failure.
	client := datagramClient(t, d.cfg.ListenAddr())
	if got := sendRecv(t, client, []byte("ok")); got != "busy:ok" {
		t.Fatalf("reply = %q, want busy:ok", got)
	}
}

// A mapping ends by idle timeout, and the next datagram from the same client
// simply creates a new one. This is the datagram replacement for "the client
// hung up" — a signal UDP does not have.
func TestDatagramMappingExpiresAfterIdleTimeout(t *testing.T) {
	target, stopTarget := udpEchoTarget(t, "idle")
	defer stopTarget()

	const idle = 80 * time.Millisecond
	d := startDatagram(t, "tunex-idle-direct", targetPortOf(t, target), DatagramOptions{IdleTimeout: idle})
	client := datagramClient(t, d.cfg.ListenAddr())

	if got := sendRecv(t, client, []byte("one")); got != "idle:one" {
		t.Fatalf("reply = %q, want idle:one", got)
	}
	if d.LiveMappings() != 1 {
		t.Fatalf("mappings = %d, want 1", d.LiveMappings())
	}

	stats := waitForStats(t, d, func(s DatagramStats) bool { return s.Mappings == 0 && s.MappingsExpired == 1 },
		"the idle mapping to be recycled")
	if stats.PacketsIn != 1 || stats.PacketsOut != 1 {
		t.Fatalf("expiry must not invent traffic: %d in / %d out", stats.PacketsIn, stats.PacketsOut)
	}

	// The client is not "gone": the next datagram builds a fresh mapping.
	if got := sendRecv(t, client, []byte("two")); got != "idle:two" {
		t.Fatalf("reply after expiry = %q, want idle:two", got)
	}
	stats = waitForStats(t, d, func(s DatagramStats) bool { return s.MappingsCreated == 2 && s.Mappings == 1 },
		"a fresh mapping for the returning client")
	if stats.MappingsCreated != 2 || stats.Mappings != 1 {
		t.Fatalf("created/live = %d/%d, want 2/1", stats.MappingsCreated, stats.Mappings)
	}
}

// The §13.3.4 semantics, translated: a target change moves where NEW mappings go
// and leaves existing mappings on the target they were created with.
func TestDatagramRetargetKeepsExistingMappingOnOldTarget(t *testing.T) {
	targetA, stopA := udpEchoTarget(t, "A")
	defer stopA()
	targetB, stopB := udpEchoTarget(t, "B")
	defer stopB()

	d := startDatagram(t, "tunex-swap-direct", targetPortOf(t, targetA), DatagramOptions{})
	listenAddr := d.cfg.ListenAddr()
	client := datagramClient(t, listenAddr)

	if got := sendRecv(t, client, []byte("one")); got != "A:one" {
		t.Fatalf("pre-swap reply = %q, want A:one", got)
	}

	if err := d.Retarget(targetB); err != nil {
		t.Fatalf("Retarget: %v", err)
	}

	// The listener is the same object on the same port: a retarget never rebinds.
	if !d.Running() || d.cfg.ListenAddr() != listenAddr {
		t.Fatalf("retarget must not touch the listener (running=%v addr=%s)", d.Running(), d.cfg.ListenAddr())
	}

	// The existing mapping keeps its target.
	if got := sendRecv(t, client, []byte("two")); got != "A:two" {
		t.Fatalf("existing mapping reply after retarget = %q, want A:two (it keeps the target it was created with)", got)
	}

	// A new source address gets the new target.
	fresh := datagramClient(t, listenAddr)
	if got := sendRecv(t, fresh, []byte("three")); got != "B:three" {
		t.Fatalf("new mapping reply after retarget = %q, want B:three", got)
	}

	if stats := d.Stats(); stats.Mappings != 2 {
		t.Fatalf("mappings = %d, want 2", stats.Mappings)
	}
}

// A datagram is never interpreted (garbage is forwarded verbatim) and never
// silently truncated, and none of it can take the listener down.
func TestDatagramPayloadsAreOpaqueAndNeverTruncated(t *testing.T) {
	target, stopTarget := udpEchoTarget(t, "srv")
	defer stopTarget()

	d := startDatagram(t, "tunex-payload-direct", targetPortOf(t, target), DatagramOptions{})
	client := datagramClient(t, d.cfg.ListenAddr())

	// 0 bytes: a legal datagram, and legal to answer with another one.
	if _, err := client.Write(nil); err != nil {
		t.Fatalf("send empty datagram: %v", err)
	}
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, datagramMaxPayload)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatalf("empty datagram must be forwarded and echoed: %v", err)
	}
	if string(buf[:n]) != "srv:" {
		t.Fatalf("empty datagram reply = %q, want %q", buf[:n], "srv:")
	}

	// Garbage bytes: opaque payload, forwarded unchanged (the tunnel does not
	// parse what it carries, so "malformed content" is not a thing here).
	garbage := bytes.Repeat([]byte{0x00, 0xff, 0xfe, 0x01}, 512)
	if got := sendRecv(t, client, garbage); got != "srv:"+string(garbage) {
		t.Fatalf("garbage payload was not forwarded verbatim (%d bytes back)", len(got))
	}

	// Large payload: bigger than any small-buffer mistake (4 KiB / 8 KiB) and
	// still within the protocol's maximum, so a truncated read would show up as a
	// short target write rather than as a dropped packet.
	big := bytes.Repeat([]byte("0123456789abcdef"), 2500) // 40 000 bytes
	if got := sendRecv(t, client, big); got != "srv:"+string(big) {
		t.Fatalf("large datagram was truncated: got %d bytes, want %d", len(got), len(big)+4)
	}

	// And the listener is still serving afterwards.
	if got := sendRecv(t, client, []byte("alive")); got != "srv:alive" {
		t.Fatalf("listener did not survive the payload cases: %q", got)
	}
}

// Over the ceiling the runtime refuses NEW mappings — it never evicts a live one
// to make room — and the refusal is counted rather than silent.
func TestDatagramCeilingRefusesNewMappingsWithoutBreakingLiveOnes(t *testing.T) {
	target, stopTarget := udpEchoTarget(t, "ceil")
	defer stopTarget()

	d := startDatagram(t, "tunex-ceil-direct", targetPortOf(t, target), DatagramOptions{MaxMappings: 1})
	listenAddr := d.cfg.ListenAddr()
	client := datagramClient(t, listenAddr)

	if got := sendRecv(t, client, []byte("one")); got != "ceil:one" {
		t.Fatalf("reply = %q", got)
	}

	// A second source cannot get a mapping. It sends three times so the count is
	// per datagram, not per source.
	blocked := datagramClient(t, listenAddr)
	for i := 0; i < 3; i++ {
		if _, err := blocked.Write([]byte("nope")); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	expectNoReply(t, blocked, 200*time.Millisecond)

	waitFor(t, 3*time.Second, func() bool { return d.Stats().DropsCeiling == 3 }, "three ceiling drops")
	stats := d.Stats()
	if stats.Mappings != 1 {
		t.Fatalf("mappings = %d, want 1 (the ceiling must not evict the live mapping)", stats.Mappings)
	}
	if stats.MappingsRejected != 3 {
		t.Fatalf("mappings_rejected = %d, want 3", stats.MappingsRejected)
	}
	if stats.Drops != 3 {
		t.Fatalf("drops = %d, want 3", stats.Drops)
	}

	// The client that already has a mapping is unaffected.
	if got := sendRecv(t, client, []byte("still-here")); got != "ceil:still-here" {
		t.Fatalf("live mapping was broken by the ceiling: %q", got)
	}
}

// DrainMappings stops admitting new sources and keeps the socket — and the live
// mappings' replies — exactly where they were (§4.3).
func TestDatagramDrainKeepsSocketOpenAndRefusesNewSources(t *testing.T) {
	target, stopTarget := udpEchoTarget(t, "drain")
	defer stopTarget()

	d := startDatagram(t, "tunex-drain-direct", targetPortOf(t, target), DatagramOptions{})
	listenAddr := d.cfg.ListenAddr()
	client := datagramClient(t, listenAddr)
	if got := sendRecv(t, client, []byte("one")); got != "drain:one" {
		t.Fatalf("reply = %q", got)
	}

	if err := d.DrainMappings(0); err != nil {
		t.Fatalf("DrainMappings: %v", err)
	}
	if !d.Running() {
		t.Fatal("a drained datagram runtime keeps its listener bound (the port stays reserved)")
	}

	// The live mapping is still fully served, in both directions.
	if got := sendRecv(t, client, []byte("two")); got != "drain:two" {
		t.Fatalf("live mapping must keep working during a drain, got %q", got)
	}

	// A new source is refused, and the refusal is a counted fact.
	fresh := datagramClient(t, listenAddr)
	if _, err := fresh.Write([]byte("new")); err != nil {
		t.Fatalf("send: %v", err)
	}
	expectNoReply(t, fresh, 200*time.Millisecond)
	waitFor(t, 3*time.Second, func() bool { return d.Stats().DropsUnknownSource >= 1 }, "an unknown-source drop")

	// A bounded drain wait returns without inventing work it cannot finish: the
	// live mapping only ends by idle expiry or by Stop.
	if err := d.DrainMappings(time.Second); err != nil {
		t.Fatalf("DrainMappings(bounded): %v", err)
	}
	if d.LiveMappings() != 1 {
		t.Fatalf("mappings = %d, want 1 (a 1s window is shorter than the idle timeout)", d.LiveMappings())
	}
}

// CloseListener is phase 1 of a shutdown: it must stop NEW mappings WITHOUT
// touching the socket, or the live mappings lose their return path.
func TestDatagramCloseListenerKeepsLiveMappingsServed(t *testing.T) {
	target, stopTarget := udpEchoTarget(t, "close")
	defer stopTarget()

	d := startDatagram(t, "tunex-close-direct", targetPortOf(t, target), DatagramOptions{})
	listenAddr := d.cfg.ListenAddr()
	client := datagramClient(t, listenAddr)
	if got := sendRecv(t, client, []byte("one")); got != "close:one" {
		t.Fatalf("reply = %q", got)
	}

	if !d.CloseListener() {
		t.Fatal("CloseListener must report that it changed the admission state")
	}
	if d.CloseListener() {
		t.Fatal("CloseListener is idempotent: the second call changed nothing")
	}
	if !d.Running() {
		t.Fatal("phase 1 must leave the listener bound")
	}
	if got := sendRecv(t, client, []byte("two")); got != "close:two" {
		t.Fatalf("phase 1 must not break a live mapping's return path, got %q", got)
	}

	fresh := datagramClient(t, listenAddr)
	if _, err := fresh.Write([]byte("new")); err != nil {
		t.Fatalf("send: %v", err)
	}
	expectNoReply(t, fresh, 200*time.Millisecond)
	waitFor(t, 3*time.Second, func() bool { return d.Stats().DropsUnknownSource >= 1 }, "an unknown-source drop")
}

// Shutdown drops the mappings (a UDP mapping cannot finish on its own inside the
// window) and REPORTS how many it dropped, instead of "0 forced, 0 remaining"
// for a tunnel that was relaying.
func TestDatagramShutdownReportsDroppedMappings(t *testing.T) {
	target, stopTarget := udpEchoTarget(t, "shut")
	defer stopTarget()

	d := startDatagram(t, "tunex-shut-direct", targetPortOf(t, target), DatagramOptions{})
	client := datagramClient(t, d.cfg.ListenAddr())
	if got := sendRecv(t, client, []byte("one")); got != "shut:one" {
		t.Fatalf("reply = %q", got)
	}
	if d.LiveMappings() != 1 {
		t.Fatalf("mappings = %d, want 1 before the shutdown", d.LiveMappings())
	}

	result := d.Shutdown(time.Second)
	if !result.ClosedListener {
		t.Fatal("the datagram runtime had not closed admission yet, so phase 1 must report the close")
	}
	if result.ForcedMappings != 1 {
		t.Fatalf("forced mappings = %d, want 1 (the dropped mapping must be reported, not hidden)", result.ForcedMappings)
	}
	if result.RemainingConns != 0 {
		t.Fatalf("remaining = %d, want 0: every mapping's socket was closed", result.RemainingConns)
	}
	if d.Running() || d.LiveMappings() != 0 {
		t.Fatal("after Shutdown the runtime is neither running nor holding mappings")
	}

	// Idempotent, and it must not double-count work that was already dropped.
	again := d.Shutdown(time.Second)
	if again.ClosedListener || again.ForcedMappings != 0 {
		t.Fatalf("second Shutdown = %+v, want a no-op", again)
	}
}

// The A3 channel carries the frozen datagram keys, and no connection fiction.
func TestDatagramProtocolDiagnosticsCarryFrozenKeys(t *testing.T) {
	target, stopTarget := udpEchoTarget(t, "diag")
	defer stopTarget()

	d := startDatagram(t, "tunex-diag-direct", targetPortOf(t, target), DatagramOptions{})
	client := datagramClient(t, d.cfg.ListenAddr())
	if got := sendRecv(t, client, []byte("one")); got != "diag:one" {
		t.Fatalf("reply = %q", got)
	}

	waitForStats(t, d, func(s DatagramStats) bool { return s.PacketsIn == 1 && s.PacketsOut == 1 },
		"the delivered counters to land")
	diag, present := d.ProtocolDiagnostics()
	if !present {
		t.Fatal("a udp tunnel HAS protocol-specific facts; present must be true")
	}
	if diag.Protocol != string(ProtocolUDP) {
		t.Fatalf("protocol = %q, want udp", diag.Protocol)
	}
	if diag.Mappings != 1 || diag.MappingsExpired != 0 {
		t.Fatalf("mappings = %d / expired = %d, want 1 / 0", diag.Mappings, diag.MappingsExpired)
	}
	if diag.PacketsIn != 1 || diag.PacketsOut != 1 || diag.BytesIn != 3 || diag.BytesOut != 8 {
		t.Fatalf("packets/bytes = %d/%d/%d/%d", diag.PacketsIn, diag.PacketsOut, diag.BytesIn, diag.BytesOut)
	}
	if diag.Drops != 0 {
		t.Fatalf("drops = %d, want 0", diag.Drops)
	}
	if diag.IdleTimeoutSeconds != int64(defaultDatagramIdleTimeout/time.Second) {
		t.Fatalf("idle_timeout_seconds = %d, want the runtime's effective timeout", diag.IdleTimeoutSeconds)
	}

	// Pin the wire keys themselves: the gate and the panel read JSON, not Go
	// field names, and a rename here would be silent.
	obj := diagJSON(t, diag)
	for _, key := range []string{
		"protocol", "mappings", "packets_in", "packets_out", "bytes_in",
		"bytes_out", "idle_timeout_seconds",
	} {
		if _, ok := obj[key]; !ok {
			t.Fatalf("diag is missing the frozen key %q (got %v)", key, obj)
		}
	}
	// The keys are a closed, frozen set: a datagram tunnel must not grow the diag
	// object with facts the panel never agreed to read, and the zero-valued
	// counters stay omitted exactly like every other protocol's zero counters.
	for key := range obj {
		if !frozenDatagramDiagKeys[key] {
			t.Fatalf("diag grew an unfrozen key %q (got %v)", key, obj)
		}
	}
	for _, forbidden := range []string{"conns", "connections", "live_conns", "conn_count"} {
		if _, ok := obj[forbidden]; ok {
			t.Fatalf("a datagram diag must not report a connection count, found %q", forbidden)
		}
	}

	// A zero-valued counter is ABSENT rather than reported as 0 (the A3
	// absent-versus-empty rule: the diag object's presence is what says "this
	// protocol has facts"). Once a drop happens, `drops` must appear — otherwise
	// "no drops" and "drops not reported" would be indistinguishable.
	if err := d.DrainMappings(0); err != nil {
		t.Fatalf("DrainMappings: %v", err)
	}
	fresh := datagramClient(t, d.cfg.ListenAddr())
	if _, err := fresh.Write([]byte("new")); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitFor(t, 3*time.Second, func() bool { return d.Stats().Drops > 0 }, "a drop to be counted")
	diag, _ = d.ProtocolDiagnostics()
	obj = diagJSON(t, diag)
	if _, ok := obj["drops"]; !ok {
		t.Fatalf("a non-zero drop count must be reported under the frozen key, got %v", obj)
	}
}

// frozenDatagramDiagKeys is the wire contract for a datagram tunnel's diag
// object. Everything outside it is a new panel-visible fact and must be frozen
// deliberately, not added by accident.
var frozenDatagramDiagKeys = map[string]bool{
	"protocol":             true,
	"mappings":             true,
	"mappings_expired":     true,
	"packets_in":           true,
	"packets_out":          true,
	"bytes_in":             true,
	"bytes_out":            true,
	"drops":                true,
	"idle_timeout_seconds": true,
}

func diagJSON(t *testing.T, diag ProtocolDiagnostics) map[string]any {
	t.Helper()
	raw, err := json.Marshal(diag)
	if err != nil {
		t.Fatalf("marshal diag: %v", err)
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatalf("unmarshal diag: %v", err)
	}
	return obj
}

// A source address the runtime cannot key must not create a table entry (and the
// drop must be visible).
func TestDatagramUnkeyableSourceIsDroppedAndCounted(t *testing.T) {
	target, stopTarget := udpEchoTarget(t, "bogus")
	defer stopTarget()

	d := startDatagram(t, "tunex-bogus-direct", targetPortOf(t, target), DatagramOptions{})

	// Port 0 is not a source a real UDP stack produces; a forged one would create
	// a mapping whose reply can never be delivered.
	d.handleDatagram(&net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0}, []byte("x"))

	stats := d.Stats()
	if stats.Mappings != 0 || stats.MappingsCreated != 0 {
		t.Fatalf("an unkeyable source must not create a mapping, got %d live / %d created", stats.Mappings, stats.MappingsCreated)
	}
	if stats.DropsMalformed != 1 || stats.Drops != 1 {
		t.Fatalf("malformed/drops = %d/%d, want 1/1", stats.DropsMalformed, stats.Drops)
	}
}

// The mapping key is listener identity + NORMALISED client address, and it never
// contains the target (§2.2).
func TestDatagramMappingKeyIsNormalisedAndTargetFree(t *testing.T) {
	d, err := NewDatagram(udpDirectConfig("tunex-key-direct", 20099, 3040), DatagramOptions{})
	if err != nil {
		t.Fatalf("NewDatagram: %v", err)
	}

	v4 := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 5353}
	mapped := &net.UDPAddr{IP: net.ParseIP("::ffff:127.0.0.1"), Port: 5353}
	if got, want := d.mappingKey(mapped), d.mappingKey(v4); got != want {
		t.Fatalf("v4-mapped key %q != v4 key %q: one client would become two mappings", got, want)
	}
	if strings.Contains(d.mappingKey(v4), d.target) {
		t.Fatalf("the mapping key %q must not contain the target %q", d.mappingKey(v4), d.target)
	}
	if !strings.HasPrefix(d.mappingKey(v4), "tunex-key-direct|") {
		t.Fatalf("the mapping key must carry the listener identity, got %q", d.mappingKey(v4))
	}
	// A link-local zone is part of the client's identity.
	zoned := &net.UDPAddr{IP: net.ParseIP("fe80::1"), Port: 5353, Zone: "eth0"}
	if !strings.Contains(d.mappingKey(zoned), "%eth0") {
		t.Fatalf("the zone must be kept in the key, got %q", d.mappingKey(zoned))
	}
}

// Every udp role is now open, and each one names the field it cannot work without.
//
// The relay contract keeps the hop "datagram end to end"
// and lands both halves in the same WP. Validate is where the two new fields show
// up, because a datagram has no handshake to imply them:
//
//   - EGRESS needs `hop_peer`: who may feed this exit;
//   - RELAY needs `next_hop`: where this ingress sends client datagrams.
//
// Each refusal must NAME the missing field: a refusal a reader cannot act on is
// the thing this test exists to prevent.
func TestDatagramValidateOpensAllUdpRolesAndNamesMissingFields(t *testing.T) {
	direct := udpDirectConfig("tunex-1-direct", 20098, 3040)
	if err := direct.Validate(); err != nil {
		t.Fatalf("udp DIRECT must validate: %v", err)
	}
	if direct.Protocol != ProtocolUDP {
		t.Fatalf("protocol normalised to %q, want udp", direct.Protocol)
	}

	// EGRESS without hop_peer: refused, and the refusal names the field.
	egress := direct.Clone()
	egress.Mode = ModeEgress
	egress.EgressPort = direct.IngressPort
	if err := egress.Validate(); err == nil {
		t.Fatal("udp EGRESS must be refused without hop_peer: the exit cannot attest a peer it was not told about")
	} else if !strings.Contains(err.Error(), "hop_peer") {
		t.Fatalf("the EGRESS refusal must name hop_peer, got %v", err)
	}
	attested := egress.Clone()
	attested.HopPeer = "127.0.0.1"
	if err := attested.Validate(); err != nil {
		t.Fatalf("udp EGRESS with hop_peer must validate: %v", err)
	}

	// RELAY without next_hop: refused, and the refusal names the field.
	relay := direct.Clone()
	relay.Mode = ModeRelay
	if err := relay.Validate(); err == nil {
		t.Fatal("udp RELAY must be refused without next_hop")
	} else if !strings.Contains(err.Error(), "next_hop") {
		t.Fatalf("the RELAY refusal must name next_hop, got %v", err)
	}
	relay.NextHop = "127.0.0.1:3040"
	if err := relay.Validate(); err != nil {
		t.Fatalf("udp RELAY with next_hop must validate: %v", err)
	}

	if _, err := NewDatagram(relay, DatagramOptions{}); err == nil {
		t.Fatal("the DIRECT constructor must still refuse a non-DIRECT mode")
	}
}

// The protocol/transport tables are the single source of truth: udp resolves to
// the datagram transport, both registries stay separate, and BuildStream refuses
// a datagram protocol (so it can never be handed to the stream path "for now").
func TestDatagramFactoryRoutingAndAdvertisedFacts(t *testing.T) {
	target, ok := TransportForProtocol(ProtocolUDP)
	if !ok || target != TransportDatagram {
		t.Fatalf("udp must resolve to the datagram transport, got %q/%v", target, ok)
	}
	if !containsString(ImplementedProtocols(), "udp") {
		t.Fatalf("udp must be advertised: %v", ImplementedProtocols())
	}
	if !containsString(ImplementedTransports(), string(TransportDatagram)) {
		t.Fatalf("datagram must be advertised: %v", ImplementedTransports())
	}

	// BuildStream must refuse udp: a datagram protocol behind a stream listener is
	// not a partial implementation, it is a wrong one.
	streamCfg := udpDirectConfig("tunex-1-direct", 1, 3040)
	if _, err := BuildStream(streamCfg, StreamBuildDeps{}); err == nil {
		t.Fatal("BuildStream must refuse a datagram protocol")
	}

	// BuildDatagram must refuse a stream protocol symmetrically.
	tcpCfg := TunnelConfig{ID: "tunex-2-direct", Mode: ModeDirect, IngressPort: 1, RemoteHost: "127.0.0.1", RemotePort: 9000}
	if _, err := BuildDatagram(tcpCfg, DatagramBuildDeps{}); err == nil {
		t.Fatal("BuildDatagram must refuse a stream protocol")
	}

	// BuildRuntime is the manager's entry point and routes by transport.
	built, err := BuildRuntime(streamCfg, BuildDeps{})
	if err != nil {
		t.Fatalf("BuildRuntime(udp): %v", err)
	}
	if _, ok := built.(*DatagramForwarder); !ok {
		t.Fatalf("BuildRuntime(udp) = %T, want a datagram runtime", built)
	}
	if built.Running() {
		t.Fatal("construction must not bind: Start() is the only place that binds")
	}
	if err := built.Stop(); err != nil {
		t.Fatalf("Stop on a never-started datagram runtime must be a no-op: %v", err)
	}

	builtTCP, err := BuildRuntime(tcpCfg, BuildDeps{})
	if err != nil {
		t.Fatalf("BuildRuntime(tcp): %v", err)
	}
	if _, ok := builtTCP.(StreamRuntime); !ok {
		t.Fatalf("BuildRuntime(tcp) = %T, want a stream runtime", builtTCP)
	}
	_ = builtTCP.Stop()
}

func containsString(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// waitForStats polls the runtime's structured facts until they satisfy cond.
//
// The in-direction counter is written AFTER the datagram has been delivered to
// the target (counting is a write-side, delivered-only fact) and a fast target
// can answer before that bookkeeping lands, so "the reply is back" is not proof
// that every counter has caught up. Polling is the honest way to assert on
// cumulative counters; asserting on them immediately would be asserting on a
// scheduling coincidence.
func waitForStats(t *testing.T, d *DatagramForwarder, cond func(DatagramStats) bool, what string) DatagramStats {
	t.Helper()
	var last DatagramStats
	waitFor(t, 3*time.Second, func() bool {
		last = d.Stats()
		return cond(last)
	}, what)
	return last
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool, what string) {
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
