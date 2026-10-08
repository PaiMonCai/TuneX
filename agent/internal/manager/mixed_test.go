package manager

import (
	"errors"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/ownership"
)

func nativeBothPort(t *testing.T) int {
	t.Helper()
	for i := 0; i < 20; i++ {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		p := l.Addr().(*net.TCPAddr).Port
		u, err := net.ListenPacket("udp", l.Addr().String())
		_ = l.Close()
		if err == nil {
			_ = u.Close()
			return p
		}
	}
	t.Fatal("no free TCP+UDP port")
	return 0
}

func nativeBothTarget(t *testing.T) string {
	t.Helper()
	addr, closeTCP := echoServer(t)
	t.Cleanup(closeTCP)
	u, err := net.ListenPacket("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = u.Close() })
	go func() {
		buf := make([]byte, 1024)
		for {
			n, peer, err := u.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = u.WriteTo(buf[:n], peer)
		}
	}()
	return addr
}

func nativeBothCfg(t *testing.T, id string) forwarder.TunnelConfig {
	cfg := directCfg(id, nativeBothPort(t), nativeBothTarget(t), 1)
	cfg.Protocol = forwarder.ProtocolBoth
	return cfg
}

func TestNativeBothRegistryRevisionStatsRemoveAndRestore(t *testing.T) {
	m := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	t.Cleanup(m.StopAll)
	cfg := nativeBothCfg(t, "tunex-601-direct")
	f, err := m.ReplaceListener(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.List()) != 1 {
		t.Fatal("two child business identities")
	}
	ports := m.UsedPortsByProtocol()
	if len(ports) != 2 || !ports["tcp"][cfg.IngressPort] || !ports["udp"][cfg.IngressPort] {
		t.Fatal("guard namespaces", ports)
	}
	echoRoundTrip(t, addrFor(cfg.IngressPort), []byte("tcp"))
	u := udpClient(t, addrFor(cfg.IngressPort))
	if got := udpRoundTrip(t, u, "udp"); got != "udp" {
		t.Fatal(got)
	}
	udpPoll(t, time.Second, func() bool { return m.Stats(cfg.ID) == 12 }, "aggregate byte stats")
	if m.LiveConns(cfg.ID) != 0 {
		t.Fatal("UDP mapping misreported as TCP connection")
	}
	if n, ok := m.LiveMappings(cfg.ID); !ok || n != 1 {
		t.Fatal("missing UDP mapping", n, ok)
	}
	if again, err := m.ReplaceListener(cfg); err != nil || again != f {
		t.Fatal("equal revision churn", err)
	}
	stale := cfg.Clone()
	stale.Revision = 0 // legacy 0 is not a stale marker
	stale.Revision = -1
	if _, err := m.ReplaceListener(stale); !errors.Is(err, ErrStaleRevision) {
		t.Fatal("stale accepted", err)
	}
	// Restart uses the exact canonical both config, not two invented IDs.
	saved := m.List()
	m.StopAll()
	for _, item := range saved {
		if _, err := m.Apply(item); err != nil {
			t.Fatal("restore", err)
		}
	}
	echoRoundTrip(t, addrFor(cfg.IngressPort), []byte("restore-tcp"))
	u2 := udpClient(t, addrFor(cfg.IngressPort))
	if got := udpRoundTrip(t, u2, "restore-udp"); got != "restore-udp" {
		t.Fatal(got)
	}
	if err := m.RemoveAtRevision(cfg.ID, 2); err != nil {
		t.Fatal(err)
	}
	if !portFreedWithin(t, m.UsedPorts, cfg.IngressPort, time.Second) {
		t.Fatal("partial port release")
	}
	if _, err := m.Apply(cfg); !errors.Is(err, ErrStaleRevision) {
		t.Fatal("deleted revision resurrected", err)
	}
	cfg.ID = "reuse"
	cfg.Revision = 3
	if _, err := m.Apply(cfg); err != nil {
		t.Fatal("exact double port reuse", err)
	}
}

func TestNativeBothHalfFailureRestoresOldAppliedRevision(t *testing.T) {
	for _, oldProtocol := range []forwarder.ForwardProtocol{forwarder.ProtocolTCP, forwarder.ProtocolUDP} {
		t.Run(string(oldProtocol), func(t *testing.T) {
			m := NewTunnelManager(NewEgressManager(), "127.0.0.1")
			t.Cleanup(m.StopAll)
			old := nativeBothCfg(t, "tunex-602-direct")
			old.Protocol = oldProtocol
			if _, err := m.Apply(old); err != nil {
				t.Fatal(err)
			}
			// A foreign socket occupies only the lane being ADDED, outside
			// manager facts. This exercises the authoritative OS half-bind.
			var release func()
			if oldProtocol == forwarder.ProtocolTCP {
				b, err := net.ListenPacket("udp", addrFor(old.IngressPort))
				if err != nil {
					t.Fatal(err)
				}
				release = func() { _ = b.Close() }
			} else {
				b, err := net.Listen("tcp", addrFor(old.IngressPort))
				if err != nil {
					t.Fatal(err)
				}
				release = func() { _ = b.Close() }
			}
			defer release()
			candidate := old.Clone()
			candidate.Protocol = forwarder.ProtocolBoth
			candidate.Revision++
			if _, err := m.ReplaceListener(candidate); err == nil {
				t.Fatal("half failure ACKed")
			}
			got, ok := m.Get(old.ID)
			if !ok || got.Protocol != old.Protocol || got.Revision != old.Revision || !m.tunnels[old.ID].fwd.Running() {
				t.Fatal("old revision not compensated", got)
			}
			if oldProtocol == forwarder.ProtocolTCP {
				echoRoundTrip(t, addrFor(old.IngressPort), []byte("compensated-tcp"))
			} else if got := udpRoundTrip(t, udpClient(t, addrFor(old.IngressPort)), "compensated-udp"); got != "compensated-udp" {
				t.Fatal(got)
			}
			release()
			if _, err := m.ReplaceListener(candidate); err != nil {
				t.Fatal("retry after actual release", err)
			}
		})
	}
}

func TestNativeBothAtomicRetargetAndSiblingModeRebuild(t *testing.T) {
	m := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	t.Cleanup(m.StopAll)
	cfg := nativeBothCfg(t, "tunex-603-direct")
	old, err := m.ReplaceListener(cfg)
	if err != nil {
		t.Fatal(err)
	}
	new_ := directCfg(cfg.ID, cfg.IngressPort, nativeBothTarget(t), 2)
	new_.Protocol = forwarder.ProtocolBoth
	if PlanForwardSwap(cfg, new_).Strategy != SwapRecreate {
		t.Fatal("mixed single-lane retarget planned")
	}
	f, err := m.ReplaceListener(new_)
	if err != nil || f == old {
		t.Fatal("partial update", err)
	}
	// The test upstream is a real two-protocol socket. For the RELAY UDP wire
	// it needn't understand the envelope: this check concerns atomic ownership.
	relay := relayCfg("tunex-603-relay", cfg.IngressPort, new_.UpstreamAddr(), 3)
	relay.Protocol = forwarder.ProtocolBoth
	r, err := m.ReplaceListener(relay)
	if err != nil || r == f {
		t.Fatal("mixed mode retarget refused instead of rebuilt", err)
	}
	if _, ok := m.Get(cfg.ID); ok || len(m.List()) != 1 {
		t.Fatal("sibling ghost")
	}
}

type mixedCompensationGuard struct{ calls int }

func (g *mixedCompensationGuard) Admit(cfg forwarder.TunnelConfig) error {
	g.calls++
	if g.calls >= 3 && cfg.Revision == 1 {
		return errors.New("old ownership expired")
	}
	return nil
}

func TestNativeBothCompensationCannotReactivateRevokedOwner(t *testing.T) {
	m := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	t.Cleanup(m.StopAll)
	m.SetOwnershipGuard(&mixedCompensationGuard{})
	old := nativeBothCfg(t, "tunex-604-direct")
	old.Protocol = forwarder.ProtocolTCP
	if _, err := m.Apply(old); err != nil {
		t.Fatal(err)
	}
	b, err := net.ListenPacket("udp", addrFor(old.IngressPort))
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	candidate := old.Clone()
	candidate.Protocol = forwarder.ProtocolBoth
	candidate.Revision = 2
	if _, err := m.ReplaceListener(candidate); err == nil {
		t.Fatal("unauthorized compensation")
	}
	if _, ok := m.Get(old.ID); ok || len(m.UsedPortsByProtocol()["tcp"]) != 0 {
		t.Fatal("stopped old owner advertised")
	}
}

func TestNativeBothActualGuardCommitsOnlyAppliedAndKeepsRenewedCompensation(t *testing.T) {
	now := time.Unix(1800000000, 0).UTC()
	m := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	t.Cleanup(m.StopAll)
	fence := ownership.OpenFence(filepath.Join(t.TempDir(), "fence.json"), "mixed-owner")
	g := ownership.New(ownership.Config{Fence: fence, Registry: m, Now: func() time.Time { return now }})
	m.SetOwnershipGuard(g)
	old := nativeBothCfg(t, "tunex-605-direct")
	old.Protocol = forwarder.ProtocolTCP
	old.OwnershipEpoch = 2
	old.LeaseExpiresAt = now.Add(10 * time.Second).Format(time.RFC3339)
	if _, err := m.Apply(old); err != nil {
		t.Fatal(err)
	}
	renewed := now.Add(5 * time.Minute).Format(time.RFC3339)
	if n, _ := g.ObserveRenewals([]ownership.Renewal{{TunnelRef: 605, Epoch: 2, Revision: 1, ExpiresAt: renewed}}, now); n != 1 {
		t.Fatal(n)
	}
	now = now.Add(20 * time.Second)
	b, err := net.ListenPacket("udp", addrFor(old.IngressPort))
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	failed := old.Clone()
	failed.Protocol = forwarder.ProtocolBoth
	failed.Revision = 2
	failed.LeaseExpiresAt = now.Add(8 * time.Minute).Format(time.RFC3339)
	if _, err := m.ReplaceListener(failed); err == nil {
		t.Fatal("failed candidate accepted")
	}
	actual, ok := m.Get(old.ID)
	if !ok || actual.Revision != 1 || actual.LeaseExpiresAt != renewed || g.CompensationConfig(actual).LeaseExpiresAt != renewed {
		t.Fatal("candidate clock committed or renewed old lease lost", actual)
	}
	echoRoundTrip(t, addrFor(old.IngressPort), []byte("effective-renewal"))
	failed.OwnershipEpoch = 3
	if _, err := m.ReplaceListener(failed); err == nil {
		t.Fatal("higher owner half failure accepted")
	}
	if _, ok := m.Get(old.ID); ok || fence.Highest(old.ID) != 3 {
		t.Fatal("superseded old owner or rolled-back fence")
	}
}

func TestNativeBothEqualRevisionRefreshesOwnerWithoutListenerChurn(t *testing.T) {
	now := time.Unix(1800000000, 0).UTC()
	m := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	t.Cleanup(m.StopAll)
	g := ownership.New(ownership.Config{Fence: ownership.OpenFence(filepath.Join(t.TempDir(), "fence.json"), "mixed-refresh"),
		Registry: m, Now: func() time.Time { return now }})
	m.SetOwnershipGuard(g)
	fired := 0
	m.SetMutationHook(func() { fired++ })
	cfg := nativeBothCfg(t, "tunex-606-direct")
	cfg.OwnershipEpoch, cfg.LeaseExpiresAt = 1, now.Add(time.Minute).Format(time.RFC3339)
	f, err := m.Apply(cfg)
	if err != nil {
		t.Fatal(err)
	}
	refresh := cfg.Clone()
	refresh.OwnershipEpoch = 2
	refresh.LeaseExpiresAt = now.Add(2 * time.Minute).Format(time.RFC3339)
	if same, err := m.ReplaceListener(refresh); err != nil || same != f {
		t.Fatal("owner refresh churned listener", err)
	}
	stored, _ := m.Get(cfg.ID)
	if stored.OwnershipEpoch != 2 || fired != 2 || g.CompensationConfig(stored).LeaseExpiresAt != refresh.LeaseExpiresAt {
		t.Fatal("registry/clock/cache observer diverged", stored, fired)
	}
	legacy := refresh.Clone()
	renewed := now.Add(5 * time.Minute).Format(time.RFC3339)
	if n, _ := g.ObserveRenewals([]ownership.Renewal{{TunnelRef: 606, Epoch: 2, Revision: 1, ExpiresAt: renewed}}, now); n != 1 {
		t.Fatal(n)
	}
	now = now.Add(3 * time.Minute) // Original command expired, live renewal did not.
	legacy.OwnershipEpoch = 0
	legacy.LeaseExpiresAt = ""
	if _, err := m.Apply(legacy); err != nil {
		t.Fatal(err)
	}
	stored, _ = m.Get(cfg.ID)
	if stored.OwnershipEpoch != 2 || stored.LeaseExpiresAt != renewed {
		t.Fatal("legacy replay stripped owner", stored)
	}
}
