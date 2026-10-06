package forwarder

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// WebSocket front tests.
//
// The claim: a WS client's frame payloads become the tunnel's byte stream, and
// everything else about the stream lifecycle is unchanged. So the tests cover
// the handshake, the framing both ways, and the three ways a client can be not-a
// -WS-client (which must cost only that connection, never the listener).

// wsClient is a minimal RFC 6455 client: enough to prove the server's framing
// without pulling in a library the agent itself refuses to depend on.
type wsClient struct {
	conn net.Conn
	br   *bufio.Reader
}

func wsDial(t *testing.T, addr string) *wsClient {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	key := make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("rand: %v", err)
	}
	encoded := base64.StdEncoding.EncodeToString(key)
	req := fmt.Sprintf("GET / HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", addr, encoded)
	if _, err := io.WriteString(conn, req); err != nil {
		t.Fatalf("write handshake: %v", err)
	}
	br := bufio.NewReader(conn)
	status, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("read status: %v", err)
	}
	if !strings.Contains(status, "101") {
		t.Fatalf("server did not switch protocols: %q", status)
	}
	want := ""
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("read headers: %v", err)
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			break
		}
		if strings.HasPrefix(strings.ToLower(trimmed), "sec-websocket-accept:") {
			want = strings.TrimSpace(trimmed[len("sec-websocket-accept:"):])
		}
	}
	sum := sha1.Sum([]byte(encoded + wsMagic))
	if want != base64.StdEncoding.EncodeToString(sum[:]) {
		t.Fatalf("Sec-WebSocket-Accept mismatch: got %q", want)
	}
	return &wsClient{conn: conn, br: br}
}

// send writes one MASKED frame (clients must mask) and returns nothing.
func (c *wsClient) send(t *testing.T, opcode byte, payload []byte) {
	t.Helper()
	var header []byte
	first := byte(0x80) | opcode
	mask := []byte{0x11, 0x22, 0x33, 0x44}
	n := len(payload)
	switch {
	case n < 126:
		header = []byte{first, 0x80 | byte(n)}
	case n <= 0xFFFF:
		header = []byte{first, 0x80 | 126, 0, 0}
		binary.BigEndian.PutUint16(header[2:], uint16(n))
	default:
		header = make([]byte, 10)
		header[0] = first
		header[1] = 0x80 | 127
		binary.BigEndian.PutUint64(header[2:], uint64(n))
	}
	header = append(header, mask...)
	masked := make([]byte, n)
	for i := range payload {
		masked[i] = payload[i] ^ mask[i%4]
	}
	if _, err := c.conn.Write(append(header, masked...)); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}

// recv reads one server frame and returns its opcode and payload.
func (c *wsClient) recv(t *testing.T) (byte, []byte) {
	t.Helper()
	var header [2]byte
	if _, err := io.ReadFull(c.br, header[:]); err != nil {
		t.Fatalf("read frame header: %v", err)
	}
	opcode := header[0] & 0x0F
	if header[1]&0x80 != 0 {
		t.Fatal("server frames must NOT be masked (RFC 6455 §5.1)")
	}
	length := int64(header[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			t.Fatalf("read ext len: %v", err)
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			t.Fatalf("read ext len: %v", err)
		}
		length = int64(binary.BigEndian.Uint64(ext[:]))
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.br, payload); err != nil {
		t.Fatalf("read payload: %v", err)
	}
	return opcode, payload
}

func (c *wsClient) close() { _ = c.conn.Close() }

func wsConfig(t *testing.T, target string) TunnelConfig {
	t.Helper()
	host, port := splitTarget(t, target)
	return TunnelConfig{
		ID:          "tunex-1-direct",
		Mode:        ModeDirect,
		IngressPort: freePort(t),
		RemoteHost:  host,
		RemotePort:  port,
		Protocol:    ProtocolWS,
		Revision:    1,
	}
}

// A WS client really upgrades, and its frame payloads come back from the target.
func TestWSDirectUpgradesAndForwards(t *testing.T) {
	target, stopTarget := echoTarget(t)
	defer stopTarget()

	cfg := wsConfig(t, target)
	runtime, err := BuildStream(cfg, StreamBuildDeps{})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = runtime.Stop() }()

	client := wsDial(t, cfg.ListenAddr())
	defer client.close()

	client.send(t, wsOpBinary, []byte("ws-payload"))
	opcode, payload := client.recv(t)
	if opcode != wsOpBinary {
		t.Fatalf("server replied with opcode 0x%x, want binary", opcode)
	}
	if string(payload) != "ws-payload" {
		t.Fatalf("echo = %q, want %q", payload, "ws-payload")
	}
	if !runtime.Running() {
		t.Fatal("a served WebSocket connection must not stop the listener")
	}
	if runtime.Stats() == 0 {
		t.Fatal("Stats must count the bytes forwarded through the WS front")
	}
}

// Text frames carry opaque bytes too: the tunnel does not interpret them, and
// refusing text would break the "just connect and send a string" client.
func TestWSTextFramesCarryOpaqueBytes(t *testing.T) {
	target, stopTarget := echoTarget(t)
	defer stopTarget()

	cfg := wsConfig(t, target)
	runtime, err := BuildStream(cfg, StreamBuildDeps{})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = runtime.Stop() }()

	client := wsDial(t, cfg.ListenAddr())
	defer client.close()
	client.send(t, wsOpText, []byte("hello-as-text"))
	_, payload := client.recv(t)
	if string(payload) != "hello-as-text" {
		t.Fatalf("echo = %q, want the text frame's payload", payload)
	}
}

// A payload larger than 125 bytes exercises the extended-length path in both
// directions — the point where a hand-rolled framer usually breaks.
func TestWSLargePayloadUsesExtendedLength(t *testing.T) {
	target, stopTarget := echoTarget(t)
	defer stopTarget()

	cfg := wsConfig(t, target)
	runtime, err := BuildStream(cfg, StreamBuildDeps{})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = runtime.Stop() }()

	client := wsDial(t, cfg.ListenAddr())
	defer client.close()

	big := bytes.Repeat([]byte("tunex-"), 6000) // 36 000 bytes
	client.send(t, wsOpBinary, big)
	got := make([]byte, 0, len(big))
	for len(got) < len(big) {
		_, payload := client.recv(t)
		got = append(got, payload...)
	}
	if !bytes.Equal(got, big) {
		t.Fatalf("large payload round-trip mismatch: got %d bytes, want %d", len(got), len(big))
	}
}

// Ping is answered with pong so clients that rely on it for liveness do not
// hang; the data stream is unaffected.
func TestWSPingIsAnsweredWithPong(t *testing.T) {
	target, stopTarget := echoTarget(t)
	defer stopTarget()

	cfg := wsConfig(t, target)
	runtime, err := BuildStream(cfg, StreamBuildDeps{})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = runtime.Stop() }()

	client := wsDial(t, cfg.ListenAddr())
	defer client.close()
	client.send(t, wsOpPing, []byte("are-you-there"))
	opcode, payload := client.recv(t)
	if opcode != wsOpPong || string(payload) != "are-you-there" {
		t.Fatalf("ping not answered: opcode=0x%x payload=%q", opcode, payload)
	}
}

// A non-WS request must be refused WITHOUT taking the listener down, and a real
// client must still be served afterwards.
func TestWSRejectsPlainHTTPAndKeepsServing(t *testing.T) {
	target, stopTarget := echoTarget(t)
	defer stopTarget()

	cfg := wsConfig(t, target)
	runtime, err := BuildStream(cfg, StreamBuildDeps{})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = runtime.Stop() }()

	conn, err := net.DialTimeout("tcp", cfg.ListenAddr(), 5*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_, _ = io.WriteString(conn, "GET / HTTP/1.1\r\nHost: x\r\n\r\n")
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 64)
	if n, err := conn.Read(buf); err == nil && strings.Contains(string(buf[:n]), "101") {
		t.Fatal("a plain HTTP request must not be upgraded")
	}
	_ = conn.Close()

	if !runtime.Running() {
		t.Fatal("a refused handshake must not take the listener down")
	}
	client := wsDial(t, cfg.ListenAddr())
	defer client.close()
	client.send(t, wsOpBinary, []byte("still-serving"))
	if _, payload := client.recv(t); string(payload) != "still-serving" {
		t.Fatalf("echo after the refused handshake = %q", payload)
	}
}

// An unmasked client frame is a protocol violation and must fail the connection
// rather than be interpreted: accepting it is how intermediaries get tricked.
//
// The assertion is "no echo", not "no bytes": the server answers a bad client by
// closing the connection, and the close frame it sends first is a byte the client
// can read. What must never arrive is the payload — that would mean the unmasked
// frame was forwarded.
func TestWSUnmaskedClientFrameIsRefused(t *testing.T) {
	target, stopTarget := echoTarget(t)
	defer stopTarget()

	cfg := wsConfig(t, target)
	runtime, err := BuildStream(cfg, StreamBuildDeps{})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = runtime.Stop() }()

	client := wsDial(t, cfg.ListenAddr())
	defer client.close()
	// opcode=binary, NO mask bit, length 4 — the payload must not be forwarded.
	if _, err := client.conn.Write([]byte{0x82, 0x04, 'h', 'i', '!', '!'}); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = client.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var header [2]byte
	if _, err := io.ReadFull(client.br, header[:]); err != nil {
		// EOF/reset is an equally correct refusal.
		return
	}
	opcode := header[0] & 0x0F
	if opcode != wsOpClose {
		t.Fatalf("expected the connection to be closed, got opcode 0x%x", opcode)
	}
	length := int(header[1] & 0x7F)
	payload := make([]byte, length)
	if length > 0 {
		_, _ = io.ReadFull(client.br, payload)
	}
	if strings.Contains(string(payload), "hi!!") {
		t.Fatal("the unmasked frame's payload was echoed: it must be refused, not forwarded")
	}
}

// The absolute client key from RFC 6455 §1.3 must produce the documented accept
// value: this is the one part of the handshake with a published test vector, and
// getting it wrong makes every real browser client fail.
func TestWSAcceptKeyMatchesRFC6455Vector(t *testing.T) {
	const key = "dGhlIHNhbXBsZSBub25jZQ=="
	const want = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
	if got := wsAcceptKey(key); got != want {
		t.Fatalf("wsAcceptKey = %q, want %q", got, want)
	}
}

// EGRESS keeps a plain listener: the egress node faces the ingress node.
func TestWSCannotBeUsedForEgress(t *testing.T) {
	cfg := wsConfig(t, "127.0.0.1:9")
	cfg.Mode = ModeEgress
	cfg.EgressPort = 30001
	if err := cfg.Validate(); err == nil {
		t.Fatal("ws on an EGRESS tunnel must not validate")
	}
}

// The handshake is bounded: a client that connects and says nothing must not
// hold a tunnel connection forever.
func TestWSHandshakeTimeoutDropsSilentClient(t *testing.T) {
	target, stopTarget := echoTarget(t)
	defer stopTarget()

	cfg := wsConfig(t, target)
	runtime, err := BuildStream(cfg, StreamBuildDeps{HandshakeTimeout: 150 * time.Millisecond})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = runtime.Stop() }()

	conn, err := net.DialTimeout("tcp", cfg.ListenAddr(), 5*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Read(make([]byte, 16)); err == nil {
		t.Fatal("a silent client must be dropped when the handshake window closes")
	}
	if !runtime.Running() {
		t.Fatal("dropping a silent client must not take the listener down")
	}
}
