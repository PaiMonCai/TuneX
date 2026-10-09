package forwarder

import (
	"bytes"
	"net"
	"testing"
	"time"
)

// Both ingress implementations are exercised through real client/hop sockets.
// The relay peer echoes the frozen hop frame; policy always meters its payload.
func policyDatagramStart(t *testing.T, relay bool, mutate func(*TunnelConfig), idle time.Duration) (DatagramRuntime, TunnelConfig, *DataPlanePolicy) {
	t.Helper()
	var cfg TunnelConfig
	if relay {
		peer := startFakeEgress(t)
		done := make(chan struct{})
		t.Cleanup(func() { close(done) })
		go func() {
			for {
				select {
				case got := <-peer.received:
					wire, err := appendDatagramHop(nil, got.header, got.payload)
					if err == nil {
						_, _ = peer.conn.WriteToUDP(wire, got.from)
					}
				case <-done:
					return
				}
			}
		}()
		cfg = relayTestConfig(t, freeUDPPort(t), peer.addr())
	} else {
		target, stop := udpEchoTarget(t, "echo")
		t.Cleanup(stop)
		host, port := splitTarget(t, target)
		cfg = udpDirectConfig("policy-udp", freeUDPPort(t), port)
		cfg.RemoteHost = host
	}
	cfg.ListenHost = "127.0.0.1"
	mutate(&cfg)
	var runtime DatagramRuntime
	var policy *DataPlanePolicy
	if relay {
		r, err := NewDatagramRelay(cfg, DatagramRelayOptions{IdleTimeout: idle})
		if err != nil {
			t.Fatal(err)
		}
		runtime, policy = r, r.policy
	} else {
		d, err := NewDatagram(cfg, DatagramOptions{IdleTimeout: idle})
		if err != nil {
			t.Fatal(err)
		}
		runtime, policy = d, d.policy
	}
	if err := runtime.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Stop() })
	return runtime, cfg, policy
}

func policyUDPClient(t *testing.T, addr, source string) *net.UDPConn {
	t.Helper()
	remote, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	local := &net.UDPAddr{IP: net.ParseIP(source)}
	c, err := net.DialUDP("udp", local, remote)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func policyUDPEcho(t *testing.T, relay bool, c *net.UDPConn, payload []byte) {
	t.Helper()
	want := string(payload)
	if !relay {
		want = "echo:" + want
	}
	if got := sendRecv(t, c, payload); got != want {
		t.Fatal("UDP payload changed")
	}
}

func TestPolicyUDPMappingCeilingsAndExpiry(t *testing.T) {
	for _, relay := range []bool{false, true} {
		t.Run(map[bool]string{false: "direct", true: "relay"}[relay], func(t *testing.T) {
			r, cfg, p := policyDatagramStart(t, relay, func(cfg *TunnelConfig) {
				cfg.MaxConnections, cfg.MaxConnectionsPerIP = 2, 1
			}, 500*time.Millisecond)
			c1 := policyUDPClient(t, cfg.ListenAddr(), "127.0.0.1")
			policyUDPEcho(t, relay, c1, []byte("first"))
			blockedIP := policyUDPClient(t, cfg.ListenAddr(), "127.0.0.1")
			_, _ = blockedIP.Write([]byte("blocked-ip"))
			expectNoReply(t, blockedIP, 50*time.Millisecond)
			c2 := policyUDPClient(t, cfg.ListenAddr(), "127.0.0.2")
			policyUDPEcho(t, relay, c2, []byte("second"))
			blockedTotal := policyUDPClient(t, cfg.ListenAddr(), "127.0.0.3")
			_, _ = blockedTotal.Write([]byte("blocked-total"))
			expectNoReply(t, blockedTotal, 50*time.Millisecond)
			stats := r.Stats()
			if stats.Mappings != 2 || stats.MappingsRejected != 2 || stats.Drops != 2 || policyActive(p) != 2 {
				t.Fatalf("wrong ceiling metrics: %+v gate=%d", stats, policyActive(p))
			}
			waitFor(t, 2*time.Second, func() bool { return r.LiveMappings() == 0 && policyActive(p) == 0 }, "expiry releases UDP capacity")
			policyUDPEcho(t, relay, blockedIP, []byte("after-expiry"))
			if err := r.Stop(); err != nil {
				t.Fatal(err)
			}
			if policyActive(p) != 0 {
				t.Fatal("UDP Stop leaked gate")
			}
		})
	}
}

func TestPolicyUDPDirectionalRateAndOversizeBurst(t *testing.T) {
	for _, relay := range []bool{false, true} {
		for _, direction := range []string{"in", "out", "legacy"} {
			t.Run(map[bool]string{false: "direct-", true: "relay-"}[relay]+direction, func(t *testing.T) {
				r, cfg, _ := policyDatagramStart(t, relay, func(cfg *TunnelConfig) {
					cfg.RateBurstBytes = 128
					if direction == "in" {
						cfg.BytesPerSecondIn = 4096
					} else if direction == "out" {
						cfg.BytesPerSecondOut = 4096
					} else {
						cfg.SpeedLimit = 4096
					}
				}, 3*time.Second)
				c := datagramClient(t, cfg.ListenAddr())
				payload := bytes.Repeat([]byte("d"), 512) // > burst; never fragment UDP
				start := time.Now()
				for i := 0; i < 4; i++ {
					policyUDPEcho(t, relay, c, payload)
				}
				elapsed := time.Since(start)
				if elapsed < 420*time.Millisecond || elapsed > 3*time.Second {
					t.Fatalf("UDP rate bypass/stall: %v", elapsed)
				}
				t.Logf("%d UDP payload bytes in %v (%.0f B/s)", 4*len(payload), elapsed, float64(4*len(payload))/elapsed.Seconds())
				wantOut := int64(2048)
				if !relay {
					wantOut += 4 * 5 // echo target's label is also payload
				}
				waitFor(t, time.Second, func() bool {
					s := r.Stats()
					return s.BytesIn == 2048 && s.BytesOut == wantOut && s.PacketsIn == 4 && s.PacketsOut == 4 && s.Drops == 0
				}, "UDP delivery metrics")
			})
		}
	}
}

func TestPolicyUDPStopInterruptsBothDirections(t *testing.T) {
	for _, relay := range []bool{false, true} {
		for _, direction := range []string{"in", "out"} {
			t.Run(map[bool]string{false: "direct-", true: "relay-"}[relay]+direction, func(t *testing.T) {
				r, cfg, p := policyDatagramStart(t, relay, func(cfg *TunnelConfig) {
					cfg.RateBurstBytes = 1
					if direction == "in" {
						cfg.BytesPerSecondIn = 1
					} else {
						cfg.BytesPerSecondOut = 1
					}
				}, time.Minute)
				c := datagramClient(t, cfg.ListenAddr())
				_, _ = c.Write(bytes.Repeat([]byte("x"), 512))
				waitFor(t, time.Second, func() bool { return r.LiveMappings() == 1 }, "UDP pending rate")
				if direction == "out" {
					waitFor(t, time.Second, func() bool { return r.Stats().PacketsIn == 1 }, "UDP request before return limiter")
				}
				start := time.Now()
				if err := r.Stop(); err != nil {
					t.Fatal(err)
				}
				if elapsed := time.Since(start); elapsed > 300*time.Millisecond {
					t.Fatalf("UDP Stop blocked on rate: %v", elapsed)
				}
				if policyActive(p) != 0 || r.LiveMappings() != 0 {
					t.Fatal("UDP teardown leaked capacity")
				}
			})
		}
	}
}

func TestPolicyUDPWaitSurvivesIdleWindow(t *testing.T) {
	for _, relay := range []bool{false, true} {
		for _, out := range []bool{false, true} {
			t.Run(map[bool]string{false: "direct-", true: "relay-"}[relay]+map[bool]string{false: "in", true: "out"}[out], func(t *testing.T) {
				r, cfg, p := policyDatagramStart(t, relay, func(cfg *TunnelConfig) {
					cfg.RateBurstBytes = 32
					if out {
						cfg.BytesPerSecondOut = 1024
					} else {
						cfg.BytesPerSecondIn = 1024
					}
				}, 120*time.Millisecond)
				c := datagramClient(t, cfg.ListenAddr())
				policyUDPEcho(t, relay, c, bytes.Repeat([]byte("w"), 512))
				if r.Stats().MappingsExpired != 0 || policyActive(p) != 1 {
					t.Fatal("pending rate wait was treated as idle")
				}
				waitFor(t, time.Second, func() bool { return policyActive(p) == 0 }, "idle expiry after pending payload finishes")
			})
		}
	}
}

func TestPolicyUDPFailedDialReleasesGate(t *testing.T) {
	r, cfg, p := policyDatagramStart(t, false, func(cfg *TunnelConfig) { cfg.MaxMappings = 1 }, time.Second)
	d := r.(*DatagramForwarder)
	d.mu.Lock()
	target := d.target
	d.target = "malformed-address"
	d.mu.Unlock()
	c := datagramClient(t, cfg.ListenAddr())
	_, _ = c.Write([]byte("fail-dial"))
	waitFor(t, time.Second, func() bool { return d.Stats().DropsSendError == 1 && policyActive(p) == 0 }, "UDP failed dial releases gate")
	if err := d.Retarget(target); err != nil {
		t.Fatal(err)
	}
	policyUDPEcho(t, false, c, []byte("after-failure"))
}

func TestPolicyUDPDrainPreservesExistingMappings(t *testing.T) {
	for _, relay := range []bool{false, true} {
		t.Run(map[bool]string{false: "direct", true: "relay"}[relay], func(t *testing.T) {
			r, cfg, p := policyDatagramStart(t, relay, func(cfg *TunnelConfig) { cfg.MaxMappings = 2 }, 300*time.Millisecond)
			c := datagramClient(t, cfg.ListenAddr())
			policyUDPEcho(t, relay, c, []byte("before-drain"))
			if err := r.DrainMappings(0); err != nil {
				t.Fatal(err)
			}
			policyUDPEcho(t, relay, c, []byte("during-drain"))
			other := datagramClient(t, cfg.ListenAddr())
			_, _ = other.Write([]byte("new-source"))
			expectNoReply(t, other, 50*time.Millisecond)
			waitFor(t, time.Second, func() bool { return r.LiveMappings() == 0 && policyActive(p) == 0 }, "draining sweeper releases gate")
		})
	}
}
