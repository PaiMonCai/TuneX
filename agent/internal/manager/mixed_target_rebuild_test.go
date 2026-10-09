package manager

import (
	"fmt"
	"io"
	"net"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/ownership"
)

// Allocate both socket namespaces together: a TCP-only ephemeral allocation
// does not prove that the corresponding UDP port is free on the test host.
func mixedRebuildSockets(t *testing.T, host string) (net.Listener, net.PacketConn) {
	t.Helper()
	var lastErr error
	for i := 0; i < 20; i++ {
		l, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
		if err != nil {
			t.Fatal(err)
		}
		u, err := net.ListenPacket("udp", l.Addr().String())
		if err == nil {
			return l, u
		}
		_ = l.Close()
		lastErr = err
	}
	t.Fatalf("allocate real TCP+UDP sockets: %v", lastErr)
	return nil, nil
}

func mixedRebuildTarget(t *testing.T, label string) (int, func() [2]int64) {
	t.Helper()
	l, u := mixedRebuildSockets(t, "127.0.0.1")
	t.Cleanup(func() { _ = l.Close(); _ = u.Close() })
	var tcp, udp atomic.Int64
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				tcp.Add(1)
				_, _ = c.Write([]byte("srv:" + label + "\n"))
				_, _ = io.Copy(io.Discard, c)
			}()
		}
	}()
	go func() {
		buf := make([]byte, 1024)
		for {
			_, peer, err := u.ReadFrom(buf)
			if err != nil {
				return
			}
			udp.Add(1)
			_, _ = u.WriteTo([]byte("srv:"+label), peer)
		}
	}()
	return l.Addr().(*net.TCPAddr).Port, func() [2]int64 { return [2]int64{tcp.Load(), udp.Load()} }
}

func TestNativeBothTargetRebuildWithActiveMappingAfterTCPClientClose(t *testing.T) {
	for _, host := range []string{"", "0.0.0.0", "::", "127.0.0.1"} {
		for _, useApply := range []bool{false, true} {
			for _, phased := range []bool{false, true} {
				for _, awaitTCP := range []bool{false, true} {
					name := fmt.Sprintf("host=%s/Apply=%t/phased=%t/awaitTCP=%t", host, useApply, phased, awaitTCP)
					t.Run(name, func(t *testing.T) {
						aPort, aCount := mixedRebuildTarget(t, "a")
						bPort, bCount := mixedRebuildTarget(t, "b")
						m := NewTunnelManager(NewEgressManager(), "")
						t.Cleanup(m.StopAll)
						now := time.Unix(1800000000, 0).UTC()
						var g *ownership.Guard
						if phased {
							g = ownership.New(ownership.Config{Fence: ownership.OpenFence(filepath.Join(t.TempDir(), "fence.json"), "mixed-rebuild"), Registry: m, Now: func() time.Time { return now }})
							m.SetOwnershipGuard(g)
						}
						l, packet := mixedRebuildSockets(t, host)
						port := l.Addr().(*net.TCPAddr).Port
						_ = l.Close()
						_ = packet.Close()
						cfg := directCfg("tunex-640-direct", port, addrFor(aPort), 1)
						cfg.Protocol, cfg.ListenHost = forwarder.ProtocolBoth, host
						if phased {
							cfg.OwnershipEpoch = 2
							cfg.LeaseExpiresAt = now.Add(10 * time.Second).Format(time.RFC3339)
						}
						activate := m.ReplaceListener
						if useApply {
							activate = m.Apply
						}
						old, err := activate(cfg)
						if err != nil {
							t.Fatalf("create both: %v", err)
						}
						addr := addrFor(port)
						c, err := net.DialTimeout("tcp", addr, time.Second)
						if err != nil {
							t.Fatal(err)
						}
						t.Cleanup(func() { _ = c.Close() })
						if got := readOneLine(t, c); got != "srv:a" {
							t.Fatalf("old TCP target = %q, want srv:a", got)
						}
						u := udpClient(t, addr)
						if got := udpRoundTrip(t, u, "before"); got != "srv:a" {
							t.Fatalf("old UDP target = %q, want srv:a", got)
						}
						if n, ok := m.LiveMappings(cfg.ID); !ok || n != 1 || m.LiveConns(cfg.ID) != 1 {
							t.Fatalf("before close: TCP=%d UDP=%d present=%v", m.LiveConns(cfg.ID), n, ok)
						}
						if phased {
							renewed := now.Add(5 * time.Minute).Format(time.RFC3339)
							if n, _ := g.ObserveRenewals([]ownership.Renewal{{TunnelRef: 640, Epoch: 2, Revision: 1, ExpiresAt: renewed}}, now); n != 1 {
								t.Fatalf("renewed %d owners, want 1", n)
							}
							now = now.Add(20 * time.Second)
						}
						if err := c.Close(); err != nil {
							t.Fatal(err)
						}
						if awaitTCP {
							udpPoll(t, 2*time.Second, func() bool { return m.LiveConns(cfg.ID) == 0 }, "TCP handler retirement")
						}
						candidate := cfg.Clone()
						candidate.Revision, candidate.RemotePort = 2, bPort
						if phased {
							candidate.LeaseExpiresAt = now.Add(8 * time.Minute).Format(time.RFC3339)
						}
						if PlanForwardSwap(cfg, candidate).Strategy != SwapRecreate {
							t.Fatal("both target change was not planned as full rebuild")
						}
						next, err := activate(candidate)
						if err != nil {
							t.Fatalf("target-only full rebuild: %v", err)
						}
						if next == old || !next.Running() || old.Running() || old.(forwarder.MixedRuntime).Datagram().LiveMappings() != 0 {
							t.Fatal("old lanes/mapping survived or new lanes are not ready")
						}
						if n, ok := m.LiveMappings(cfg.ID); !ok || n != 0 {
							t.Fatalf("new runtime inherited old mapping: %d present=%v", n, ok)
						}
						stored, ok := m.Get(cfg.ID)
						if !ok || stored.Revision != 2 || stored.RemotePort != bPort || stored.Protocol != forwarder.ProtocolBoth || m.Len() != 1 || m.MaxRevision() != 2 {
							t.Fatalf("registry did not commit one both revision: %+v", stored)
						}
						if phased && g.CompensationConfig(stored).LeaseExpiresAt != candidate.LeaseExpiresAt {
							t.Fatal("phased guard clock did not commit candidate")
						}
						ports := m.UsedPortsByProtocol()
						if !ports["tcp"][port] || !ports["udp"][port] || len(ports) != 2 {
							t.Fatalf("partial port ownership: %v", ports)
						}
						c2, err := net.DialTimeout("tcp", addr, time.Second)
						if err != nil {
							t.Fatal(err)
						}
						t.Cleanup(func() { _ = c2.Close() })
						if got := readOneLine(t, c2); got != "srv:b" {
							t.Fatalf("rebuilt TCP target = %q, want srv:b", got)
						}
						if got := udpRoundTrip(t, u, "same-peer-after"); got != "srv:b" {
							t.Fatalf("rebuilt existing UDP peer target = %q, want srv:b", got)
						}
						if got := udpRoundTrip(t, udpClient(t, addr), "new-peer-after"); got != "srv:b" {
							t.Fatalf("rebuilt new UDP peer target = %q, want srv:b", got)
						}
						if got := aCount(); got != [2]int64{1, 1} {
							t.Fatalf("old target received traffic after ACK: %v", got)
						}
						if got := bCount(); got != [2]int64{1, 2} {
							t.Fatalf("new target lane counts: %v, want [1 2]", got)
						}
						_ = c2.Close()
					})
				}
			}
		}
	}
}
