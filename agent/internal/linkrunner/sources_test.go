package linkrunner

import (
	"encoding/json"
	"testing"
)

func TestUnsupportedSourceRuntimeRejectsBeforeFenceAndRestore(t *testing.T) {
	m := newTestManager(t, helperBinary(t), t.TempDir())
	if m.ClientSourceSupported() {
		t.Fatal("legacy helper advertised client source")
	}
	cfg := exitConfig(t, "source", "tcp", freePort(t, "tcp"), 1)
	var raw map[string]any
	if err := json.Unmarshal(cfg.RunnerConfig, &raw); err != nil {
		t.Fatal(err)
	}
	raw["clientSources"] = []map[string]any{{"version": 1, "ruleId": 101, "receiveProxy": false, "trustedCIDRs": []string{}, "sendProxy": "off"}}
	setRunner(t, &cfg, raw)
	if _, err := m.Apply(cfg); err != ErrSourceCapability {
		t.Fatal("source config accepted by old runner", err)
	}
	if len(m.records) != 0 || len(m.running) != 0 {
		t.Fatal("rejected source config changed fence/runtime")
	}
	deadline, listeners, err := validateConfig(&cfg)
	if err != nil {
		t.Fatal(err)
	}
	if p, err := m.startChildLocked(cfg, deadline, listeners); p != nil || err != ErrSourceCapability {
		t.Fatal("restore ignored source requirement", err)
	}
}

func TestSourceUseIncludesUngatedHashAndEntryConfigs(t *testing.T) {
	for _, raw := range []string{`{"targetSets":[{"strategy":"ip_hash"}]}`, `{"entries":[{"targetSet":{"strategy":"ip_hash"}}]}`, `{"entries":[{"clientSource":{"version":1}}]}`} {
		if !usesClientSource(json.RawMessage(raw)) {
			t.Fatal("source requirement hidden", raw)
		}
	}
	for _, raw := range []string{`{"entries":[]}`, `{"clientSources":null}`, `{"entries":[{"targetSet":{"strategy":"fallback"}}]}`} {
		if usesClientSource(json.RawMessage(raw)) {
			t.Fatal("legacy falsely requires source", raw)
		}
	}
}
