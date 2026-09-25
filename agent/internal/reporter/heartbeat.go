// Package reporter is the agent's outbound telemetry.
//
// WP4 implements the heartbeat only: every 30s the agent POSTs its version,
// role, node id, running tunnels and their ports to the panel, so the panel can
// place the node in the v3 orchestration without polling it. Traffic and metrics
// reporters are later work packages.
//
// Transport contract (devmap §6.1 "内部上报"): the heartbeat is a machine
// endpoint POST <panel>/api/internal/heartbeat, sent by the agent as an
// outbound request (the control transport stays agent-initiated, per the WP6
// rule that no public agent HTTP dependency is introduced).
//
// The post function is injected so unit tests never touch the network.
package reporter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

// Interval is the heartbeat cadence (devmap v0.3: 每 30s 上报一次).
const Interval = 30 * time.Second

// ClientTimeout bounds a single heartbeat POST: a hung panel endpoint must not
// pile up goroutines or delay the next beat by more than one interval.
const ClientTimeout = 10 * time.Second

// HeartbeatPath is the panel endpoint the agent posts to.
const HeartbeatPath = "/api/internal/heartbeat"

// ErrNoPanelURL is returned by Run when no panel URL is configured. A node may
// legitimately run without reporting, so this is a startup decision, not a
// runtime failure.
var ErrNoPanelURL = errors.New("reporter: panel url is not configured")

// ErrAlreadyRunning is returned by Run when a previous Run is still active.
var ErrAlreadyRunning = errors.New("reporter: already running")

// Payload is the heartbeat body. Field names match the panel's Node model so
// the backend can deserialise it directly.
type Payload struct {
	NodeID      string                   `json:"node_id"`
	Version     string                   `json:"version"`
	Role        string                   `json:"role"`
	Timestamp   int64                    `json:"timestamp"`
	Tunnels     []forwarder.TunnelConfig `json:"tunnels,omitempty"`
	EgressPools map[string]EgressPool    `json:"egress_pools,omitempty"`
}

// EgressPool is the reported target pool of one egress tunnel.
type EgressPool struct {
	Strategy string   `json:"strategy"`
	Targets  []string `json:"targets"`
}

// The sources the reporter reads from. manager.TunnelManager satisfies
// TunnelLister directly; main adapts EgressManager (its Snapshot returns
// manager.PoolSnapshot, which maps 1:1 onto EgressPool).
type (
	TunnelLister interface {
		List() []forwarder.TunnelConfig
	}
	EgressLister interface {
		Snapshot() map[string]EgressPool
	}
)

// Reporter periodically reports the node's heartbeat.
type Reporter struct {
	cfg Config

	mu   sync.Mutex
	stop chan struct{}
}

// Config configures the reporter.
type Config struct {
	PanelURL string // e.g. "http://panel:3001"; empty disables reporting
	NodeID   string
	Version  string
	Role     string

	tunnels TunnelLister
	egress  EgressLister

	// post overrides the HTTP call (tests). Defaults to httpPost.
	post func(ctx context.Context, url string, body []byte) error
	// now overrides time.Now (tests).
	now func() time.Time
}

// Option customises the reporter.
type Option func(*Config)

// WithTunnels sets the running-tunnel source.
func WithTunnels(t TunnelLister) Option { return func(c *Config) { c.tunnels = t } }

// WithEgress sets the egress-pool source.
func WithEgress(e EgressLister) Option { return func(c *Config) { c.egress = e } }

// WithPost replaces the HTTP transport (tests).
func WithPost(fn func(ctx context.Context, url string, body []byte) error) Option {
	return func(c *Config) { c.post = fn }
}

// WithClock replaces the clock (tests).
func WithNow(now func() time.Time) Option { return func(c *Config) { c.now = now } }

// New builds a reporter with options applied after cfg.
func New(cfg Config, opts ...Option) *Reporter {
	for _, o := range opts {
		o(&cfg)
	}
	if cfg.post == nil {
		cfg.post = httpPost
	}
	if cfg.now == nil {
		cfg.now = time.Now
	}
	return &Reporter{cfg: cfg}
}

// Endpoint returns the full heartbeat URL, or "" when reporting is disabled.
func (r *Reporter) Endpoint() string {
	base := strings.TrimRight(strings.TrimSpace(r.cfg.PanelURL), "/")
	if base == "" {
		return ""
	}
	return base + HeartbeatPath
}

// Payload builds the current heartbeat body.
func (r *Reporter) Payload() Payload {
	p := Payload{
		NodeID:    r.cfg.NodeID,
		Version:   r.cfg.Version,
		Role:      r.cfg.Role,
		Timestamp: r.cfg.now().Unix(),
	}
	if r.cfg.tunnels != nil {
		p.Tunnels = r.cfg.tunnels.List()
	}
	if r.cfg.egress != nil {
		p.EgressPools = r.cfg.egress.Snapshot()
	}
	return p
}

// Run blocks, sending a heartbeat every Interval until ctx is cancelled or Stop
// is called. The first beat goes out immediately so the panel sees the node
// right after a restart (devmap §5.5: 节点重启 → 启动时拉取 ACTIVE 隧道).
//
// A failed beat is dropped and retried on the next tick; reporting never makes
// the agent exit. Returns ErrNoPanelURL immediately when reporting is off, and
// ErrAlreadyRunning if Run is called twice.
func (r *Reporter) Run(ctx context.Context) error {
	if r.Endpoint() == "" {
		return ErrNoPanelURL
	}
	r.mu.Lock()
	if r.stop != nil {
		r.mu.Unlock()
		return ErrAlreadyRunning
	}
	r.stop = make(chan struct{})
	stop := r.stop
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		r.stop = nil
		r.mu.Unlock()
	}()

	t := time.NewTicker(Interval)
	defer t.Stop()

	r.send(ctx)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-stop:
			return nil
		case <-t.C:
			r.send(ctx)
		}
	}
}

// send posts one heartbeat, best effort: a transport failure is intentionally
// swallowed here (the agent's own logging happens inside the post hook) because
// a flaky panel must never cascade into the node's data plane.
func (r *Reporter) send(ctx context.Context) {
	body, err := json.Marshal(r.Payload())
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, ClientTimeout)
	defer cancel()
	_ = r.cfg.post(ctx, r.Endpoint(), body)
}

// Stop makes a running Run return. Safe before/after Run and more than once.
func (r *Reporter) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stop != nil {
		close(r.stop)
		r.stop = nil
	}
}

// httpPost is the default transport: POST the payload as JSON and treat any
// 3xx/4xx/5xx as an error so the caller can decide to log it.
func httpPost(ctx context.Context, url string, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("heartbeat post %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("heartbeat post %s: status %d", url, resp.StatusCode)
	}
	return nil
}
