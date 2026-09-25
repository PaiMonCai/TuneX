package agentconfig

import (
	"flag"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The legacy flags were removed with the legacy data plane. A WP15 regression
// would silently reintroduce them, so pin their absence: parsing a legacy flag
// must fail rather than be ignored.
func TestParseRejectsRemovedLegacyFlags(t *testing.T) {
	legacy := [][]string{
		{"-server", "https://tunex.example.com:3000"},
		{"-token", "secret"},
		{"-connect-ip", "1.2.3.4"},
		{"-port-range", "49800-49899"},
		{"-pprof-port", "6060"},
		{"-v3-runtime", "direct"},
	}
	for _, args := range legacy {
		_, err := Parse(args, "test")
		if err == nil {
			t.Errorf("Parse(%v) = nil error, want flag unknown (flag was removed in WP15)", args)
		}
	}
}

func TestParseSurvivingFlags(t *testing.T) {
	cfg, err := Parse([]string{
		"--node-id", "node-01",
		"--role", "ingress",
		"--panel-http-url", "http://panel:3001/",
		"--agent-admin-port", "9090",
		"--agent-admin-token", "tok",
		"--ingress-range", "10000-30000",
		"--egress-range", "30001-60000",
	}, "test")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.NodeID != "node-01" {
		t.Errorf("NodeID = %q", cfg.NodeID)
	}
	if cfg.Role != RoleIngress {
		t.Errorf("Role = %q, want INGRESS", cfg.Role)
	}
	// Trailing slash is trimmed so the heartbeat URL join stays exact.
	if cfg.PanelHTTPURL != "http://panel:3001" {
		t.Errorf("PanelHTTPURL = %q", cfg.PanelHTTPURL)
	}
	if cfg.AgentAdminPort != 9090 || cfg.AgentAdminToken != "tok" {
		t.Errorf("admin plane = %d/%q", cfg.AgentAdminPort, cfg.AgentAdminToken)
	}
	if cfg.IngressRange != "10000-30000" || cfg.EgressRange != "30001-60000" {
		t.Errorf("ranges = %q/%q", cfg.IngressRange, cfg.EgressRange)
	}
}

func TestParseDefaultsAdminPortAndRole(t *testing.T) {
	cfg, err := Parse(nil, "test")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.AgentAdminPort != DefaultAgentAdminPort {
		t.Errorf("AgentAdminPort = %d, want %d", cfg.AgentAdminPort, DefaultAgentAdminPort)
	}
	if cfg.Role != RoleBoth {
		t.Errorf("Role = %q, want BOTH", cfg.Role)
	}
}

// An admin port with no token leaves the mutating routes unreachable, so the
// runtime must refuse to open the plane (rather than silently serving an
// unauthenticated one) and start the rest of the node anyway.
func TestParseAllowsAdminPortWithoutToken(t *testing.T) {
	cfg, err := Parse([]string{"--agent-admin-port", "9090"}, "test")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.AgentAdminPort != 9090 || cfg.AgentAdminToken != "" {
		t.Errorf("admin plane = %d/%q", cfg.AgentAdminPort, cfg.AgentAdminToken)
	}
}

func TestParseVersionIsNotHelp(t *testing.T) {
	cfg, err := Parse([]string{"--version"}, "1.2.3")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !cfg.ShowVersion {
		t.Error("ShowVersion = false, want true")
	}
}

func TestNormalizeRole(t *testing.T) {
	cases := map[string]string{
		"":         RoleBoth,
		"ingress":  RoleIngress,
		"EGRESS":   RoleEgress,
		" Both ":   RoleBoth,
		"nonsense": RoleBoth,
	}
	for in, want := range cases {
		if got := NormalizeRole(in); got != want {
			t.Errorf("NormalizeRole(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestApplyYAMLV3Keys(t *testing.T) {
	cfg := &Config{}
	applyYAML(cfg, `
node-id: node-42
role: egress
debug: true
listen-ip: 10.0.0.5
panel-http-url: http://panel:3001
agent-admin-port: 9090
agent-admin-token: tok
ingress-range: 10000-30000
egress-range: 30001-60000
node-credential: cred
# a comment line
`)
	if cfg.NodeID != "node-42" || cfg.Role != "egress" || !cfg.Debug || cfg.ListenIP != "10.0.0.5" {
		t.Errorf("scalars: %+v", cfg)
	}
	if cfg.PanelHTTPURL != "http://panel:3001" || cfg.AgentAdminPort != 9090 || cfg.AgentAdminToken != "tok" {
		t.Errorf("panel: %+v", cfg)
	}
	if cfg.IngressRange != "10000-30000" || cfg.EgressRange != "30001-60000" || cfg.NodeCredential != "cred" {
		t.Errorf("ranges/cred: %+v", cfg)
	}
}

// A pre-WP15 config file must still load: its legacy keys are ignored, not fatal.
func TestApplyYAMLIgnoresLegacyKeys(t *testing.T) {
	cfg := &Config{}
	applyYAML(cfg, `
server: https://tunex.example.com:3000
token: secret
port-range: 49800-49899
connect-ip: 1.2.3.4
tcp-port: 20000
pprof-port: 6060
node-id: after-legacy
`)
	if cfg.NodeID != "after-legacy" {
		t.Errorf("v3 key after legacy noise = %q", cfg.NodeID)
	}
}

func TestParsePrefersFlagOverFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(path, []byte("node-id: from-file\nrole: INGRESS\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Parse([]string{"--config", path, "--node-id", "from-flag"}, "test")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.NodeID != "from-flag" {
		t.Errorf("NodeID = %q, want from-flag", cfg.NodeID)
	}
	// The file still supplies the keys the flag did not touch.
	if cfg.Role != RoleIngress {
		t.Errorf("Role = %q, want INGRESS", cfg.Role)
	}
}

func TestUsageHasNoLegacyFlags(t *testing.T) {
	fs := flag.NewFlagSet("tunex-agent", flag.ContinueOnError)
	var sb strings.Builder
	fs.SetOutput(&sb)
	fs.Usage = func() { printUsage(fs.Output(), "test") }
	fs.Usage()
	out := sb.String()
	// Match flags as they appear in the flag column (leading whitespace + dash),
	// so a substring inside a longer flag name (--agent-admin-token) is not a
	// false positive for the removed bare -token.
	for _, bad := range []string{"-server", "-token", "-connect-ip", "-port-range", "-pprof-port", "-v3-runtime"} {
		re := regexp.MustCompile(`(?m)^\s+` + regexp.QuoteMeta(bad) + `\b`)
		if re.MatchString(out) {
			t.Errorf("usage still documents removed flag %q:\n%s", bad, out)
		}
	}
	for _, good := range []string{"--role", "--panel-http-url", "--agent-admin-port", "--ingress-range", "--egress-range", "--node-credential"} {
		if !strings.Contains(out, good) {
			t.Errorf("usage missing %q:\n%s", good, out)
		}
	}
}
