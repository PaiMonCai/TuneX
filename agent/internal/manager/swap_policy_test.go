package manager

import (
	"net"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

func TestSwapPlanRequiresEquivalentEffectivePolicyBeforeTargetSwap(t *testing.T) {
	base := relayCfg("policy-plan", 21000, "127.0.0.1:8080", 1)
	changes := []struct {
		name string
		edit func(*forwarder.TunnelConfig)
	}{
		{"legacy-rate", func(c *forwarder.TunnelConfig) { c.SpeedLimit = 1024 }},
		{"ingress-rate", func(c *forwarder.TunnelConfig) { c.BytesPerSecondIn = 1024 }},
		{"egress-rate", func(c *forwarder.TunnelConfig) { c.BytesPerSecondOut = 1024 }},
		{"capacity", func(c *forwarder.TunnelConfig) { c.MaxConnections = 1 }},
		{"source-capacity", func(c *forwarder.TunnelConfig) { c.MaxConnectionsPerIP = 1 }},
	}
	for _, change := range changes {
		t.Run(change.name, func(t *testing.T) {
			cfg := base.Clone()
			cfg.NextHop = "127.0.0.1:8081"
			cfg.Revision++
			change.edit(&cfg)
			if plan := PlanForwardSwap(base, cfg); plan.Strategy != SwapRecreate || !plan.DrainOld || plan.FreeOldPort {
				t.Fatalf("target+policy must rebuild without freeing its socket scope: %+v", plan)
			}
		})
	}
	// Compare the effective policy, including the legacy rate projection and
	// implicit burst/scope defaults, rather than treating different encodings as
	// different limits. The target-only path must continue to preserve live work.
	base.SpeedLimit = 1024
	cfg := base.Clone()
	cfg.NextHop = "127.0.0.1:8081"
	cfg.SpeedLimit = 0
	cfg.BytesPerSecondIn, cfg.BytesPerSecondOut = 1024, 1024
	cfg.PolicyScope = forwarder.PolicyScopeRuntime
	if plan := PlanForwardSwap(base, cfg); plan.Strategy != SwapTargetSwap {
		t.Fatalf("equivalent effective policy should retain target swap: %+v", plan)
	}
	cfg.RateBurstBytes = 2048
	if plan := PlanForwardSwap(base, cfg); plan.Strategy != SwapRecreate {
		t.Fatalf("changed burst must rebuild: %+v", plan)
	}
}

func TestTargetAndPolicyChangeRebuildsAndEnforcesNewStreamCapacity(t *testing.T) {
	for _, route := range []string{"Apply", "ReplaceDirect", "ReplaceRelay", "ReplaceSibling"} {
		t.Run(route, func(t *testing.T) {
			tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
			t.Cleanup(tm.StopAll)
			a, _ := labeledServer(t, "policy-old")
			b, bServed := labeledServer(t, "policy-new")
			port := freePort(t)
			cfg := directCfg("tunex-policy-direct", port, addrFor(a), 1)
			if route == "ReplaceRelay" {
				cfg = relayCfg("tunex-policy-relay", port, addrFor(a), 1)
			}
			cfg.MaxConnections = 2
			old, err := tm.Apply(cfg)
			if err != nil {
				t.Fatal(err)
			}
			first, err := net.DialTimeout("tcp", addrFor(port), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			second, err := net.DialTimeout("tcp", addrFor(port), time.Second)
			if err != nil {
				_ = first.Close()
				t.Fatal(err)
			}
			if readOneLine(t, first) != "srv:policy-old" || readOneLine(t, second) != "srv:policy-old" {
				t.Fatal("old runtime did not admit two connections")
			}
			_ = first.Close()
			_ = second.Close()
			udpPoll(t, 3*time.Second, func() bool { return tm.LiveConns(cfg.ID) == 0 }, "old stream work to complete")

			updated := directCfg(cfg.ID, port, addrFor(b), 2)
			if route == "ReplaceRelay" {
				updated = relayCfg(cfg.ID, port, addrFor(b), 2)
			} else if route == "ReplaceSibling" {
				updated = relayCfg("tunex-policy-relay", port, addrFor(b), 2)
			}
			updated.MaxConnections = 1
			var current forwarder.Runtime
			if route == "Apply" {
				current, err = tm.Apply(updated)
			} else {
				current, err = tm.ReplaceListener(updated)
			}
			if err != nil {
				t.Fatal(err)
			}
			if current == old || old.Running() {
				t.Fatal("target+policy merely retargeted the old runtime")
			}
			if got, ok := tm.Get(updated.ID); !ok || got.MaxConnections != 1 || got.Revision != 2 {
				t.Fatalf("reported policy drift: %+v, found=%v", got, ok)
			}
			if route == "ReplaceSibling" {
				if _, found := tm.Get(cfg.ID); found {
					t.Fatal("old sibling retained its registry ownership")
				}
			}
			admitted, err := net.DialTimeout("tcp", addrFor(port), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer admitted.Close()
			if got := readOneLine(t, admitted); got != "srv:policy-new" {
				t.Fatalf("new runtime target = %q", got)
			}
			denied, err := net.DialTimeout("tcp", addrFor(port), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer denied.Close()
			_ = denied.SetReadDeadline(time.Now().Add(time.Second))
			buf := make([]byte, 32)
			if n, err := denied.Read(buf); n != 0 || err == nil {
				t.Fatalf("new max_connections=1 admitted second upstream payload %q, err=%v", buf[:n], err)
			} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
				t.Fatal("capacity refusal left the second stream pending")
			}
			if bServed() != 1 || !tm.UsedPortsByProtocol()["tcp"][port] {
				t.Fatal("new policy or socket ownership was not enforced")
			}
		})
	}
}

func TestTargetAndPolicyChangeRebuildsAndEnforcesDatagramCapacity(t *testing.T) {
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	t.Cleanup(tm.StopAll)
	a, _, stopA := udpLabeledTarget(t, "policy-old")
	b, bServed, stopB := udpLabeledTarget(t, "policy-new")
	t.Cleanup(stopA)
	t.Cleanup(stopB)
	port := freeSharedPort(t)
	cfg := udpDirectCfg("policy-udp", port, a, 1)
	cfg.MaxMappings = 2
	old, err := tm.ReplaceListener(cfg)
	if err != nil {
		t.Fatal(err)
	}
	client := udpClient(t, addrFor(port))
	if got := udpRoundTrip(t, client, "before-policy"); got != "srv:policy-old" {
		t.Fatal(got)
	}
	updated := udpDirectCfg(cfg.ID, port, b, 2)
	updated.MaxMappings = 1
	if plan := PlanForwardSwap(cfg, updated); plan.Strategy != SwapRecreate {
		t.Fatalf("UDP mapping policy must rebuild: %+v", plan)
	}
	current, err := tm.ReplaceListener(updated)
	if err != nil {
		t.Fatal(err)
	}
	if current == old || old.Running() {
		t.Fatal("UDP target+policy did not rebuild")
	}
	if got := udpRoundTrip(t, client, "after-policy"); got != "srv:policy-new" {
		t.Fatal(got)
	}
	other := udpClient(t, addrFor(port))
	if _, err := other.Write([]byte("over-capacity")); err != nil {
		t.Fatal(err)
	}
	udpExpectNoReply(t, other)
	if bServed() != 1 || !tm.UsedPortsByProtocol()["udp"][port] {
		t.Fatal("new UDP mapping ceiling or ownership was not enforced")
	}
}
