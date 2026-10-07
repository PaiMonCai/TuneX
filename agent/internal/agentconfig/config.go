// Package agentconfig parses the Agent's CLI, environment and optional flat
// YAML configuration using only the Go standard library.
package agentconfig

import (
	"errors"
	"flag"
	"fmt"
	"github.com/tunex/agent/internal/identityprobe"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
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

	// ── 面板迁移回退（task-44）──────────────────────────────────────────────
	//
	// 面板换地址（换域名/换机房/迁 IP）时 Agent 不必重新接入：主地址连续失败到阈值
	// （或距迁移起始时间超过期限、且已有失败证据）就切到备用地址，并在**每一次**上报里
	// 如实带上「当前生效地址 + 迁移 id + 是否在回退态」。
	//
	// **两个键齐备才算启用**（备用地址 + 迁移 id）——与参照实现的"齐备才写、否则三个
	// 一起删"同一语义：只填一个说明配置写坏了，必须报出来，不能猜。
	// `PanelMigrationStartedAt` 可选；缺失时只能用"连续失败"这一条判据（面板侧仍会
	// 下发它，便于审计"这次迁移从什么时候开始"）。
	//
	// 三个都空 = 本能力未配置，也是**缺省部署**的状态：行为与以前完全一致。
	PanelFallbackURL        string
	PanelMigrationID        string
	PanelMigrationStartedAt string
}

// DefaultStateDir is where the container mounts the agent's writable state.
const DefaultStateDir = "/var/lib/tunex-agent"

/* ================================================================== */
/* 面板迁移回退（task-44）                                             */
/* ================================================================== */

// PanelMigrationFallback 是**已经校验过**的回退配置（启用时才有意义）。
//
// 行为参照声明：本组类型与判据参照 ForwardX（AGPL-3.0）的 agent 配置
// `migrationFallbackPanelUrl` / `panelMigrationId` / `panelMigrationStartedAt`
// 三个键的语义（**齐备才生效**）。TuneX 侧是独立实现：这里只做**配置面**的解析与
// 校验，切换判据在 `internal/reporter` 的纯函数里，口径按本项目契约重写。
type PanelMigrationFallback struct {
	// PrimaryURL 是主面板地址（当前 agent.env 的 TUNEX_PANEL_HTTP_URL）。
	PrimaryURL string
	// FallbackURL 是备用面板地址（已去掉尾部斜杠）。
	FallbackURL string
	// MigrationID 是这次面板迁移的标识（面板侧生成；用于审计与"同一迁移不重复处理"）。
	MigrationID string
	// StartedAt 是迁移起始时刻；StartedAtKnown=false 表示面板没下发，只能用失败阈值判据。
	StartedAt      time.Time
	StartedAtKnown bool
}

// 面板迁移配置面的三种坏形状（都必须**报出来**，不能静默忽略）。
var (
	// ErrPanelMigrationNotConfigured：三个键都空 = 本能力未配置（正常缺省）。
	ErrPanelMigrationNotConfigured = errors.New("agentconfig: panel migration fallback is not configured")
	// ErrPanelMigrationIncomplete：只填了一部分（必须"齐备才启用"）。
	ErrPanelMigrationIncomplete = errors.New("agentconfig: panel migration fallback needs BOTH TUNEX_PANEL_FALLBACK_URL and TUNEX_PANEL_MIGRATION_ID")
	// ErrPanelMigrationBadURL：备用地址不是合法的 http(s) 绝对地址。
	ErrPanelMigrationBadURL = errors.New("agentconfig: TUNEX_PANEL_FALLBACK_URL must be an absolute http(s) URL")
	// ErrPanelMigrationBadStartedAt：起始时间给了但不是可解析的时间。
	ErrPanelMigrationBadStartedAt = errors.New("agentconfig: TUNEX_PANEL_MIGRATION_STARTED_AT must be RFC3339 (or unix seconds)")
)

// PanelMigration 解析回退三元组。
//
// 返回 nil error 才表示**启用**（此时 fallback 可用）。三个键都空 ⇒
// ErrPanelMigrationNotConfigured（正常缺省，调用方不应当把它当故障）；
// 其它 error 都是**配置写坏了**，调用方必须如实记录/呈现，而不是退回"当作没配"。
//
// 为什么要"齐备才启用"：面板侧下发时是"两个键齐备才写、否则三个一起删"（可撤销的
// 回退态）。agent 侧如果对"只填了备用地址"睁一只眼，就会出现"以为配好了其实不会切"
// 或者"切到一个没被授权的地址"两种都不该有的状态。
func (c Config) PanelMigration() (*PanelMigrationFallback, error) {
	primary := strings.TrimRight(strings.TrimSpace(c.PanelHTTPURL), "/")
	fallback := strings.TrimRight(strings.TrimSpace(c.PanelFallbackURL), "/")
	migrationID := strings.TrimSpace(c.PanelMigrationID)
	startedRaw := strings.TrimSpace(c.PanelMigrationStartedAt)

	if fallback == "" && migrationID == "" && startedRaw == "" {
		return nil, ErrPanelMigrationNotConfigured
	}
	if fallback == "" || migrationID == "" {
		return nil, ErrPanelMigrationIncomplete
	}
	u, err := url.Parse(fallback)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, ErrPanelMigrationBadURL
	}
	out := &PanelMigrationFallback{
		PrimaryURL:  primary,
		FallbackURL: fallback,
		MigrationID: migrationID,
	}
	if startedRaw != "" {
		at, err := parseMigrationStartedAt(startedRaw)
		if err != nil {
			return nil, ErrPanelMigrationBadStartedAt
		}
		out.StartedAt = at
		out.StartedAtKnown = true
	}
	return out, nil
}

// parseMigrationStartedAt 接受 RFC3339（面板侧下发的形状）与 unix 秒（方便脚本/测试）。
func parseMigrationStartedAt(raw string) (time.Time, error) {
	if ts, err := strconv.ParseInt(raw, 10, 64); err == nil {
		if ts <= 0 {
			return time.Time{}, fmt.Errorf("non-positive unix timestamp")
		}
		return time.Unix(ts, 0).UTC(), nil
	}
	return time.Parse(time.RFC3339, raw)
}

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
	// 面板迁移回退（task-44）：主地址不可达时切到备用地址（两个键齐备才启用）。
	fs.StringVar(&cfg.PanelFallbackURL, "panel-fallback-url", cfg.PanelFallbackURL, "Fallback Panel base URL used when the primary Panel is unreachable (needs --panel-migration-id too)")
	fs.StringVar(&cfg.PanelMigrationID, "panel-migration-id", cfg.PanelMigrationID, "Identifier of the Panel migration this fallback belongs to")
	fs.StringVar(&cfg.PanelMigrationStartedAt, "panel-migration-started-at", cfg.PanelMigrationStartedAt, "When the Panel migration started (RFC3339 or unix seconds; optional)")
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
	// 面板迁移回退（task-44）：由安装器写进 agent.env。**两个键齐备才启用**，
	// 解析纪律见 Config.PanelMigration（只填一个 = 配置写坏了，必须报出来）。
	envStr("PANEL_FALLBACK_URL", &cfg.PanelFallbackURL)
	envStr("PANEL_MIGRATION_ID", &cfg.PanelMigrationID)
	envStr("PANEL_MIGRATION_STARTED_AT", &cfg.PanelMigrationStartedAt)
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
      --panel-fallback-url string Fallback Panel URL used when the primary Panel is unreachable
                                  (needs --panel-migration-id as well; both empty = feature off)
      --panel-migration-id string Identifier of the Panel migration the fallback belongs to
      --panel-migration-started-at string  When the migration started (RFC3339 / unix seconds; optional)
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
