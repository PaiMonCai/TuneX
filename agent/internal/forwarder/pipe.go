package forwarder

import (
	"io"
	"net"
	"sync/atomic"
)

// byteCounter accumulates transferred bytes. The zero value is ready to use.
type byteCounter struct{ n int64 }

func (c *byteCounter) add(delta int64) { atomic.AddInt64(&c.n, delta) }

func (c *byteCounter) load() int64 { return atomic.LoadInt64(&c.n) }

// relayBuffer is one read chunk. 32KiB matches io.Copy's own default and keeps
// the syscall count sane on a bulk transfer.
const relayBuffer = 32 * 1024

// writeAll keeps writing until p is fully written or an error occurs, and
// reports how many bytes actually landed.
func writeAll(w io.Writer, p []byte) (int, error) {
	var written int
	for written < len(p) {
		n, err := w.Write(p[written:])
		written += n
		if err != nil {
			return written, err
		}
		if n == 0 {
			return written, io.ErrShortWrite
		}
	}
	return written, nil
}

// copyOne relays one direction and counts the bytes that actually reached the
// destination. The loop is driven by hand instead of delegating to io.Copy on
// purpose: io.Copy asks the *destination* whether it implements io.ReaderFrom
// and hands control to (*net.TCPConn).ReadFrom, whose fast paths never call
// Read on anything we wrapped on the other side. Wrapping the source to count
// therefore silently under-counts real traffic; counting on the write side is
// also the more honest accounting — it bills bytes delivered, not bytes seen.
//
// c is the counter the delivered bytes are added to. Pass nil to disable
// counting.
//
// A nil dst means "this direction is a sink": data is drained and discarded
// (PipeConns uses it when the peer's write side is gone and this side's
// remaining output has nowhere to go).
func copyOne(dst io.Writer, src io.Reader, c *byteCounter) {
	if src == nil {
		return
	}
	buf := make([]byte, relayBuffer)
	for {
		nr, rerr := src.Read(buf)
		if nr > 0 {
			if dst == nil {
				// Drain the peer anyway so it sees a closed connection
				// rather than a stalled one.
				continue
			}
			nw, werr := writeAll(dst, buf[:nr])
			if c != nil {
				c.add(int64(nw))
			}
			if werr != nil {
				return
			}
		}
		if rerr != nil {
			// io.EOF and any connection error both end the direction.
			return
		}
	}
}

// pairCounterOf returns the per-connection counter one side of the pair owns,
// or nil when neither does. When a wrapper is present its counter meters the
// WHOLE connection: copyOne hands it both directions, so a target is billed
// everything it carried rather than half of it, and the caller folds that total
// into the shared counter once — every byte is counted exactly once.
func pairCounterOf(a, b net.Conn) *byteCounter {
	for _, c := range []net.Conn{a, b} {
		if cc, ok := c.(counterCarrier); ok {
			if n := cc.ownCounter(); n != nil {
				return n
			}
		}
	}
	return nil
}

// Pipe relays bytes in both directions between a and b, counting everything
// into c (nil disables counting). It returns once both directions are done and
// leaves both ends open, so the caller decides how to close them.
//
// It never half-closes. net.Pipe cannot express a half-close at all, and the
// callers that own real TCP connections use PipeConns instead.
func Pipe(a, b io.ReadWriter, c *byteCounter) {
	done := make(chan struct{}, 2)
	go func() { copyOne(a, b, c); done <- struct{}{} }()
	go func() { copyOne(b, a, c); done <- struct{}{} }()
	<-done
	<-done
}

// PipeConns relays bytes between a connection pair with TCP half-close support:
// as soon as a direction sees EOF, the *destination* peer's write side is
// closed (CloseWrite) so the peer learns no more data is coming, while the
// relay keeps draining the other direction until it really finishes.
//
// Propagation is deliberately one-sided per direction. When a's write side is
// gone (dirA hit EOF) only b gets CloseWrite: a's write side must stay open
// because dirB still has upstream data to deliver to a. Closing both ends on
// the first EOF is the classic proxy bug — a client that finished sending its
// request (HTTP/1.0, or a curl that closed the request body) would still
// expect the upstream's response, and tearing the connection down here
// silently truncates it.
//
// The half-close also makes the destination's read side report EOF (a
// half-closed TCP conn reads EOF), which is what actually terminates the
// symmetric non-TCP transport (net.Pipe, TLS), where one side closing is the
// only end-of-stream signal.
//
// Both conns are left open; the caller owns the final Close (base.go's
// handleConn defers both, so Stop still drains in-flight pairs).
func PipeConns(a, b net.Conn, c *byteCounter) {
	// When one side carries its own counter (the egress forwarder bills its
	// targets this way) the pair is metered into it instead of the shared
	// tracker, so attribution stays exact under concurrency. The shared
	// total is then topped up by exactly that connection's total once — no
	// byte is counted twice and none is lost.
	own := pairCounterOf(a, b)
	meter := c
	if own != nil {
		meter = own
	}
	defer func() {
		if own != nil && c != nil {
			c.add(own.load())
		}
	}()

	// dirA: bytes flowing from a into b. dirB: from b into a.
	dirADone := make(chan struct{})
	dirBDone := make(chan struct{})
	// One half-close per finished direction, aimed at its own destination:
	// dirA finishing (a sent everything it ever will) closes b's write side,
	// and dirB finishing closes a's. The source of a finished direction is
	// never closed here — it may still be owed bytes by the other direction.
	go func() { copyOne(b, a, meter); closeWrite(b); close(dirADone) }()
	go func() { copyOne(a, b, meter); closeWrite(a); close(dirBDone) }()
	<-dirADone
	<-dirBDone
}

// closeWrite half-closes the write side of c when the connection supports it
// (*net.TCPConn does; net.Pipe and TLS conns do not).
func closeWrite(c net.Conn) {
	type halfCloser interface{ CloseWrite() error }
	if hc, ok := c.(halfCloser); ok {
		_ = hc.CloseWrite()
	}
}
