// Package ws is a minimal RFC 6455 WebSocket client implementation built on the
// standard library only.
//
// It supports exactly what the agent needs to speak Socket.IO over WebSocket:
// a client handshake (no extensions, no compression) and unfragmented
// text/binary/ping/pong/close frames. Server->client frames are never masked;
// client->server frames are always masked (per RFC 6455).
package ws

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

// maxFramePayload caps a single inbound frame to guard against memory abuse.
const maxFramePayload = 16 << 20 // 16 MiB

// Conn is a client WebSocket connection.
type Conn struct {
	conn net.Conn
	br   *bufio.Reader

	writeMu sync.Mutex

	readDeadline  time.Time
	writeDeadline time.Time
}

// ErrClosed is returned once the connection is closed.
var ErrClosed = errors.New("ws: connection closed")

// Dial performs the HTTP Upgrade handshake against rawURL. headers may add or
// override request headers (e.g. Authorization).
func Dial(rawURL string, headers http.Header, timeout time.Duration) (*Conn, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("ws: parse url: %w", err)
	}
	host := u.Host
	if u.Port() == "" {
		if u.Scheme == "wss" {
			host += ":443"
		} else {
			host += ":80"
		}
	}
	d := net.Dialer{Timeout: timeout}
	nc, err := d.Dial("tcp", host)
	if err != nil {
		return nil, err
	}

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		nc.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)

	// Build the request path (path + query).
	reqPath := u.Path
	if reqPath == "" {
		reqPath = "/"
	}
	if u.RawQuery != "" {
		reqPath += "?" + u.RawQuery
	}

	var b strings.Builder
	fmt.Fprintf(&b, "GET %s HTTP/1.1\r\n", reqPath)
	fmt.Fprintf(&b, "Host: %s\r\n", u.Host)
	b.WriteString("Upgrade: websocket\r\n")
	b.WriteString("Connection: Upgrade\r\n")
	fmt.Fprintf(&b, "Sec-WebSocket-Key: %s\r\n", key)
	b.WriteString("Sec-WebSocket-Version: 13\r\n")
	if headers != nil {
		for k, vs := range headers {
			if strings.EqualFold(k, "Host") || strings.EqualFold(k, "Upgrade") ||
				strings.EqualFold(k, "Connection") || strings.EqualFold(k, "Sec-WebSocket-Key") ||
				strings.EqualFold(k, "Sec-WebSocket-Version") {
				continue
			}
			for _, v := range vs {
				fmt.Fprintf(&b, "%s: %s\r\n", k, v)
			}
		}
	}
	b.WriteString("\r\n")

	if timeout > 0 {
		nc.SetWriteDeadline(time.Now().Add(timeout))
	}
	if _, err := nc.Write([]byte(b.String())); err != nil {
		nc.Close()
		return nil, err
	}

	br := bufio.NewReader(nc)
	if timeout > 0 {
		nc.SetReadDeadline(time.Now().Add(timeout))
	}
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		nc.Close()
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		resp.Body.Close()
		nc.Close()
		return nil, fmt.Errorf("ws: bad status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if !strings.Contains(strings.ToLower(resp.Header.Get("Upgrade")), "websocket") {
		nc.Close()
		return nil, errors.New("ws: missing Upgrade header in response")
	}
	want := acceptKey(key)
	if got := resp.Header.Get("Sec-WebSocket-Accept"); got != want {
		nc.Close()
		return nil, fmt.Errorf("ws: bad Sec-WebSocket-Accept %q", got)
	}

	// Clear the handshake deadline; callers set their own.
	nc.SetReadDeadline(time.Time{})
	nc.SetWriteDeadline(time.Time{})
	return &Conn{conn: nc, br: br}, nil
}

func acceptKey(key string) string {
	h := sha1.New()
	h.Write([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// SetReadDeadline sets the deadline for future reads.
func (c *Conn) SetReadDeadline(t time.Time) error { return c.conn.SetReadDeadline(t) }

// SetWriteDeadline sets the deadline for future writes.
func (c *Conn) SetWriteDeadline(t time.Time) error { return c.conn.SetWriteDeadline(t) }

// Close closes the underlying connection.
func (c *Conn) Close() error { return c.conn.Close() }

// WriteText sends an unfragmented masked text frame.
func (c *Conn) WriteText(payload []byte) error { return c.writeFrame(opText, payload) }

// WriteBinary sends an unfragmented masked binary frame.
func (c *Conn) WriteBinary(payload []byte) error { return c.writeFrame(opBinary, payload) }

// WritePing sends a masked ping frame.
func (c *Conn) WritePing(payload []byte) error { return c.writeFrame(opPing, payload) }

// WritePong sends a masked pong frame.
func (c *Conn) WritePong(payload []byte) error { return c.writeFrame(opPong, payload) }

func (c *Conn) writeFrame(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	var header [14]byte
	header[0] = 0x80 | opcode // FIN + opcode
	n := len(payload)
	pos := 2
	switch {
	case n < 126:
		header[1] = 0x80 | byte(n)
	case n < 65536:
		header[1] = 0x80 | 126
		binary.BigEndian.PutUint16(header[2:4], uint16(n))
		pos = 4
	default:
		header[1] = 0x80 | 127
		binary.BigEndian.PutUint64(header[2:10], uint64(n))
		pos = 10
	}
	maskKey := make([]byte, 4)
	if _, err := rand.Read(maskKey); err != nil {
		return err
	}
	copy(header[pos:pos+4], maskKey)
	pos += 4

	masked := make([]byte, n)
	for i := 0; i < n; i++ {
		masked[i] = payload[i] ^ maskKey[i%4]
	}

	if _, err := c.conn.Write(header[:pos]); err != nil {
		return err
	}
	if n > 0 {
		if _, err := c.conn.Write(masked); err != nil {
			return err
		}
	}
	return nil
}

// ReadMessage reads the next data message (text or binary), transparently
// answering ping frames with pong and skipping pongs. Close frames return
// io.EOF. Fragmented data frames are reassembled.
func (c *Conn) ReadMessage() (opcode byte, payload []byte, err error) {
	var msgOpcode byte
	var buf []byte
	for {
		fin, op, data, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case opPing:
			_ = c.WritePong(data)
			continue
		case opPong:
			continue
		case opClose:
			_ = c.writeFrame(opClose, data)
			return 0, nil, io.EOF
		case opText, opBinary:
			msgOpcode = op
			buf = append(buf, data...)
			if fin {
				return msgOpcode, buf, nil
			}
		case opContinuation:
			buf = append(buf, data...)
			if fin {
				if msgOpcode == 0 {
					msgOpcode = opBinary
				}
				return msgOpcode, buf, nil
			}
		default:
			return 0, nil, fmt.Errorf("ws: unknown opcode %d", op)
		}
	}
}

// readFrame reads a single frame and returns (fin, opcode, payload).
func (c *Conn) readFrame() (bool, byte, []byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(c.br, hdr[:]); err != nil {
		return false, 0, nil, err
	}
	fin := hdr[0]&0x80 != 0
	opcode := hdr[0] & 0x0f
	masked := hdr[1]&0x80 != 0
	length := int64(hdr[1] & 0x7f)

	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = int64(binary.BigEndian.Uint64(ext[:]))
	}
	if length < 0 || length > maxFramePayload {
		return false, 0, nil, fmt.Errorf("ws: frame too large (%d)", length)
	}

	var maskKey [4]byte
	if masked {
		if _, err := io.ReadFull(c.br, maskKey[:]); err != nil {
			return false, 0, nil, err
		}
	}
	payload := make([]byte, length)
	if length > 0 {
		if _, err := io.ReadFull(c.br, payload); err != nil {
			return false, 0, nil, err
		}
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	return fin, opcode, payload, nil
}
