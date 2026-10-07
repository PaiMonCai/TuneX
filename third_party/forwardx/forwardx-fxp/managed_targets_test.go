package main

import (
	"bytes"
	"flag"
	"net"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"
)

func managedTargetsFixture(protocol, strategy, probe string, targets ...managedTarget) config {
	set := managedTargetSet{Version: 1, RuleID: 101, Protocol: protocol, Strategy: strategy, FailureSeconds: 10, RecoverSeconds: 10, Probe: probe, Targets: targets}
	cfg := config{Role: "exit", TunnelID: 71, ListenHost: "127.0.0.1", ListenPort: 30300, Protocol: "both", Key: "f2-private-key", RequireBindingAuth: true, TargetSets: []managedTargetSet{set}}
	for _, network := range []string{"tcp", "udp"} {
		if !targetSetHas(set, network) {
			continue
		}
		for _, target := range targets {
			cfg.AllowedBindings = append(cfg.AllowedBindings, authorizedBinding{101, network, target.Host, target.Port})
		}
		if network == "udp" {
			cfg.UDPTargets = []udpTarget{{101, targets[0].Host, targets[0].Port}}
		}
	}
	enableManagedTargets(&cfg, true)
	return normalizeConfig(cfg)
}

func waitManagedCondition(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("managed condition did not become true")
}

func TestManagedTargetsExplicitGateAndStrictCandidate(t *testing.T) {
	cfg := managedTargetsFixture("both", "fallback", "none", managedTarget{"127.0.0.1", 443}, managedTarget{"localhost", 444})
	path := managedFile(t, cfg)
	if _, _, err := readManagedConfig(path); err == nil {
		t.Fatal("target set accepted without CLI opt-in")
	}
	if _, err := readConfig(path); err == nil {
		t.Fatal("initial config accepted without CLI opt-in")
	}
	if _, _, err := readManagedConfig(path, true); err != nil {
		t.Fatal(err)
	}
	if _, err := readConfig(path, true); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*config){
		"strategy":         func(c *config) { c.TargetSets[0].Strategy = "bogus" },
		"version":          func(c *config) { c.TargetSets[0].Version = 2 },
		"protocol":         func(c *config) { c.TargetSets[0].Protocol = "TCP" },
		"probe":            func(c *config) { c.TargetSets[0].Probe = "udp" },
		"failureLow":       func(c *config) { c.TargetSets[0].FailureSeconds = 9 },
		"recoverHigh":      func(c *config) { c.TargetSets[0].RecoverSeconds = 3601 },
		"empty":            func(c *config) { c.TargetSets[0].Targets = nil },
		"tooMany":          func(c *config) { c.TargetSets[0].Targets = make([]managedTarget, 11) },
		"duplicate":        func(c *config) { c.TargetSets[0].Targets[1] = c.TargetSets[0].Targets[0] },
		"port":             func(c *config) { c.TargetSets[0].Targets[0].Port = 65536 },
		"host":             func(c *config) { c.TargetSets[0].Targets[0].Host = "host\nsecret" },
		"hostBracket":      func(c *config) { c.TargetSets[0].Targets[0].Host = "[127.0.0.1]" },
		"hostControl":      func(c *config) { c.TargetSets[0].Targets[0].Host = "host\x01" },
		"hostDEL":          func(c *config) { c.TargetSets[0].Targets[0].Host = "host\x7f" },
		"hostBackslash":    func(c *config) { c.TargetSets[0].Targets[0].Host = "host\\name" },
		"hostZone":         func(c *config) { c.TargetSets[0].Targets[0].Host = "fe80::1%eth0" },
		"hostColon":        func(c *config) { c.TargetSets[0].Targets[0].Host = "host:444" },
		"partialAuthority": func(c *config) { c.AllowedBindings = c.AllowedBindings[:1] },
		"outsideAuthority": func(c *config) {
			c.AllowedBindings = append(c.AllowedBindings, authorizedBinding{101, "tcp", "other", 555})
		},
		"udpFirst":      func(c *config) { c.UDPTargets[0].TargetPort = 444 },
		"duplicateRule": func(c *config) { c.TargetSets = append(c.TargetSets, c.TargetSets[0]) },
		"tooManyRules":  func(c *config) { c.TargetSets = make([]managedTargetSet, 501) },
		"noBindingAuth": func(c *config) { c.RequireBindingAuth = false },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := managedTargetsFixture("both", "fallback", "none", managedTarget{"127.0.0.1", 443}, managedTarget{"localhost", 444})
			mutate(&candidate)
			if _, digest, err := readManagedConfig(managedFile(t, candidate), true); err == nil || len(digest) != 64 {
				t.Fatal("invalid raw candidate normalized or partially authorized")
			}
		})
	}
	legacy := managedFixture()
	if _, _, err := readManagedConfig(managedFile(t, legacy), true); err != nil {
		t.Fatal("opt-in broke legacy config", err)
	}
	entry := config{Role: "entry", TunnelID: 71, RuleID: 101, Protocol: "both", TargetIP: "127.0.0.1", TargetPort: 443, TargetSet: &cfg.TargetSets[0]}
	enableManagedTargets(&entry, true)
	if err := validateManagedTargets(entry); err != nil {
		t.Fatal(err)
	}
	entry.TargetPort = 444
	if validateManagedTargets(entry) == nil {
		t.Fatal("entry first target mismatch accepted")
	}
}

func TestManagedTargetsFullBindingScanAndHelloBoundary(t *testing.T) {
	cfg := managedTargetsFixture("tcp", "fallback", "none", managedTarget{"127.0.0.1", 443}, managedTarget{"127.0.0.1", 444})
	if err := validateConfig(cfg); err != nil {
		t.Fatal("multiple same-rule bindings rejected", err)
	}
	for _, port := range []int{443, 444} {
		hello := helloFrame{TunnelID: 71, RuleID: 101, Network: "tcp", TargetIP: "127.0.0.1", TargetPort: port}
		if err := authorizeHello(cfg, &hello); err != nil {
			t.Fatal("authorized backup rejected at first nonmatch", err)
		}
		if hello.TargetPort != 443 {
			t.Fatal("client controlled selected destination")
		}
	}
	for _, hello := range []helloFrame{
		{TunnelID: 71, RuleID: 102, Network: "tcp", TargetIP: "127.0.0.1", TargetPort: 443},
		{TunnelID: 72, RuleID: 101, Network: "tcp", TargetIP: "127.0.0.1", TargetPort: 443},
		{TunnelID: 71, RuleID: 101, Network: "udp", TargetIP: "127.0.0.1", TargetPort: 443},
		{TunnelID: 71, RuleID: 101, Network: "tcp", TargetIP: "127.0.0.1", TargetPort: 445},
		{TunnelID: 71, RuleID: 101, Network: "tcp"},
	} {
		if authorizeHello(cfg, &hello) == nil {
			t.Fatal("forged or incomplete target authorized", hello)
		}
	}
	cfg.AllowedBindings = append(cfg.AllowedBindings, cfg.AllowedBindings[0])
	if validateBindingPolicy(cfg) == nil {
		t.Fatal("duplicate exact target authorization accepted")
	}
}

func TestManagedTargetHealthWindowsAndFailClosed(t *testing.T) {
	cfg := managedTargetsFixture("both", "fallback", "tcp", managedTarget{"127.0.0.1", 443}, managedTarget{"127.0.0.1", 444})
	p := policyFor(cfg).pools[101]
	now := time.Unix(1000, 0)
	if _, index, ok := p.pick("udp", nil); !ok || index != 0 || p.health[0].state != "unknown" || p.checked != 0 {
		t.Fatal("unknown was treated as unavailable or healthy")
	}
	p.observe(0, true, now)
	p.observe(0, false, now.Add(time.Second))
	p.observe(0, false, now.Add(10*time.Second))
	if p.health[0].state != "suspect" {
		t.Fatal("failure window shortened")
	}
	p.observe(0, true, now.Add(11*time.Second))
	p.observe(0, false, now.Add(12*time.Second))
	if !p.observe(0, false, now.Add(22*time.Second)) || p.health[0].state != "unhealthy" {
		t.Fatal("continuous failure did not confirm")
	}
	p.observe(1, false, now.Add(12*time.Second))
	p.observe(1, false, now.Add(22*time.Second))
	if _, _, ok := p.pick("tcp", nil); ok || p.reason != "all_unavailable" {
		t.Fatal("all confirmed unhealthy fell back to trying arbitrary target")
	}
	p.observe(0, true, now.Add(23*time.Second))
	p.observe(0, true, now.Add(32*time.Second))
	if p.health[0].state != "recovering" || p.available(0) {
		t.Fatal("recovery window shortened")
	}
	p.observe(0, false, now.Add(33*time.Second))
	p.observe(0, true, now.Add(34*time.Second))
	p.observe(0, true, now.Add(44*time.Second))
	if !p.available(0) || p.health[0].state != "healthy" || p.reason != "target_recovered" {
		t.Fatal("consecutive recovery did not restore")
	}
	if _, index, ok := p.pick("udp", nil); !ok || index != 0 {
		t.Fatal("fallback priority not restored")
	}
}

func TestManagedPoolStrategiesReuseUpstreamOrder(t *testing.T) {
	for _, strategy := range []string{"fallback", "round_robin", "random"} {
		cfg := managedTargetsFixture("tcp", strategy, "none", managedTarget{"127.0.0.1", 443}, managedTarget{"127.0.0.1", 444}, managedTarget{"127.0.0.1", 445})
		p := policyFor(cfg).pools[101]
		for i := 0; i < 30; i++ {
			_, index, ok := p.pick("tcp", nil)
			if !ok || index < 0 || index >= 3 {
				t.Fatal("strategy escaped pool")
			}
			if strategy == "fallback" && index != 0 {
				t.Fatal("fallback reordered targets")
			}
			if strategy == "round_robin" && index != i%3 {
				t.Fatal("round robin semantics changed")
			}
		}
		_, index, ok := p.pick("tcp", map[int]bool{0: true, 1: true})
		if !ok || index != 2 {
			t.Fatal("attempted targets retried")
		}
	}
}

func TestManagedPoolReloadKeepsSiblingStateAndSelector(t *testing.T) {
	cfg := managedTargetsFixture("both", "round_robin", "none", managedTarget{"127.0.0.1", 443}, managedTarget{"127.0.0.1", 444})
	b := cfg.TargetSets[0]
	b.RuleID = 102
	cfg.TargetSets = append(cfg.TargetSets, b)
	for _, binding := range append([]authorizedBinding(nil), cfg.AllowedBindings...) {
		binding.RuleID = 102
		cfg.AllowedBindings = append(cfg.AllowedBindings, binding)
	}
	cfg.UDPTargets = append(cfg.UDPTargets, udpTarget{102, "127.0.0.1", 443})
	s := &managedExitState{digest: strings.Repeat("a", 64)}
	s.policy.Store(policyFor(cfg))
	oldA, oldB := s.policy.Load().pools[101], s.policy.Load().pools[102]
	oldB.pick("tcp", nil)
	oldB.observe(1, false, time.Now())
	a, ap := net.Pipe()
	defer a.Close()
	defer ap.Close()
	bconn, bp := net.Pipe()
	defer bconn.Close()
	defer bp.Close()
	s.clients.Store(a, 101)
	s.clients.Store(bconn, 102)
	next := cfg
	next.TargetSets = append([]managedTargetSet(nil), cfg.TargetSets...)
	next.TargetSets[0].Strategy = "fallback"
	s.apply(next, strings.Repeat("b", 64))
	if s.policy.Load().pools[101] == oldA || s.policy.Load().pools[102] != oldB {
		t.Fatal("reload discarded unchanged pool or retained changed pool")
	}
	if _, index, _ := oldB.pick("tcp", nil); index != 1 || oldB.health[1].state != "suspect" {
		t.Fatal("B selector or health reset")
	}
	_ = ap.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := ap.Read(make([]byte, 1)); err == nil {
		t.Fatal("changed strategy retained TCP")
	}
	if _, ok := s.clients.Load(bconn); !ok {
		t.Fatal("unchanged B TCP closed")
	}
	before := s.policy.Load()
	s.apply(next)
	if s.policy.Load().pools[102] != before.pools[102] {
		t.Fatal("unchanged policy state reset")
	}
}

func TestManagedTargetsClosedStatusAndDigest(t *testing.T) {
	cfg := managedTargetsFixture("udp", "fallback", "none", managedTarget{"private-host.invalid", 443}, managedTarget{"other-private.invalid", 444})
	s := &managedExitState{digest: strings.Repeat("a", 64)}
	s.policy.Store(policyFor(cfg))
	var output bytes.Buffer
	previous := managedTargetsLog.Writer()
	managedTargetsLog.SetOutput(&output)
	defer managedTargetsLog.SetOutput(previous)
	s.emitTargets()
	first := output.String()
	if !strings.Contains(first, "tcp=-1 udp=-1 checked=0 reason=initial states=unknown,unknown") {
		t.Fatal("initial status claimed readiness", first)
	}
	s.policy.Load().pools[101].selected("udp", 1)
	s.apply(cfg, strings.Repeat("b", 64))
	output.Reset()
	s.emitTargets()
	line := output.String()
	if !strings.Contains(line, "sha256="+strings.Repeat("b", 64)) || !strings.Contains(line, "udp=1 checked=0 reason=selected") || strings.Contains(line, "private") || len(line) >= 4096 {
		t.Fatal("status leaked target, wrong digest or invented health", line)
	}
}

func TestManagedTargetsProbeBoundAndCancellation(t *testing.T) {
	cfg := managedTargetsFixture("tcp", "fallback", "tcp", managedTarget{"127.0.0.1", freeTCPPort(t)})
	policy := policyFor(cfg)
	// Populate the maximum spec without spawning a goroutine per target.
	for rule := 102; rule <= 600; rule++ {
		set := cfg.TargetSets[0]
		set.RuleID = rule
		set.Targets = make([]managedTarget, 10)
		for index := range set.Targets {
			set.Targets[index] = managedTarget{"127.0.0.1", 10000 + index}
		}
		policy.pools[rule] = newManagedTargetPool(set)
	}
	policy.buildProbes()
	if len(policy.probes) != 4991 {
		t.Fatal("probe schedule not bounded by spec", len(policy.probes))
	}
	s := &managedExitState{}
	s.policy.Store(policy)
	s.startTargets()
	waitManagedCondition(t, func() bool { p := policy.pools[101]; p.mu.Lock(); defer p.mu.Unlock(); return p.checked > 0 })
	start := time.Now()
	s.stopTargets()
	if time.Since(start) > 2*time.Second {
		t.Fatal("stop did not cancel and drain probes")
	}
	if s.targetContext().Err() == nil {
		t.Fatal("probe context alive after shutdown")
	}
}

func TestManagedTargetsCapabilityCLI(t *testing.T) {
	command := exec.Command(os.Args[0], "-test.run=^TestManagedTargetsCapabilityHelper$")
	command.Env = append(os.Environ(), "FXP_TARGET_CAPABILITY_HELPER=1")
	got, err := command.CombinedOutput()
	if err != nil || string(got) != "{\"managed_targets\":1}\n" {
		t.Fatalf("capability output=%q error=%v", got, err)
	}
}

func TestManagedTargetsCapabilityHelper(t *testing.T) {
	if os.Getenv("FXP_TARGET_CAPABILITY_HELPER") != "1" {
		return
	}
	flag.CommandLine = flag.NewFlagSet("fxp-capability", flag.ExitOnError)
	os.Args = []string{os.Args[0], "-managed-target-capabilities"}
	main()
	os.Exit(0)
}

func TestManagedTargetsImmutableTransportStillRejected(t *testing.T) {
	cfg := managedTargetsFixture("tcp", "fallback", "none", managedTarget{"127.0.0.1", 443})
	s := &managedExitState{}
	s.policy.Store(policyFor(cfg))
	m := &managedRuntime{cfg: cfg, exit: s}
	next := cfg
	next.Key = "changed"
	if code, err := m.apply(next); code != "immutable" || err != nil || !reflect.DeepEqual(s.policy.Load().cfg, cfg) {
		t.Fatal("target feature weakened transport immutability")
	}
}

func TestManagedNoProbeHalfOpenIsBoundedAndHonorsRecoveryWindow(t *testing.T) {
	cfg := managedTargetsFixture("both", "fallback", "none", managedTarget{"127.0.0.1", 443})
	p := policyFor(cfg).pools[101]
	now := time.Now()
	p.observe(0, false, now.Add(-20*time.Second))
	p.observe(0, false, now.Add(-10*time.Second))
	if _, _, ok := p.pick("udp", nil); ok {
		t.Fatal("UDP used a failed target as a recovery probe")
	}
	if _, i, ok := p.pick("tcp", nil); !ok || i != 0 {
		t.Fatal("failed no-probe TCP target has no recovery path")
	}
	if _, _, ok := p.pick("tcp", nil); ok {
		t.Fatal("concurrent half-open probes were unbounded")
	}
	p.observe(0, true, now)
	if p.available(0) || p.health[0].state != "recovering" {
		t.Fatal("first success bypassed recovery window")
	}
	if _, _, ok := p.pick("tcp", nil); ok {
		t.Fatal("half-open cooldown ignored")
	}
	p.observe(0, true, now.Add(10*time.Second))
	if !p.available(0) || p.health[0].state != "healthy" {
		t.Fatal("consecutive successes did not recover")
	}
}

func TestManagedUDPWireHistoryBoundRejectsWithoutEviction(t *testing.T) {
	now := time.Now()
	s := &managedExitState{wires: make(map[managedUDPWireKey]*managedUDPWireState)}
	for sid := uint64(1); sid <= managedUDPWireLimit; sid++ {
		s.wires[managedUDPWireKey{101, sid}] = &managedUDPWireState{expires: now.Add(time.Minute), highest: 9, seen: 1, initialized: true}
	}
	next := &udpDirectExitSession{ruleID: 101, sessionID: managedUDPWireLimit + 1}
	if s.attachUDPWire(next, now) || len(s.wires) != managedUDPWireLimit {
		t.Fatal("full cache evicted replay history or exceeded bound")
	}
	if state := s.wires[managedUDPWireKey{101, 1}]; state == nil || state.highest != 9 {
		t.Fatal("old replay history lost under pressure")
	}
	if !s.attachUDPWire(next, now.Add(2*time.Minute)) || len(s.wires) != 1 {
		t.Fatal("expired wire history did not release capacity")
	}
}
