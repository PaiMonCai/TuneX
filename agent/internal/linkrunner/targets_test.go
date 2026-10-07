package linkrunner

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestTargetStatusAcceptsOnlyAuthorizedBoundedFreshFacts(t *testing.T) {
	digest := strings.Repeat("a", 64)
	raw := json.RawMessage(`{"role":"exit","targetSets":[{"ruleId":101,"targets":[{"host":"first","port":80},{"host":"second","port":80}]}]}`)
	p := &child{managed: true, currentDigest: digest}
	p.setTargetConfig(Config{ConfigDigest: digest, RunnerConfig: raw})
	line := func(sha, rule, tcp, states string, millis int64) string {
		return fmt.Sprintf("managed targets sha256=%s rule=%s tcp=%s udp=1 checked=%d reason=selected states=%s\n", sha, rule, tcp, millis, states)
	}
	for _, bad := range []string{line(strings.Repeat("b", 64), "101", "0", "healthy,unknown", time.Now().UnixMilli()),
		line(digest, "102", "0", "healthy,unknown", time.Now().UnixMilli()), line(digest, "101", "2", "healthy,unknown", time.Now().UnixMilli()),
		line(digest, "101", "0", "healthy", time.Now().UnixMilli()), line(digest, "101", "0", "healthy,credential", time.Now().UnixMilli()),
		line(digest, "101", "0", "healthy,unknown", 0),
		line(digest, "101", "0", "healthy,unknown", time.Now().Add(time.Hour).UnixMilli()), line(digest, "101", "0", "healthy,unknown", time.Now().Add(-2*time.Minute).UnixMilli())} {
		p.Write([]byte(bad))
		if len(p.targetFacts) != 0 {
			t.Fatal("invalid target facts entered state", bad)
		}
	}
	p.Write([]byte(line(digest, "101", "0", "healthy,unknown", time.Now().UnixMilli())))
	facts := p.targetStatusLocked(digest)
	if len(facts) != 1 || facts[0].ForwardID != 101 || *facts[0].SelectedTCP != 0 || facts[0].States[1] != "unknown" {
		t.Fatal(facts)
	}
	if len(p.logs) != 0 {
		t.Fatal("target status copied to arbitrary diagnostic logs", p.logs)
	}
	fact := p.targetFacts[101]
	fact.received = time.Now().Add(-16 * time.Second)
	p.targetFacts[101] = fact
	if len(p.targetStatusLocked(digest)) != 0 {
		t.Fatal("stale target facts retained")
	}
}

func TestUnsupportedTargetRuntimeRejectsBeforeFenceOrListener(t *testing.T) {
	m := newTestManager(t, helperBinary(t), t.TempDir())
	if m.TargetSetsSupported() {
		t.Fatal("legacy helper advertises targets")
	}
	cfg := exitConfig(t, "targets", "tcp", freePort(t, "tcp"), 1)
	var raw map[string]any
	if err := json.Unmarshal(cfg.RunnerConfig, &raw); err != nil {
		t.Fatal(err)
	}
	raw["targetSets"] = []map[string]any{{"ruleId": 101, "targets": []map[string]any{{"host": "127.0.0.1", "port": 80}}}}
	setRunner(t, &cfg, raw)
	if _, err := m.Apply(cfg); err != ErrTargetCapability {
		t.Fatal("legacy runner accepted target config", err)
	}
	if len(m.records) != 0 || len(m.running) != 0 {
		t.Fatal("unsupported target config mutated persisted fence/runtime")
	}
	deadline, expected, err := validateConfig(&cfg)
	if err != nil {
		t.Fatal(err)
	}
	if p, err := m.startChildLocked(cfg, deadline, expected); p != nil || err != ErrTargetCapability {
		t.Fatal("restore startup silently used an old runner", err)
	}
}

func TestTargetFactsAreBoundedAcrossBindingChurn(t *testing.T) {
	p := &child{currentDigest: strings.Repeat("a", 64), targetFacts: map[int64]targetFact{}}
	for i := 1; i <= 1500; i++ {
		digest := fmt.Sprintf("%064x", i)
		raw := json.RawMessage(fmt.Sprintf(`{"targetSets":[{"ruleId":%d,"targets":[{}]}]}`, i))
		p.setTargetConfig(Config{ConfigDigest: digest, RunnerConfig: raw})
		p.targetFacts[int64(i)] = targetFact{digest: digest}
		p.commitReload(digest)
		if len(p.targetFacts) != 1 || len(p.targetCounts) != 1 {
			t.Fatal("removed rules retained across target updates", len(p.targetFacts), len(p.targetCounts))
		}
	}
}
