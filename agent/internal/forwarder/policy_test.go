package forwarder

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"
)

func policyTCPConfig(t *testing.T, target string) TunnelConfig {
	t.Helper()
	host, port := splitTarget(t, target)
	return TunnelConfig{ID: "policy-tcp", Mode: ModeDirect, Protocol: ProtocolTCP,
		ListenHost: "127.0.0.1", IngressPort: freePort(t), RemoteHost: host, RemotePort: port}
}

func policyTCPStart(t *testing.T, cfg TunnelConfig) *SingleHopForwarder {
	t.Helper()
	f, err := NewSingleHop(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Stop() })
	return f
}

func policyTCPDial(t *testing.T, addr, source string) net.Conn {
	t.Helper()
	d := net.Dialer{Timeout: time.Second}
	if source != "" {
		d.LocalAddr = &net.TCPAddr{IP: net.ParseIP(source)}
	}
	c, err := d.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	_ = c.SetDeadline(time.Now().Add(4 * time.Second))
	return c
}

func policyEcho(t *testing.T, c net.Conn, payload []byte) {
	t.Helper()
	if _, err := writeAll(c, payload); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(c, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("payload changed")
	}
}

func policyRejectedTCP(t *testing.T, c net.Conn) {
	t.Helper()
	_ = c.SetDeadline(time.Now().Add(500 * time.Millisecond))
	_, _ = c.Write([]byte("rejected"))
	if _, err := c.Read(make([]byte, 32)); err == nil || isTimeout(err) {
		t.Fatalf("gate did not promptly close client: %v", err)
	}
}

func policyActive(p *DataPlanePolicy) int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.active
}

func TestPolicyConfigContract(t *testing.T) {
	cfg := TunnelConfig{Protocol: ProtocolTCP, SpeedLimit: 100, BytesPerSecondIn: 50, BytesPerSecondOut: 200}
	p, err := NewDataPlanePolicy(cfg)
	if err != nil || p.in.rate != 50 || p.out.rate != 100 {
		t.Fatalf("legacy must cap both directions: %+v, %v", p, err)
	}
	legacy, err := NewDataPlanePolicy(TunnelConfig{SpeedLimit: 4096})
	if err != nil || legacy.in.rate != 4096 || legacy.out.rate != 4096 {
		t.Fatalf("legacy bytes/second semantics: %v", err)
	}
	for _, bad := range []TunnelConfig{
		{SpeedLimit: -1}, {BytesPerSecondIn: -1}, {BytesPerSecondOut: -1},
		{RateBurstBytes: -1}, {MaxConnections: -1}, {MaxConnectionsPerIP: -1},
		{MaxMappings: -1}, {MaxMappingsPerSourceIP: -1}, {PolicyScope: "user"},
		{RateBurstBytes: 128}, {Protocol: ProtocolTCP, MaxMappings: 1},
		{BytesPerSecondIn: 2147483648}, {BytesPerSecondOut: 2147483648},
		{MaxConnections: 2147483648}, {MaxConnectionsPerIP: 2147483648},
	} {
		if _, err := NewDataPlanePolicy(bad); err == nil {
			t.Fatalf("invalid policy accepted: %+v", bad)
		}
	}
	egress := TunnelConfig{ID: "udp-exit", Mode: ModeEgress, Protocol: ProtocolUDP, EgressPort: 1234,
		HopPeer: "127.0.0.1", SpeedLimit: 100, Targets: []Target{{Host: "127.0.0.1", Port: 1235}}}
	if err := egress.Validate(); err == nil {
		t.Fatal("unwired UDP egress policy must not be silently accepted")
	}
}

func TestPolicyGateNormalizesAndReleases(t *testing.T) {
	p, _ := NewDataPlanePolicy(TunnelConfig{MaxConnections: 2, MaxConnectionsPerIP: 1})
	v4 := &net.TCPAddr{IP: net.ParseIP("192.0.2.1"), Port: 1}
	mapped := &net.TCPAddr{IP: net.ParseIP("::ffff:192.0.2.1"), Port: 2}
	release, err := p.Acquire(v4)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Acquire(mapped); !errors.Is(err, ErrPolicySourceIP) {
		t.Fatalf("same IP at another port/mapped spelling: %v", err)
	}
	r2, err := p.Acquire(&net.TCPAddr{IP: net.ParseIP("192.0.2.2"), Port: 3})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Acquire(&net.TCPAddr{IP: net.ParseIP("192.0.2.3"), Port: 4}); !errors.Is(err, ErrPolicyCapacity) {
		t.Fatalf("global cap: %v", err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); release(); r2() }()
	}
	wg.Wait()
	if policyActive(p) != 0 || len(p.byIP) != 0 {
		t.Fatal("release leaked gate capacity")
	}
	if _, err := p.Acquire(dummyAddr{}); !errors.Is(err, ErrPolicySourceIP) {
		t.Fatal("unparseable address bypassed source-IP ceiling")
	}
}

func TestPolicyComparisonForManagerHotSwap(t *testing.T) {
	legacy := TunnelConfig{SpeedLimit: 100, MaxConnections: 5, MaxConnectionsPerIP: 2}
	explicit := TunnelConfig{PolicyScope: PolicyScopeRuntime, BytesPerSecondIn: 100, BytesPerSecondOut: 100, MaxConnections: 5, MaxConnectionsPerIP: 2}
	if !SameDataPlanePolicy(legacy, explicit) {
		t.Fatal("equivalent legacy and explicit policies require the same runtime")
	}
	explicit.RemoteHost = "new-target.example"
	if !SameDataPlanePolicy(legacy, explicit) {
		t.Fatal("target-only hot swap must keep its policy")
	}
	explicit.MaxConnections = 1
	if SameDataPlanePolicy(legacy, explicit) {
		t.Fatal("target plus capacity change must not hot-swap only the target")
	}
	if SameDataPlanePolicy(TunnelConfig{MaxConnections: -1}, TunnelConfig{MaxConnections: -1}) {
		t.Fatal("invalid policy must fail closed")
	}
}

func TestPolicyLimiterOversizedAndCancellation(t *testing.T) {
	l := newByteLimiter(4096, 16)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	start := time.Now()
	if err := l.wait(ctx, 256); err != nil {
		t.Fatalf("larger than burst deadlocked: %v", err)
	}
	if time.Since(start) < 50*time.Millisecond {
		t.Fatal("oversized request bypassed rate")
	}
	l = newByteLimiter(1, 1)
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start = time.Now()
	if err := l.wait(ctx, 1024); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("wait not cancelled: %v", err)
	}
	if time.Since(start) > 300*time.Millisecond {
		t.Fatal("cancellation was not prompt")
	}
	// Also exercise an int64 burst whose low-rate deficit would overflow a
	// duration; it must remain cancellable, without a hot spin.
	l = newByteLimiter(1, 1<<62)
	l.tokens = 0
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := l.wait(ctx, 1<<30); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("huge deficit: %v", err)
	}
}

func TestPolicyTCPDirectionalThroughput(t *testing.T) {
	for _, direction := range []string{"in", "out", "legacy"} {
		t.Run(direction, func(t *testing.T) {
			target, stop := echoTarget(t)
			defer stop()
			cfg := policyTCPConfig(t, target)
			cfg.RateBurstBytes = 512
			switch direction {
			case "in":
				cfg.BytesPerSecondIn = 32 * 1024
			case "out":
				cfg.BytesPerSecondOut = 32 * 1024
			case "legacy":
				cfg.SpeedLimit = 32 * 1024
			}
			f := policyTCPStart(t, cfg)
			c := policyTCPDial(t, cfg.ListenAddr(), "")
			payload := bytes.Repeat([]byte("r"), 16*1024)
			start := time.Now()
			policyEcho(t, c, payload)
			elapsed := time.Since(start)
			if elapsed < 430*time.Millisecond || elapsed > 3*time.Second {
				t.Fatalf("uncontrolled/stalled %s transfer: %v", direction, elapsed)
			}
			t.Logf("%s: %d payload bytes in %v (%.0f B/s)", direction, len(payload), elapsed, float64(len(payload))/elapsed.Seconds())
			_ = c.(*net.TCPConn).CloseWrite()
			if _, err := c.Read(make([]byte, 1)); !errors.Is(err, io.EOF) {
				t.Fatalf("TCP half-close lost: %v", err)
			}
			waitFor(t, time.Second, func() bool { return f.Stats() == int64(2*len(payload)) && policyActive(f.policy) == 0 }, "metrics and gate after EOF")
		})
	}
}

func TestPolicyTCPRateSharedAcrossConnections(t *testing.T) {
	target, stop := echoTarget(t)
	defer stop()
	cfg := policyTCPConfig(t, target)
	cfg.BytesPerSecondIn, cfg.RateBurstBytes = 32*1024, 512
	f := policyTCPStart(t, cfg)
	clients := []net.Conn{policyTCPDial(t, cfg.ListenAddr(), ""), policyTCPDial(t, cfg.ListenAddr(), "")}
	errs := make(chan error, 2)
	start := time.Now()
	for _, c := range clients {
		go func(c net.Conn) {
			payload := bytes.Repeat([]byte("s"), 12*1024)
			_, err := writeAll(c, payload)
			if err == nil {
				got := make([]byte, len(payload))
				_, err = io.ReadFull(c, got)
				if err == nil && !bytes.Equal(got, payload) {
					err = errors.New("payload changed")
				}
			}
			errs <- err
		}(c)
	}
	for range clients {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if elapsed := time.Since(start); elapsed < 680*time.Millisecond {
		t.Fatalf("each connection received its own rate bucket: %v", elapsed)
	}
	waitFor(t, time.Second, func() bool { return f.Stats() == 48*1024 }, "aggregate delivered metrics")
}

func TestPolicyTCPConnectionCeilings(t *testing.T) {
	target, stop := echoTarget(t)
	defer stop()
	cfg := policyTCPConfig(t, target)
	cfg.MaxConnections, cfg.MaxConnectionsPerIP = 2, 1
	f := policyTCPStart(t, cfg)
	c1 := policyTCPDial(t, cfg.ListenAddr(), "127.0.0.1")
	policyEcho(t, c1, []byte("first"))
	policyRejectedTCP(t, policyTCPDial(t, cfg.ListenAddr(), "127.0.0.1"))
	c2 := policyTCPDial(t, cfg.ListenAddr(), "127.0.0.2")
	policyEcho(t, c2, []byte("second"))
	policyRejectedTCP(t, policyTCPDial(t, cfg.ListenAddr(), "127.0.0.3"))
	if f.LiveConns() != 2 || policyActive(f.policy) != 2 {
		t.Fatal("rejected clients changed live count/capacity")
	}
	_ = c1.Close()
	waitFor(t, time.Second, func() bool { return policyActive(f.policy) == 1 }, "disconnect releases source slot")
	policyEcho(t, policyTCPDial(t, cfg.ListenAddr(), "127.0.0.1"), []byte("reused"))
}

func TestPolicyTCPFailedDialReleasesGate(t *testing.T) {
	cfg := policyTCPConfig(t, net.JoinHostPort("127.0.0.1", strconv.Itoa(freePort(t))))
	cfg.MaxConnections = 1
	f := policyTCPStart(t, cfg)
	policyRejectedTCP(t, policyTCPDial(t, cfg.ListenAddr(), ""))
	waitFor(t, time.Second, func() bool { return policyActive(f.policy) == 0 }, "dial failure releases gate")
	target, stop := echoTarget(t)
	defer stop()
	if err := f.SetUpstream(target); err != nil {
		t.Fatal(err)
	}
	policyEcho(t, policyTCPDial(t, cfg.ListenAddr(), ""), []byte("after-failure"))
}

func TestPolicyTCPStopAndShutdownInterruptWait(t *testing.T) {
	cases := []struct {
		name          string
		shutdown, out bool
	}{{"StopIn", false, false}, {"StopOut", false, true}, {"ShutdownIn", true, false}, {"ShutdownOut", true, true}}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			target, stop := echoTarget(t)
			defer stop()
			cfg := policyTCPConfig(t, target)
			cfg.BytesPerSecondIn, cfg.RateBurstBytes, cfg.MaxConnections = 1, 1, 1
			if tc.out {
				cfg.BytesPerSecondIn, cfg.BytesPerSecondOut = 0, 1
			}
			f := policyTCPStart(t, cfg)
			c := policyTCPDial(t, cfg.ListenAddr(), "")
			_, _ = c.Write(bytes.Repeat([]byte("x"), 1024))
			if _, err := io.ReadFull(c, make([]byte, 1)); err != nil {
				t.Fatal(err)
			}
			start := time.Now()
			if tc.shutdown {
				if result := f.Shutdown(0); result.RemainingConns != 0 {
					t.Fatalf("shutdown left limiter running: %+v", result)
				}
			} else if err := f.Stop(); err != nil {
				t.Fatal(err)
			}
			if elapsed := time.Since(start); elapsed > 300*time.Millisecond {
				t.Fatalf("teardown blocked on rate: %v", elapsed)
			}
			waitFor(t, time.Second, func() bool { return policyActive(f.policy) == 0 }, "stopped gate")
			wantBytes := int64(2)
			if tc.out {
				wantBytes = 1025
			}
			if f.Stats() != wantBytes {
				t.Fatalf("undelivered bytes counted: %d", f.Stats())
			}
		})
	}
}

func TestPolicyTCPDirectionsIndependent(t *testing.T) {
	for _, out := range []bool{false, true} {
		t.Run(map[bool]string{false: "upload", true: "download"}[out], func(t *testing.T) {
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = ln.Close() })
			received := make(chan time.Time, 1)
			serverErr := make(chan error, 1)
			payload := bytes.Repeat([]byte("a"), 16*1024)
			go func() {
				c, err := ln.Accept()
				if err != nil {
					serverErr <- err
					return
				}
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(3 * time.Second))
				got := make([]byte, len(payload))
				_, err = io.ReadFull(c, got)
				received <- time.Now()
				if err == nil {
					_, err = writeAll(c, got)
				}
				serverErr <- err
			}()
			cfg := policyTCPConfig(t, ln.Addr().String())
			cfg.RateBurstBytes = 512
			if out {
				cfg.BytesPerSecondOut = 32 * 1024
			} else {
				cfg.BytesPerSecondIn = 32 * 1024
			}
			_ = policyTCPStart(t, cfg)
			c := policyTCPDial(t, cfg.ListenAddr(), "")
			start := time.Now()
			policyEcho(t, c, payload)
			finished := time.Now()
			if err := <-serverErr; err != nil {
				t.Fatal(err)
			}
			atTarget := <-received
			upload, download := atTarget.Sub(start), finished.Sub(atTarget)
			limited, unlimited := upload, download
			if out {
				limited, unlimited = download, upload
			}
			if limited < 430*time.Millisecond || unlimited > 300*time.Millisecond {
				t.Fatalf("directions not independent: upload=%v download=%v", upload, download)
			}
		})
	}
}

func TestPolicyTCPStopDuringPendingDial(t *testing.T) {
	target, stop := echoTarget(t)
	defer stop()
	cfg := policyTCPConfig(t, target)
	cfg.MaxConnections = 1
	tracker := &pipeTracker{cfg: cfg}
	dialStarted, unblock := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(unblock) }); _ = tracker.stop() })
	if err := tracker.start(func(net.Conn) (net.Conn, error) {
		close(dialStarted)
		<-unblock
		return net.DialTimeout("tcp", target, time.Second)
	}); err != nil {
		t.Fatal(err)
	}
	_ = policyTCPDial(t, cfg.ListenAddr(), "")
	select {
	case <-dialStarted:
	case <-time.After(time.Second):
		t.Fatal("dial did not start")
	}
	policyRejectedTCP(t, policyTCPDial(t, cfg.ListenAddr(), ""))
	start := time.Now()
	_ = tracker.stop()
	if time.Since(start) > 300*time.Millisecond || policyActive(tracker.policy) != 0 {
		t.Fatal("pending dial blocked Stop or leaked gate")
	}
	once.Do(func() { close(unblock) })
}

func TestPolicyTLSAndWSPayloadAndFailure(t *testing.T) {
	for _, protocol := range []ForwardProtocol{ProtocolTLS, ProtocolWS} {
		t.Run(string(protocol), func(t *testing.T) {
			target, stop := echoTarget(t)
			defer stop()
			cfg := policyTCPConfig(t, target)
			cfg.Protocol = protocol
			if protocol == ProtocolTLS {
				cfg.TLSCertPath, cfg.TLSKeyPath = testCertFiles(t, "127.0.0.1")
			}
			cfg.MaxConnections = 1
			cfg.BytesPerSecondOut, cfg.RateBurstBytes = 16*1024, 256
			runtime, err := BuildStream(cfg, StreamBuildDeps{HandshakeTimeout: time.Second})
			if err != nil {
				t.Fatal(err)
			}
			f := runtime.(*SingleHopForwarder)
			if err := f.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = f.Stop() })
			bad := policyTCPDial(t, cfg.ListenAddr(), "")
			_, _ = bad.Write([]byte("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"))
			_, _ = io.ReadAll(bad)
			waitFor(t, time.Second, func() bool { return policyActive(f.policy) == 0 }, "failed handshake gate")
			payload := bytes.Repeat([]byte("p"), 4096)
			start := time.Now()
			if protocol == ProtocolTLS {
				c, err := tls.Dial("tcp", cfg.ListenAddr(), &tls.Config{InsecureSkipVerify: true})
				if err != nil {
					t.Fatal(err)
				}
				_ = c.SetDeadline(time.Now().Add(3 * time.Second))
				policyEcho(t, c, payload)
				_ = c.Close()
			} else {
				c := wsDial(t, cfg.ListenAddr())
				c.send(t, wsOpBinary, payload)
				var got []byte
				for len(got) < len(payload) {
					_, part := c.recv(t)
					got = append(got, part...)
				}
				if !bytes.Equal(got, payload) {
					t.Fatal("WS payload changed")
				}
				c.close()
			}
			if time.Since(start) < 210*time.Millisecond {
				t.Fatal("protocol front bypassed payload limit")
			}
			waitFor(t, time.Second, func() bool { return f.Stats() == 8192 && policyActive(f.policy) == 0 }, "front metrics and disconnect gate")
			diag, _ := f.ProtocolDiagnostics()
			if protocol == ProtocolTLS && diag.HandshakeFailures == 0 {
				t.Fatal("TLS failure diagnostic lost")
			}
		})
	}
}

func TestPolicyWSPendingHandshakeIsGatedAndStopped(t *testing.T) {
	target, stop := echoTarget(t)
	defer stop()
	cfg := policyTCPConfig(t, target)
	cfg.Protocol, cfg.MaxConnections = ProtocolWS, 1
	runtime, err := BuildStream(cfg, StreamBuildDeps{})
	if err != nil {
		t.Fatal(err)
	}
	f := runtime.(*SingleHopForwarder)
	if err := f.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Stop() })
	_ = policyTCPDial(t, cfg.ListenAddr(), "")
	waitFor(t, time.Second, func() bool { return policyActive(f.policy) == 1 }, "pending WS capacity")
	policyRejectedTCP(t, policyTCPDial(t, cfg.ListenAddr(), ""))
	if f.LiveConns() != 0 {
		t.Fatal("pending WS handshake inflated live pipe metrics")
	}
	start := time.Now()
	_ = f.Stop()
	if time.Since(start) > 300*time.Millisecond {
		t.Fatal("silent WS handshake blocked Stop")
	}
	waitFor(t, time.Second, func() bool { return policyActive(f.policy) == 0 }, "pending WS gate release")
}
