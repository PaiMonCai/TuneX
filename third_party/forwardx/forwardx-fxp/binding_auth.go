package main

import (
	"errors"
	"fmt"
	"strings"
)

// authorizedBinding is supplied by the single Link compiler, not by a client.
// The FXP wire format is unchanged; stricter exit policy is opt-in for legacy
// upstream fixtures and mandatory for TuneX-managed Link deployments.
type authorizedBinding struct {
	RuleID     int    `json:"ruleId"`
	Protocol   string `json:"protocol"`
	TargetIP   string `json:"targetIp"`
	TargetPort int    `json:"targetPort"`
}

func validateBindingPolicy(cfg config) error {
	if !cfg.RequireBindingAuth {
		return nil
	}
	if cfg.Role != "exit" || cfg.TunnelID <= 0 {
		return errors.New("binding authorization requires an identified exit")
	}
	seen := make(map[string]bool)
	for _, b := range cfg.AllowedBindings {
		if b.RuleID <= 0 || strings.TrimSpace(b.TargetIP) == "" || b.TargetPort <= 0 || b.TargetPort > 65535 || (b.Protocol != "tcp" && b.Protocol != "udp") {
			return errors.New("invalid authorized binding")
		}
		key := fmt.Sprintf("%d/%s/%s/%d", b.RuleID, b.Protocol, strings.ToLower(strings.TrimSpace(b.TargetIP)), b.TargetPort)
		if seen[key] {
			return errors.New("duplicate authorized binding")
		}
		seen[key] = true
	}
	for _, target := range cfg.UDPTargets {
		if !authorizedTarget(cfg, target.RuleID, "udp", target.TargetIP, target.TargetPort) {
			return errors.New("UDP target is outside authorized bindings")
		}
	}
	return nil
}

func authorizedTarget(cfg config, ruleID int, protocol, host string, port int) bool {
	for _, b := range cfg.AllowedBindings {
		if b.RuleID == ruleID && b.Protocol == protocol && strings.EqualFold(strings.TrimSpace(host), strings.TrimSpace(b.TargetIP)) && port == b.TargetPort {
			return true
		}
	}
	return false
}

func authorizeHello(cfg config, hello *helloFrame) error {
	if managed := managedExitFor(cfg); managed != nil {
		cfg = managed.policy.Load().cfg
	}
	if !cfg.RequireBindingAuth {
		return nil
	}
	if hello.TunnelID != cfg.TunnelID || (hello.Network != "tcp" && hello.Network != "udp") {
		return errors.New("unauthorized carrier or protocol")
	}
	set := managedSetFor(cfg, hello.RuleID)
	if set != nil && (hello.TargetIP == "" || hello.TargetPort <= 0) {
		return errors.New("unauthorized binding target")
	}
	if set != nil && !targetSetHas(*set, hello.Network) {
		return errors.New("unauthorized binding protocol")
	}
	for _, b := range cfg.AllowedBindings {
		if b.RuleID != hello.RuleID || b.Protocol != hello.Network {
			continue
		}
		if (hello.TargetIP != "" && !strings.EqualFold(strings.TrimSpace(hello.TargetIP), strings.TrimSpace(b.TargetIP))) || (hello.TargetPort != 0 && hello.TargetPort != b.TargetPort) {
			continue
		}
		hello.TargetIP, hello.TargetPort = b.TargetIP, b.TargetPort
		if set != nil {
			hello.TargetIP, hello.TargetPort = set.Targets[0].Host, set.Targets[0].Port
		}
		// Trusted source forwarding is not enabled by a client-controlled hello.
		hello.ProxyProtocolExitReceive = cfg.ProxyProtocolExitReceive
		hello.ProxyProtocolExitSend = cfg.ProxyProtocolExitSend
		return nil
	}
	return errors.New("unauthorized binding")
}
