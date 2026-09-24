package engine

import (
	"encoding/json"
	"testing"
)

// reload builds a runtime bound to an ephemeral range and applies a config.
func reloadWith(t *testing.T, cfgJSON string) (*Runtime, []string) {
	t.Helper()
	rt := NewRuntime("127.0.0.1", "")
	var errs []string
	rt.OnListenError = func(name, code string) {
		errs = append(errs, name+":"+code)
	}
	n, err := rt.Reload([]byte(cfgJSON))
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if n < 0 {
		t.Fatalf("negative service count")
	}
	return rt, errs
}

// TestTCPUDPOfSameTunnelGetDifferentPorts is the regression guard for the
// reported multi-node defect: within one agent the tcp and udp listeners of the
// same tunnel must never be handed the same port number.
func TestTCPUDPOfSameTunnelGetDifferentPorts(t *testing.T) {
	cfg := `{"services":[
		{"name":"tcp-8","addr":":WAIT_LISTEN49800-49899","handler":{"type":"tcp"},"listener":{"type":"tcp"}},
		{"name":"udp-8","addr":":WAIT_LISTEN49800-49899","handler":{"type":"udp"},"listener":{"type":"udp"}}
	]}`
	rt, _ := reloadWith(t, cfg)
	defer rt.Stop()

	ports := rt.ActivePorts()
	if len(ports) != 2 {
		t.Fatalf("expected 2 running services, got %d (%v)", len(ports), ports)
	}
	tcpPort := ports["tcp-8"]
	udpPort := ports["udp-8"]
	if tcpPort == 0 || udpPort == 0 {
		t.Fatalf("missing ports: %v", ports)
	}
	if tcpPort == udpPort {
		t.Fatalf("tcp-8 and udp-8 share port %d (regression)", tcpPort)
	}
	for name, p := range ports {
		if p < 49800 || p > 49899 {
			t.Fatalf("%s port %d outside range", name, p)
		}
	}
}

// TestDeterministicStartOrder: services are started in name order regardless of
// the order they appear in the config, so port assignment is reproducible.
func TestDeterministicStartOrder(t *testing.T) {
	// udp-8 listed FIRST, tcp-8 second; sorted start order should give tcp-8 the
	// lower port.
	cfg := `{"services":[
		{"name":"zudp-8","addr":":WAIT_LISTEN49800-49899","handler":{"type":"udp"},"listener":{"type":"udp"}},
		{"name":"atcp-8","addr":":WAIT_LISTEN49800-49899","handler":{"type":"tcp"},"listener":{"type":"tcp"}}
	]}`
	rt, _ := reloadWith(t, cfg)
	defer rt.Stop()
	ports := rt.ActivePorts()
	if ports["atcp-8"] >= ports["zudp-8"] {
		t.Fatalf("expected deterministic name order to give atcp-8 a lower port: %v", ports)
	}
}

// TestDynamicPortExhaustionSignalsControlPlane: when the range cannot hold all
// listeners, the agent emits ERR_NO_FREE_PORT instead of failing silently.
func TestDynamicPortExhaustionSignalsControlPlane(t *testing.T) {
	cfg := `{"services":[
		{"name":"a","addr":":WAIT_LISTEN49800-49800","handler":{"type":"tcp"},"listener":{"type":"tcp"}},
		{"name":"b","addr":":WAIT_LISTEN49800-49800","handler":{"type":"tcp"},"listener":{"type":"tcp"}}
	]}`
	rt, errs := reloadWith(t, cfg)
	defer rt.Stop()

	if len(errs) != 1 {
		t.Fatalf("expected exactly 1 listen_error, got %v", errs)
	}
	if errs[0] != "b:ERR_NO_FREE_PORT" {
		t.Fatalf("unexpected error signal: %v", errs)
	}
	if len(rt.ActivePorts()) != 1 {
		t.Fatalf("expected 1 service to start: %v", rt.ActivePorts())
	}
}

// TestReloadIsIdempotent: reapplying the same config does not churn listeners or
// reassign ports.
func TestReloadIsIdempotent(t *testing.T) {
	cfg := `{"services":[
		{"name":"tcp-8","addr":":WAIT_LISTEN49800-49899","handler":{"type":"tcp"},"listener":{"type":"tcp"}}
	]}`
	rt, _ := reloadWith(t, cfg)
	defer rt.Stop()
	first := rt.ActivePorts()["tcp-8"]

	if _, err := rt.Reload([]byte(cfg)); err != nil {
		t.Fatalf("second reload: %v", err)
	}
	if got := rt.ActivePorts()["tcp-8"]; got != first {
		t.Fatalf("port changed across identical reload: %d -> %d", first, got)
	}
}

// sanity: the config parses.
func TestParseConfigRoundTrip(t *testing.T) {
	var c Config
	if err := json.Unmarshal([]byte(`{"services":[{"name":"x","addr":":1"}]}`), &c); err != nil {
		t.Fatal(err)
	}
	if len(c.Services) != 1 || c.Services[0].Name != "x" {
		t.Fatalf("bad parse: %+v", c.Services)
	}
}
