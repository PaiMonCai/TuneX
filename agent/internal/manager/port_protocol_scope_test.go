package manager

import (
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

func udpEchoTarget(t *testing.T) int {
	t.Helper()
	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 65535)
		for {
			n, peer, err := conn.ReadFrom(buf)
			if err != nil {
				return
			}
			if _, err := conn.WriteTo(buf[:n], peer); err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() { _ = conn.Close(); <-done })
	return conn.LocalAddr().(*net.UDPAddr).Port
}

// Probe both real socket namespaces before releasing a candidate numeric port.
func freeSharedPort(t *testing.T) int {
	t.Helper()
	for i := 0; i < 20; i++ {
		ln, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := ln.Addr().(*net.TCPAddr).Port
		packet, err := net.ListenPacket("udp4", addrFor(port))
		_ = ln.Close()
		if err == nil {
			_ = packet.Close()
			return port
		}
	}
	t.Fatal("could not find a free TCP and UDP numeric port")
	return 0
}

func waitProtocolPort(t *testing.T, tm *TunnelManager, protocol string, port int, held bool) {
	t.Helper()
	udpPoll(t, 5*time.Second, func() bool {
		return tm.UsedPortsByProtocol()[protocol][port] == held
	}, protocol+" port reservation")
}

// These are independent rules with byte-identical, real socket round trips.
// Every activation API and insertion order must enforce the same boundary.
func TestSharedSocketPortPayloadConflictDeleteAndReuse(t *testing.T) {
	for _, replace := range []bool{false, true} {
		for _, udpFirst := range []bool{false, true} {
			name := "Apply"
			if replace {
				name = "ReplaceListener"
			}
			if udpFirst {
				name += "/udp-first"
			} else {
				name += "/tcp-first"
			}
			t.Run(name, func(t *testing.T) {
				tcpTarget, stopTCP := echoServer(t)
				t.Cleanup(stopTCP)
				udpTarget := udpEchoTarget(t)
				tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
				t.Cleanup(tm.StopAll)
				activate := tm.Apply
				if replace {
					activate = tm.ReplaceListener
				}
				port := freeSharedPort(t)
				tcpCfg := directCfg("share-tcp", port, tcpTarget, 1)
				udpCfg := udpDirectCfg("share-udp", port, udpTarget, 1)
				configs := []forwarder.TunnelConfig{tcpCfg, udpCfg}
				if udpFirst {
					configs[0], configs[1] = configs[1], configs[0]
				}
				for _, cfg := range configs {
					if _, err := activate(cfg); err != nil {
						t.Fatalf("activate %s: %v", cfg.Protocol, err)
					}
				}
				udp := udpClient(t, addrFor(port))
				payload := []byte("shared-number\x00\xff\x01payload")
				assertPayload := func() {
					t.Helper()
					echoRoundTrip(t, addrFor(port), payload)
					if got := udpRoundTrip(t, udp, string(payload)); got != string(payload) {
						t.Fatalf("UDP payload = %q, want %q", got, payload)
					}
				}
				assertPayload()
				byProtocol := tm.UsedPortsByProtocol()
				if !byProtocol["tcp"][port] || !byProtocol["udp"][port] || len(tm.UsedPorts()) != 1 {
					t.Fatalf("shared socket facts: protocol=%v flat=%v", byProtocol, tm.UsedPorts())
				}
				for _, cfg := range configs {
					duplicate := cfg.Clone()
					duplicate.ID += "-other-owner"
					if _, err := activate(duplicate); err == nil || !strings.Contains(err.Error(), "already used by another tunnel") {
						t.Fatalf("same-protocol conflict = %v", err)
					}
				}
				// Changing one owner's protocol must not stop it before discovering
				// that the other independent rule owns the destination socket.
				change := udpCfg.Clone()
				change.ID, change.Revision = tcpCfg.ID, 2
				equal := change.Clone()
				equal.Revision = 1
				if _, err := activate(equal); err != nil {
					t.Fatalf("equal revision must remain an idempotent no-op: %v", err)
				}
				if _, err := activate(change); err == nil {
					t.Fatal("protocol takeover bypassed another rule's reservation")
				}
				assertPayload()
				if got, _ := tm.Get(tcpCfg.ID); got.Protocol != forwarder.ProtocolTCP || got.Revision != 1 {
					t.Fatalf("refused takeover changed old config: %+v", got)
				}

				if err := tm.RemoveAtRevision(tcpCfg.ID, 2); err != nil {
					t.Fatal(err)
				}
				waitProtocolPort(t, tm, "tcp", port, false)
				if !tm.UsedPortsByProtocol()["udp"][port] || !tm.UsedPorts()[port] {
					t.Fatal("deleting TCP released the independent UDP rule")
				}
				if got := udpRoundTrip(t, udp, string(payload)); got != string(payload) {
					t.Fatalf("UDP payload after TCP delete = %q", got)
				}
				for _, stale := range []int64{1, 2} {
					cfg := tcpCfg.Clone()
					cfg.Revision = stale
					if _, err := activate(cfg); !errors.Is(err, ErrStaleRevision) {
						t.Fatalf("deleted revision %d resurrected: %v", stale, err)
					}
				}
				reuse := tcpCfg.Clone()
				reuse.ID = "share-new-tcp"
				if _, err := activate(reuse); err != nil {
					t.Fatalf("new rule reusing deleted TCP scope: %v", err)
				}
				assertPayload()
				if err := tm.Remove(reuse.ID); err != nil {
					t.Fatal(err)
				}
				waitProtocolPort(t, tm, "tcp", port, false)
				tcpCfg.Revision = 3
				if _, err := activate(tcpCfg); err != nil {
					t.Fatalf("newer revision reusing tombstoned ID: %v", err)
				}
				if _, err := activate(change); !errors.Is(err, ErrStaleRevision) {
					t.Fatalf("stale protocol change bypassed revision gate: %v", err)
				}
				assertPayload()
				if err := tm.RemoveAtRevision(udpCfg.ID, 2); err != nil {
					t.Fatal(err)
				}
				waitProtocolPort(t, tm, "udp", port, false)
				if !tm.UsedPortsByProtocol()["tcp"][port] {
					t.Fatal("deleting UDP released the independent TCP rule")
				}
				reuse = udpCfg.Clone()
				reuse.ID = "share-new-udp"
				if _, err := activate(reuse); err != nil {
					t.Fatalf("new rule reusing deleted UDP scope: %v", err)
				}
				assertPayload()
			})
		}
	}
}

func TestSameProtocolBindScopesConflictOrRemainIndependent(t *testing.T) {
	for _, protocol := range []forwarder.ForwardProtocol{forwarder.ProtocolTCP, forwarder.ProtocolUDP} {
		for _, replace := range []bool{false, true} {
			t.Run(string(protocol)+"/replace="+strconv.FormatBool(replace), func(t *testing.T) {
				tcpTarget, stopTCP := echoServer(t)
				t.Cleanup(stopTCP)
				udpTarget := udpEchoTarget(t)
				tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
				t.Cleanup(tm.StopAll)
				activate := tm.Apply
				if replace {
					activate = tm.ReplaceListener
				}
				port := freeSharedPort(t)
				first := directCfg("scope-a", port, tcpTarget, 1)
				if protocol == forwarder.ProtocolUDP {
					first = udpDirectCfg("scope-a", port, udpTarget, 1)
				}
				first.ListenHost = " [::ffff:7f00:1] "
				if _, err := activate(first); err != nil {
					t.Fatalf("mapped IPv4 apply: %v", err)
				}
				if got, _ := tm.Get(first.ID); got.ListenHost != "127.0.0.1" {
					t.Fatalf("registered host not canonical: %q", got.ListenHost)
				}
				for _, host := range []string{"127.0.0.1", "::ffff:127.0.0.1", "0.0.0.0", "::", "[::]", "*", "localhost"} {
					other := first.Clone()
					other.ID, other.ListenHost = "scope-conflict", host
					if _, err := activate(other); err == nil || !strings.Contains(err.Error(), "already used by another tunnel") {
						t.Fatalf("host %q conflict = %v", host, err)
					}
				}
				second := first.Clone()
				second.ID, second.ListenHost = "scope-b", "127.0.0.2"
				if _, err := activate(second); err != nil {
					t.Fatalf("disjoint concrete scopes must share a numeric port: %v", err)
				}
				assertScope := func(host string) {
					t.Helper()
					addr := net.JoinHostPort(host, strconv.Itoa(port))
					if protocol == forwarder.ProtocolTCP {
						echoRoundTrip(t, addr, []byte("scope-payload"))
					} else {
						client := udpClient(t, addr)
						if got := udpRoundTrip(t, client, "scope-payload"); got != "scope-payload" {
							t.Fatalf("scope %s payload = %q", host, got)
						}
					}
				}
				assertScope("127.0.0.1")
				assertScope("127.0.0.2")
				// Exempting the current ID must not hide a second scope owner.
				expand := first.Clone()
				expand.ListenHost, expand.Revision = "::", 2
				if _, err := activate(expand); err == nil || !strings.Contains(err.Error(), "already used by another tunnel") {
					t.Fatalf("same-owner wildcard expansion bypassed another scope: %v", err)
				}
				assertScope("127.0.0.1")
				assertScope("127.0.0.2")
				if err := tm.Remove(first.ID); err != nil {
					t.Fatal(err)
				}
				udpPoll(t, 5*time.Second, func() bool {
					tm.mu.RLock()
					defer tm.mu.RUnlock()
					return len(tm.stoppingPorts) == 0
				}, "first scope's teardown")
				if !tm.UsedPortsByProtocol()[string(protocol)][port] {
					t.Fatal("releasing one concrete scope released the other")
				}
				assertScope("127.0.0.2")
				first.ID = "scope-reused"
				if _, err := activate(first); err != nil {
					t.Fatalf("reuse deleted concrete scope: %v", err)
				}
				assertScope("127.0.0.1")
			})
		}
	}
}

func TestSwapPlanIncludesHostAndProtocolBoundary(t *testing.T) {
	base := directCfg("plan", 19000, "127.0.0.1:9000", 1)
	base.ListenHost = "127.0.0.1"
	for _, tc := range []struct {
		name, host string
		protocol   forwarder.ForwardProtocol
		want       SwapStrategy
	}{
		{"same concrete host", "127.0.0.1", forwarder.ProtocolTCP, SwapMetadata},
		{"mapped spelling", "[::ffff:127.0.0.1]", forwarder.ProtocolTCP, SwapMetadata},
		{"host moves", "127.0.0.2", forwarder.ProtocolTCP, SwapListener},
		{"wildcard expands scope", "::", forwarder.ProtocolTCP, SwapListener},
		{"socket protocol changes", "127.0.0.1", forwarder.ProtocolUDP, SwapRecreate},
		{"TCP front changes", "127.0.0.1", forwarder.ProtocolWS, SwapRecreate},
	} {
		t.Run(tc.name, func(t *testing.T) {
			next := base.Clone()
			next.ListenHost, next.Protocol, next.Revision = tc.host, tc.protocol, 2
			if got := PlanForwardSwap(base, next); got.Strategy != tc.want {
				t.Fatalf("plan = %+v, want %s", got, tc.want)
			}
		})
	}
}

// pausedStopRuntime delegates all socket work to a real runtime, but lets the
// test observe teardown before Stop can complete. A live client alone cannot
// establish that boundary: Stop is allowed to cancel and close its connections.
type pausedStopRuntime struct {
	forwarder.Runtime
	entered chan struct{}
	release chan struct{}
	stop    sync.Once
	err     error
}

func (r *pausedStopRuntime) Stop() error {
	r.stop.Do(func() {
		close(r.entered)
		<-r.release
		r.err = r.Runtime.Stop()
	})
	return r.err
}

func pauseTunnelStop(t *testing.T, tm *TunnelManager, id string, runtime forwarder.Runtime) (*pausedStopRuntime, func()) {
	t.Helper()
	paused := &pausedStopRuntime{Runtime: runtime, entered: make(chan struct{}), release: make(chan struct{})}
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(paused.release) }) }
	t.Cleanup(release)
	tm.mu.Lock()
	tm.tunnels[id].fwd = paused
	tm.mu.Unlock()
	return paused, release
}

func TestStoppingScopeKeepsOnlyItsSocketProtocolReserved(t *testing.T) {
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	t.Cleanup(tm.StopAll)
	port := freeSharedPort(t)
	cfg := directCfg("stopping-tcp", port, "127.0.0.1:9000", 1)
	cfg.ListenHost = "127.0.0.1"
	runtime, err := tm.Apply(cfg)
	if err != nil {
		t.Fatal(err)
	}
	old, release := pauseTunnelStop(t, tm, cfg.ID, runtime)
	if err := tm.RemoveAtRevision(cfg.ID, 2); err != nil {
		t.Fatal(err)
	}
	select {
	case <-old.entered:
	case <-time.After(time.Second):
		t.Fatal("Stop did not start")
	}
	if !old.Running() || !tm.UsedPortsByProtocol()["tcp"][port] {
		t.Fatal("a stopping listener lost its TCP reservation before Stop returned")
	}
	udpTarget := udpEchoTarget(t)
	udpCfg := udpDirectCfg("stopping-independent-udp", port, udpTarget, 1)
	if _, err := tm.ReplaceListener(udpCfg); err != nil {
		t.Fatalf("TCP teardown blocked an independent UDP socket: %v", err)
	}
	client := udpClient(t, addrFor(port))
	if got := udpRoundTrip(t, client, "while-tcp-stops"); got != "while-tcp-stops" {
		t.Fatalf("UDP payload during TCP stop = %q", got)
	}
	conflict := cfg.Clone()
	conflict.ID, conflict.ListenHost = "stopping-conflict", "[::ffff:127.0.0.1]"
	for _, activate := range []func(forwarder.TunnelConfig) (forwarder.Runtime, error){tm.Apply, tm.ReplaceListener} {
		if _, err := activate(conflict); err == nil || !strings.Contains(err.Error(), "already used by another tunnel") {
			t.Fatalf("a still-stopping TCP scope was handed out: %v", err)
		}
	}
	release()
	waitProtocolPort(t, tm, "tcp", port, false)
	if !tm.UsedPortsByProtocol()["udp"][port] {
		t.Fatal("TCP teardown released an independent UDP runtime")
	}
	if _, err := tm.Apply(conflict); err != nil {
		t.Fatalf("TCP scope cannot be reused after Stop completed: %v", err)
	}
	// Simulate a delayed completion observing a newer same-ID incarnation.
	// Rebuilding the derived guard must retain the newer live owner.
	tm.releasePortAfterStop(conflict)()
	if byProtocol := tm.UsedPortsByProtocol(); !byProtocol["tcp"][port] || !byProtocol["udp"][port] {
		t.Fatalf("late release lost a live owner: %v", byProtocol)
	}
}

func TestReplaceListenerMovesBindScopeOnTheSamePort(t *testing.T) {
	for _, sibling := range []bool{false, true} {
		t.Run("sibling="+strconv.FormatBool(sibling), func(t *testing.T) {
			target, stopTarget := echoServer(t)
			t.Cleanup(stopTarget)
			tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
			t.Cleanup(tm.StopAll)
			port := freeSharedPort(t)
			cfg := directCfg("tunex-scope-direct", port, target, 1)
			old, err := tm.Apply(cfg)
			if err != nil {
				t.Fatal(err)
			}
			echoRoundTrip(t, addrFor(port), []byte("old-scope-payload"))
			paused, release := pauseTunnelStop(t, tm, cfg.ID, old)
			next := cfg.Clone()
			next.ListenHost, next.Revision = "127.0.0.2", 2
			if sibling {
				next.ID, next.Mode, next.NextHop = "tunex-scope-relay", forwarder.ModeRelay, target
			}
			current, err := tm.ReplaceListener(next)
			if err != nil {
				t.Fatalf("move concrete scope on the same port: %v", err)
			}
			if current == old {
				t.Fatal("scope change was absorbed as a target swap")
			}
			select {
			case <-paused.entered:
			case <-time.After(time.Second):
				t.Fatal("old scope teardown did not start")
			}
			newAddr := net.JoinHostPort("127.0.0.2", strconv.Itoa(port))
			echoRoundTrip(t, newAddr, []byte("new-scope-payload"))
			conflict := cfg.Clone()
			conflict.ID = "old-scope-in-drain"
			if _, err := tm.Apply(conflict); err == nil || !strings.Contains(err.Error(), "already used by another tunnel") {
				t.Fatalf("old scope not reserved while draining: %v", err)
			}
			release()
			udpPoll(t, 5*time.Second, func() bool { return !old.Running() }, "old scope socket closed")
			udpPoll(t, 5*time.Second, func() bool {
				tm.mu.RLock()
				defer tm.mu.RUnlock()
				return len(tm.stoppingPorts) == 0
			}, "scope move teardown note cleared")
			if _, err := tm.Apply(conflict); err != nil {
				t.Fatalf("old concrete scope cannot be reused: %v", err)
			}
			echoRoundTrip(t, addrFor(port), []byte("reused-old-scope"))
			echoRoundTrip(t, newAddr, []byte("new-scope-still-owned"))
		})
	}
}

func TestSiblingProtocolChangeCannotTakeAnotherRulesSocket(t *testing.T) {
	target, stopTarget := echoServer(t)
	t.Cleanup(stopTarget)
	udpTarget := udpEchoTarget(t)
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	t.Cleanup(tm.StopAll)
	port := freeSharedPort(t)
	oldCfg := directCfg("tunex-sibling-direct", port, target, 1)
	old, err := tm.Apply(oldCfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tm.Apply(udpDirectCfg("unrelated-udp", port, udpTarget, 1)); err != nil {
		t.Fatal(err)
	}
	next := relayCfg("tunex-sibling-relay", port, addrFor(udpTarget), 2)
	next.Protocol = forwarder.ProtocolUDP
	if _, err := tm.ReplaceListener(next); err == nil || !strings.Contains(err.Error(), "already used by another tunnel") {
		t.Fatalf("sibling protocol takeover = %v", err)
	}
	if !old.Running() {
		t.Fatal("refused sibling takeover stopped the old TCP rule")
	}
	if _, ok := tm.Get(next.ID); ok {
		t.Fatal("refused sibling takeover registered a new resource ID")
	}
	echoRoundTrip(t, addrFor(port), []byte("tcp-sibling-kept"))
	udp := udpClient(t, addrFor(port))
	if got := udpRoundTrip(t, udp, "udp-kept"); got != "udp-kept" {
		t.Fatalf("independent UDP payload = %q", got)
	}
}

func TestConcreteIPv4AndIPv6ScopesShareNumberAndNormalize(t *testing.T) {
	probe, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Skipf("IPv6 loopback unavailable: %v", err)
	}
	_ = probe.Close()
	packet, err := net.ListenPacket("udp6", "[::1]:0")
	if err != nil {
		t.Skipf("IPv6 UDP loopback unavailable: %v", err)
	}
	_ = packet.Close()
	for _, protocol := range []forwarder.ForwardProtocol{forwarder.ProtocolTCP, forwarder.ProtocolUDP} {
		t.Run(string(protocol), func(t *testing.T) {
			target, stopTarget := echoServer(t)
			t.Cleanup(stopTarget)
			udpTarget := udpEchoTarget(t)
			tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
			t.Cleanup(tm.StopAll)
			port := freeSharedPort(t)
			v4 := directCfg("concrete-v4", port, target, 1)
			if protocol == forwarder.ProtocolUDP {
				v4 = udpDirectCfg("concrete-v4", port, udpTarget, 1)
			}
			if _, err := tm.Apply(v4); err != nil {
				t.Fatal(err)
			}
			v6 := v4.Clone()
			v6.ID, v6.ListenHost = "concrete-v6", " [0:0:0:0:0:0:0:1] "
			if _, err := tm.ReplaceListener(v6); err != nil {
				t.Fatalf("distinct concrete address families should share the number: %v", err)
			}
			if got, _ := tm.Get(v6.ID); got.ListenHost != "::1" {
				t.Fatalf("IPv6 listen host was not canonicalized: %q", got.ListenHost)
			}
			alias := v6.Clone()
			alias.ID, alias.ListenHost = "v6-alias-conflict", "::0001"
			if _, err := tm.Apply(alias); err == nil || !strings.Contains(err.Error(), "already used by another tunnel") {
				t.Fatalf("IPv6 alias conflict = %v", err)
			}
			for _, host := range []string{"127.0.0.1", "::1"} {
				addr := net.JoinHostPort(host, strconv.Itoa(port))
				payload := "concrete-family-payload\x00\xff"
				if protocol == forwarder.ProtocolTCP {
					echoRoundTrip(t, addr, []byte(payload))
				} else {
					client := udpClient(t, addr)
					if got := udpRoundTrip(t, client, payload); got != payload {
						t.Fatalf("%s payload = %q", host, got)
					}
				}
			}
		})
	}
}
