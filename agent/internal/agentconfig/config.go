// Package agentconfig parses the Agent's CLI, environment and optional flat
// YAML configuration using only the Go standard library.
package agentconfig

import (
	"errors"
	"flag"
	"fmt"
	"github.com/tunex/agent/internal/identityprobe"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Config is the resolved agent configuration.
type Config struct {
	// AgentID is the immutable Panel-issued physical Agent identity.
	// It does not change when the display node name or INGRESS/EGRESS/BOTH role changes.
	AgentID         string
	NodeID          string
	Debug           bool
	ListenIP        string
	Role            string
	PanelHTTPURL    string
	AgentAdminPort  int
	AgentAdminToken string
	IngressRange    string
	EgressRange     string

	// NodeCredential authenticates the production command/state path. Without
	// it the Agent cannot poll revisioned commands or post authenticated state.
	NodeCredential string

	ShowVersion bool
	ConfigFile  string

	// ── 身份探针（升级脚本在容器内调用的隐藏模式）────────────────────────────
	//
	// `--identity-probe` 只做一件事：用节点自己的凭据问一次 Panel，打印**一行**
	// 结论然后退出 —— 绝不启动运行时。它是升级脚本身份校验的首选路径，因为
	// Go stdlib 可以做到 shell 探针做不到的两件事：**永不跟随重定向**（凭据不会随
	// 3xx 被重发到别的 host）与**真 JSON 解析**（`{"data": oops}` 不会被当成 Panel）。
	//
	// 用**布尔开关**而不是子命令是刻意的：老镜像的二进制会把位置参数当成"多余参数"
	// 而**照常启动运行时**（`flag.Parse` 遇到位置参数就停下，剩下的进 `fs.Args()`，
	// 而 run() 不检查它）—— 在已经在跑 Agent 的容器里再起一个进程是危险的。
	// 未知**标志**则被 `flag` 包直接拒绝（usage + 退出码 2），所以探测是安全的。
	IdentityProbe bool
	// ProbeURL 是 Panel 基址（缺省回落到 agent.env 里的 TUNEX_PANEL_HTTP_URL）。
	ProbeURL string
	// ProbeTimeoutS 是整次探针的上限秒数。
	ProbeTimeoutS int
	// ProbeEnvFile 是读凭据的 agent.env 路径。
	//
	// **没有** `--probe-credential`：凭据只能从文件读 —— 从命令行传会进 `ps`、shell
	// 历史与容器 inspect 输出，而这条探针的设计前提就是"凭据不出容器、不进日志"。
	ProbeEnvFile string

	// StateDir holds agent-local durable state, including the last-known-good
	// desired-state cache that lets a restart during a panel outage come
	// back with its listeners instead of empty. Empty disables the cache.
	StateDir string
}

// DefaultStateDir is where the container mounts the agent's writable state.
const DefaultStateDir = "/var/lib/tunex-agent"

// LKGPath is the last-known-good cache file inside StateDir.
func (c *Config) LKGPath() string {
	dir := strings.TrimSpace(c.StateDir)
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "desired-lkg.json")
}

// OwnershipFencePath is the ownership epoch fence inside StateDir.
//
// It lives in the SAME durable directory as the last-known-good cache because it
// answers the same kind of question ("what does this node remember across a
// restart?") and is subject to the same lifecycle: an operator who wipes or
// mounts that directory has made one decision about durable agent state, not
// two. It is a separate file, not a field of the cache, so a corrupted desired
// snapshot can never cost the fence — the fence is the one fact whose loss turns
// a restart into a split-brain risk.
//
// Empty StateDir returns "" and the fence then lives only in memory, which the
// node reports (ownership.Facts.Durable) instead of hiding.
func (c *Config) OwnershipFencePath() string {
	dir := strings.TrimSpace(c.StateDir)
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "ownership-epoch.json")
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

	// DefaultAgentAdminPort is the optional local admin API port.
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
		// Durable state is on by default so a node restarted during a Panel
		// outage can restore its last-known-good listeners.
		// An explicitly empty TUNEX_STATE_DIR disables the cache.
		StateDir: DefaultStateDir,
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
	if err := applyDefaults(cfg, file); err != nil {
		return nil, err
	}

	fs.StringVar(&cfg.ConfigFile, "config", cfg.ConfigFile, "Config file")
	fs.StringVar(&cfg.ConfigFile, "c", cfg.ConfigFile, "Config file (shorthand)")
	fs.BoolVar(&cfg.Debug, "debug", cfg.Debug, "Enable debug mode")
	fs.BoolVar(&cfg.Debug, "d", cfg.Debug, "Enable debug mode (shorthand)")
	fs.StringVar(&cfg.AgentID, "agent-id", cfg.AgentID, "Immutable Panel-issued Agent ID")
	fs.StringVar(&cfg.NodeID, "node-id", cfg.NodeID, "Human-readable node name (defaults to hostname)")
	fs.StringVar(&cfg.NodeID, "n", cfg.NodeID, "Node ID (shorthand)")
	fs.StringVar(&cfg.ListenIP, "listen-ip", cfg.ListenIP, "Interface tunnels bind when the config does not pin one")
	fs.StringVar(&cfg.ListenIP, "l", cfg.ListenIP, "Interface tunnels bind (shorthand)")
	fs.StringVar(&cfg.Role, "role", cfg.Role, "Node role: INGRESS, EGRESS or BOTH")
	fs.StringVar(&cfg.Role, "R", cfg.Role, "Node role (shorthand)")
	fs.StringVar(&cfg.PanelHTTPURL, "panel-http-url", cfg.PanelHTTPURL, "Panel HTTP base URL for control and reporting, e.g. http://panel:3000")
	fs.StringVar(&cfg.AgentAdminToken, "agent-admin-token", cfg.AgentAdminToken, "Bearer token for the local admin API on AGENT_ADMIN_PORT")
	fs.IntVar(&cfg.AgentAdminPort, "agent-admin-port", cfg.AgentAdminPort, "Local admin API port; 0 disables it")
	fs.StringVar(&cfg.IngressRange, "ingress-range", cfg.IngressRange, "Port range the ingress tunnels may bind, e.g. 10000-30000")
	fs.StringVar(&cfg.EgressRange, "egress-range", cfg.EgressRange, "Port range the egress tunnels may bind, e.g. 30001-60000")
	// Per-node credential must never be echoed in logs or usage output.
	fs.StringVar(&cfg.NodeCredential, "node-credential", cfg.NodeCredential, "Per-node credential for command polling and state reporting")
	// Durable state directory for restore and ownership fencing.
	fs.StringVar(&cfg.StateDir, "state-dir", cfg.StateDir, "Directory for durable agent state (last-known-good desired cache); empty disables it")
	fs.BoolVar(&cfg.ShowVersion, "version", false, "version for TuneX agent")
	fs.BoolVar(&cfg.ShowVersion, "v", false, "version for TuneX agent (shorthand)")
	// Identity probe (see Config.IdentityProbe). Deliberately flags, not a subcommand:
	// an older binary rejects an unknown FLAG safely, but would treat a positional
	// argument as "extra args" and start the runtime anyway.
	fs.BoolVar(&cfg.IdentityProbe, "identity-probe", false, "Run the in-container identity probe, print one verdict line and exit (used by the upgrade script)")
	fs.StringVar(&cfg.ProbeURL, "probe-url", "", "Panel base URL for --identity-probe (falls back to TUNEX_PANEL_HTTP_URL in the env file)")
	fs.IntVar(&cfg.ProbeTimeoutS, "probe-timeout", int(identityprobe.DefaultTimeout.Seconds()), "Seconds to wait for the --identity-probe request")
	fs.StringVar(&cfg.ProbeEnvFile, "probe-env-file", identityprobe.DefaultEnvFile, "agent.env path read by --identity-probe")

	if err := fs.Parse(args); err != nil {
		return nil, err
	}

	if cfg.ShowVersion {
		return cfg, nil
	}
	// 探针模式：只跑一次探针就返回，调用方（main）打印结论并退出。
	if cfg.IdentityProbe {
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
func applyDefaults(cfg *Config, file string) error {
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
	// Integer environment values fail closed when malformed; silently falling
	// back would make the running Agent disagree with the operator's config.
	envInt := func(key string, dst *int) error {
		v, ok := os.LookupEnv("TUNEX_" + key)
		if !ok || strings.TrimSpace(v) == "" {
			return nil
		}
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil {
			return fmt.Errorf("TUNEX_%s=%q 不是整数", key, v)
		}
		*dst = n
		return nil
	}
	envStr("AGENT_ID", &cfg.AgentID)
	envStr("NODE_ID", &cfg.NodeID)
	envStr("LISTEN_IP", &cfg.ListenIP)
	envStr("ROLE", &cfg.Role)
	envStr("PANEL_HTTP_URL", &cfg.PanelHTTPURL)
	envStr("AGENT_ADMIN_TOKEN", &cfg.AgentAdminToken)
	envStr("NODE_CREDENTIAL", &cfg.NodeCredential)
	envStr("INGRESS_RANGE", &cfg.IngressRange)
	envStr("EGRESS_RANGE", &cfg.EgressRange)
	// LookupEnv (not envStr): an explicitly empty TUNEX_STATE_DIR must be able
	// to turn the durable cache OFF, which "unset" cannot express.
	if v, ok := os.LookupEnv("TUNEX_STATE_DIR"); ok {
		cfg.StateDir = strings.TrimSpace(v)
	}
	// Propagate invalid numeric configuration instead of silently using a default.
	if err := envInt("AGENT_ADMIN_PORT", &cfg.AgentAdminPort); err != nil {
		return err
	}
	return nil
}

func printUsage(w io.Writer, version string) {
	fmt.Fprintf(w, `TuneX agent — node-side data plane for the TuneX control plane.

Usage:
  tunex-agent [flags]

Flags:
  -c, --config string             Config file (default $HOME/.tunex-agent.yaml)
  -d, --debug                     Enable debug mode
  -h, --help                      help for TuneX agent
  -l, --listen-ip string          Interface tunnels bind when the config does not pin one
      --agent-id string           Immutable Panel-issued Agent ID
  -n, --node-id string            Human-readable node name (defaults to hostname)
  -v, --version                   version for TuneX agent

Runtime:
      --role string               Node role: INGRESS, EGRESS or BOTH (default BOTH)
      --panel-http-url string     Panel HTTP base URL for command polling and state reporting
      --agent-admin-token string  Bearer token for the local admin API
      --agent-admin-port int      Local admin API port; 0 disables (default 9090)
      --ingress-range string      Port range ingress tunnels may bind, e.g. 10000-30000
      --egress-range string       Port range egress tunnels may bind, e.g. 30001-60000
      --node-credential string    Per-node credential for the state report
      --state-dir string          Durable state dir (last-known-good cache); empty disables

Version: %s
`, version)
}

// IsHelp reports whether err means "help requested".
func IsHelp(err error) bool { return errors.Is(err, flag.ErrHelp) }
