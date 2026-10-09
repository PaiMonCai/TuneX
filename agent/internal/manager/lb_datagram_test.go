package manager

import (
	"errors"
	"net"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

func startLBUDPTarget(t *testing.T, addr string, label string) *net.UDPConn {
	t.Helper()
	raddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	c, err := net.ListenUDP("udp", raddr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	go func() {
		buf := make([]byte, 128)
		for {
			_, from, err := c.ReadFromUDP(buf)
			if err != nil {
				return
			}
			_, _ = c.WriteToUDP([]byte(label), from)
		}
	}()
	return c
}

func startLBUDPRelay(t *testing.T, p *Pool) string {
	t.Helper()
	exitPort := freeUDPPort(t)
	exit, err := forwarder.NewDatagramEgress(forwarder.TunnelConfig{
		ID: "lb-udp-exit", Mode: forwarder.ModeEgress, Protocol: forwarder.ProtocolUDP,
		EgressPort: exitPort, ListenHost: "127.0.0.1", HopPeer: "127.0.0.1",
	}, p, forwarder.DatagramEgressOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := exit.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = exit.Stop() })
	ingressPort := freeUDPPort(t)
	ingress, err := forwarder.NewDatagramRelay(forwarder.TunnelConfig{
		ID: "lb-udp-ingress", Mode: forwarder.ModeRelay, Protocol: forwarder.ProtocolUDP,
		IngressPort: ingressPort, ListenHost: "127.0.0.1", NextHop: addrFor(exitPort),
	}, forwarder.DatagramRelayOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := ingress.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ingress.Stop() })
	return addrFor(ingressPort)
}

func lbUDPCheck(t *testing.T, c *net.UDPConn, want string) {
	t.Helper()
	if got := udpRoundTrip(t, c, "?"); got != want {
		t.Fatalf("UDP target = %q, want %q", got, want)
	}
}

func TestFallbackRealUDPRecoveryOnlyChangesNewMappings(t *testing.T) {
	primary := startLBUDPTarget(t, "127.0.0.1:0", "A")
	backup := startLBUDPTarget(t, "127.0.0.1:0", "B")
	a := tg("127.0.0.1", primary.LocalAddr().(*net.UDPAddr).Port)
	b := tg("127.0.0.1", backup.LocalAddr().(*net.UDPAddr).Port)
	clk := newFakeClock()
	p := healthPool(t, Fallback, []forwarder.Target{a, b}, []forwarder.TargetHealth{
		th(a.Host, a.Port, "healthy"), th(b.Host, b.Port, "healthy"),
	}, clk, BreakerBounds{Cooldown: time.Minute})
	addr := startLBUDPRelay(t, p)
	lbUDPCheck(t, udpClient(t, addr), "A")
	_ = primary.Close()
	p.SetHealth([]forwarder.TargetHealth{th(a.Host, a.Port, "unhealthy"), th(b.Host, b.Port, "healthy")})
	existing := udpClient(t, addr)
	lbUDPCheck(t, existing, "B")
	startLBUDPTarget(t, a.Addr(), "A")
	p.SetHealth([]forwarder.TargetHealth{th(a.Host, a.Port, "healthy"), th(b.Host, b.Port, "healthy")})
	lbUDPCheck(t, udpClient(t, addr), "B") // cooldown is still enforced
	clk.advance(time.Minute)
	lbUDPCheck(t, udpClient(t, addr), "A") // actual reply closes half-open
	lbUDPCheck(t, existing, "B")           // no reselection for an established mapping
	lbUDPCheck(t, udpClient(t, addr), "A")
	if got := breakerOf(t, p.BreakerStates(), a.Host, a.Port); got.Breaker != "closed" || got.Health != "healthy" {
		t.Fatalf("UDP reply did not resolve recovered primary's probe: %+v", got)
	}
}

func TestIPHashLegacyUDPRelayRefusesUnknownSource(t *testing.T) {
	a := startLBUDPTarget(t, "127.0.0.1:0", "A")
	b := startLBUDPTarget(t, "127.0.0.1:0", "B")
	p := newPool("hash-udp", IPHash, []forwarder.Target{
		tg("127.0.0.1", a.LocalAddr().(*net.UDPAddr).Port),
		tg("127.0.0.1", b.LocalAddr().(*net.UDPAddr).Port),
	})
	_, err := forwarder.NewDatagramEgress(forwarder.TunnelConfig{
		ID: "hash-udp", Mode: forwarder.ModeEgress, Protocol: forwarder.ProtocolUDP,
		EgressPort: freeUDPPort(t), HopPeer: "127.0.0.1",
	}, p, forwarder.DatagramEgressOptions{})
	if !errors.Is(err, forwarder.ErrClientIPRequired) {
		t.Fatalf("UDP relay accepted IP_HASH without original source: %v", err)
	}
}

func TestIPHashUnsupportedUDPHotUpdatePreservesExistingMapping(t *testing.T) {
	a := startLBUDPTarget(t, "127.0.0.1:0", "A")
	target := tg("127.0.0.1", a.LocalAddr().(*net.UDPAddr).Port)
	p := newPool("hot-udp-source", Fallback, []forwarder.Target{target})
	addr := startLBUDPRelay(t, p)
	existing := udpClient(t, addr)
	lbUDPCheck(t, existing, "A")
	p.SwapTargets(IPHash, []forwarder.Target{target})
	lbUDPCheck(t, existing, "A")
	newClient := udpClient(t, addr)
	if _, err := newClient.Write([]byte("?")); err != nil {
		t.Fatal(err)
	}
	_ = newClient.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	if _, err := newClient.Read(make([]byte, 128)); err == nil {
		t.Fatal("new source-less UDP mapping was admitted")
	} else if ne, ok := err.(net.Error); !ok || !ne.Timeout() {
		t.Fatalf("expected a mapping rejection, got %v", err)
	}
	lbUDPCheck(t, existing, "A")
}
