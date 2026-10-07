package linkrunner

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tunex/agent/internal/manager"
	"github.com/tunex/agent/internal/portlease"
)

func TestRealFXPManagedSiblingTraffic(t *testing.T) {
	if os.Getenv("TUNEX_TEST_FXP_BINARY") == "" {
		t.Skip("requires real FXP")
	}
	m := newTestManager(t, binaryForTest(t), t.TempDir())
	native := manager.NewTunnelManager(manager.NewEgressManager(), "127.0.0.1")
	if err := m.SetPortGuard(native); err != nil {
		t.Fatal(err)
	}
	aTarget, bTarget, editedTarget := realEchoTarget(t), realEchoTarget(t), realEchoTarget(t)
	carrier, aPort, bPort := freePort(t, "tcp"), freePort(t, "tcp"), freePort(t, "tcp")
	for aPort == carrier {
		aPort = freePort(t, "tcp")
	}
	for bPort == carrier || bPort == aPort {
		bPort = freePort(t, "tcp")
	}
	exit := exitConfig(t, "managed-exit", "both", carrier, 1)
	ingress := cloneConfig(exit)
	ingress.ID = "managed-ingress"
	ingress.Role = "ingress"
	aMaxConnections := 2
	configure := func(includeA bool, aTargetPort int, extraPort int) {
		entries := []map[string]any{}
		allowed := []map[string]any{}
		targets := []map[string]any{}
		ingress.Ports = nil
		ingress.RuntimeIDs = nil
		for _, binding := range []struct{ id, port, target int }{{102, bPort, bTarget.port}, {101, aPort, aTargetPort}, {103, extraPort, aTarget.port}} {
			if binding.id == 101 && !includeA || binding.id == 103 && extraPort == 0 {
				continue
			}
			maxConnections := 2
			if binding.id == 101 {
				maxConnections = aMaxConnections
			}
			entries = append(entries, map[string]any{"role": "entry", "tunnelId": 91, "ruleId": binding.id, "listenHost": "127.0.0.1", "listenPort": binding.port, "protocol": "both", "exitHost": "127.0.0.1", "exitPort": carrier, "targetIp": "127.0.0.1", "targetPort": binding.target, "key": fixtureKey, "maxConnections": maxConnections, "limitIn": 1048576, "limitOut": 1048576})
			for _, protocol := range []string{"tcp", "udp"} {
				ingress.Ports = append(ingress.Ports, Port{protocol, "127.0.0.1", binding.port})
				ingress.RuntimeIDs = append(ingress.RuntimeIDs, fmt.Sprintf("binding-%d-%s", binding.id, protocol))
				allowed = append(allowed, map[string]any{"ruleId": binding.id, "protocol": protocol, "targetIp": "127.0.0.1", "targetPort": binding.target})
			}
			targets = append(targets, map[string]any{"ruleId": binding.id, "targetIp": "127.0.0.1", "targetPort": binding.target})
		}
		setRunner(t, &exit, map[string]any{"role": "exit", "tunnelId": 91, "listenHost": "127.0.0.1", "listenPort": carrier, "udpListenPort": carrier, "protocol": "both", "key": fixtureKey, "requireBindingAuth": true, "managedReload": true, "allowedBindings": allowed, "udpTargets": targets})
		setRunner(t, &ingress, map[string]any{"role": "entry-group", "tunnelId": 91, "entries": entries, "managedReload": true})
	}
	configure(false, aTarget.port, 0)
	x, err := m.Apply(exit)
	requireReady(t, x, err)
	exitPID := x.PID
	x, err = m.Apply(ingress)
	requireReady(t, x, err)
	ingressPID := x.PID
	connect := func(protocol string, port int) net.Conn {
		c, err := net.Dial(protocol, fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		return c
	}
	bTCP, bUDP := connect("tcp", bPort), connect("udp", bPort)
	if err := echoRoundTrip(bTCP, "B-held"); err != nil {
		t.Fatal(err)
	}
	bPeer := udpRoundTrip(t, bUDP, bTarget, "B-fixed-source")
	stop, finished := make(chan struct{}), make(chan struct{})
	failures := make(chan error, 1)
	var samples atomic.Int64
	go func() {
		defer close(finished)
		for {
			select {
			case <-stop:
				return
			default:
			}
			if err := echoRoundTrip(bTCP, "B-continuous-tcp"); err != nil {
				failures <- err
				return
			}
			if err := echoRoundTrip(bUDP, "B-continuous-udp"); err != nil {
				failures <- err
				return
			}
			select {
			case peer := <-bTarget.udpPeers:
				if peer != bPeer {
					failures <- fmt.Errorf("B mapping changed: %s -> %s", bPeer, peer)
					return
				}
			case <-time.After(time.Second):
				failures <- errors.New("B UDP target missing")
				return
			}
			samples.Add(1)
			time.Sleep(time.Millisecond)
		}
	}()
	defer func() { close(stop); <-finished }()
	apply := func(label string) {
		exit.Generation++
		ingress.Generation++
		start := time.Now()
		x, err := m.Apply(exit)
		requireReady(t, x, err)
		if x.PID != exitPID || x.UpdateMode != "managed_reload" {
			t.Fatalf("%s exit restarted: %+v", label, x)
		}
		x, err = m.Apply(ingress)
		requireReady(t, x, err)
		if x.PID != ingressPID || x.UpdateMode != "managed_reload" {
			t.Fatalf("%s ingress restarted: %+v", label, x)
		}
		t.Logf("%s confirmed in %s", label, time.Since(start))
		time.Sleep(25 * time.Millisecond)
		select {
		case err := <-failures:
			t.Fatalf("%s broke B: %v", label, err)
		default:
		}
	}
	configure(true, aTarget.port, 0)
	apply("add A")
	aClaims := []portlease.Binding{portlease.New("tcp", aPort, "127.0.0.1"), portlease.New("udp", aPort, "127.0.0.1")}
	if err := native.ReserveExternal("other", aClaims); err == nil {
		native.ReleaseExternal("other")
		t.Fatal("managed add omitted external slot")
	}
	aTCP := connect("tcp", aPort)
	if err := echoRoundTrip(aTCP, "A-before-edit"); err != nil {
		t.Fatal(err)
	}
	aUDP := connect("udp", aPort)
	udpRoundTrip(t, aUDP, aTarget, "A-before-edit-udp")
	aMaxConnections = 4
	configure(true, editedTarget.port, 0)
	apply("edit A target and policy")
	if err := echoRoundTrip(aTCP, "A-old-must-close"); err == nil {
		t.Fatal("edited A TCP kept forwarding")
	}
	aTCP = connect("tcp", aPort)
	if err := echoRoundTrip(aTCP, "A-edited"); err != nil {
		t.Fatal(err)
	}
	udpRoundTrip(t, aUDP, editedTarget, "A-edited-udp")
	oldAPort := aPort
	for aPort == oldAPort || aPort == bPort || aPort == carrier {
		aPort = freePort(t, "tcp")
	}
	configure(true, editedTarget.port, 0)
	apply("move A business listener")
	if err := native.ReserveExternal("other", aClaims); err != nil {
		t.Fatal("moved A retained its old listener claims", err)
	}
	native.ReleaseExternal("other")
	aClaims = []portlease.Binding{portlease.New("tcp", aPort, "127.0.0.1"), portlease.New("udp", aPort, "127.0.0.1")}
	if err := echoRoundTrip(aTCP, "old-A-listener-must-close"); err == nil {
		t.Fatal("moved A old TCP kept forwarding")
	}
	aTCP = connect("tcp", aPort)
	if err := echoRoundTrip(aTCP, "A-moved"); err != nil {
		t.Fatal(err)
	}
	aUDP = connect("udp", aPort)
	udpRoundTrip(t, aUDP, editedTarget, "A-moved-udp")
	configure(false, aTarget.port, 0)
	apply("delete A")
	if err := native.ReserveExternal("other", aClaims); err != nil {
		t.Fatal("managed delete retained external slot", err)
	}
	native.ReleaseExternal("other")
	if err := echoRoundTrip(aTCP, "A-deleted-must-close"); err == nil {
		t.Fatal("deleted A TCP kept forwarding")
	}
	if c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", aPort), 100*time.Millisecond); err == nil {
		c.Close()
		t.Fatal("deleted listener remained")
	}
	_ = aUDP.SetDeadline(time.Now().Add(100 * time.Millisecond))
	aUDP.Write([]byte("deleted-udp"))
	buf := make([]byte, 32)
	if _, err := aUDP.Read(buf); err == nil {
		t.Fatal("deleted UDP mapping forwarded")
	}
	// An OS bind failure for a new child must compensate without restarting B.
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	configure(false, aTarget.port, busy.Addr().(*net.TCPAddr).Port)
	ingress.Generation++
	x, err = m.Apply(ingress)
	if !errors.Is(err, ErrReloadRejected) || x.State != "rolled_back" || !x.Ready || x.PID != ingressPID {
		t.Fatalf("bind rollback: %+v %v", x, err)
	}
	select {
	case err := <-failures:
		t.Fatalf("rollback broke B: %v", err)
	default:
	}
	// B TCP+UDP occupy the common maxConnections=2 gate even after updates.
	if c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", bPort)); err == nil {
		if err := echoRoundTrip(c, "over-shared-gate"); err == nil {
			c.Close()
			t.Fatal("B common TCP/UDP gate reset")
		}
		c.Close()
	}
	t.Logf("B preserved: %d TCP/UDP round trips, TCP drops=0, UDP mapping changes=0", samples.Load())
	if samples.Load() < 10 {
		t.Fatal("insufficient concurrent traffic")
	}
}

func TestRealFXPManagedSourceTamper(t *testing.T) {
	if os.Getenv("TUNEX_TEST_FXP_BINARY") == "" {
		t.Skip("requires real FXP")
	}
	m := newTestManager(t, binaryForTest(t), t.TempDir())
	cfg := exitConfig(t, "tamper", "tcp", freePort(t, "tcp"), 1)
	var shape map[string]any
	_ = json.Unmarshal(cfg.RunnerConfig, &shape)
	shape["managedReload"] = true
	setRunner(t, &cfg, shape)
	o, err := m.Apply(cfg)
	requireReady(t, o, err)
	p := m.running[cfg.ID]
	shape["key"] = "tampered-private-key"
	bad := cloneConfig(cfg)
	setRunner(t, &bad, shape)
	if err := atomicPrivateWrite(p.path, bad.RunnerConfig); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.done:
	case <-time.After(3 * time.Second):
		t.Fatal("tampered managed source did not fail closed")
	}
	o = m.Status()[0]
	if o.Ready || o.LastError != ErrConfigTampered.Error() {
		t.Fatalf("tamper status: %+v", o)
	}
	if m.records[cfg.ID].Config.ConfigDigest != cfg.ConfigDigest {
		t.Fatal("tamper committed")
	}
	if _, err := os.Stat(p.path); !os.IsNotExist(err) {
		t.Fatal("plaintext config survived exit")
	}
}
