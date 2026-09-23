// Package agent wires the control plane (Socket.IO) and the data plane (engine)
// together and owns the reconnect loop.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/relayx/agent/internal/agentconfig"
	"github.com/relayx/agent/internal/engine"
	"github.com/relayx/agent/internal/fernet"
	"github.com/relayx/agent/internal/license"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/netutil"
	"github.com/relayx/agent/internal/socketio"
)

// version is the reported agent version; overridable from main.
var version = "0.13.22"

// keyFromEnv resolves an installation key, preferring the TuneX variable name
// and falling back to the legacy RELAYX name during migration. No key is ever
// compiled into the binary.
func keyFromEnv(primary, legacy string) string {
	if v := strings.TrimSpace(os.Getenv(primary)); v != "" {
		return v
	}
	return strings.TrimSpace(os.Getenv(legacy))
}
// SetVersion overrides the reported version (called from main).
func SetVersion(v string) {
	if v != "" {
		version = v
	}
}

const (
	serverClockToleranceSeconds = 300
	sysinfoInterval             = 10 * time.Second
	registerAckTimeout          = 15 * time.Second
)

// Agent is the running node agent.
type Agent struct {
	cfg     *agentconfig.Config
	runtime *engine.Runtime

	configKey []byte
	licKey    []byte

	mu          sync.Mutex
	client      *socketio.Client
	connectIPs  []string
	serverURL   string
	registered  bool
	lastSysinfo *netutil.SysInfo
}

// New builds an Agent from config.
func New(cfg *agentconfig.Config) (*Agent, error) {
	configKey, err := license.DecodeConfigKey(keyFromEnv(license.EnvConfigKey, "RELAYX_CONFIG_KEY"))
	if err != nil {
		return nil, fmt.Errorf("agent: config key: %w", err)
	}
	licKey, err := license.DecodeLicenseKey(keyFromEnv(license.EnvLicenseKey, "RELAYX_LICENSE_KEY"))
	if err != nil {
		return nil, fmt.Errorf("agent: license key: %w", err)
	}

	a := &Agent{
		cfg:       cfg,
		configKey: configKey,
		licKey:    licKey,
	}
	a.runtime = engine.NewRuntime(cfg.ListenIP, cfg.PortRange)
	a.runtime.OnListen = a.onListen
	a.runtime.OnListenError = a.onListenError

	// Resolve connect IPs.
	a.connectIPs = cfg.ConnectIP
	if len(a.connectIPs) == 0 {
		if ips := netutil.GetPublicIPs(5 * time.Second); len(ips) > 0 {
			a.connectIPs = ips
		} else {
			a.connectIPs = netutil.FallbackConnectIPs()
		}
	}

	// Server URL: the license site_url must match this exactly.
	a.serverURL = cfg.Server
	if dir := os.Getenv("RELAYX_SITE_URL"); dir != "" {
		a.serverURL = strings.TrimRight(dir, "/")
	}
	return a, nil
}

// Run connects and reconnects until ctx is cancelled.
func (a *Agent) Run(ctx context.Context) error {
	defer a.runtime.Stop()

	logx.Info("TuneX agent starting",
		"version", versionString(),
		"server", a.serverURL,
		"node_id", a.cfg.NodeID,
		"connect_ip", strings.Join(a.connectIPs, ","),
	)

	backoff := time.Second
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		if err := a.connectAndServe(ctx); err != nil {
			logx.Warn("disconnected", "err", err.Error(), "retry_in", backoff.String())
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		// Exponential backoff capped at 30s, reset on a successful long session
		// is approximated by capping at 30s.
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
		if a.wasRegistered() {
			backoff = 2 * time.Second
		}
	}
}

func (a *Agent) connectAndServe(ctx context.Context) error {
	client, err := socketio.Connect(socketio.Options{
		ServerURL: a.serverURL,
		Token:     a.cfg.Token,
		Timeout:   15 * time.Second,
	})
	if err != nil {
		return err
	}
	defer client.Close()
	logx.Info("Connected to server successfully")

	a.setClient(client)
	a.setRegistered(false)
	defer a.setClient(nil)

	client.On("config", a.handleConfig)
	client.On("test", a.handleTest)
	client.On("ping", a.handlePing)
	client.On("upgrade", a.handleUpgrade)

	// Register (blocking ack).
	if err := a.register(client); err != nil {
		return err
	}
	a.setRegistered(true)
	logx.Info("License loaded successfully")

	// Periodic sysinfo.
	stop := make(chan struct{})
	defer close(stop)
	go a.sysinfoLoop(client, stop)

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-client.Done():
		return errors.New("connection closed")
	}
}

func (a *Agent) register(client *socketio.Client) error {
	basic := netutil.GetBasicSysInfo()
	payload := map[string]any{
		"node_id":    a.cfg.NodeID,
		"connect_ip": a.connectIPs,
		"ports": map[string]int{
			"tcp": a.cfg.TCPPort, "udp": a.cfg.UDPPort, "tls": a.cfg.TLSPort,
			"wss": a.cfg.WSSPort, "mtcp": a.cfg.MTCPPort, "mtls": a.cfg.MTLSPort,
			"mwss": a.cfg.MWSSPort, "quic": a.cfg.QUICPort, "relayx": a.cfg.RelayxPort,
		},
		"sysinfo": basic,
		"version": versionString(),
	}

	ack, err := client.EmitWithAck(registerAckTimeout, "register", payload)
	if err != nil {
		return fmt.Errorf("register: %w", err)
	}
	// The ack payload is a single JSON object: {license, site_url, type, now}.
	if len(ack) == 0 {
		return errors.New("register: empty ack")
	}
	var resp struct {
		License string `json:"license"`
		SiteURL string `json:"site_url"`
		Type    string `json:"type"`
		Now     int64  `json:"now"`
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(ack[0], &resp); err != nil {
		return fmt.Errorf("register: bad ack: %w", err)
	}
	if resp.Error != "" {
		return fmt.Errorf("register rejected: %s", resp.Error)
	}

	info, err := license.Verify(resp.License, keyFromEnv(license.EnvLicenseKey, "RELAYX_LICENSE_KEY"), a.serverURL)
	if err != nil {
		return fmt.Errorf("register: license: %w", err)
	}
	if info.Expired {
		return fmt.Errorf("license is expired at %d, please renew your license", info.Payload.ExpiredAt)
	}
	if !info.SiteURLMatches {
		return fmt.Errorf("License site_url %q does not match server %q", info.Payload.SiteURL, a.serverURL)
	}
	return nil
}

func (a *Agent) sysinfoLoop(client *socketio.Client, stop <-chan struct{}) {
	// Send one immediately, then every 10s.
	a.sendSysinfo(client)
	t := time.NewTicker(sysinfoInterval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-client.Done():
			return
		case <-t.C:
			a.sendSysinfo(client)
		}
	}
}

func (a *Agent) sendSysinfo(client *socketio.Client) {
	info := netutil.GetSysInfo()
	a.mu.Lock()
	a.lastSysinfo = &info
	a.mu.Unlock()
	if err := client.Emit("sysinfo", map[string]any{
		"node_id": a.cfg.NodeID,
		"sysinfo": info,
	}); err != nil {
		logx.Debug("sysinfo emit failed", "err", err.Error())
	}
}

// ---------------------------------------------------------------------------
// Inbound events
// ---------------------------------------------------------------------------

// handleConfig decrypts and applies a pushed gost config.
func (a *Agent) handleConfig(args []json.RawMessage) {
	if len(args) == 0 {
		logx.Warn("config event with no payload")
		return
	}
	// The payload is a bare JSON string containing the Fernet token (NOT an array).
	var token string
	if err := json.Unmarshal(args[0], &token); err != nil {
		logx.Error("config: payload is not a string", "err", err.Error())
		return
	}
	plaintext, err := fernet.Decrypt(a.configKey, token)
	if err != nil {
		logx.Error("config: decrypt failed", "err", err.Error())
		return
	}
	n, err := a.runtime.Reload(plaintext)
	if err != nil {
		logx.Error("config: reload failed", "err", err.Error())
		return
	}
	logx.Info("config applied", "services", n)
}

// handleTest performs a TCP reachability probe of host:port.
func (a *Agent) handleTest(args []json.RawMessage) {
	if len(args) < 2 {
		logx.Debug("test: missing args")
		return
	}
	var host, port string
	if err := json.Unmarshal(args[0], &host); err != nil {
		return
	}
	if err := json.Unmarshal(args[1], &port); err != nil {
		return
	}
	target := host
	if !strings.Contains(host, ":") {
		target = host + ":" + port
	}
	c, err := netDial(target, 5*time.Second)
	reachable := err == nil
	if c != nil {
		c.Close()
	}
	logx.Debug("test result", "target", target, "reachable", reachable)
	// The original logs the result; the server does not rely on an ack value.
}

// handlePing logs a server ping (argument is a string).
func (a *Agent) handlePing(args []json.RawMessage) {
	if len(args) == 0 {
		return
	}
	var msg string
	if err := json.Unmarshal(args[0], &msg); err == nil {
		logx.Debug("ping", "msg", msg)
	}
}

// handleUpgrade is a no-op placeholder: the original verifies a minisign
// signature before replacing the binary. Auto-upgrade is intentionally disabled
// here (safer default); it logs the request instead.
func (a *Agent) handleUpgrade(args []json.RawMessage) {
	logx.Info("upgrade requested by server (auto-upgrade disabled in this build)")
}

// ---------------------------------------------------------------------------
// Listen callbacks
// ---------------------------------------------------------------------------

func (a *Agent) onListen(name string, port int, typ string) {
	a.mu.Lock()
	client := a.client
	a.mu.Unlock()
	if client == nil {
		return
	}
	if err := client.Emit("listen", map[string]any{
		"node_id": a.cfg.NodeID,
		"name":    name,
		"port":    port,
		"type":    typ,
	}); err != nil {
		logx.Debug("listen emit failed", "err", err.Error())
	}
}

func (a *Agent) onListenError(name string, errCode string) {
	a.mu.Lock()
	client := a.client
	a.mu.Unlock()
	if client == nil {
		return
	}
	_ = client.Emit("listen_error", map[string]any{
		"node_id": a.cfg.NodeID,
		"name":    name,
		"error":   errCode,
	})
}

// client holds the active Socket.IO client so callbacks can emit.
func (a *Agent) setClient(c *socketio.Client) {
	a.mu.Lock()
	a.client = c
	a.mu.Unlock()
}

func (a *Agent) setRegistered(v bool) {
	a.mu.Lock()
	a.registered = v
	a.mu.Unlock()
}

func (a *Agent) wasRegistered() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.registered
}

// versionString returns the reported agent version.
func versionString() string { return version }

// netDial is a small indirection so the test handler can be unit tested.
var netDial = func(addr string, timeout time.Duration) (net.Conn, error) {
	return net.DialTimeout("tcp", addr, timeout)
}
