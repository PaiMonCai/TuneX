package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	managedTargetMaxRules       = 500
	managedTargetMaxTargets     = 10
	managedTargetProbeWorkers   = 128
	managedTargetDialTimeout    = time.Second
	managedTargetProbeInterval  = 5 * time.Second
	managedTargetStatusInterval = 4 * time.Second
)

type managedTarget struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

type managedTargetSet struct {
	Version        int             `json:"version"`
	RuleID         int             `json:"ruleId"`
	Protocol       string          `json:"protocol"`
	Strategy       string          `json:"strategy"`
	FailureSeconds int             `json:"failureSeconds"`
	RecoverSeconds int             `json:"recoverSeconds"`
	Probe          string          `json:"probe"`
	Targets        []managedTarget `json:"targets"`
}

func enableManagedTargets(cfg *config, enabled bool) {
	cfg.managedTargetsV1 = enabled
	for i := range cfg.Entries {
		enableManagedTargets(&cfg.Entries[i], enabled)
	}
}

func targetSetHas(set managedTargetSet, protocol string) bool {
	return set.Protocol == protocol || set.Protocol == "both"
}

func targetEqual(host string, port int, target managedTarget) bool {
	return strings.EqualFold(host, target.Host) && port == target.Port
}

func validManagedTargetSet(set managedTargetSet) bool {
	if set.Version != 1 || set.RuleID <= 0 || (set.Protocol != "tcp" && set.Protocol != "udp" && set.Protocol != "both") ||
		(set.Strategy != "fallback" && set.Strategy != "round_robin" && set.Strategy != "random") ||
		set.FailureSeconds < 10 || set.FailureSeconds > 3600 || set.RecoverSeconds < 10 || set.RecoverSeconds > 3600 ||
		(set.Probe != "tcp" && set.Probe != "none") || len(set.Targets) == 0 || len(set.Targets) > managedTargetMaxTargets {
		return false
	}
	seen := make(map[string]bool)
	for _, target := range set.Targets {
		if target.Host == "" || target.Host != strings.TrimSpace(target.Host) || len(target.Host) > 255 || target.Port < 1 || target.Port > 65535 ||
			strings.ContainsAny(target.Host, "[]/\\") || (strings.Contains(target.Host, ":") && net.ParseIP(target.Host) == nil) {
			return false
		}
		for _, ch := range target.Host {
			if ch < 32 || ch == 127 || unicode.IsSpace(ch) {
				return false
			}
		}
		key := strings.ToLower(net.JoinHostPort(target.Host, strconv.Itoa(target.Port)))
		if seen[key] {
			return false
		}
		seen[key] = true
	}
	return true
}

// Sets are compiler authority. They never come from a Hello or a UDP datagram.
// Bindings for the same rule must authorize exactly the complete target set.
func validateManagedTargets(cfg config) error {
	bad := func() error { return errors.New("invalid managed target policy") }
	if cfg.TargetSet != nil || len(cfg.TargetSets) > 0 {
		if !cfg.managedTargetsV1 || cfg.TunnelID <= 0 {
			return bad()
		}
	}
	if cfg.TargetSet != nil {
		set := *cfg.TargetSet
		if cfg.Role != "entry" || len(cfg.TargetSets) > 0 || !validManagedTargetSet(set) || set.RuleID != cfg.RuleID || set.Protocol != cfg.Protocol ||
			!targetEqual(cfg.TargetIP, cfg.TargetPort, set.Targets[0]) {
			return bad()
		}
	}
	if len(cfg.TargetSets) > 0 {
		if cfg.Role != "exit" || !cfg.RequireBindingAuth || len(cfg.TargetSets) > managedTargetMaxRules {
			return bad()
		}
		seen := make(map[int]bool)
		for _, set := range cfg.TargetSets {
			if !validManagedTargetSet(set) || seen[set.RuleID] || (cfg.Protocol != "both" && cfg.Protocol != set.Protocol) {
				return bad()
			}
			seen[set.RuleID] = true
			for _, binding := range cfg.AllowedBindings {
				if binding.RuleID != set.RuleID {
					continue
				}
				member := false
				for _, target := range set.Targets {
					if targetEqual(binding.TargetIP, binding.TargetPort, target) {
						member = true
					}
				}
				if !targetSetHas(set, binding.Protocol) || !member {
					return bad()
				}
			}
			for _, protocol := range []string{"tcp", "udp"} {
				if !targetSetHas(set, protocol) {
					continue
				}
				for _, target := range set.Targets {
					if !authorizedTarget(cfg, set.RuleID, protocol, target.Host, target.Port) {
						return bad()
					}
				}
			}
			for _, target := range cfg.UDPTargets {
				if target.RuleID == set.RuleID && (!targetSetHas(set, "udp") || !targetEqual(target.TargetIP, target.TargetPort, set.Targets[0])) {
					return bad()
				}
			}
		}
	}
	if cfg.Role == "entry-group" && len(cfg.Entries) > managedTargetMaxRules {
		for _, entry := range cfg.Entries {
			if entry.TargetSet != nil {
				return bad()
			}
		}
	}
	for _, entry := range cfg.Entries {
		if err := validateManagedTargets(entry); err != nil {
			return err
		}
	}
	return nil
}

func managedSetFor(cfg config, rule int) *managedTargetSet {
	for i := range cfg.TargetSets {
		if cfg.TargetSets[i].RuleID == rule {
			return &cfg.TargetSets[i]
		}
	}
	return nil
}

type managedTargetHealth struct {
	state                       string
	failureSince, recoverySince time.Time
	nextProbe                   time.Time
	probing                     bool
}

type managedTargetPool struct {
	set      managedTargetSet
	selector *exitEndpointSelector
	mu       sync.Mutex
	health   []managedTargetHealth
	tcp, udp int
	checked  int64
	reason   string
}

func newManagedTargetPool(set managedTargetSet) *managedTargetPool {
	// Own the spec: callers may reuse their candidate slices during reload.
	set.Targets = append([]managedTarget(nil), set.Targets...)
	exits := make([]exitEndpoint, len(set.Targets))
	health := make([]managedTargetHealth, len(set.Targets))
	for i, target := range set.Targets {
		exits[i] = exitEndpoint{Host: target.Host, Port: target.Port}
		health[i].state = "unknown"
	}
	return &managedTargetPool{set: set, selector: newExitEndpointSelector(exits[1:], exits[0], set.Strategy), health: health, tcp: -1, udp: -1, reason: "initial"}
}

func (p *managedTargetPool) available(index int) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return index >= 0 && index < len(p.health) && p.health[index].state != "unhealthy" && p.health[index].state != "recovering"
}

func (p *managedTargetPool) pick(protocol string, attempted map[int]bool) (managedTarget, int, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	excluded := make(map[int]bool, len(p.health))
	now := time.Now()
	for i, health := range p.health {
		excluded[i] = attempted[i] || health.state == "unhealthy" || health.state == "recovering"
		// No active probes: allow one on-demand TCP recovery dial per interval.
		// UDP silence remains unknown and never becomes an implicit probe.
		if !attempted[i] && protocol == "tcp" && p.set.Probe == "none" &&
			(health.state == "unhealthy" || health.state == "recovering") && !health.probing && !now.Before(health.nextProbe) {
			excluded[i] = false
		}
	}
	endpoint, index, ok := p.selector.pick(excluded)
	if !ok {
		all := true
		for _, health := range p.health {
			if health.state != "unhealthy" && health.state != "recovering" {
				all = false
			}
		}
		if all {
			p.reason = "all_unavailable"
		}
		return managedTarget{}, -1, false
	}
	if p.health[index].state == "unhealthy" || p.health[index].state == "recovering" {
		p.health[index].probing = true
		p.health[index].nextProbe = now.Add(managedTargetProbeInterval)
	}
	return managedTarget{Host: endpoint.Host, Port: endpoint.Port}, index, true
}

func (p *managedTargetPool) selected(protocol string, index int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if protocol == "tcp" {
		p.tcp = index
	} else {
		p.udp = index
	}
	p.reason = "selected"
}

// Only observations advance the windows. Elapsed time alone never declares a
// target unhealthy or recovered, and success breaks a run of failures.
func (p *managedTargetPool) observe(index int, success bool, now time.Time) (confirmedFailure bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	h := &p.health[index]
	if p.set.Probe == "none" {
		h.probing = false
		h.nextProbe = now.Add(managedTargetProbeInterval)
	}
	p.checked = now.UnixMilli()
	previous := h.state
	if success {
		h.failureSince = time.Time{}
		switch h.state {
		case "unhealthy":
			h.state, h.recoverySince = "recovering", now
		case "recovering":
			if now.Sub(h.recoverySince) >= time.Duration(p.set.RecoverSeconds)*time.Second {
				h.state = "healthy"
			}
		default:
			h.state = "healthy"
		}
		if h.state == "healthy" && (previous == "recovering" || previous == "suspect") {
			p.reason = "target_recovered"
		}
	} else {
		h.recoverySince = time.Time{}
		switch h.state {
		case "unhealthy", "recovering":
			h.state = "unhealthy"
		default:
			if h.failureSince.IsZero() {
				h.failureSince = now
			}
			h.state = "suspect"
			if now.Sub(h.failureSince) >= time.Duration(p.set.FailureSeconds)*time.Second {
				h.state = "unhealthy"
			}
		}
		p.reason = "target_failed"
	}
	confirmedFailure = h.state == "unhealthy" && previous != "unhealthy" && previous != "recovering"
	all := true
	for _, state := range p.health {
		if state.state != "unhealthy" && state.state != "recovering" {
			all = false
		}
	}
	if all {
		p.reason = "all_unavailable"
	}
	return
}

func (s *managedExitState) observeTarget(p *managedTargetPool, index int, success bool, now time.Time) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.policy.Load().pools[p.set.RuleID] != p {
		return
	}
	if p.observe(index, success, now) && p.set.Probe == "tcp" {
		s.invalidateTargetUDP(p, index)
	}
}

type managedUDPBinding struct {
	pool  *managedTargetPool
	index int
}

func (s *managedExitState) invalidateTargetUDP(p *managedTargetPool, index int) {
	s.udp.Range(func(key, value any) bool {
		if value.(int) == p.set.RuleID {
			key.(*udpDirectExitSession).invalidateManagedTarget(p, index)
		}
		return true
	})
	s.udpCarriers.Range(func(key, value any) bool {
		binding := value.(managedUDPBinding)
		if binding.pool == p && binding.index == index {
			_ = key.(net.Conn).Close()
		}
		return true
	})
}

func dialManagedTarget(ctx context.Context, network string, target managedTarget) (net.Conn, error) {
	dialer := net.Dialer{Timeout: managedTargetDialTimeout}
	return dialer.DialContext(ctx, network, net.JoinHostPort(target.Host, strconv.Itoa(target.Port)))
}

func (s *managedExitState) dialTarget(p *managedTargetPool, network string) (net.Conn, int, error) {
	attempted := make(map[int]bool)
	for len(attempted) < len(p.set.Targets) {
		s.mu.RLock()
		if s.policy.Load().pools[p.set.RuleID] != p {
			s.mu.RUnlock()
			return nil, -1, errors.New("managed target policy replaced")
		}
		target, index, ok := p.pick(network, attempted)
		if !ok {
			s.mu.RUnlock()
			break
		}
		attempted[index] = true
		conn, err := dialManagedTarget(s.targetContext(), network, target)
		if network == "tcp" {
			if p.observe(index, err == nil, time.Now()) && p.set.Probe == "tcp" {
				s.invalidateTargetUDP(p, index)
			}
		}
		if err == nil && !p.available(index) {
			// Half-open success is evidence; the recovery window still fences
			// business payload until enough consecutive successes complete it.
			_ = conn.Close()
			err = errors.New("managed target recovering")
		}
		if err == nil {
			p.selected(network, index)
		}
		s.mu.RUnlock()
		if err == nil {
			return conn, index, nil
		}
	}
	return nil, -1, errors.New("managed targets unavailable")
}

func (s *managedExitState) dialLegacyTarget(hello helloFrame) (net.Conn, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	policy := s.policy.Load()
	if policy.pools[hello.RuleID] != nil || (policy.cfg.RequireBindingAuth && !authorizedTarget(policy.cfg, hello.RuleID, hello.Network, hello.TargetIP, hello.TargetPort)) {
		return nil, errors.New("managed target policy replaced")
	}
	if hello.Network == "tcp" {
		return dialTCP(hello.TargetIP, hello.TargetPort, 10*time.Second)
	}
	return dialManagedTarget(s.targetContext(), "udp", managedTarget{hello.TargetIP, hello.TargetPort})
}

func (s *managedExitState) targetContext() context.Context {
	if s.targetCtx != nil {
		return s.targetCtx
	}
	return context.Background()
}

type managedProbeJob struct {
	pool  *managedTargetPool
	index int
}

// A fixed worker set and a bounded queue, including at 500 x 10 targets. The
// rotating scan prevents early rules monopolizing the queue during outages.
func (s *managedExitState) startTargets(stops ...<-chan struct{}) {
	if s.targetCtx == nil {
		s.targetCtx, s.targetCancel = context.WithCancel(context.Background())
	}
	var stop <-chan struct{}
	if len(stops) > 0 {
		stop = stops[0]
	}
	s.targetDone = make(chan struct{})
	jobs := make(chan managedProbeJob, managedTargetProbeWorkers)
	var workers sync.WaitGroup
	for i := 0; i < managedTargetProbeWorkers; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				select {
				case <-s.targetCtx.Done():
					return
				case job := <-jobs:
					s.mu.RLock()
					p := job.pool
					if s.policy.Load().pools[p.set.RuleID] == p && s.targetCtx.Err() == nil {
						conn, err := dialManagedTarget(s.targetCtx, "tcp", p.set.Targets[job.index])
						if conn != nil {
							_ = conn.Close()
						}
						if s.targetCtx.Err() == nil && p.observe(job.index, err == nil, time.Now()) {
							s.invalidateTargetUDP(p, job.index)
						}
					}
					p.mu.Lock()
					p.health[job.index].probing = false
					p.health[job.index].nextProbe = time.Now().Add(managedTargetProbeInterval)
					p.mu.Unlock()
					s.mu.RUnlock()
				}
			}
		}()
	}
	go func() {
		defer close(s.targetDone)
		defer workers.Wait()
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		status := time.NewTicker(managedTargetStatusInterval)
		defer status.Stop()
		cursor := 0
		for {
			select {
			case <-stop:
				s.targetCancel()
				return
			case <-s.targetCtx.Done():
				return
			case <-status.C:
				s.emitTargets()
			case now := <-ticker.C:
				policy := s.policy.Load()
				count := len(policy.probes)
				for scanned := 0; scanned < count; scanned++ {
					job := policy.probes[cursor%count]
					cursor = (cursor + 1) % count
					p := job.pool
					p.mu.Lock()
					h := &p.health[job.index]
					full := false
					if !h.probing && !now.Before(h.nextProbe) {
						select {
						case jobs <- job:
							h.probing = true
						default:
							full = true
						}
					}
					p.mu.Unlock()
					if full {
						break
					}
				}
			}
		}
	}()
}

func (s *managedExitState) stopTargets() {
	if s.targetCancel != nil {
		s.targetCancel()
		if s.targetDone != nil {
			<-s.targetDone
		}
	}
}

var managedTargetsLog = log.New(os.Stdout, "", log.LstdFlags|log.Lmicroseconds)

func (s *managedExitState) emitTargets() {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.digest) != 64 {
		return
	}
	rules := make([]int, 0, len(s.policy.Load().pools))
	for rule := range s.policy.Load().pools {
		rules = append(rules, rule)
	}
	sort.Ints(rules)
	for _, rule := range rules {
		p := s.policy.Load().pools[rule]
		p.mu.Lock()
		states := make([]string, len(p.health))
		for i, health := range p.health {
			states[i] = health.state
		}
		line := fmt.Sprintf("managed targets sha256=%s rule=%d tcp=%d udp=%d checked=%d reason=%s states=%s", s.digest, rule, p.tcp, p.udp, p.checked, p.reason, strings.Join(states, ","))
		p.mu.Unlock()
		if len(line) < 4096 {
			managedTargetsLog.Print(line)
		}
	}
}

func managedPoolsEqual(a, b *managedTargetPool) bool {
	return a != nil && b != nil && reflect.DeepEqual(a.set, b.set)
}

func (p *managedPolicy) buildProbes() {
	p.probes = nil
	rules := make([]int, 0, len(p.pools))
	for rule := range p.pools {
		rules = append(rules, rule)
	}
	sort.Ints(rules)
	for _, rule := range rules {
		pool := p.pools[rule]
		if pool.set.Probe == "tcp" {
			for index := range pool.set.Targets {
				p.probes = append(p.probes, managedProbeJob{pool: pool, index: index})
			}
		}
	}
}
