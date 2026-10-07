package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func sourceFixture(receive bool, send string) managedClientSource {
	source := managedClientSource{Version: 1, ReceiveProxy: receive, SendProxy: send, TrustedCIDRs: []string{}}
	if receive {
		source.TrustedCIDRs = []string{"127.0.0.0/8", "::1/128"}
	}
	return source
}

func sourceHello(source managedClientSource, ip string) helloFrame {
	return helloFrame{TunnelID: 71, RuleID: 101, Network: "tcp", TargetIP: "127.0.0.1", TargetPort: 443,
		SourceVersion: 1, SourcePolicy: managedSourceDigest(source), ProxySourceIP: ip, ProxySourcePort: 32001, ProxyDestIP: "192.0.2.10", ProxyDestPort: 443}
}

func TestManagedSourceStrictGateAndAuthenticatedBinding(t *testing.T) {
	var unknown managedClientSource
	if json.Unmarshal([]byte(`{"version":1,"receiveProxy":false,"trustedCIDRs":[],"sendProxy":"off","untrustedOverride":true}`), &unknown) == nil {
		t.Fatal("unknown source policy silently ignored")
	}
	source := sourceFixture(false, "v2")
	source.RuleID = 101
	cfg := managedTargetsFixture("tcp", "ip_hash", "none", managedTarget{"127.0.0.1", 443}, managedTarget{"127.0.0.1", 444})
	cfg.ClientSources = []managedClientSource{source}
	path := managedFile(t, cfg)
	if _, _, err := readManagedConfig(path, true); err == nil {
		t.Fatal("source enabled without negotiated flag")
	}
	if _, _, err := readManagedConfig(path, true, true); err != nil {
		t.Fatal(err)
	}
	enableManagedSources(&cfg, true)
	h := sourceHello(source, "198.51.100.2")
	h.SelectionKey, h.ProxyProtocolVersion, h.ProxyProtocolExitSend = "forged-key", 1, false
	if err := authorizeHello(cfg, &h); err != nil || h.SelectionKey != "198.51.100.2" || !h.ProxyProtocolExitSend || h.ProxyProtocolVersion != 2 {
		t.Fatal("hello overrode authoritative policy", h, err)
	}
	for name, mutate := range map[string]func(*helloFrame){
		"missing":     func(h *helloFrame) { h.SourceVersion = 0 },
		"future":      func(h *helloFrame) { h.SourceVersion = 2 },
		"policy":      func(h *helloFrame) { h.SourcePolicy = strings.Repeat("0", 64) },
		"address":     func(h *helloFrame) { h.ProxySourceIP = "client.example" },
		"zone":        func(h *helloFrame) { h.ProxySourceIP = "fe80::1%eth0" },
		"unspecified": func(h *helloFrame) { h.ProxySourceIP = "0.0.0.0" },
		"port":        func(h *helloFrame) { h.ProxySourcePort = 65536 },
		"family":      func(h *helloFrame) { h.ProxyDestIP = "2001:db8::1" },
		"rule":        func(h *helloFrame) { h.RuleID = 102 },
		"target":      func(h *helloFrame) { h.TargetPort = 9999 },
		"udp":         func(h *helloFrame) { h.Network = "udp" },
	} {
		t.Run(name, func(t *testing.T) {
			h := sourceHello(source, "198.51.100.2")
			mutate(&h)
			if authorizeHello(cfg, &h) == nil {
				t.Fatal("invalid source/binding accepted")
			}
		})
	}
	for _, cidr := range []string{"0.0.0.0/0", "::/0", "127.0.0.1/8", "::ffff:127.0.0.0/104", "127.0.0.1", "127.0.0.0/33"} {
		bad := sourceFixture(true, "off")
		bad.TrustedCIDRs = []string{cidr}
		if validManagedSource(bad) {
			t.Fatal("bad trust accepted", cidr)
		}
	}
	for name, mutate := range map[string]func(*config){
		"udpBinding": func(c *config) {
			c.AllowedBindings = append(c.AllowedBindings, authorizedBinding{101, "udp", "127.0.0.1", 443})
		},
		"unknownRule":   func(c *config) { c.ClientSources[0].RuleID = 999 },
		"sourceMissing": func(c *config) { c.ClientSources = nil },
		"sourceVersion": func(c *config) { c.ClientSources[0].Version = 2 },
		"noTrust":       func(c *config) { c.ClientSources[0].ReceiveProxy = true },
		"trustOff":      func(c *config) { c.ClientSources[0].TrustedCIDRs = []string{"127.0.0.0/8"} },
		"legacyFlags":   func(c *config) { c.ProxyProtocolExitSend = true },
	} {
		t.Run(name, func(t *testing.T) {
			c := cfg
			c.ClientSources = append([]managedClientSource(nil), cfg.ClientSources...)
			mutate(&c)
			if validateConfig(c) == nil {
				t.Fatal("unsupported policy accepted")
			}
		})
	}
}

func TestManagedProxyBoundedStrictHeadersAndAbsoluteDeadline(t *testing.T) {
	for _, version := range []int{1, 2} {
		for _, ipv6 := range []bool{false, true} {
			h := helloFrame{ProxySourceIP: "198.51.100.2", ProxyDestIP: "192.0.2.10", ProxySourcePort: 32001, ProxyDestPort: 443, ProxyProtocolVersion: version}
			if ipv6 {
				h.ProxySourceIP, h.ProxyDestIP = "2001:db8::2", "2001:db8::10"
			}
			data := formatProxyProtocol(h)
			a, b := net.Pipe()
			finished := make(chan struct{})
			go func() {
				defer close(finished)
				defer b.Close()
				for _, ch := range data {
					if _, err := b.Write([]byte{ch}); err != nil {
						return
					}
				}
				_, _ = b.Write([]byte("payload"))
			}()
			info, err := readManagedProxyHeader(a, time.Second)
			if err != nil || info.SourceIP != h.ProxySourceIP || info.SourcePort != h.ProxySourcePort {
				t.Fatal(info, err)
			}
			buf := make([]byte, 7)
			if _, err := io.ReadFull(a, buf); err != nil || string(buf) != "payload" {
				t.Fatal("header consumed payload", err)
			}
			a.Close()
			<-finished
		}
	}
	oversize := formatProxyProtocolV2(helloFrame{ProxySourceIP: "198.51.100.2", ProxyDestIP: "192.0.2.10", ProxySourcePort: 1, ProxyDestPort: 2})
	binary.BigEndian.PutUint16(oversize[14:16], 65535)
	local := formatProxyProtocolV2Local()
	for _, data := range [][]byte{[]byte("PROXY UNKNOWN\r\n"), []byte("PROXY TCP4 bad 192.0.2.10 1 2\r\n"), []byte("PROXY TCP6 198.51.100.2 192.0.2.10 1 2\r\n"), []byte("PROXY TCP4 198.51.100.2 192.0.2.10 0 2\r\n"), append([]byte("PROXY "), bytes.Repeat([]byte("x"), 102)...), oversize, local} {
		a, b := net.Pipe()
		done := make(chan struct{})
		go func() { defer close(done); defer b.Close(); _, _ = b.Write(data) }()
		if _, err := readManagedProxyHeader(a, 100*time.Millisecond); err == nil {
			t.Fatal("invalid header accepted", data)
		}
		a.Close()
		<-done
	}
	a, b := net.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer b.Close()
		for _, ch := range []byte("PROXY TCP4 198.51.100.2 192.0.2.10 1 2\r\n") {
			if _, err := b.Write([]byte{ch}); err != nil {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	start := time.Now()
	if _, err := readManagedProxyHeader(a, 40*time.Millisecond); err == nil {
		t.Fatal("slow header accepted")
	}
	a.Close()
	<-done
	if time.Since(start) > 250*time.Millisecond {
		t.Fatal("deadline renewed per fragment")
	}
}

func TestManagedSourceHashNoMissingSourceFallbackAndDeterministicRemapping(t *testing.T) {
	set := managedTargetSet{Version: 1, RuleID: 101, Protocol: "tcp", Strategy: "ip_hash", FailureSeconds: 10, RecoverSeconds: 10, Probe: "none", Targets: []managedTarget{{"127.0.0.1", 443}, {"127.0.0.1", 444}}}
	p := newManagedTargetPool(set)
	if _, _, ok := p.pick("tcp", nil); ok {
		t.Fatal("missing source degraded to round robin")
	}
	indexes := map[int]bool{}
	for _, ip := range []string{"198.51.100.2", "198.51.100.3"} {
		_, index, ok := p.pick("tcp", nil, ip)
		if !ok {
			t.Fatal("source selection failed")
		}
		indexes[index] = true
		for n := 0; n < 5; n++ {
			if _, next, ok := p.pick("tcp", nil, ip); !ok || next != index {
				t.Fatal("hash changed without eligibility change")
			}
		}
	}
	if len(indexes) != 2 {
		t.Fatal("test clients unexpectedly collide")
	}
	p.health[0].state = "unhealthy"
	p.health[0].probing = true
	if _, index, ok := p.pick("tcp", nil, "198.51.100.2"); !ok || index != 1 {
		t.Fatal("unhealthy target selected")
	}
}

func TestManagedSourcePolicyEditClosesOnlyAffectedRuleAndRejectsOldAttestation(t *testing.T) {
	cfg := managedFixture()
	source := sourceFixture(false, "v1")
	source.RuleID = 101
	cfg.ClientSources = []managedClientSource{source}
	enableManagedSources(&cfg, true)
	state := &managedExitState{}
	state.policy.Store(policyFor(cfg))
	managedExits.Store(exitIdentity(cfg), state)
	defer managedExits.Delete(exitIdentity(cfg))
	a, ap := net.Pipe()
	b, bp := net.Pipe()
	defer a.Close()
	defer ap.Close()
	defer b.Close()
	defer bp.Close()
	state.clients.Store(a, 101)
	state.clients.Store(b, 102)
	next := cfg
	next.ClientSources = append([]managedClientSource(nil), cfg.ClientSources...)
	next.ClientSources[0].SendProxy = "v2"
	state.apply(next)
	if _, ok := state.clients.Load(b); !ok {
		t.Fatal("unrelated B removed")
	}
	if _, ok := state.clients.Load(a); ok {
		t.Fatal("old source rule remained open")
	}
	h := sourceHello(source, "198.51.100.2")
	if authorizeHello(cfg, &h) == nil {
		t.Fatal("stale source policy authorized after edit")
	}
	if _, err := state.dialLegacyTarget(h); err == nil {
		t.Fatal("stale policy reached target")
	}
	// Legacy source fields cannot enable PROXY at the target.
	h = helloFrame{TunnelID: 71, RuleID: 102, Network: "udp", TargetIP: "127.0.0.1", TargetPort: 444, ProxyProtocolExitSend: true}
	if err := authorizeHello(next, &h); err != nil || h.ProxyProtocolExitSend {
		t.Fatal("hello controlled legacy PROXY send", err)
	}
}
