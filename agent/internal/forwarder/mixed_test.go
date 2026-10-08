package forwarder

import (
	"bytes"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

func mixedFreePort(t *testing.T) int {
	t.Helper()
	for i := 0; i < 20; i++ {
		tcp, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := tcp.Addr().(*net.TCPAddr).Port
		udp, err := net.ListenPacket("udp", tcp.Addr().String())
		_ = tcp.Close()
		if err == nil {
			_ = udp.Close()
			return port
		}
	}
	t.Fatal("no free TCP/UDP test port")
	return 0
}

func mixedEchoTarget(t *testing.T) (string, int) {
	t.Helper()
	addr, closeTCP := echoTarget(t)
	t.Cleanup(closeTCP)
	udp, err := net.ListenPacket("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = udp.Close() })
	go func() {
		buf := make([]byte, 4096)
		for {
			n, peer, err := udp.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = udp.WriteTo(buf[:n], peer)
		}
	}()
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	n, _ := strconv.Atoi(port)
	return host, n
}

func mixedConfig(t *testing.T) TunnelConfig {
	host, port := mixedEchoTarget(t)
	return TunnelConfig{ID: "mixed-direct", Mode: ModeDirect, Protocol: ProtocolBoth, ListenHost: "127.0.0.1", IngressPort: mixedFreePort(t), RemoteHost: host, RemotePort: port}
}
func mixedClient(t *testing.T, network, addr string) net.Conn {
	t.Helper()
	c, err := net.DialTimeout(network, addr, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}
func mixedRoundTrip(t *testing.T, c net.Conn, payload []byte) {
	t.Helper()
	_ = c.SetDeadline(time.Now().Add(6 * time.Second))
	if _, err := c.Write(payload); err != nil {
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
func mixedWait(t *testing.T, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if ready() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("real runtime did not converge")
}

func TestMixedDirectRealPayloadStatsAndExactPortReuse(t *testing.T) {
	cfg := mixedConfig(t)
	f, err := BuildMixed(cfg, BuildDeps{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Stop() })
	if err := f.Start(); err != nil {
		t.Fatal(err)
	}
	tcp, udp := mixedClient(t, "tcp", cfg.ListenAddr()), mixedClient(t, "udp", cfg.ListenAddr())
	mixedRoundTrip(t, tcp, []byte("mixed-tcp"))
	mixedRoundTrip(t, udp, []byte("mixed-udp"))
	mixedWait(t, func() bool { return f.Stats() == 36 && f.LiveConns() == 1 && f.Datagram().LiveMappings() == 1 })
	if !f.Running() {
		t.Fatal("both did not become ready")
	}
	diag, ok := f.ProtocolDiagnostics()
	if !ok || diag.Protocol != "both" {
		t.Fatal("mixed diagnostics projected as UDP", diag)
	}
	_ = tcp.Close()
	_ = f.Stop()
	if f.Running() {
		t.Fatal("stopped mixed reports ready")
	}
	l, err := net.Listen("tcp", cfg.ListenAddr())
	if err != nil {
		t.Fatal("TCP leaked", err)
	}
	defer l.Close()
	u, err := net.ListenPacket("udp", cfg.ListenAddr())
	if err != nil {
		t.Fatal("UDP leaked", err)
	}
	defer u.Close()
}

func TestMixedIngressSharesConnectionAndSourceBudgetsAcrossLanes(t *testing.T) {
	for _, perIP := range []int{0, 1} {
		t.Run(strconv.Itoa(perIP), func(t *testing.T) {
			cfg := mixedConfig(t)
			cfg.MaxConnections = 2
			cfg.MaxConnectionsPerIP = perIP
			f, err := BuildMixed(cfg, BuildDeps{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = f.Stop() })
			if err := f.Start(); err != nil {
				t.Fatal(err)
			}
			tcp := mixedClient(t, "tcp", cfg.ListenAddr())
			mixedRoundTrip(t, tcp, []byte("occupy-tcp"))
			udp := mixedClient(t, "udp", cfg.ListenAddr())
			if perIP > 0 {
				_, _ = udp.Write([]byte("over-ip"))
				_ = udp.SetReadDeadline(time.Now().Add(80 * time.Millisecond))
				if _, err := udp.Read(make([]byte, 16)); err == nil {
					t.Fatal("TCP and UDP did not share source ceiling")
				}
				_ = tcp.Close()
				mixedWait(t, func() bool { return f.LiveConns() == 0 })
				mixedRoundTrip(t, udp, []byte("released-ip"))
			} else {
				mixedRoundTrip(t, udp, []byte("occupy-udp"))
				extra := mixedClient(t, "tcp", cfg.ListenAddr())
				_, _ = extra.Write([]byte("over-total"))
				_ = extra.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
				if _, err := extra.Read(make([]byte, 16)); err == nil {
					t.Fatal("mixed total ceiling multiplied by two")
				}
			}
		})
	}
}

func TestMixedHalfBindFailureClosesOtherLane(t *testing.T) {
	for _, busyNetwork := range []string{"tcp", "udp"} {
		t.Run(busyNetwork, func(t *testing.T) {
			cfg := mixedConfig(t)
			var closeBusy func()
			if busyNetwork == "tcp" {
				l, err := net.Listen("tcp", cfg.ListenAddr())
				if err != nil {
					t.Fatal(err)
				}
				closeBusy = func() { _ = l.Close() }
			} else {
				l, err := net.ListenPacket("udp", cfg.ListenAddr())
				if err != nil {
					t.Fatal(err)
				}
				closeBusy = func() { _ = l.Close() }
			}
			defer closeBusy()
			f, err := BuildMixed(cfg, BuildDeps{})
			if err != nil {
				t.Fatal(err)
			}
			if err := f.Start(); err == nil || f.Running() {
				t.Fatal("half-bound mixed accepted")
			}
			if busyNetwork == "udp" {
				l, err := net.Listen("tcp", cfg.ListenAddr())
				if err != nil {
					t.Fatal("prepared TCP leaked", err)
				}
				_ = l.Close()
			} else {
				l, err := net.ListenPacket("udp", cfg.ListenAddr())
				if err != nil {
					t.Fatal("unprepared UDP leaked", err)
				}
				_ = l.Close()
			}
		})
	}
}

func TestMixedSharedRateBudgetChargesRealTCPAndUDPBytes(t *testing.T) {
	for _, direction := range []string{"in", "out"} {
		t.Run(direction, func(t *testing.T) {
			cfg := mixedConfig(t)
			if direction == "in" {
				cfg.BytesPerSecondIn = 1000
			} else {
				cfg.BytesPerSecondOut = 1000
			}
			cfg.RateBurstBytes = 1000
			f, err := BuildMixed(cfg, BuildDeps{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = f.Stop() })
			if err := f.Start(); err != nil {
				t.Fatal(err)
			}
			c, u := mixedClient(t, "tcp", cfg.ListenAddr()), mixedClient(t, "udp", cfg.ListenAddr())
			payload := bytes.Repeat([]byte("x"), 750)
			start := time.Now()
			// Sequential lanes avoid scheduler fairness assumptions. Each 750B
			// payload fits a private 1000B burst. Sharing that burst requires
			// ~500ms of replenishment; two private buckets finish immediately.
			mixedRoundTrip(t, c, payload)
			mixedRoundTrip(t, u, payload)
			if elapsed := time.Since(start); elapsed < 400*time.Millisecond {
				t.Fatalf("%s budget duplicated between transports: %s", direction, elapsed)
			}
			_ = c.Close()
		})
	}
}

func TestMixedDrainAndShutdownKeepDistinctWorkAndCannotRestart(t *testing.T) {
	cfg := mixedConfig(t)
	f, err := BuildMixed(cfg, BuildDeps{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Stop() })
	if err := f.Start(); err != nil {
		t.Fatal(err)
	}
	c, u := mixedClient(t, "tcp", cfg.ListenAddr()), mixedClient(t, "udp", cfg.ListenAddr())
	mixedRoundTrip(t, c, []byte("tcp-before"))
	mixedRoundTrip(t, u, []byte("udp-before"))
	if err := f.Drain(0); err != nil {
		t.Fatal(err)
	}
	if f.Running() {
		t.Fatal("draining both advertised ready")
	}
	mixedRoundTrip(t, c, []byte("tcp-draining"))
	mixedRoundTrip(t, u, []byte("udp-draining"))
	newUDP := mixedClient(t, "udp", cfg.ListenAddr())
	_, _ = newUDP.Write([]byte("new-mapping"))
	_ = newUDP.SetReadDeadline(time.Now().Add(80 * time.Millisecond))
	if _, err := newUDP.Read(make([]byte, 30)); err == nil {
		t.Fatal("drain admitted UDP")
	}
	start := time.Now()
	result := f.Shutdown(35 * time.Millisecond)
	if time.Since(start) > 500*time.Millisecond || result.ForcedConns == 0 || result.ForcedMappings != 1 || result.RemainingConns != 0 {
		t.Fatal("mixed deadline/work report", result)
	}
	if again := f.Shutdown(0); again.ForcedMappings != 0 || again.ForcedConns != 0 {
		t.Fatal("double counted", again)
	}
	if err := f.Start(); err == nil {
		t.Fatal("consumed runtime resurrected")
	}
}

func TestMixedRelayRealPayloadAndNoEgressIPHashDowngrade(t *testing.T) {
	host, targetPort := mixedEchoTarget(t)
	exit := TunnelConfig{ID: "mixed-exit", Mode: ModeEgress, Protocol: ProtocolBoth, ListenHost: "127.0.0.1", EgressPort: mixedFreePort(t), HopPeer: "127.0.0.1"}
	target := staticSelector{t: Target{Host: host, Port: targetPort}}
	x, err := BuildMixed(exit, BuildDeps{StreamBuildDeps: StreamBuildDeps{SelectorFor: func(string) (TargetSelector, error) { return target, nil }}, Datagram: DatagramBuildDeps{SelectorFor: func(string) (TargetSelector, error) { return target, nil }}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = x.Stop() })
	if err := x.Start(); err != nil {
		t.Fatal(err)
	}
	entry := TunnelConfig{ID: "mixed-relay", Mode: ModeRelay, Protocol: ProtocolBoth, ListenHost: "127.0.0.1", IngressPort: mixedFreePort(t), NextHop: exit.ListenAddr(), MaxConnections: 2}
	r, err := BuildMixed(entry, BuildDeps{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Stop() })
	if err := r.Start(); err != nil {
		t.Fatal(err)
	}
	c := mixedClient(t, "tcp", entry.ListenAddr())
	u := mixedClient(t, "udp", entry.ListenAddr())
	mixedRoundTrip(t, c, []byte("relay-tcp"))
	mixedRoundTrip(t, u, []byte("relay-udp"))
	if !x.Running() || !r.Running() {
		t.Fatal("both relay legs not ready")
	}
	exit.LBStrategy = "IP_HASH"
	if _, err := BuildMixed(exit, BuildDeps{StreamBuildDeps: StreamBuildDeps{SelectorFor: func(string) (TargetSelector, error) { return target, nil }}, Datagram: DatagramBuildDeps{SelectorFor: func(string) (TargetSelector, error) { return target, nil }}}); err == nil {
		t.Fatal("source-less mixed exit enabled IP_HASH")
	}
}
