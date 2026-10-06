// WebSocket front for the stream runtime.
//
// WS wraps **client-facing** traffic. A WS client
// connects to the ingress listener, the frames' payloads are unwrapped into the
// byte stream that is forwarded to the target, and the inter-node hop is
// unchanged. So this file is a **connection adapter**, not a runtime: it takes an
// accepted connection and returns a net.Conn whose bytes are the client's
// payload. Everything downstream — the pipe, drain, stats, the port guard, hot
// reload — is the same code path as plain TCP.
//
// Why hand-rolled instead of a library: the agent is standard-library only
// (`go.mod` has no dependencies, which is what keeps `go build ./...` working
// offline). RFC 6455's framing that a server needs is small and fully specified:
// an HTTP/1.1 upgrade, then unmasked-in / unmasked-out frames. Ping/pong and
// close are handled because a tunnel that ignores them hangs clients that rely
// on them for liveness.
package forwarder

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// wsMagic is the RFC 6455 handshake constant.
const wsMagic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// wsMaxHandshakeBytes bounds what a client may send before we call it a non-WS
// request. Without a bound, a client could stream a body forever and hold a
// tunnel connection open without ever negotiating.
const wsMaxHandshakeBytes = 16 << 10

// WebSocket opcodes (RFC 6455 §5.2).
const (
	wsOpContinuation = 0x0
	wsOpText         = 0x1
	wsOpBinary       = 0x2
	wsOpClose        = 0x8
	wsOpPing         = 0x9
	wsOpPong         = 0xA
)

// ErrWSHandshake is returned when an accepted connection is not a usable
// WebSocket client. It is an expected outcome, not a fault: port scanners and
// health probes hit every listener.
var ErrWSHandshake = errors.New("forwarder: not a websocket client")

// wsAcceptKey computes the Sec-WebSocket-Accept value (RFC 6455 §4.2.2).
func wsAcceptKey(clientKey string) string {
	h := sha1.Sum([]byte(clientKey + wsMagic))
	return base64.StdEncoding.EncodeToString(h[:])
}

// upgradeWebSocket performs the server side of the handshake on an accepted
// connection and returns a net.Conn that speaks the tunnel's byte stream.
//
// The returned conn's Read/Write are the client's **payload**: callers never see
// framing. A non-WS request is refused with ErrWSHandshake, which the accept loop
// turns into "drop this connection, keep serving".
func upgradeWebSocket(conn net.Conn, handshakeTimeout time.Duration) (net.Conn, error) {
	if handshakeTimeout <= 0 {
		handshakeTimeout = 10 * time.Second
	}
	_ = conn.SetDeadline(time.Now().Add(handshakeTimeout))
	defer func() { _ = conn.SetDeadline(time.Time{}) }()

	// Read the handshake header block BYTE BY BYTE from the reader that will
	// serve the frames afterwards, bounded by wsMaxHandshakeBytes.
	//
	// This looks fussy and is not: wrapping the connection in an
	// io.LimitReader instead (the first version) silently capped the WHOLE
	// connection, so any client that sent more than 16 KiB saw its tunnel reset
	// mid-transfer — a limit that was supposed to bound a handshake became a
	// limit on the payload. Reading into a separate bufio.Reader is the mirror
	// image of the same mistake: header bytes and the first frame often arrive in
	// one TCP segment, and a discarded reader would swallow it.
	br := bufio.NewReaderSize(conn, 4096)
	var header bytes.Buffer
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrWSHandshake, err)
		}
		if header.Len()+len(line) > wsMaxHandshakeBytes {
			return nil, fmt.Errorf("%w: header block exceeds %d bytes", ErrWSHandshake, wsMaxHandshakeBytes)
		}
		header.WriteString(line)
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	req, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(header.Bytes())))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrWSHandshake, err)
	}
	if req.Method != http.MethodGet ||
		!strings.EqualFold(strings.TrimSpace(req.Header.Get("Upgrade")), "websocket") ||
		!headerHasToken(req.Header.Get("Connection"), "upgrade") ||
		strings.TrimSpace(req.Header.Get("Sec-WebSocket-Key")) == "" {
		return nil, fmt.Errorf("%w: missing upgrade headers", ErrWSHandshake)
	}
	// Only version 13 is supported: 8 and earlier have a different handshake, and
	// "accepting" them would produce a connection that neither side can frame.
	if v := strings.TrimSpace(req.Header.Get("Sec-WebSocket-Version")); v != "" && v != "13" {
		return nil, fmt.Errorf("%w: unsupported version %q", ErrWSHandshake, v)
	}
	// A subprotocol is not negotiated: the tunnel carries opaque bytes, so there
	// is nothing to agree on. Echoing a client's offer would claim support for a
	// protocol we do not implement.

	accept := wsAcceptKey(strings.TrimSpace(req.Header.Get("Sec-WebSocket-Key")))
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := io.WriteString(conn, resp); err != nil {
		return nil, fmt.Errorf("%w: write handshake: %v", ErrWSHandshake, err)
	}
	return newWSConn(conn, br), nil
}

// headerHasToken reports whether a comma-separated header value contains token
// (case-insensitive). `Connection: keep-alive, Upgrade` is legal and common.
func headerHasToken(value, token string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

// wsConn adapts a WebSocket connection to net.Conn.
//
// Read returns payload bytes from data frames (text and binary alike — the
// tunnel does not interpret them, and refusing text would break the common
// "just connect and send a string" client). Control frames are handled inline:
// ping is answered with pong, close ends the stream with io.EOF, and pong is
// ignored.
type wsConn struct {
	raw net.Conn
	br  *bufio.Reader

	// readBuf holds the remainder of the current frame's payload.
	readBuf []byte

	writeMu sync.Mutex
	closed  bool
}

func newWSConn(raw net.Conn, br *bufio.Reader) *wsConn {
	return &wsConn{raw: raw, br: br}
}

func (c *wsConn) LocalAddr() net.Addr                { return c.raw.LocalAddr() }
func (c *wsConn) RemoteAddr() net.Addr               { return c.raw.RemoteAddr() }
func (c *wsConn) SetDeadline(t time.Time) error      { return c.raw.SetDeadline(t) }
func (c *wsConn) SetReadDeadline(t time.Time) error  { return c.raw.SetReadDeadline(t) }
func (c *wsConn) SetWriteDeadline(t time.Time) error { return c.raw.SetWriteDeadline(t) }

// Close sends a close frame (best effort) and closes the socket.
func (c *wsConn) Close() error {
	c.writeMu.Lock()
	if !c.closed {
		c.closed = true
		_ = writeWSFrame(c.raw, wsOpClose, nil)
	}
	c.writeMu.Unlock()
	return c.raw.Close()
}

// Read returns the next slice of application payload. Payloads are NOT split at
// frame boundaries for the caller: a 1 MiB message arriving as ten frames reads
// like a stream, which is what the pipe expects.
func (c *wsConn) Read(p []byte) (int, error) {
	for {
		if len(c.readBuf) > 0 {
			n := copy(p, c.readBuf)
			c.readBuf = c.readBuf[n:]
			return n, nil
		}
		opcode, payload, err := c.readFrame()
		if err != nil {
			return 0, err
		}
		switch opcode {
		case wsOpContinuation, wsOpText, wsOpBinary:
			if len(payload) == 0 {
				continue
			}
			c.readBuf = payload
		case wsOpPing:
			if err := c.writeControl(wsOpPong, payload); err != nil {
				return 0, err
			}
		case wsOpPong:
			// Liveness is the client's business; nothing to answer.
		case wsOpClose:
			// Answer the close handshake once, then report EOF so the pipe
			// tears the pair down normally.
			_ = c.writeControl(wsOpClose, payload)
			return 0, io.EOF
		default:
			// Unknown opcode (reserved / future): fail this connection rather
			// than guess its framing.
			return 0, fmt.Errorf("forwarder: unsupported websocket opcode 0x%x", opcode)
		}
	}
}

// Write sends payload as one binary frame. Binary (not text) because the tunnel
// carries bytes, not UTF-8: a text frame would let intermediates validate and
// mangle the payload.
func (c *wsConn) Write(p []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed {
		return 0, net.ErrClosed
	}
	if err := writeWSFrame(c.raw, wsOpBinary, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *wsConn) writeControl(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed {
		return net.ErrClosed
	}
	return writeWSFrame(c.raw, opcode, payload)
}

// readFrame reads one frame and returns its opcode and unmasked payload.
//
// Client-to-server frames MUST be masked (RFC 6455 §5.1) and the payload must be
// unmasked before use — forgetting that is the classic WS bug where the tunnel
// "works" for small tests and corrupts real traffic.
func (c *wsConn) readFrame() (byte, []byte, error) {
	var header [2]byte
	if _, err := io.ReadFull(c.br, header[:]); err != nil {
		return 0, nil, err
	}
	fin := header[0]&0x80 != 0
	opcode := header[0] & 0x0F
	masked := header[1]&0x80 != 0
	length := int64(header[1] & 0x7F)

	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return 0, nil, err
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return 0, nil, err
		}
		length = int64(binary.BigEndian.Uint64(ext[:]))
		if length < 0 {
			return 0, nil, errors.New("forwarder: websocket frame length overflow")
		}
	}
	if !masked {
		// Refuse instead of accepting unmasked client frames: RFC 6455 makes
		// masking mandatory precisely so intermediaries cannot be tricked into
		// interpreting frame bytes as a request.
		return 0, nil, errors.New("forwarder: client websocket frame is not masked")
	}
	var mask [4]byte
	if _, err := io.ReadFull(c.br, mask[:]); err != nil {
		return 0, nil, err
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.br, payload); err != nil {
		return 0, nil, err
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	if !fin && opcode != wsOpContinuation && opcode >= 0x8 {
		// Fragmented control frames are illegal; a control frame must fit in one
		// frame. Failing here keeps the state machine honest.
		return 0, nil, errors.New("forwarder: fragmented websocket control frame")
	}
	return opcode, payload, nil
}

// writeWSFrame writes one server frame (never masked, per RFC 6455 §5.1).
func writeWSFrame(w io.Writer, opcode byte, payload []byte) error {
	var header []byte
	first := byte(0x80) | opcode
	n := len(payload)
	switch {
	case n < 126:
		header = []byte{first, byte(n)}
	case n <= 0xFFFF:
		header = []byte{first, 126, 0, 0}
		binary.BigEndian.PutUint16(header[2:], uint16(n))
	default:
		header = make([]byte, 10)
		header[0] = first
		header[1] = 127
		binary.BigEndian.PutUint64(header[2:], uint64(n))
	}
	if _, err := w.Write(header); err != nil {
		return err
	}
	if n == 0 {
		return nil
	}
	_, err := w.Write(payload)
	return err
}
