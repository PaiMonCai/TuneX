// Package mux is a minimal, dependency-free implementation of the xtaci/smux
// version-1 stream multiplexing protocol, which the relayx tunnel uses on top of
// the (WebSocket-wrapped) carrier connection.
//
// Frame header (8 bytes):
//
//	[0]    version (must be 1)
//	[1]    command: 0=SYN 1=FIN 2=PSH 3=NOP 4=UPD
//	[2:4]  length  (little-endian uint16, payload length)
//	[4:8]  stream id (little-endian uint32)
//
// The client uses odd stream ids (starting at 3: nextStreamID starts at 1 and is
// pre-incremented by 2), the server uses even ids. Version 1 has no per-stream
// window updates, but the proxy handles an inbound cmdUPD (8 payload bytes)
// gracefully.
package mux

import (
	"encoding/binary"
	"errors"
	"io"
	"sync"
	"time"
)

const (
	cmdSYN byte = 0
	cmdFIN byte = 1
	cmdPSH byte = 2
	cmdNOP byte = 3
	cmdUPD byte = 4

	version    = 1
	headerSize = 8
	szCmdUPD   = 8
)

// ErrClosed is returned when the session is closed.
var ErrClosed = errors.New("mux: session closed")

// Config tunes the session.
type Config struct {
	MaxFrameSize      int
	KeepAliveInterval time.Duration
	KeepAliveTimeout  time.Duration
	KeepAliveDisabled bool
}

// DefaultConfig mirrors xtaci/smux DefaultConfig.
func DefaultConfig() *Config {
	return &Config{
		MaxFrameSize:      32768,
		KeepAliveInterval: 10 * time.Second,
		KeepAliveTimeout:  30 * time.Second,
	}
}

type frame struct {
	cmd  byte
	sid  uint32
	data []byte
}

// Session is a multiplexed connection.
type Session struct {
	conn io.ReadWriteCloser
	cfg  *Config
	// client uses odd stream ids, server even.
	client bool

	writeMu sync.Mutex
	streams map[uint32]*Stream
	mu      sync.Mutex

	acceptCh chan *Stream
	die      chan struct{}
	dieOnce  sync.Once

	nextID uint32
}

// Client creates a client-side session (odd stream ids).
func Client(conn io.ReadWriteCloser, cfg *Config) (*Session, error) {
	return newSession(conn, cfg, true), nil
}

// Server creates a server-side session (even stream ids).
func Server(conn io.ReadWriteCloser, cfg *Config) *Session {
	return newSession(conn, cfg, false)
}

func newSession(conn io.ReadWriteCloser, cfg *Config, client bool) *Session {
	if cfg == nil {
		cfg = DefaultConfig()
	}
	s := &Session{
		conn:     conn,
		cfg:      cfg,
		client:   client,
		streams:  make(map[uint32]*Stream),
		acceptCh: make(chan *Stream, 1024),
		die:      make(chan struct{}),
	}
	if client {
		s.nextID = 1 // first OpenStream yields 3
	} else {
		s.nextID = 0 // first accepted peer id is 1, server replies with 2
	}
	go s.recvLoop()
	if !cfg.KeepAliveDisabled {
		go s.keepalive()
	}
	return s
}

// OpenStream opens a new stream (client side).
func (s *Session) OpenStream() (*Stream, error) {
	if s.isClosed() {
		return nil, ErrClosed
	}
	s.mu.Lock()
	s.nextID += 2
	sid := s.nextID
	st := newStream(sid, s)
	s.streams[sid] = st
	s.mu.Unlock()

	if err := s.writeFrame(frame{cmd: cmdSYN, sid: sid}); err != nil {
		return nil, err
	}
	return st, nil
}

// AcceptStream blocks until a peer opens a stream (server side).
func (s *Session) AcceptStream() (*Stream, error) {
	select {
	case st := <-s.acceptCh:
		return st, nil
	case <-s.die:
		return nil, ErrClosed
	}
}

// Close closes the session and all streams.
func (s *Session) Close() error {
	s.dieOnce.Do(func() {
		close(s.die)
		s.conn.Close()
	})
	s.mu.Lock()
	for _, st := range s.streams {
		st.closeLocal()
	}
	s.mu.Unlock()
	return nil
}

func (s *Session) isClosed() bool {
	select {
	case <-s.die:
		return true
	default:
		return false
	}
}

func (s *Session) writeFrame(f frame) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	var hdr [headerSize]byte
	hdr[0] = version
	hdr[1] = f.cmd
	binary.LittleEndian.PutUint16(hdr[2:4], uint16(len(f.data)))
	binary.LittleEndian.PutUint32(hdr[4:8], f.sid)
	if _, err := s.conn.Write(hdr[:]); err != nil {
		return err
	}
	if len(f.data) > 0 {
		if _, err := s.conn.Write(f.data); err != nil {
			return err
		}
	}
	return nil
}

func (s *Session) recvLoop() {
	var hdr [headerSize]byte
	for {
		if _, err := io.ReadFull(s.conn, hdr[:]); err != nil {
			s.Close()
			return
		}
		if hdr[0] != version {
			s.Close()
			return
		}
		cmd := hdr[1]
		length := binary.LittleEndian.Uint16(hdr[2:4])
		sid := binary.LittleEndian.Uint32(hdr[4:8])

		var payload []byte
		if length > 0 {
			payload = make([]byte, length)
			if _, err := io.ReadFull(s.conn, payload); err != nil {
				s.Close()
				return
			}
		}

		switch cmd {
		case cmdNOP:
			// keepalive
		case cmdSYN:
			s.mu.Lock()
			if _, ok := s.streams[sid]; !ok {
				st := newStream(sid, s)
				s.streams[sid] = st
				select {
				case s.acceptCh <- st:
				case <-s.die:
				}
			}
			s.mu.Unlock()
		case cmdPSH:
			s.mu.Lock()
			st := s.streams[sid]
			s.mu.Unlock()
			if st != nil && len(payload) > 0 {
				st.pushBytes(payload)
			}
		case cmdFIN:
			s.mu.Lock()
			st := s.streams[sid]
			delete(s.streams, sid)
			s.mu.Unlock()
			if st != nil {
				st.notifyEOF()
			}
		case cmdUPD:
			// version-1 proxy: window updates are ignored.
		default:
			s.Close()
			return
		}
	}
}

func (s *Session) keepalive() {
	t := time.NewTicker(s.cfg.KeepAliveInterval)
	defer t.Stop()
	for {
		select {
		case <-s.die:
			return
		case <-t.C:
			_ = s.writeFrame(frame{cmd: cmdNOP})
		}
	}
}

func (s *Session) removeStream(sid uint32) {
	s.mu.Lock()
	delete(s.streams, sid)
	s.mu.Unlock()
}

// ---------------------------------------------------------------------------

// Stream is one logical stream over a Session.
type Stream struct {
	sess *Session
	sid  uint32

	mu     sync.Mutex
	buf    []byte
	cond   *sync.Cond
	eof    bool
	closed bool
	die    chan struct{}
	once   sync.Once
}

func newStream(sid uint32, sess *Session) *Stream {
	st := &Stream{sess: sess, sid: sid, die: make(chan struct{})}
	st.cond = sync.NewCond(&st.mu)
	return st
}

// ID returns the stream id.
func (s *Stream) ID() uint32 { return s.sid }

// Read implements io.Reader.
func (s *Stream) Read(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for len(s.buf) == 0 {
		if s.closed {
			return 0, io.EOF
		}
		if s.eof {
			return 0, io.EOF
		}
		s.cond.Wait()
	}
	n := copy(p, s.buf)
	s.buf = s.buf[n:]
	return n, nil
}

// Write implements io.Writer, splitting into MaxFrameSize chunks.
func (s *Stream) Write(p []byte) (int, error) {
	maxSize := s.sess.cfg.MaxFrameSize
	if maxSize <= 0 {
		maxSize = 32768
	}
	total := 0
	for len(p) > 0 {
		n := len(p)
		if n > maxSize {
			n = maxSize
		}
		if err := s.sess.writeFrame(frame{cmd: cmdPSH, sid: s.sid, data: p[:n]}); err != nil {
			return total, err
		}
		total += n
		p = p[n:]
	}
	return total, nil
}

// Close sends FIN and tears the stream down.
func (s *Stream) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.mu.Unlock()
	s.cond.Broadcast()
	_ = s.sess.writeFrame(frame{cmd: cmdFIN, sid: s.sid})
	s.sess.removeStream(s.sid)
	return nil
}

// CloseWrite is a v1 no-op alias for Close for stream types that only need a
// half-close; kept for API clarity.
func (s *Stream) CloseWrite() error { return s.Close() }

func (s *Stream) pushBytes(b []byte) {
	s.mu.Lock()
	s.buf = append(s.buf, b...)
	s.mu.Unlock()
	s.cond.Broadcast()
}

func (s *Stream) notifyEOF() {
	s.mu.Lock()
	s.eof = true
	s.mu.Unlock()
	s.cond.Broadcast()
}

func (s *Stream) closeLocal() {
	s.once.Do(func() { close(s.die) })
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	s.cond.Broadcast()
}
