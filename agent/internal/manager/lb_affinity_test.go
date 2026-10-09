package manager

import (
	"errors"
	"io"
	"net"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

func TestFallbackPreservesInputOrderAndIgnoresWeights(t *testing.T) {
	targets := []forwarder.Target{
		{Host: "", Port: 80},
		{Host: "primary", Port: 80, Weight: 0, Order: 9},
		{Host: "backup", Port: 80, Weight: 100, Order: 1},
	}
	l := New(Fallback, targets)
	for i := 0; i < 10; i++ {
		if got := l.Select().Addr(); got != "primary:80" {
			t.Fatalf("fallback pick = %s, want input head primary:80", got)
		}
	}
	l.UpdateTargets(Fallback, []forwarder.Target{targets[2], targets[1]})
	if got := l.Select().Addr(); got != "backup:80" {
		t.Fatalf("reordered input pick = %s, want backup:80", got)
	}
}

func TestAffinityUsesExistingHealthRanksAndUnknownHandling(t *testing.T) {
	a, b := tg("primary", 80), tg("backup", 80)
	for _, strategy := range []Strategy{Fallback, IPHash} {
		t.Run(string(strategy), func(t *testing.T) {
			for _, tc := range []struct {
				primary, backup string
				want            forwarder.Target
			}{
				{"healthy", "healthy", a},
				{"unknown", "healthy", b},
				{"recovering", "degraded", a},
				{"degraded", "unknown", a},
				{"unhealthy", "unknown", b},
				{"unknown", "unhealthy", a},
			} {
				l := New(strategy, []forwarder.Target{a, b})
				l.UpdateHealth([]forwarder.TargetHealth{th(a.Host, a.Port, tc.primary), th(b.Host, b.Port, tc.backup)})
				if got := l.SelectForClient("192.0.2.1"); got != tc.want {
					t.Fatalf("%s/%s pick = %v, want %v", tc.primary, tc.backup, got, tc.want)
				}
				if !reflect.DeepEqual(l.Targets(), []forwarder.Target{a, b}) {
					t.Fatal("health selection changed desired targets")
				}
			}
			l := New(strategy, []forwarder.Target{a, b})
			// A fact absent from the array is unknown, exactly like an explicit
			// unknown. No private health conclusion is filled in for it.
			l.UpdateHealth([]forwarder.TargetHealth{th(a.Host, a.Port, "unhealthy")})
			if got := l.SelectForClient("192.0.2.1"); got != b {
				t.Fatalf("unmentioned backup pick = %v, want %v", got, b)
			}
			l.UpdateHealth(nil)
			if got := l.SelectForClient("192.0.2.1"); got != a || len(l.BreakerStates()) != 0 {
				t.Fatalf("without health pick = %v, breakers = %v", got, l.BreakerStates())
			}
		})
	}
}

func TestAffinityRecoveryRespectsExistingProbeAllowance(t *testing.T) {
	a, b := tg("primary", 80), tg("backup", 80)
	for _, strategy := range []Strategy{Fallback, IPHash} {
		t.Run(string(strategy), func(t *testing.T) {
			clk := newFakeClock()
			p := healthPool(t, strategy, []forwarder.Target{a, b}, []forwarder.TargetHealth{
				th(a.Host, a.Port, "unhealthy"), th(b.Host, b.Port, "healthy"),
			}, clk, BreakerBounds{Cooldown: time.Minute})
			if got := p.SelectForClient("192.0.2.1"); got != b {
				t.Fatalf("failed primary pick = %v, want backup", got)
			}
			p.SetHealth([]forwarder.TargetHealth{th(a.Host, a.Port, "healthy"), th(b.Host, b.Port, "healthy")})
			if got := p.SelectForClient("192.0.2.1"); got != b {
				t.Fatalf("a label must not bypass cooldown: %v", got)
			}
			clk.advance(time.Minute)
			if got := p.SelectForClient("192.0.2.1"); got != a {
				t.Fatalf("recovered primary probe = %v, want primary", got)
			}
			if got := p.SelectForClient("192.0.2.1"); got != b {
				t.Fatalf("second pick must respect primary's one-probe allowance: %v", got)
			}
			p.ReportDial(a, true)
			if got := p.SelectForClient("192.0.2.1"); got != a {
				t.Fatalf("successful probe did not restore primary affinity: %v", got)
			}
			if got := breakerOf(t, p.BreakerStates(), a.Host, a.Port); got.Breaker != "closed" || got.Health != "healthy" {
				t.Fatalf("recovered breaker = %+v", got)
			}
		})
	}
}

func TestAffinityAllOpenKeepsForcedPickAccounting(t *testing.T) {
	a, b := tg("primary", 80), tg("backup", 80)
	for _, strategy := range []Strategy{Fallback, IPHash} {
		l := New(strategy, []forwarder.Target{a, b})
		l.UpdateHealth([]forwarder.TargetHealth{th(a.Host, a.Port, "unhealthy"), th(b.Host, b.Port, "unhealthy")})
		for i := 0; i < 4; i++ {
			if got := l.SelectForClient("192.0.2.1"); got != a {
				t.Fatalf("%s all-open pick = %v, want ordered/hashed primary", strategy, got)
			}
		}
		if l.ForcedPicks() != 4 {
			t.Fatalf("%s forced picks = %d, want 4", strategy, l.ForcedPicks())
		}
	}
}

func TestIPHashFixedIPsAndEquivalentSpellings(t *testing.T) {
	targets := []forwarder.Target{tg("a", 80), tg("b", 80), tg("c", 80)}
	// Fixed FNV-1a vectors also prove restart stability and source-port
	// independence. Health-neutral payloads must produce the same assignment.
	for _, health := range [][]forwarder.TargetHealth{nil, {th("a", 80, "unknown")}} {
		l := New(IPHash, targets)
		l.UpdateHealth(health)
		for source, index := range map[string]int{
			"192.0.2.1": 2, "192.0.2.1:1": 2, "192.0.2.1:65535": 2,
			"[::ffff:192.0.2.1]:1234": 2, "::ffff:192.0.2.1": 2,
			"192.0.2.3": 1, "2001:db8::1": 0,
			"[2001:0DB8:0:0:0:0:0:1]:9": 0,
		} {
			for i := 0; i < 20; i++ {
				if got := l.SelectForClient(source); got != targets[index] {
					t.Fatalf("IP %s pick = %v, want %v", source, got, targets[index])
				}
			}
		}
	}
	if clientIP("fe80::1%eth0") != clientIP("[fe80::1%eth1]:80") {
		t.Fatal("IPv6 scope/port changed the canonical IP")
	}
}

func TestIPHashUnknownSourceFailsClosedAndEmptyPoolRecovers(t *testing.T) {
	a, b := tg("a", 80), tg("b", 80)
	for _, health := range [][]forwarder.TargetHealth{nil, {th("a", 80, "unknown")}} {
		l := New(IPHash, nil)
		l.UpdateHealth(health)
		if got := l.SelectForClient("192.0.2.1"); got.Addr() != "" || l.ForcedPicks() != 0 {
			t.Fatalf("empty pool returned %v or recorded a forced pick", got)
		}
		l.UpdateTargetsAndHealth(IPHash, []forwarder.Target{a, b}, health)
		for _, source := range []string{"", "relay.example:80", "mapping:1", "not-an-ip"} {
			if got := l.SelectForClient(source); got.Addr() != "" {
				t.Fatalf("unknown source %q must reject selection: %v", source, got)
			}
		}
		if l.ForcedPicks() != 0 {
			t.Fatal("missing source must not consume probe allowance or force a pick")
		}
		l.UpdateTargets(IPHash, nil)
		if got := l.SelectForClient("192.0.2.1"); got != a {
			t.Fatalf("bad update cleared affinity pool: %v", got)
		}
	}
}

func TestAffinityConcurrentUpdates(t *testing.T) {
	a, b := tg("a", 80), tg("b", 80)
	p := newPool("affinity", IPHash, []forwarder.Target{a, b})
	var wg sync.WaitGroup
	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 1000; i++ {
				if got := p.SelectForClient("192.0.2.1:1234"); got != a && got != b {
					t.Errorf("concurrent pick = %v", got)
					return
				}
			}
		}()
	}
	for i := 0; i < 100; i++ {
		p.SwapTargetsAndHealth([]Strategy{Fallback, IPHash}[i%2], []forwarder.Target{a, b},
			[]forwarder.TargetHealth{th(a.Host, a.Port, "unknown"), th(b.Host, b.Port, "healthy")})
	}
	wg.Wait()
}

type lbTCPTarget struct {
	ln      net.Listener
	mu      sync.Mutex
	stopped bool
	conns   map[net.Conn]struct{}
}

func startLBTCPTarget(t *testing.T, addr string, label byte) *lbTCPTarget {
	t.Helper()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("target listen: %v", err)
	}
	s := &lbTCPTarget{ln: ln, conns: make(map[net.Conn]struct{})}
	t.Cleanup(s.stop)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			if s.stopped {
				s.mu.Unlock()
				_ = c.Close()
				return
			}
			s.conns[c] = struct{}{}
			s.mu.Unlock()
			go func() {
				defer c.Close()
				defer func() { s.mu.Lock(); delete(s.conns, c); s.mu.Unlock() }()
				buf := make([]byte, 1)
				for {
					if _, err := io.ReadFull(c, buf); err != nil {
						return
					}
					if _, err := c.Write([]byte{label}); err != nil {
						return
					}
				}
			}()
		}
	}()
	return s
}

func (s *lbTCPTarget) stop() {
	_ = s.ln.Close()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopped = true
	for c := range s.conns {
		_ = c.Close()
	}
}

func lbTargetOf(ln net.Listener) forwarder.Target {
	addr := ln.Addr().(*net.TCPAddr)
	return tg(addr.IP.String(), addr.Port)
}

func lbClient(t *testing.T, addr, sourceIP string) net.Conn {
	t.Helper()
	d := net.Dialer{Timeout: time.Second, LocalAddr: &net.TCPAddr{IP: net.ParseIP(sourceIP)}}
	c, err := d.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial egress: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func lbCheckReply(t *testing.T, c net.Conn, want byte) {
	t.Helper()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.Write([]byte{'?'}); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 1)
	if _, err := io.ReadFull(c, buf); err != nil || buf[0] != want {
		t.Fatalf("target reply = %q, err = %v, want %c", buf, err, want)
	}
}

func startLBEgress(t *testing.T, p *Pool, opts forwarder.EgressOptions) string {
	t.Helper()
	port := freePort(t)
	f, err := forwarder.NewEgressWithOptions(forwarder.TunnelConfig{
		ID: "lb-real", Mode: forwarder.ModeEgress, EgressPort: port, ListenHost: "127.0.0.1",
	}, p, opts)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Stop() })
	p.SetLedger(f.TargetStats)
	return addrFor(port)
}

func TestFallbackRealTCPFailureRecoveryAndExistingConnections(t *testing.T) {
	primary := startLBTCPTarget(t, "127.0.0.1:0", 'A')
	backup := startLBTCPTarget(t, "127.0.0.1:0", 'B')
	a, b := lbTargetOf(primary.ln), lbTargetOf(backup.ln)
	clk := newFakeClock()
	p := healthPool(t, Fallback, []forwarder.Target{a, b}, []forwarder.TargetHealth{
		th(a.Host, a.Port, "healthy"), th(b.Host, b.Port, "healthy"),
	}, clk, BreakerBounds{Cooldown: time.Minute})
	addr := startLBEgress(t, p, forwarder.EgressOptions{})
	lbCheckReply(t, lbClient(t, addr, "127.0.0.1"), 'A')
	primary.stop()
	failed := lbClient(t, addr, "127.0.0.1")
	_ = failed.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = failed.Write([]byte{'?'})
	buf := make([]byte, 1)
	if _, err := failed.Read(buf); err == nil {
		t.Fatal("stopped primary unexpectedly answered")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("failed target dial did not drop the client")
	}
	stats := p.TargetStats()
	if len(stats) != 1 || stats[0].DialFailed != 1 || stats[0].DialOK != 1 {
		t.Fatalf("real primary dial facts = %+v", stats)
	}
	if got := breakerOf(t, p.BreakerStates(), a.Host, a.Port); got.Health != "healthy" || got.Breaker != "closed" {
		t.Fatalf("single dial failure invented health: %+v", got)
	}
	p.SetHealth([]forwarder.TargetHealth{th(a.Host, a.Port, "unhealthy"), th(b.Host, b.Port, "healthy")})
	existing := lbClient(t, addr, "127.0.0.1")
	lbCheckReply(t, existing, 'B')
	startLBTCPTarget(t, a.Addr(), 'A')
	p.SetHealth([]forwarder.TargetHealth{th(a.Host, a.Port, "healthy"), th(b.Host, b.Port, "healthy")})
	lbCheckReply(t, lbClient(t, addr, "127.0.0.1"), 'B') // still in cooldown
	clk.advance(time.Minute)
	lbCheckReply(t, lbClient(t, addr, "127.0.0.1"), 'A') // real successful probe
	lbCheckReply(t, existing, 'B')                       // existing connection stays pinned
	if got := breakerOf(t, p.BreakerStates(), a.Host, a.Port); got.Breaker != "closed" {
		t.Fatalf("real probe did not close breaker: %+v", got)
	}
}

func TestIPHashRealTCPTrustedDirectClientsAndRelayUnknownSource(t *testing.T) {
	primary := startLBTCPTarget(t, "127.0.0.1:0", 'A')
	backup := startLBTCPTarget(t, "127.0.0.1:0", 'B')
	a, b := lbTargetOf(primary.ln), lbTargetOf(backup.ln)
	p := newPool("hash-real", IPHash, []forwarder.Target{a, b})
	addr := startLBEgress(t, p, forwarder.EgressOptions{
		// This test has real clients directly connected to the exit, so the
		// immediate peer is explicitly a trusted source here.
		ClientSource: func(c net.Conn) string { return c.RemoteAddr().String() },
	})
	for i := 0; i < 4; i++ {
		lbCheckReply(t, lbClient(t, addr, "127.0.0.1"), 'A')
		lbCheckReply(t, lbClient(t, addr, "127.0.0.2"), 'B')
	}
	// The legacy relay must reject this selector before binding any listener.
	_, err := forwarder.NewEgress(forwarder.TunnelConfig{
		ID: "hash-relay", Mode: forwarder.ModeEgress, EgressPort: freePort(t),
	}, newPool("relay", IPHash, []forwarder.Target{a, b}))
	if !errors.Is(err, forwarder.ErrClientIPRequired) {
		t.Fatalf("legacy relay accepted IP_HASH without an original source: %v", err)
	}
}

func TestIPHashUnsupportedTCPHotUpdateRejectsNewConnections(t *testing.T) {
	primary := startLBTCPTarget(t, "127.0.0.1:0", 'A')
	a := lbTargetOf(primary.ln)
	p := newPool("hot-source", Fallback, []forwarder.Target{a})
	addr := startLBEgress(t, p, forwarder.EgressOptions{})
	existing := lbClient(t, addr, "127.0.0.1")
	lbCheckReply(t, existing, 'A')
	p.SwapTargets(IPHash, []forwarder.Target{a})
	lbCheckReply(t, existing, 'A')
	rejected := lbClient(t, addr, "127.0.0.1")
	_ = rejected.SetDeadline(time.Now().Add(time.Second))
	_, _ = rejected.Write([]byte{'?'})
	if _, err := rejected.Read(make([]byte, 1)); err == nil {
		t.Fatal("new source-less connection survived the IP_HASH update")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("new source-less connection was not promptly rejected")
	}
	if stats := p.TargetStats(); len(stats) != 1 || stats[0].DialOK != 1 || stats[0].DialFailed != 0 {
		t.Fatalf("source rejection must not dial a target or invent failure facts: %+v", stats)
	}
}
