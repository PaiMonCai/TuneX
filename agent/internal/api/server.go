// Package api is the agent's local HTTP management plane.
//
// The panel (or an operator on the node) drives the agent over
//
//	POST   /tunnel             apply a tunnel (create / replace, with revision)
//	DELETE /tunnel?id=<id>     remove a tunnel
//	PATCH  /node/targets       hot-update one tunnel's egress target pool
//	GET    /health             version / role / ports / egress pools
//
// Mutating routes require a bearer token; by default the server binds to
// loopback (127.0.0.1:9090 — the v3 deployment layout's admin port, separate
// from the data-plane range).
//
// WP4 scope ends here: the routes call TunnelManager/EgressManager and report
// state. The final panel orchestration (WP6 command/revision/ACK contract and
// its outbound transport) is deliberately not wired in, and no Prisma model is
// referenced — the node state shape is a plain struct the later WP6 layer can
// serialise.
//
// Standard-library only, so the agent keeps building fully offline.
package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/manager"
)

// DefaultPort is the admin port from the v3 deployment layout (agent port 9090,
// internal reporting port 9191).
const DefaultPort = 9090

// DefaultHost keeps the admin plane off the public interface unless an operator
// explicitly widens it (e.g. for a container healthcheck).
const DefaultHost = "127.0.0.1"

// Server timeouts stop a stray connection from pinning a goroutine forever
// (Slowloris hardening on an endpoint that can mutate tunnels).
const (
	readHeaderTimeout = 5 * time.Second
	readTimeout       = 30 * time.Second
	writeTimeout      = 30 * time.Second
	idleTimeout       = 90 * time.Second
)

// maxBodyBytes caps a command payload: a tunnel config is a few hundred bytes,
// so anything near this is malformed or hostile.
const maxBodyBytes = 1 << 20

// Options configures the admin server.
type Options struct {
	ListenHost string // default 127.0.0.1
	Port       int    // default 9090
	Token      string // required bearer token
	NodeID     string // reported by /health
	Version    string // reported by /health
	Role       string // reported by /health
}

// NodeState is the /health payload. Field names match the panel's Node model
// (snake_case) so a state_request reply can forward this shape unchanged.
type NodeState struct {
	Version   string                          `json:"version"`
	NodeID    string                          `json:"node_id"`
	Role      string                          `json:"role"`
	Tunnels   []forwarder.TunnelConfig        `json:"tunnels"`
	UsedPorts []int                           `json:"used_ports"`
	Egress    map[string]manager.PoolSnapshot `json:"egress_pools,omitempty"`
}

// StateFunc builds the node snapshot. main wires it to the running managers;
// tests supply a stub.
type StateFunc func() NodeState

// Server is the agent's admin HTTP plane.
type Server struct {
	opts    Options
	tunnels *manager.TunnelManager
	egress  *manager.EgressManager
	state   StateFunc

	mu  sync.Mutex
	srv *http.Server
	ln  net.Listener
}

// New builds an admin server over the given managers. tunnels is required;
// egress may be nil on a pure ingress node (PATCH /node/targets is then
// rejected). The token must be non-empty: an unauthenticated management plane
// is never an acceptable default.
func New(opts Options, tunnels *manager.TunnelManager, egress *manager.EgressManager, state StateFunc) (*Server, error) {
	if tunnels == nil {
		return nil, errors.New("api: tunnel manager is required")
	}
	if opts.Port == 0 {
		opts.Port = DefaultPort
	}
	if opts.ListenHost == "" {
		opts.ListenHost = DefaultHost
	}
	if strings.TrimSpace(opts.Token) == "" {
		return nil, errors.New("api: a bearer token is required (AGENT_ADMIN_TOKEN)")
	}
	return &Server{opts: opts, tunnels: tunnels, egress: egress, state: state}, nil
}

// ListenAddr is the "host:port" the server binds.
func (s *Server) ListenAddr() string {
	return net.JoinHostPort(s.opts.ListenHost, strconv.Itoa(s.opts.Port))
}

// Handler builds the route table. Exported so tests can mount it on an
// httptest server without binding the real admin port.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/tunnel", s.withAuth(s.handleTunnel))
	mux.HandleFunc("/tunnel/", s.withAuth(s.handleTunnel))
	mux.HandleFunc("/node/targets", s.withAuth(s.handleTargets))
	return mux
}

// Start binds the admin port and serves until Stop. Idempotent-safe: a second
// call while running returns ErrAlreadyStarted.
func (s *Server) Start() error {
	ln, err := net.Listen("tcp", s.ListenAddr())
	if err != nil {
		return err
	}
	return s.StartOn(ln)
}

// StartOn serves on an existing listener (tests use this with an ephemeral
// port; it also lets an operator hand over a pre-bound socket).
func (s *Server) StartOn(ln net.Listener) error {
	s.mu.Lock()
	if s.srv != nil {
		s.mu.Unlock()
		return forwarder.ErrAlreadyStarted
	}
	s.srv = &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
	}
	s.ln = ln
	s.mu.Unlock()

	go func() { _ = s.srv.Serve(ln) }()
	return nil
}

// Stop closes the listener. It is safe to call before Start and more than once.
func (s *Server) Stop() error {
	s.mu.Lock()
	srv := s.srv
	s.srv = nil
	s.ln = nil
	s.mu.Unlock()
	if srv == nil {
		return nil
	}
	return srv.Close()
}

// Running reports whether the admin plane is serving.
func (s *Server) Running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.srv != nil
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

// withAuth requires the configured bearer token on h.
func (s *Server) withAuth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, s.opts.Token) {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		h(w, r)
	}
}

// authorized checks the bearer token in constant time. Both
// "Authorization: Bearer <token>" and a bare "<token>" are accepted; anything
// else (missing, wrong scheme, wrong value) is rejected.
func authorized(r *http.Request, want string) bool {
	if want == "" {
		// An unconfigured server refuses everything (New rejects this, but a
		// directly-constructed Server in a test should fail closed too).
		return false
	}
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	if h == "" {
		return false
	}
	token := h
	if lower := strings.ToLower(h); strings.HasPrefix(lower, "bearer ") {
		token = strings.TrimSpace(h[len("bearer "):])
	}
	if token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(want)) == 1
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

func (s *Server) handleTunnel(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		s.handleApplyTunnel(w, r)
	case http.MethodDelete:
		s.handleRemoveTunnel(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// applyRequest accepts both the nested TunnelConfig shape and a flat payload
// carrying "revision" next to the tunnel fields (the WP6 command envelope).
type applyRequest struct {
	forwarder.TunnelConfig
	Revision int64 `json:"revision"`
}

func (s *Server) handleApplyTunnel(w http.ResponseWriter, r *http.Request) {
	body, err := readLimited(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req applyRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid tunnel json: "+err.Error())
		return
	}
	cfg := req.TunnelConfig
	if cfg.Revision == 0 {
		cfg.Revision = req.Revision
	}

	// Route by the hot-reload plan (WP2, DEVELOPMENT.md §13.3.4): a command
	// that moves the listener must not drop live connections, and a command
	// that only moves the upstream must not rebuild the forwarder at all.
	// ReplaceListener makes both decisions inside the manager, against the
	// config the node is actually running, under the manager's lock — the
	// same routing the panel's apply_tunnel command gets. Applying the plan
	// here as well would freeze a classification the running config may
	// already have contradicted, and it would give the two apply surfaces
	// two places to keep in sync.
	if _, err := s.tunnels.ReplaceListener(cfg); err != nil {
		if errors.Is(err, manager.ErrStaleRevision) {
			// The panel must reject this command rather than retry it.
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeOK(w, map[string]any{"ok": true, "id": cfg.ID, "revision": cfg.Revision})
}

func (s *Server) handleRemoveTunnel(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		// Also accept DELETE /tunnel/<id>.
		trimmed := strings.Trim(r.URL.Path, "/")
		if i := strings.LastIndex(trimmed, "/"); i >= 0 {
			id = trimmed[i+1:]
		}
	}
	if id == "" || id == "tunnel" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	if err := s.tunnels.Remove(id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeOK(w, map[string]any{"ok": true, "id": id})
}

// targetsRequest is the PATCH /node/targets body.
type targetsRequest struct {
	TunnelID string             `json:"tunnel_id"`
	Strategy manager.Strategy   `json:"strategy"`
	Targets  []forwarder.Target `json:"targets"`
}

func (s *Server) handleTargets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch && r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.egress == nil {
		writeError(w, http.StatusBadRequest, "node has no egress target pools")
		return
	}
	body, err := readLimited(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req targetsRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid targets json: "+err.Error())
		return
	}
	if strings.TrimSpace(req.TunnelID) == "" {
		writeError(w, http.StatusBadRequest, "tunnel_id is required")
		return
	}
	if err := s.egress.UpdateTargets(req.TunnelID, req.Strategy, req.Targets); err != nil {
		if errors.Is(err, manager.ErrPoolNotFound) {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeOK(w, map[string]any{"ok": true, "tunnel_id": req.TunnelID})
}

// handleHealth reports the node snapshot. It is unauthenticated by design (the
// panel's health probe and an operator's curl both need it without a token) and
// leaks no secrets — only version, role, tunnel ids, ports and pool addresses.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var st NodeState
	if s.state != nil {
		st = s.state()
	} else {
		st = s.snapshot()
	}
	writeOK(w, st)
}

// snapshot builds the node state straight from the managers.
func (s *Server) snapshot() NodeState {
	st := NodeState{
		Version: s.opts.Version,
		NodeID:  s.opts.NodeID,
		Role:    s.opts.Role,
		Tunnels: s.tunnels.List(),
	}
	for p := range s.tunnels.UsedPorts() {
		st.UsedPorts = append(st.UsedPorts, p)
	}
	sort.Ints(st.UsedPorts)
	if s.egress != nil {
		st.Egress = s.egress.Snapshot()
	}
	return st
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// readLimited reads at most maxBodyBytes from r and rejects an empty body.
func readLimited(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, errors.New("request body is required")
	}
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return nil, errors.New("request body is required")
	}
	return body, nil
}

func writeOK(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": msg})
}
