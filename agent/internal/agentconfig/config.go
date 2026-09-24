// Package agentconfig parses the agent's command line (and optional YAML config
// file) using only the standard library.
//
// Flag names, short names and defaults match the original tunex-agent v0.13.22
// so existing service units / install scripts keep working. The original used
// cobra+viper; here we use `flag` plus a tiny YAML reader (see yaml.go).
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
	Server          string
	Token           string
	NodeID          string
	Debug           bool
	ConnectIP       []string
	ListenIP        string
	PortRange       string
	OutInterface    string
	VnstatInterface string
	PprofPort       int

	// Per-protocol fixed listen ports (0 = dynamic / WAIT_LISTEN).
	TCPPort   int
	UDPPort   int
	TLSPort   int
	WSSPort   int
	MTCPPort  int
	MTLSPort  int
	MWSSPort  int
	QUICPort  int
	TunexPort int

	ShowVersion bool
	ConfigFile  string
}

// DefaultConfigFile is the original default config path.
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
		ConfigFile: DefaultConfigFile(),
		PprofPort:  6060,
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
	fs.StringVar(&cfg.Server, "server", cfg.Server, "Server address, like http://localhost:3000 (required)")
	fs.StringVar(&cfg.Server, "s", cfg.Server, "Server address (shorthand)")
	fs.StringVar(&cfg.Token, "token", cfg.Token, "Node group token (required)")
	fs.StringVar(&cfg.Token, "t", cfg.Token, "Node group token (shorthand)")
	fs.StringVar(&cfg.NodeID, "node-id", cfg.NodeID, "Node ID (defaults to hostname)")
	fs.StringVar(&cfg.NodeID, "n", cfg.NodeID, "Node ID (shorthand)")
	fs.BoolVar(&cfg.Debug, "debug", cfg.Debug, "Enable debug mode")
	fs.BoolVar(&cfg.Debug, "d", cfg.Debug, "Enable debug mode (shorthand)")
	fs.StringVar(&cfg.ListenIP, "listen-ip", cfg.ListenIP, "Force all services to listen on this IP")
	fs.StringVar(&cfg.ListenIP, "l", cfg.ListenIP, "Force all services to listen on this IP (shorthand)")
	fs.StringVar(&cfg.PortRange, "port-range", cfg.PortRange, "Port range, e.g. 80,443,30000-30010")
	fs.StringVar(&cfg.PortRange, "r", cfg.PortRange, "Port range (shorthand)")
	fs.StringVar(&cfg.OutInterface, "out-interface", cfg.OutInterface, "Outbound interface")
	fs.StringVar(&cfg.OutInterface, "o", cfg.OutInterface, "Outbound interface (shorthand)")
	fs.StringVar(&cfg.VnstatInterface, "vnstat-interface", cfg.VnstatInterface, "vnstat interface to use for traffic monitoring")
	fs.StringVar(&cfg.VnstatInterface, "I", cfg.VnstatInterface, "vnstat interface (shorthand)")
	fs.IntVar(&cfg.PprofPort, "pprof-port", cfg.PprofPort, "Pprof port on 127.0.0.1 only (0 disables)")
	fs.IntVar(&cfg.TCPPort, "tcp-port", cfg.TCPPort, "TCP port")
	fs.IntVar(&cfg.UDPPort, "udp-port", cfg.UDPPort, "UDP port")
	fs.IntVar(&cfg.TLSPort, "tls-port", cfg.TLSPort, "TLS port")
	fs.IntVar(&cfg.WSSPort, "wss-port", cfg.WSSPort, "WSS port")
	fs.IntVar(&cfg.MTCPPort, "mtcp-port", cfg.MTCPPort, "MTCP port")
	fs.IntVar(&cfg.MTLSPort, "mtls-port", cfg.MTLSPort, "MTLS port")
	fs.IntVar(&cfg.MWSSPort, "mwss-port", cfg.MWSSPort, "MWSS port")
	fs.IntVar(&cfg.QUICPort, "quic-port", cfg.QUICPort, "QUIC port")
	fs.IntVar(&cfg.TunexPort, "tunex-port", cfg.TunexPort, "TuneX port")
	fs.BoolVar(&cfg.ShowVersion, "version", false, "version for TuneX agent")
	fs.BoolVar(&cfg.ShowVersion, "v", false, "version for TuneX agent (shorthand)")

	// connect-ip is a repeatable string flag (`-i a -i b`).
	var connectIPs stringList
	fs.Var(&connectIPs, "connect-ip", "Connect IP list (repeatable)")
	fs.Var(&connectIPs, "i", "Connect IP list (repeatable, shorthand)")

	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if len(connectIPs) > 0 {
		cfg.ConnectIP = connectIPs
	}
	// Environment overrides for the two required values (nice for containers).
	if cfg.Server == "" {
		cfg.Server = os.Getenv("TUNEX_SERVER")
	}
	if cfg.Token == "" {
		cfg.Token = os.Getenv("TUNEX_TOKEN")
	}

	if cfg.ShowVersion {
		return cfg, nil
	}
	if cfg.Server == "" || cfg.Token == "" {
		var missing []string
		if cfg.Server == "" {
			missing = append(missing, "server")
		}
		if cfg.Token == "" {
			missing = append(missing, "token")
		}
		return nil, fmt.Errorf("required flag(s) %q not set", strings.Join(missing, `", "`))
	}
	if !strings.HasPrefix(cfg.Server, "http://") && !strings.HasPrefix(cfg.Server, "https://") {
		// The original accepts a bare host too; normalise to http:// so the
		// Socket.IO endpoint is well formed.
		cfg.Server = "http://" + cfg.Server
	}
	cfg.Server = strings.TrimRight(cfg.Server, "/")

	if cfg.NodeID == "" {
		if h, err := os.Hostname(); err == nil {
			cfg.NodeID = h
		} else {
			cfg.NodeID = "tunex-agent"
		}
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
			if _, err := fmt.Sscanf(v, "%d", &n); err == nil {
				*dst = n
			}
		}
	}
	envStr("SERVER", &cfg.Server)
	envStr("TOKEN", &cfg.Token)
	envStr("NODE_ID", &cfg.NodeID)
	envStr("LISTEN_IP", &cfg.ListenIP)
	envStr("PORT_RANGE", &cfg.PortRange)
	envInt("PPROF_PORT", &cfg.PprofPort)
}

func printUsage(w io.Writer, version string) {
	fmt.Fprintf(w, `TuneX agent — node side of the TuneX control plane.

Usage:
  tunex-agent [flags]

Flags:
  -c, --config string             Config file (default $HOME/.tunex-agent.yaml)
  -i, --connect-ip strings        Connect IP list (repeatable; auto-detected when empty)
  -d, --debug                     Enable debug mode
  -h, --help                      help for TuneX agent
  -l, --listen-ip string          Force all services to listen on this IP
      --mtcp-port int             MTCP port
      --mtls-port int             MTLS port
      --mwss-port int             MWSS port
  -n, --node-id string            Node ID (defaults to hostname)
  -o, --out-interface string      Outbound interface
  -r, --port-range string         Port range, e.g. 80,443,30000-30010
      --pprof-port int            Pprof port on 127.0.0.1 only (0 disables) (default 6060)
      --quic-port int             QUIC port
      --tunex-port int           TuneX port
  -s, --server string             Server address, like http://localhost:3000 (required)
      --tcp-port int              TCP port
      --tls-port int              TLS port
  -t, --token string              Node group token (required)
      --udp-port int              UDP port
  -v, --version                   version for TuneX agent
  -I, --vnstat-interface string   vnstat interface to use for traffic monitoring
      --wss-port int              WSS port

Version: %s
`, version)
}

// IsHelp reports whether err means "help requested".
func IsHelp(err error) bool { return errors.Is(err, flag.ErrHelp) }
