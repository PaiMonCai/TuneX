package manager

import (
	"strings"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/portlease"
)

func TestExternalClaimsShareNativeProtocolAndScopeGuard(t *testing.T) {
	target, stopTarget := echoServer(t)
	t.Cleanup(stopTarget)
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	t.Cleanup(tm.StopAll)
	port := freeSharedPort(t)
	cfg := directCfg("native", port, target, 1)
	if _, err := tm.Apply(cfg); err != nil {
		t.Fatal(err)
	}
	tcp := portlease.New("tcp", port, "::ffff:127.0.0.1")
	udp := portlease.New("udp", port, "127.0.0.1")
	if err := tm.ReserveExternal("link-a", []portlease.Binding{tcp}); err == nil {
		t.Fatal("external process stole a native socket")
	}
	if err := tm.ReserveExternal("link-a", []portlease.Binding{udp}); err != nil {
		t.Fatalf("independent external UDP socket: %v", err)
	}
	if err := tm.ReserveExternal("link-b", []portlease.Binding{udp}); err == nil {
		t.Fatal("external owners shared an overlapping socket")
	}
	if err := tm.ReserveExternal("link-a", []portlease.Binding{udp, udp}); err != nil {
		t.Fatalf("same owner retry must be idempotent: %v", err)
	}
	// Claims guard PREPARE even before any external OS socket exists.
	newPort := freeSharedPort(t)
	for newPort == port {
		newPort = freeSharedPort(t)
	}
	prepared := portlease.New("tcp", newPort, "127.0.0.1")
	if err := tm.ReserveExternal("link-a", []portlease.Binding{udp, prepared}); err != nil {
		t.Fatal(err)
	}
	for _, activate := range []func(forwarder.TunnelConfig) (forwarder.Runtime, error){tm.Apply, tm.ReplaceListener} {
		candidate := directCfg("native-prepare-conflict", newPort, target, 1)
		if _, err := activate(candidate); err == nil || !strings.Contains(err.Error(), "already used by another tunnel") {
			t.Fatalf("native apply bypassed external PREPARE claim: %v", err)
		}
		candidate = udpDirectCfg("native-udp-conflict", port, 9000, 1)
		if _, err := activate(candidate); err == nil || !strings.Contains(err.Error(), "already used by another tunnel") {
			t.Fatalf("native UDP bypassed external claim: %v", err)
		}
	}
	move := cfg.Clone()
	move.IngressPort, move.Revision = newPort, 2
	if _, err := tm.ReplaceListener(move); err == nil {
		t.Fatal("listener move bypassed an external claim")
	}
	echoRoundTrip(t, addrFor(port), []byte("native-kept-after-refused-move"))
	// A failed complete-list replacement must keep the previous claims.
	if err := tm.ReserveExternal("link-a", []portlease.Binding{tcp}); err == nil {
		t.Fatal("invalid owner update took a native socket")
	}
	if facts := tm.UsedPortsByProtocol(); !facts["udp"][port] || !facts["tcp"][newPort] {
		t.Fatalf("failed update discarded previous claims: %v", facts)
	}
	// Omitting a prepared socket from the full list releases only that socket.
	if err := tm.ReserveExternal("link-a", []portlease.Binding{udp}); err != nil {
		t.Fatal(err)
	}
	if tm.UsedPortsByProtocol()["tcp"][newPort] {
		t.Fatal("complete-list update leaked the removed prepared binding")
	}
	tm.ReleaseExternal("link-a")
	if facts := tm.UsedPortsByProtocol(); !facts["tcp"][port] || facts["udp"][port] {
		t.Fatalf("release touched native ownership: %v", facts)
	}
	if _, err := tm.ReplaceListener(move); err != nil {
		t.Fatalf("port not reusable after external stop/release: %v", err)
	}
}

func TestExternalClaimsRespectDrainingAndConservativeScopes(t *testing.T) {
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	t.Cleanup(tm.StopAll)
	port := freeSharedPort(t)
	cfg := directCfg("draining-native", port, "127.0.0.1:9000", 1)
	runtime, err := tm.Apply(cfg)
	if err != nil {
		t.Fatal(err)
	}
	paused, release := pauseTunnelStop(t, tm, cfg.ID, runtime)
	if err := tm.Remove(cfg.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-paused.entered:
	case <-time.After(time.Second):
		t.Fatal("teardown did not start")
	}
	for _, host := range []string{"127.0.0.1", "[::ffff:127.0.0.1]", "::", "0.0.0.0", "localhost"} {
		if err := tm.ReserveExternal("link-tcp", []portlease.Binding{portlease.New("tcp", port, host)}); err == nil {
			t.Fatalf("external scope %q bypassed native teardown", host)
		}
	}
	udp := portlease.New("udp", port, "127.0.0.1")
	if err := tm.ReserveExternal("link-udp", []portlease.Binding{udp}); err != nil {
		t.Fatal(err)
	}
	release()
	waitProtocolPort(t, tm, "tcp", port, false)
	if err := tm.ReserveExternal("link-tcp", []portlease.Binding{portlease.New("tcp", port, "127.0.0.1")}); err != nil {
		t.Fatal(err)
	}
	tm.ReleaseExternal("link-tcp")
	if !tm.UsedPortsByProtocol()["udp"][port] {
		t.Fatal("external TCP release dropped an independent external UDP claim")
	}
	tm.BeginShutdown()
	if err := tm.ReserveExternal("link-late", []portlease.Binding{udp}); err != ErrNodeShuttingDown {
		t.Fatalf("shutdown accepted a new external activation: %v", err)
	}
	tm.ReleaseExternal("link-udp")
	if len(tm.UsedPorts()) != 0 {
		t.Fatal("external claims cannot be released during shutdown")
	}
}
