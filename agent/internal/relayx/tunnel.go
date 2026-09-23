// Package relayx implements the RelayX tunnel protocol: a WebSocket-framed,
// smux-multiplexed, Bearer-token-authenticated port-forwarding channel, used
// between agent nodes.
//
// Authentication (verified from the original binary):
//
//	authKey   = HKDF-SHA256(secret, salt=nil, info="relayx-auth-v1", L=32)
//	token(56) = nonce[16] || unixNano[8] BE || HMAC-SHA256(authKey, nonce||ts)[32]
//	header    = Authorization: Bearer <base64(token)>
//
// The listener accepts a token when: a "Bearer " prefix is present, the token is
// exactly 56 bytes, its timestamp is within ±300s of now, the HMAC verifies, and
// the nonce has not been seen before (replay cache).
//
// Handshake (dialer side):
//
//  1. WebSocket upgrade to wss://<node>:<port><randomPath> with the decorative
//     headers the original sends (Origin / Cache-Control / Pragma /
//     Accept-Language / User-Agent).
//  2. Read and discard the server's random padding frame (must be non-empty).
//  3. Start an smux client session over the byte stream and open a stream.
//
// The optional request header "X-Gost-Target" tells a listener which tunnel a
// stream belongs to.
package relayx

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/relayx/agent/internal/mux"
	"github.com/relayx/agent/internal/ws"
)

// HKDFInfo is the fixed HKDF info string.
const HKDFInfo = "relayx-auth-v1"

// TokenBytes is the exact token length the listener enforces.
const TokenBytes = 56

// WindowSeconds is the accepted clock skew for token timestamps.
const WindowSeconds = 300

// DeriveAuthKey derives the 32-byte auth key from a secret using
// HKDF-SHA256(secret, salt=nil, info="relayx-auth-v1", L=32).
func DeriveAuthKey(secret string) []byte {
	return hkdfSHA256([]byte(secret), nil, []byte(HKDFInfo), 32)
}

// hkdfSHA256 implements RFC 5869 HKDF with SHA-256 (extract + expand), so the
// agent does not need golang.org/x/crypto.
func hkdfSHA256(ikm, salt, info []byte, length int) []byte {
	if len(salt) == 0 {
		salt = make([]byte, sha256.Size)
	}
	// Extract.
	extract := hmac.New(sha256.New, salt)
	extract.Write(ikm)
	prk := extract.Sum(nil)

	// Expand.
	var out []byte
	var prev []byte
	counter := byte(1)
	for len(out) < length {
		expand := hmac.New(sha256.New, prk)
		expand.Write(prev)
		expand.Write(info)
		expand.Write([]byte{counter})
		prev = expand.Sum(nil)
		out = append(out, prev...)
		counter++
	}
	return out[:length]
}

// BuildToken builds the 56-byte authentication token.
//
// nonce[16] = random; if reuse is true its first byte's LSB is set (the original
// uses this bit to mark session reuse).
// timestamp[8] = big-endian UnixNano.
func BuildToken(authKey []byte, reuse bool) []byte {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		// fall back to a time-derived nonce rather than panicking
		binary.BigEndian.PutUint64(nonce[:8], uint64(time.Now().UnixNano()))
		binary.BigEndian.PutUint64(nonce[8:], uint64(time.Now().Unix()))
	}
	if reuse {
		nonce[0] |= 0x01
	} else {
		nonce[0] &^= 0x01
	}
	ts := make([]byte, 8)
	binary.BigEndian.PutUint64(ts, uint64(time.Now().UnixNano()))

	mac := hmac.New(sha256.New, authKey)
	mac.Write(nonce)
	mac.Write(ts)
	sig := mac.Sum(nil)

	return append(append(nonce, ts...), sig...)
}

// VerifyToken checks a raw 56-byte token against authKey within the ±300s window.
func VerifyToken(authKey, token []byte) bool {
	if len(token) != TokenBytes {
		return false
	}
	nonce := token[0:16]
	ts := token[16:24]
	sig := token[24:56]
	want := hmac.New(sha256.New, authKey)
	want.Write(nonce)
	want.Write(ts)
	if !hmac.Equal(want.Sum(nil), sig) {
		return false
	}
	nanos := int64(binary.BigEndian.Uint64(ts))
	skew := time.Since(time.Unix(0, nanos))
	if skew < 0 {
		skew = -skew
	}
	return skew <= WindowSeconds*time.Second
}

// ParseBearer extracts the raw token from an Authorization header value.
func ParseBearer(header string) ([]byte, bool) {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return nil, false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(header[len(prefix):]))
	if err != nil {
		// tolerate raw-url / unpadded
		raw, err = base64.RawURLEncoding.DecodeString(strings.TrimSpace(header[len(prefix):]))
		if err != nil {
			return nil, false
		}
	}
	return raw, true
}

// DialOptions configures a relayx client dial.
type DialOptions struct {
	// WSURL is the full ws:// or wss:// URL of the listener (including a random
	// path). Callers build it from the node address + port.
	WSURL  string
	Secret string
	// Target is advertised via the X-Gost-Target header.
	Target string
	// Reuse marks the token's session-reuse bit.
	Reuse    bool
	Timeout  time.Duration
	RandPath bool
}

// Dial connects to a relayx listener and returns an established, multiplexed
// stream ready for bidirectional forwarding.
func Dial(opts DialOptions) (*mux.Stream, *mux.Session, error) {
	if opts.Timeout <= 0 {
		opts.Timeout = 15 * time.Second
	}
	authKey := DeriveAuthKey(opts.Secret)
	token := BuildToken(authKey, opts.Reuse)

	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+base64.StdEncoding.EncodeToString(token))
	headers.Set("Origin", originFromURL(opts.WSURL))
	headers.Set("Cache-Control", "no-cache")
	headers.Set("Pragma", "no-cache")
	headers.Set("Accept-Language", "en-US,en;q=0.9")
	headers.Set("User-Agent", randomUserAgent())
	if opts.Target != "" {
		headers.Set("X-Gost-Target", opts.Target)
	}

	conn, err := ws.Dial(opts.WSURL, headers, opts.Timeout)
	if err != nil {
		return nil, nil, fmt.Errorf("relayx: ws dial: %w", err)
	}

	// Read and discard the server's random padding frame (must be non-empty).
	conn.SetReadDeadline(time.Now().Add(opts.Timeout))
	_, padding, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return nil, nil, fmt.Errorf("relayx: read padding: %w", err)
	}
	if len(padding) == 0 {
		conn.Close()
		return nil, nil, fmt.Errorf("relayx: empty mux signal")
	}
	conn.SetReadDeadline(time.Time{})

	stream := newWSStream(conn)
	sess, err := mux.Client(stream, mux.DefaultConfig())
	if err != nil {
		conn.Close()
		return nil, nil, err
	}
	st, err := sess.OpenStream()
	if err != nil {
		sess.Close()
		return nil, nil, err
	}
	return st, sess, nil
}

// ---------------------------------------------------------------------------
// Byte-stream adapter over the message-framed WebSocket
// ---------------------------------------------------------------------------

type wsStream struct {
	conn *ws.Conn
	rbuf bytes.Buffer
}

func newWSStream(conn *ws.Conn) *wsStream { return &wsStream{conn: conn} }

func (s *wsStream) Read(p []byte) (int, error) {
	for s.rbuf.Len() == 0 {
		_, msg, err := s.conn.ReadMessage()
		if err != nil {
			return 0, err
		}
		if len(msg) == 0 {
			continue
		}
		s.rbuf.Write(msg)
	}
	return s.rbuf.Read(p)
}

func (s *wsStream) Write(p []byte) (int, error) {
	if err := s.conn.WriteBinary(p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (s *wsStream) Close() error { return s.conn.Close() }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func originFromURL(wsURL string) string {
	u := wsURL
	u = strings.TrimPrefix(u, "wss://")
	u = strings.TrimPrefix(u, "ws://")
	if i := strings.IndexByte(u, '/'); i >= 0 {
		u = u[:i]
	}
	return "https://" + u
}

var userAgents = []string{
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:138.0) Gecko/20100101 Firefox/138.0",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0",
}

func randomUserAgent() string {
	if len(userAgents) == 0 {
		return "Mozilla/5.0"
	}
	n, err := rand.Int(rand.Reader, big.NewInt(int64(len(userAgents))))
	if err != nil {
		return userAgents[0]
	}
	return userAgents[n.Int64()]
}

// RandomPath returns a random-looking URL path (any path is accepted by the
// listener; routing does not depend on it).
func RandomPath() string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 12+randomIntn(8))
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(letters))))
		b[i] = letters[n.Int64()]
	}
	return "/" + string(b)
}

func randomIntn(n int) int {
	if n <= 0 {
		return 0
	}
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		return 0
	}
	return int(v.Int64())
}

// AddrFromConnectIP picks the connect address+port to dial a node at.
func AddrFromConnectIP(connectIP string, port int) string {
	ip := strings.TrimSpace(strings.Split(connectIP, ",")[0])
	return net.JoinHostPort(ip, fmt.Sprintf("%d", port))
}
