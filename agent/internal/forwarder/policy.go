package forwarder

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// PolicyScope names the owner of capacity. Cross-runtime/user-wide pooling is
// not implemented and must not be implied by configuration.
type PolicyScope string

const PolicyScopeRuntime PolicyScope = "runtime"

var (
	ErrPolicyCapacity = errors.New("forwarder: runtime capacity exceeded")
	ErrPolicySourceIP = errors.New("forwarder: source IP concurrency exceeded")
)

func (c *TunnelConfig) validatePolicy() error {
	if c.PolicyScope != "" && c.PolicyScope != PolicyScopeRuntime {
		return fmt.Errorf("forwarder: unsupported policy_scope %q (want runtime)", c.PolicyScope)
	}
	if c.SpeedLimit < 0 || c.BytesPerSecondIn < 0 || c.BytesPerSecondOut < 0 ||
		c.RateBurstBytes < 0 || c.MaxConnections < 0 || c.MaxConnectionsPerIP < 0 ||
		c.MaxMappings < 0 || c.MaxMappingsPerSourceIP < 0 {
		return errors.New("forwarder: policy rates, burst bytes and concurrency ceilings must be nonnegative")
	}
	if c.BytesPerSecondIn > 2147483647 || c.BytesPerSecondOut > 2147483647 || c.MaxConnections > 2147483647 || c.MaxConnectionsPerIP > 2147483647 {
		return errors.New("forwarder: explicit policy limits exceed 2147483647")
	}
	if c.Protocol != ProtocolUDP && (c.MaxMappings > 0 || c.MaxMappingsPerSourceIP > 0) {
		return errors.New("forwarder: stream policy requires max_connections/max_connections_per_ip, not UDP mapping ceilings")
	}
	if c.RateBurstBytes > 0 && c.SpeedLimit == 0 && c.BytesPerSecondIn == 0 && c.BytesPerSecondOut == 0 {
		return errors.New("forwarder: rate_burst_bytes requires a positive rate")
	}
	return nil
}

func (c TunnelConfig) hasPolicy() bool {
	return c.SpeedLimit > 0 || c.BytesPerSecondIn > 0 || c.BytesPerSecondOut > 0 ||
		c.MaxConnections > 0 || c.MaxConnectionsPerIP > 0 || c.MaxMappings > 0 || c.MaxMappingsPerSourceIP > 0
}

// DataPlanePolicy is reusable by ingress, egress and future FXP adapters. Create
// it ONCE per runtime, acquire before handshake/dial/mapping allocation, and
// release on every failure and final teardown. WaitIn/Out must run before writing
// payload; a cancelled context interrupts even a multi-year low-rate wait.
type DataPlanePolicy struct {
	mu      sync.Mutex
	paused  bool
	active  int64
	byIP    map[string]int
	max     int64
	maxIP   int
	in, out *byteLimiter
}

// NewDataPlanePolicy checks the policy contract without binding a socket. It
// does not check a constructor's protocol support; that belongs to Validate.
func NewDataPlanePolicy(cfg TunnelConfig) (*DataPlanePolicy, error) {
	protocol, err := ParseForwardProtocol(string(cfg.Protocol))
	if err != nil {
		return nil, err
	}
	cfg.Protocol = protocol
	if err := cfg.validatePolicy(); err != nil {
		return nil, err
	}
	max, maxIP := cfg.MaxConnections, cfg.MaxConnectionsPerIP
	if cfg.Protocol == ProtocolUDP {
		// The four product fields are shared by transports: UDP counts logical
		// client mappings. Optional mapping-only ceilings can further tighten it.
		max = policyRate(max, cfg.MaxMappings)
		maxIP = int(policyRate(int64(maxIP), int64(cfg.MaxMappingsPerSourceIP)))
	}
	return &DataPlanePolicy{
		max: max, maxIP: maxIP, byIP: make(map[string]int),
		in:  newByteLimiter(policyRate(cfg.SpeedLimit, cfg.BytesPerSecondIn), cfg.RateBurstBytes),
		out: newByteLimiter(policyRate(cfg.SpeedLimit, cfg.BytesPerSecondOut), cfg.RateBurstBytes),
	}, nil
}

func policyRate(legacy, explicit int64) int64 {
	if legacy > 0 && (explicit == 0 || legacy < explicit) {
		return legacy
	}
	return explicit
}

// SameDataPlanePolicy compares effective runtime policy, including legacy rate
// semantics and default bursts. Managers must check it before an upstream-only
// hot swap: SetUpstream/Retarget cannot change an existing runtime's policy.
// Invalid policy is never equivalent, even to another invalid configuration.
func SameDataPlanePolicy(a, b TunnelConfig) bool {
	x, err := NewDataPlanePolicy(a)
	if err != nil {
		return false
	}
	y, err := NewDataPlanePolicy(b)
	if err != nil {
		return false
	}
	sameRate := func(left, right *byteLimiter) bool {
		if left == nil || right == nil {
			return left == right
		}
		return left.rate == right.rate && left.burst == right.burst
	}
	return x.max == y.max && x.maxIP == y.maxIP && sameRate(x.in, y.in) && sameRate(x.out, y.out)
}

// Acquire grants a connection/mapping slot. Its release function is idempotent.
// An unparseable peer is refused when source-IP limiting is enabled; otherwise
// a transport adapter could accidentally bypass the configured IP ceiling.
func (p *DataPlanePolicy) Acquire(peer net.Addr) (func(), error) {
	ip := policySourceIP(peer)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.paused {
		return nil, ErrPolicyCapacity
	}
	if p.max > 0 && p.active >= p.max {
		return nil, ErrPolicyCapacity
	}
	if p.maxIP > 0 && (ip == "" || p.byIP[ip] >= p.maxIP) {
		return nil, ErrPolicySourceIP
	}
	p.active++
	if p.maxIP > 0 {
		p.byIP[ip]++
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			p.mu.Lock()
			defer p.mu.Unlock()
			p.active--
			if p.maxIP > 0 {
				if p.byIP[ip] <= 1 {
					delete(p.byIP, ip)
				} else {
					p.byIP[ip]--
				}
			}
		})
	}, nil
}

// A mixed runtime opens admission only after BOTH listeners bind successfully.
func (p *DataPlanePolicy) pauseAdmission(paused bool) {
	p.mu.Lock()
	p.paused = paused
	p.mu.Unlock()
}

func policySourceIP(peer net.Addr) string {
	if peer == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(peer.String())
	if err != nil {
		return ""
	}
	ip, err := netip.ParseAddr(strings.TrimSpace(host))
	if err != nil {
		return ""
	}
	return ip.Unmap().String() // preserve link-local zones, discard ports
}

func (p *DataPlanePolicy) WaitIn(ctx context.Context, payloadBytes int) error {
	return p.in.wait(ctx, payloadBytes)
}

func (p *DataPlanePolicy) WaitOut(ctx context.Context, payloadBytes int) error {
	return p.out.wait(ctx, payloadBytes)
}

// byteLimiter follows Forwardx's shared token bucket / cancellable wait design.
// Reservations never hold the mutex while sleeping; every debit is <= burst.
type byteLimiter struct {
	mu          sync.Mutex
	rate, burst int64
	tokens      float64
	last        time.Time
}

func newByteLimiter(rate, burst int64) *byteLimiter {
	if rate == 0 {
		return nil
	}
	if burst == 0 {
		burst = rate / 10
		if burst < 1 {
			burst = 1
		}
		if burst > relayBuffer {
			burst = relayBuffer
		}
	}
	return &byteLimiter{rate: rate, burst: burst, tokens: float64(burst), last: time.Now()}
}

func (l *byteLimiter) chunk(n int) int {
	if l != nil && int64(n) > l.burst {
		return int(l.burst)
	}
	return n
}

func (l *byteLimiter) wait(ctx context.Context, n int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if l == nil || n <= 0 {
		return nil
	}
	for n > 0 {
		wanted := l.chunk(n)
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			l.mu.Lock()
			now := time.Now()
			l.tokens += now.Sub(l.last).Seconds() * float64(l.rate)
			if l.tokens > float64(l.burst) {
				l.tokens = float64(l.burst)
			}
			l.last = now
			if l.tokens >= float64(wanted) {
				l.tokens -= float64(wanted)
				l.mu.Unlock()
				break
			}
			seconds := (float64(wanted) - l.tokens) / float64(l.rate)
			// Cap before duration conversion: huge bursts at 1B/s must not
			// overflow time.Duration into a busy loop or an uninterruptible wait.
			if seconds > 1 {
				seconds = 1
			}
			delay := time.Duration(seconds * float64(time.Second))
			if delay < time.Nanosecond {
				delay = time.Nanosecond
			}
			l.mu.Unlock()
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
		n -= wanted
	}
	return ctx.Err()
}

// policyConn ensures closing a tracked socket also cancels its limiter waits.
// The protocol adapter still sees the original net.Conn semantics.
type policyConn struct {
	net.Conn
	cancel context.CancelFunc
}

func (c *policyConn) Close() error {
	c.cancel()
	return c.Conn.Close()
}

func (c *policyConn) CloseWrite() error {
	if hc, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return hc.CloseWrite()
	}
	return nil
}

// PipeConnsWithPolicy relays client <-> upstream with payload limits, TCP
// half-closes and existing target attribution. count receives delivered bytes
// and may be called concurrently by the two directions;
// a target's own counter is folded into it once, just like PipeConns.
// Cancellation or an I/O error closes both sockets; a clean EOF preserves the
// other direction so clients which CloseWrite can still receive their response.
func PipeConnsWithPolicy(ctx context.Context, client, upstream net.Conn, p *DataPlanePolicy, count func(int64)) {
	if p == nil {
		p = &DataPlanePolicy{}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	own := pairCounterOf(client, upstream)
	meter := count
	if own != nil {
		meter = own.add
		defer func() {
			if count != nil {
				count(own.load())
			}
		}()
	}
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		<-ctx.Done()
		_ = client.Close()
		_ = upstream.Close()
	}()
	var wg sync.WaitGroup
	wg.Add(2)
	copyDirection := func(dst, src net.Conn, l *byteLimiter) {
		defer wg.Done()
		err := copyWithPolicy(ctx, dst, src, l, meter)
		if err != nil && !errors.Is(err, io.EOF) {
			cancel()
		}
		closeWrite(dst)
	}
	go copyDirection(upstream, client, p.in)
	go copyDirection(client, upstream, p.out)
	wg.Wait()
	cancel()
	<-watchDone
}

func copyWithPolicy(ctx context.Context, dst io.Writer, src io.Reader, l *byteLimiter, count func(int64)) error {
	buf := make([]byte, relayBuffer)
	for {
		n, err := src.Read(buf)
		for offset := 0; offset < n; {
			size := l.chunk(n - offset)
			if werr := l.wait(ctx, size); werr != nil {
				return werr
			}
			written, werr := writeAll(dst, buf[offset:offset+size])
			if count != nil {
				count(int64(written))
			}
			if werr != nil {
				return werr
			}
			offset += written
		}
		if err != nil {
			return err
		}
	}
}
