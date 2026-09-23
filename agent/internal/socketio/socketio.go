// Package socketio implements the slice of Engine.IO v4 / Socket.IO v3 that the
// agent needs: connect over WebSocket, send/ack events, receive events and keep
// the engine.io heartbeat alive.
//
// Packet recap (Engine.IO v4):
//
//	0 open | 1 close | 2 ping | 3 pong | 4 message
//
// Socket.IO framing on top of an engine "message" (4):
//
//	0 connect | 1 disconnect | 2 event | 3 ack | 4 connect_error | 5 binary_event
//
// So a plain event is "42<json-array>", an event with an ack id is
// "42<id><json-array>", and an ack to event id N is "43<id><json-array>".
// ⚠️ "44" is the Socket.IO ERROR packet, NOT an ack (a classic trap).
package socketio

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tunex/agent/internal/ws"
)

// Packet type constants.
const (
	engineOpen    = '0'
	engineClose   = '1'
	enginePing    = '2'
	enginePong    = '3'
	engineMessage = '4'

	sioConnect      = '0'
	sioDisconnect   = '1'
	sioEvent        = '2'
	sioAck          = '3'
	sioConnectError = '4'
)

// OpenPacket is the Engine.IO handshake payload.
type OpenPacket struct {
	SID          string   `json:"sid"`
	Upgrades     []string `json:"upgrades"`
	PingInterval int      `json:"pingInterval"` // ms
	PingTimeout  int      `json:"pingTimeout"`  // ms
}

// Handler is invoked for an inbound Socket.IO event. args are the decoded JSON
// arguments after the event name.
type Handler func(args []json.RawMessage)

// Client is a connected Socket.IO client.
type Client struct {
	conn      *ws.Conn
	open      OpenPacket
	namespace string

	handlersMu sync.RWMutex
	handlers   map[string]Handler

	ackMu   sync.Mutex
	nextID  uint64
	pending map[uint64]chan []json.RawMessage

	writeMu sync.Mutex
	closed  chan struct{}
	closeMu sync.Once

	// ready is closed after the server accepts the Socket.IO CONNECT.
	ready   chan struct{}
	readyMu sync.Once

	onClose func()
}

// Options configures a connection.
type Options struct {
	ServerURL string
	Token     string // node group token, sent in the Socket.IO CONNECT payload
	Namespace string // defaults to "/"
	Headers   http.Header
	Timeout   time.Duration
}

// Connect dials the server and completes the Engine.IO + Socket.IO handshakes.
func Connect(opts Options) (*Client, error) {
	namespace := opts.Namespace
	if namespace == "" {
		namespace = "/"
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	wsURL, err := socketIOURL(opts.ServerURL)
	if err != nil {
		return nil, err
	}
	conn, err := ws.Dial(wsURL, opts.Headers, timeout)
	if err != nil {
		return nil, err
	}

	c := &Client{
		conn:      conn,
		namespace: namespace,
		handlers:  make(map[string]Handler),
		pending:   make(map[uint64]chan []json.RawMessage),
		closed:    make(chan struct{}),
		ready:     make(chan struct{}),
	}

	// The first frame must be the Engine.IO open packet.
	conn.SetReadDeadline(time.Now().Add(timeout))
	_, payload, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return nil, err
	}
	if len(payload) == 0 || payload[0] != engineOpen {
		conn.Close()
		return nil, fmt.Errorf("socketio: expected engine.io open packet, got %q", truncate(payload))
	}
	if err := json.Unmarshal(payload[1:], &c.open); err != nil {
		conn.Close()
		return nil, fmt.Errorf("socketio: bad open packet: %w", err)
	}
	conn.SetReadDeadline(time.Time{})

	// Send the Socket.IO CONNECT packet with our auth token. The default
	// namespace "/" must be omitted from the packet (no "/" prefix).
	connectPayload, _ := json.Marshal(map[string]string{"token": opts.Token})
	if err := c.writePacket([]byte("4" + c.nsPrefix() + "0" + string(connectPayload))); err != nil {
		conn.Close()
		return nil, err
	}

	go c.readLoop()
	go c.pingLoop()

	// Wait for the CONNECT ack (or timeout).
	select {
	case <-c.ready:
	case <-time.After(timeout):
		conn.Close()
		return nil, fmt.Errorf("socketio: connect ack timed out")
	case <-c.closed:
		return nil, fmt.Errorf("socketio: connection closed during handshake")
	}
	return c, nil
}

// SetOnClose registers a callback fired once the connection drops.
func (c *Client) SetOnClose(fn func()) { c.onClose = fn }

// On registers an event handler.
func (c *Client) On(event string, h Handler) {
	c.handlersMu.Lock()
	defer c.handlersMu.Unlock()
	c.handlers[event] = h
}

// Emit sends an event with no ack. args are JSON-marshalled.
func (c *Client) Emit(event string, args ...any) error {
	return c.emit(event, nil, args...)
}

// EmitWithAck sends an event with an ack id and waits for the ack.
func (c *Client) EmitWithAck(timeout time.Duration, event string, args ...any) ([]json.RawMessage, error) {
	ch := make(chan []json.RawMessage, 1)
	id := atomic.AddUint64(&c.nextID, 1) - 1
	c.ackMu.Lock()
	c.pending[id] = ch
	c.ackMu.Unlock()

	if err := c.emit(event, &id, args...); err != nil {
		c.ackMu.Lock()
		delete(c.pending, id)
		c.ackMu.Unlock()
		return nil, err
	}
	select {
	case res := <-ch:
		return res, nil
	case <-time.After(timeout):
		c.ackMu.Lock()
		delete(c.pending, id)
		c.ackMu.Unlock()
		return nil, fmt.Errorf("socketio: ack timeout for %q", event)
	case <-c.closed:
		return nil, fmt.Errorf("socketio: closed before ack for %q", event)
	}
}

func (c *Client) emit(event string, ackID *uint64, args ...any) error {
	arr := make([]any, 0, len(args)+1)
	arr = append(arr, event)
	arr = append(arr, args...)
	body, err := json.Marshal(arr)
	if err != nil {
		return err
	}
	var prefix string
	if ackID != nil {
		prefix = "42" + strconv.FormatUint(*ackID, 10)
	} else {
		prefix = "42"
	}
	return c.writePacket(append([]byte(prefix), body...))
}

func (c *Client) writePacket(p []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.WriteText(p)
}

// Close tears down the connection.
func (c *Client) Close() {
	c.closeMu.Do(func() {
		close(c.closed)
		c.conn.Close()
	})
}

func (c *Client) closeWithCallback() {
	c.closeMu.Do(func() {
		close(c.closed)
		c.conn.Close()
	})
	if c.onClose != nil {
		c.onClose()
	}
}

// Done returns a channel closed when the connection ends.
func (c *Client) Done() <-chan struct{} { return c.closed }

// pingLoop replies to engine.io pings (type '2') with pongs ('3') and keeps the
// read side fresh. It is conservative: it does not send unsolicited pings
// because the tunex-clone Socket.IO server sends its own pings.
func (c *Client) pingLoop() {
	interval := time.Duration(c.open.PingInterval) * time.Millisecond
	if interval <= 0 {
		interval = 25 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-c.closed:
			return
		case <-t.C:
			// A pong in response to a server ping is sent from readLoop; here we
			// simply keep the ticker so a dead readLoop is noticed elsewhere.
		}
	}
}

func (c *Client) readLoop() {
	for {
		payload, ok := c.readOnce()
		if !ok {
			c.closeWithCallback()
			return
		}
		if payload == nil {
			continue
		}
		c.handlePacket(payload)
	}
}

// readOnce reads one engine.io frame. Returns (nil, true) for frames handled
// internally, (payload, true) for messages to dispatch, (nil, false) on error.
func (c *Client) readOnce() ([]byte, bool) {
	// Keep a read deadline generous but bounded so a half-open socket is caught.
	c.conn.SetReadDeadline(time.Now().Add(c.readTimeout()))
	_, msg, err := c.conn.ReadMessage()
	if err != nil {
		return nil, false
	}
	if len(msg) == 0 {
		return nil, true
	}
	switch msg[0] {
	case enginePing:
		_ = c.writePacket([]byte{enginePong})
		return nil, true
	case enginePong:
		return nil, true
	case engineClose:
		return nil, false
	case engineMessage:
		return msg[1:], true
	case engineOpen:
		// Re-open is unexpected mid-stream; ignore.
		return nil, true
	default:
		return nil, true
	}
}

func (c *Client) readTimeout() time.Duration {
	pt := time.Duration(c.open.PingTimeout) * time.Millisecond
	if pt <= 0 {
		pt = 20 * time.Second
	}
	pi := time.Duration(c.open.PingInterval) * time.Millisecond
	if pi <= 0 {
		pi = 25 * time.Second
	}
	return pi + pt + 30*time.Second
}

func (c *Client) handlePacket(p []byte) {
	if len(p) == 0 {
		return
	}
	// Strip an optional "/namespace," prefix.
	if p[0] == '/' {
		if i := indexByte(p, ','); i >= 0 {
			p = p[i+1:]
		}
		if len(p) == 0 {
			return
		}
	}
	switch p[0] {
	case sioConnect:
		// "40{sid...}" (namespace ack) or "40/ns,{sid...}".
		c.readyMu.Do(func() { close(c.ready) })
	case sioDisconnect:
		c.closeWithCallback()
	case sioConnectError:
		// Server rejected us (bad token). Drop the connection to trigger retry.
		c.closeWithCallback()
	case sioEvent:
		c.handleEvent(p)
	case sioAck:
		// "43<id>[json]" — an ack to one of our events.
		c.handleAck(p)
	default:
		// ignore unknown
	}
}

// handleEvent parses "42[<id>]<json-array>".
func (c *Client) handleEvent(p []byte) {
	rest := p[1:]
	var ackID *uint64
	// Optional numeric ack id before the JSON array.
	i := 0
	for i < len(rest) && rest[i] >= '0' && rest[i] <= '9' {
		i++
	}
	if i > 0 {
		id, err := strconv.ParseUint(string(rest[:i]), 10, 64)
		if err == nil {
			ackID = &id
		}
	}
	jsonPart := rest[i:]
	if len(jsonPart) == 0 || jsonPart[0] != '[' {
		return
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(jsonPart, &arr); err != nil {
		return
	}
	if len(arr) == 0 {
		return
	}
	var name string
	if err := json.Unmarshal(arr[0], &name); err != nil {
		return
	}
	args := arr[1:]
	// Dispatch to the handler; for acked events, reply with an empty ack once
	// the handler returns so the server's acknowledgement resolves.
	if h := c.lookup(name); h != nil {
		h(args)
	}
	if ackID != nil {
		body, _ := json.Marshal([]any{})
		_ = c.writePacket(append([]byte("43"+strconv.FormatUint(*ackID, 10)), body...))
	}
}

// handleAck parses "43<json-array>" (ack with id 0) — the register ACK frame is
// "430[{..}]" where 0 is the ack id.
func (c *Client) handleAck(p []byte) {
	rest := p[1:]
	i := 0
	for i < len(rest) && rest[i] >= '0' && rest[i] <= '9' {
		i++
	}
	if i == 0 {
		return
	}
	id, err := strconv.ParseUint(string(rest[:i]), 10, 64)
	if err != nil {
		return
	}
	jsonPart := rest[i:]
	var arr []json.RawMessage
	if len(jsonPart) == 0 || json.Unmarshal(jsonPart, &arr) != nil {
		return
	}
	c.ackMu.Lock()
	ch := c.pending[id]
	delete(c.pending, id)
	c.ackMu.Unlock()
	if ch != nil {
		select {
		case ch <- arr:
		default:
		}
	}
}

func (c *Client) lookup(name string) Handler {
	c.handlersMu.RLock()
	defer c.handlersMu.RUnlock()
	return c.handlers[name]
}

// nsPrefix returns the namespace prefix for Socket.IO packets: empty for the
// default namespace "/", otherwise "/name,".
func (c *Client) nsPrefix() string {
	if c.namespace == "" || c.namespace == "/" {
		return ""
	}
	return c.namespace + ","
}

func socketIOURL(serverURL string) (string, error) {
	// serverURL is http(s)://host[:port]; convert to ws(s)://host/socket.io?EIO=4&transport=websocket
	trimmed := serverURL
	scheme := "ws"
	if len(trimmed) >= 8 && trimmed[:8] == "https://" {
		scheme = "wss"
		trimmed = trimmed[8:]
	} else if len(trimmed) >= 7 && trimmed[:7] == "http://" {
		trimmed = trimmed[7:]
	} else {
		return "", fmt.Errorf("socketio: unsupported server url %q", serverURL)
	}
	return fmt.Sprintf("%s://%s/socket.io/?EIO=4&transport=websocket", scheme, trimmed), nil
}

func truncate(b []byte) string {
	if len(b) > 120 {
		return string(b[:120]) + "..."
	}
	return string(b)
}

func indexByte(b []byte, c byte) int {
	for i := range b {
		if b[i] == c {
			return i
		}
	}
	return -1
}
