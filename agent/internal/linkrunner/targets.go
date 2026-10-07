package linkrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The child reports indexes, never target addresses, keys or raw configs.
type TargetStatus struct {
	ForwardID     int64    `json:"forward_id"`
	States        []string `json:"states"`
	SelectedTCP   *int     `json:"selected_tcp"`
	SelectedUDP   *int     `json:"selected_udp"`
	LastCheckedAt *string  `json:"last_checked_at"`
	Reason        string   `json:"reason"`
}
type targetFact struct {
	status   TargetStatus
	digest   string
	received time.Time
}

var targetLog = regexp.MustCompile(`^(?:[0-9]{4}/[0-9]{2}/[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)? )?managed targets sha256=([0-9a-f]{64}) rule=([0-9]+) tcp=(-1|[0-9]+) udp=(-1|[0-9]+) checked=([0-9]+) reason=(initial|selected|target_failed|target_recovered|all_unavailable) states=([a-z_,]+)$`)

func probeTargetSets(binary string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "-managed-target-capabilities")
	for _, env := range os.Environ() {
		name, _, _ := strings.Cut(env, "=")
		if !strings.EqualFold(name, "AUTH_SECRET") && !strings.EqualFold(name, "NODE_CREDENTIAL") {
			cmd.Env = append(cmd.Env, env)
		}
	}
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &boundedTrafficProbe{buffer: &out}, io.Discard
	if cmd.Run() != nil {
		return false
	}
	var reply struct {
		Targets int `json:"managed_targets"`
	}
	dec := json.NewDecoder(&out)
	dec.DisallowUnknownFields()
	return dec.Decode(&reply) == nil && dec.Decode(new(any)) == io.EOF && reply.Targets == 1
}
func (m *Manager) TargetSetsSupported() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.targetProbeDone {
		m.targetSupport, m.targetProbeDone = probeTargetSets(m.binaryPath), true
	}
	return m.targetSupport
}
func usesTargetSets(raw json.RawMessage) bool {
	var cfg struct {
		TargetSets json.RawMessage `json:"targetSets"`
		Entries    []struct {
			TargetSet json.RawMessage `json:"targetSet"`
		} `json:"entries"`
	}
	if json.Unmarshal(raw, &cfg) != nil {
		return false
	}
	if len(cfg.TargetSets) > 0 && !bytes.Equal(cfg.TargetSets, []byte("null")) {
		return true
	}
	for _, entry := range cfg.Entries {
		if len(entry.TargetSet) > 0 && !bytes.Equal(entry.TargetSet, []byte("null")) {
			return true
		}
	}
	return false
}
func targetCounts(raw json.RawMessage) map[int64]int {
	var cfg struct {
		TargetSets []struct {
			RuleID  int64             `json:"ruleId"`
			Targets []json.RawMessage `json:"targets"`
		} `json:"targetSets"`
	}
	if json.Unmarshal(raw, &cfg) != nil || len(cfg.TargetSets) > 500 {
		return nil
	}
	counts := map[int64]int{}
	for _, set := range cfg.TargetSets {
		if !safeTrafficInt(set.RuleID) || len(set.Targets) < 1 || len(set.Targets) > 10 || counts[set.RuleID] != 0 {
			return nil
		}
		counts[set.RuleID] = len(set.Targets)
	}
	return counts
}
func (p *child) setTargetConfig(cfg Config) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.targetCounts == nil {
		p.targetCounts = map[string]map[int64]int{}
	}
	// At most the committed and one candidate digest are authorized.
	for digest := range p.targetCounts {
		if digest != p.currentDigest {
			delete(p.targetCounts, digest)
		}
	}
	p.targetCounts[cfg.ConfigDigest] = targetCounts(cfg.RunnerConfig)
	p.pruneTargetFactsLocked()
}

func (p *child) pruneTargetFactsLocked() {
	for id, fact := range p.targetFacts {
		if p.targetCounts[fact.digest][id] == 0 {
			delete(p.targetFacts, id)
		}
	}
}
func (p *child) readTargetLineLocked(line string) bool {
	match := targetLog.FindStringSubmatch(line)
	if match == nil {
		return false
	}
	if match[1] != p.currentDigest && match[1] != p.pendingDigest {
		return true
	}
	rule, err := strconv.ParseInt(match[2], 10, 64)
	count := p.targetCounts[match[1]][rule]
	if err != nil || count == 0 {
		return true
	}
	states := strings.Split(match[7], ",")
	if len(states) != count {
		return true
	}
	for _, state := range states {
		switch state {
		case "unknown", "healthy", "suspect", "recovering", "unhealthy":
		default:
			return true
		}
	}
	selected := func(raw string) (*int, bool) {
		n, err := strconv.Atoi(raw)
		if err != nil || n < -1 || n >= count {
			return nil, false
		}
		if n < 0 {
			return nil, true
		}
		return &n, true
	}
	tcp, ok := selected(match[3])
	if !ok {
		return true
	}
	udp, ok := selected(match[4])
	if !ok {
		return true
	}
	millis, err := strconv.ParseInt(match[5], 10, 64)
	if err != nil || millis < 0 {
		return true
	}
	var checked *string
	if millis != 0 {
		stamp := time.UnixMilli(millis)
		if stamp.After(time.Now().Add(5*time.Second)) || time.Since(stamp) > time.Minute {
			return true
		}
		formatted := stamp.UTC().Format(time.RFC3339Nano)
		checked = &formatted
	} else {
		for _, state := range states {
			if state != "unknown" {
				return true
			}
		}
	}
	if p.targetFacts == nil {
		p.targetFacts = map[int64]targetFact{}
	}
	p.targetFacts[rule] = targetFact{TargetStatus{rule, states, tcp, udp, checked, match[6]}, match[1], time.Now()}
	return true
}
func (p *child) targetStatusLocked(digest string) []TargetStatus {
	var out []TargetStatus
	for id, count := range p.targetCounts[digest] {
		fact, ok := p.targetFacts[id]
		if !ok || fact.digest != digest || time.Since(fact.received) > 15*time.Second || len(fact.status.States) != count {
			continue
		}
		status := fact.status
		status.States = append([]string(nil), status.States...)
		if status.SelectedTCP != nil {
			n := *status.SelectedTCP
			status.SelectedTCP = &n
		}
		if status.SelectedUDP != nil {
			n := *status.SelectedUDP
			status.SelectedUDP = &n
		}
		if status.LastCheckedAt != nil {
			stamp := *status.LastCheckedAt
			status.LastCheckedAt = &stamp
		}
		out = append(out, status)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ForwardID < out[j].ForwardID })
	return out
}
