// Package agentconfig parses the agent's command line (and optional YAML config
// file) using only the standard library.
//
// WP15 removed the legacy shutdown surface with the legacy data plane: the
// flags only the old engine read (-server/-token for the Socket.IO session,
// -connect-ip, --port-range and the per-protocol fixed ports that fed
// `register`) are gone. What is left is the v3 runtime's own configuration:
// node identity, the panel it reports to, its local admin plane, the role and
// the port ranges the managers may bind.
package agentconfig

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Config is the resolved agent configuration.
type Config struct {
	NodeID          string
	Debug           bool
	ListenIP        string
	Role            string
	PanelHTTPURL    string
	AgentAdminPort  int
	AgentAdminToken string
	IngressRange    string
	EgressRange     string

	// NodeCredential is the WP7 per-node credential (services/node-credential.ts).
	// It authenticates the state report POST /api/internal/node/state; empty
	// means "no credential provisioned", in which case the heartbeat keeps its
	// legacy shape and the state report is skipped (the node still works).
	NodeCredential string

	ShowVersion bool
	ConfigFile  string
}

// Node roles (the panel's NodeRole enum).
const (
	// RoleIngress runs ingress tunnels only (DIRECT/RELAY listeners).
	RoleIngress = "INGRESS"
	// RoleEgress runs the egress target pools only.
	RoleEgress = "EGRESS"
	// RoleBoth runs both in one process; the shared port guard is what keeps
	// the two ranges from clashing.
	RoleBoth = "BOTH"

	// DefaultAgentAdminPort is the v3 admin plane port (devmap §8: 9090).
	DefaultAgentAdminPort = 9090
)

// NormalizeRole maps a raw role value to one of the three canonical roles.
// Empty or unknown values become BOTH, which is the permissive default for a
// freshly provisioned node (the role is refined by the panel on first apply).
func NormalizeRole(role string) string {
	switch strings.ToUpper(strings.TrimSpace(role)) {
	case RoleIngress:
		return RoleIngress
	case RoleEgress:
		return RoleEgress
	default:
		return RoleBoth
	}
}

// DefaultConfigFile is the agent's default config path.
func DefaultConfigFile() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = "."
	}
	return filepath.Join(home, ".tunex-agent.yaml")
}

// Parse turns argv (without the program name) into a Config.
//
// Precedence (matching the original viper setup): flags > env > config file.
// It returns flag.ErrHelp when -h/--help was requested (the usage text is
// printed to stdout) so main can exit 0.
func Parse(args []string, version string) (*Config, error) {
	fs := flag.NewFlagSet("tunex-agent", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	fs.Usage = func() {
		printUsage(fs.Output(), version)
	}

	cfg := &Config{
		ConfigFile:     DefaultConfigFile(),
		AgentAdminPort: DefaultAgentAdminPort,
	}

	// Defaults from a config file / environment are read first so that explicit
	// flags (parsed below) override them.
	pre := preScan(args)
	file := pre["config"]
	if file == "" {
		file = os.Getenv("TUNEX_CONFIG")
	}
	if file == "" {
		file = cfg.ConfigFile
	}
	applyDefaults(cfg, file)

	fs.StringVar(&cfg.ConfigFile, "config", cfg.ConfigFile, "Config file")
	fs.StringVar(&cfg.ConfigFile, "c", cfg.ConfigFile, "Config file (shorthand)")
	fs.BoolVar(&cfg.Debug, "debug", cfg.Debug, "Enable debug mode")
	fs.BoolVar(&cfg.Debug, "d", cfg.Debug, "Enable debug mode (shorthand)")
	fs.StringVar(&cfg.NodeID, "node-id", cfg.NodeID, "Node ID (defaults to hostname)")
	fs.StringVar(&cfg.NodeID, "n", cfg.NodeID, "Node ID (shorthand)")
	fs.StringVar(&cfg.ListenIP, "listen-ip", cfg.ListenIP, "Interface tunnels bind when the config does not pin one")
	fs.StringVar(&cfg.ListenIP, "l", cfg.ListenIP, "Interface tunnels bind (shorthand)")
	fs.StringVar(&cfg.Role, "role", cfg.Role, "Node role: INGRESS, EGRESS or BOTH")
	fs.StringVar(&cfg.Role, "R", cfg.Role, "Node role (shorthand)")
	fs.StringVar(&cfg.PanelHTTPURL, "panel-http-url", cfg.PanelHTTPURL, "Panel HTTP base URL for heartbeat/state reporting, e.g. http://panel:3001")
	fs.StringVar(&cfg.AgentAdminToken, "agent-admin-token", cfg.AgentAdminToken, "Bearer token for the local admin API on AGENT_ADMIN_PORT")
	fs.IntVar(&cfg.AgentAdminPort, "agent-admin-port", cfg.AgentAdminPort, "Local admin API port; 0 disables it")
	fs.StringVar(&cfg.IngressRange, "ingress-range", cfg.IngressRange, "Port range the ingress tunnels may bind, e.g. 10000-30000")
	fs.StringVar(&cfg.EgressRange, "egress-range", cfg.EgressRange, "Port range the egress tunnels may bind, e.g. 30001-60000")
	// WP7：per-node credential。绝不明文进日志（usage 文本里也不回显值）。
	fs.StringVar(&cfg.NodeCredential, "node-credential", cfg.NodeCredential, "Per-node credential for the state report (WP7)")
	fs.BoolVar(&cfg.ShowVersion, "version", false, "version for TuneX agent")
	fs.BoolVar(&cfg.ShowVersion, "v", false, "version for TuneX agent (shorthand)")

	if err := fs.Parse(args); err != nil {
		return nil, err
	}

	if cfg.ShowVersion {
		return cfg, nil
	}

	if cfg.NodeID == "" {
		if h, err := os.Hostname(); err == nil {
			cfg.NodeID = h
		} else {
			cfg.NodeID = "tunex-agent"
		}
	}
	cfg.Role = NormalizeRole(cfg.Role)
	if cfg.PanelHTTPURL != "" {
		cfg.PanelHTTPURL = strings.TrimRight(cfg.PanelHTTPURL, "/")
	}
	return cfg, nil
}

// stringList is a flag.Value collecting repeated string flags.
type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }

func (s *stringList) Set(v string) error {
	for _, part := range strings.Split(v, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			*s = append(*s, part)
		}
	}
	return nil
}

// preScan finds --config/-c value without full parsing (so the file can supply
// defaults for the real parse).
func preScan(args []string) map[string]string {
	out := map[string]string{}
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--config" || a == "-c":
			if i+1 < len(args) {
				out["config"] = args[i+1]
			}
		case strings.HasPrefix(a, "--config="):
			out["config"] = strings.TrimPrefix(a, "--config=")
		case strings.HasPrefix(a, "-c="):
			out["config"] = strings.TrimPrefix(a, "-c=")
		}
	}
	return out
}

// applyDefaults loads the config file (if present) and environment into cfg.
func applyDefaults(cfg *Config, file string) {
	if file != "" {
		if f, err := os.Open(file); err == nil {
			data, _ := io.ReadAll(f)
			f.Close()
			applyYAML(cfg, string(data))
		}
	}
	// Environment (kebab-case keys upper-cased with TUNEX_ prefix).
	envStr := func(key string, dst *string) {
		if v := os.Getenv("TUNEX_" + key); v != "" {
			*dst = v
		}
	}
	envInt := func(key string, dst *int) {
		if v := os.Getenv("TUNEX_" + key); v != "" {
			var n int
			if _, err := fmt.Sscanf(v, "%d", &n); err != nil {
				*dst = n
			}
		}
	}
	envStr("NODE_ID", &cfg.NodeID)
	envStr("LISTEN_IP", &cfg.ListenIP)
	envStr("ROLE", &cfg.Role)
	envStr("PANEL_HTTP_URL", &cfg.PanelHTTPURL)
	envStr("AGENT_ADMIN_TOKEN", &cfg.AgentAdminToken)
	envStr("NODE_CREDENTIAL", &cfg.NodeCredential)
	envStr("INGRESS_RANGE", &cfg.IngressRange)
	envStr("EGRESS_RANGE", &cfg.EgressRange)
	envInt("AGENT_ADMIN_PORT", &cfg.AgentAdminPort)
}

func printUsage(w io.Writer, version string) {
	fmt.Fprintf(w, `TuneX agent — node side of the TuneX control plane (v3 runtime).

Usage:
  tunex-agent [flags]

Flags:
  -c, --config string             Config file (default $HOME/.tunex-agent.yaml)
  -d, --debug                     Enable debug mode
  -h, --help                      help for TuneX agent
  -l, --listen-ip string          Interface tunnels bind when the config does not pin one
  -n, --node-id string            Node ID (defaults to hostname)
  -v, --version                   version for TuneX agent

Runtime:
      --role string               Node role: INGRESS, EGRESS or BOTH (default BOTH)
      --panel-http-url string     Panel HTTP base URL for heartbeat/state reporting
      --agent-admin-token string  Bearer token for the local admin API
      --agent-admin-port int      Local admin API port; 0 disables (default 9090)
      --ingress-range string      Port range ingress tunnels may bind, e.g. 10000-30000
      --egress-range string       Port range egress tunnels may bind, e.g. 30001-60000
      --node-credential string    Per-node credential for the state report

Version: %s
`, version)
}

// IsHelp reports whether err means "help requested".
func IsHelp(err error) bool { return errors.Is(err, flag.ErrHelp) }
