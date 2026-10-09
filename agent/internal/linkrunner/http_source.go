package linkrunner

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var (
	ErrPanelUnavailable  = errors.New("linkrunner: panel unavailable")
	ErrPanelUnauthorized = errors.New("linkrunner: panel authorization refused")
	ErrSnapshot          = errors.New("linkrunner: invalid link snapshot")
)

// Snapshot uses the existing desired endpoint, with links separated from the
// legacy tunnels. NodeDBID is Panel-authenticated numeric identity; AgentNodeID
// (a UUID or display key) is never parsed into a DB id.
type Snapshot struct {
	NodeDBID int64    `json:"node_db_id"`
	AgentID  string   `json:"agent_id,omitempty"`
	Links    []Config `json:"links"`
}

type HTTPSource struct {
	PanelURL, Credential, AgentID string
	Client                        *http.Client
	MaxBytes                      int64
}

func (s HTTPSource) FetchSnapshot(ctx context.Context) (*Snapshot, error) {
	base := strings.TrimRight(strings.TrimSpace(s.PanelURL), "/")
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.TrimSpace(s.Credential) == "" {
		return nil, ErrSnapshot
	}
	client := http.Client{Timeout: 12 * time.Second}
	if s.Client != nil {
		client = *s.Client
	}
	if client.Timeout == 0 {
		client.Timeout = 12 * time.Second
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/internal/node/desired", nil)
	if err != nil {
		return nil, ErrSnapshot
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(s.Credential))
	resp, err := client.Do(req)
	if err != nil {
		return nil, ErrPanelUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		return nil, ErrPanelUnavailable
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 || resp.StatusCode == 404 {
		return nil, ErrPanelUnauthorized
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, ErrSnapshot
	}
	limit := s.MaxBytes
	if limit <= 0 || limit > maxCacheBytes {
		limit = maxCacheBytes
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, ErrPanelUnavailable
	}
	if int64(len(data)) > limit {
		return nil, ErrSnapshot
	}
	var env struct {
		Data *struct {
			Snapshot *struct {
				NodeDBID int64     `json:"node_db_id"`
				AgentID  string    `json:"agent_id"`
				Links    *[]Config `json:"links"`
			} `json:"snapshot"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &env) != nil || env.Data == nil || env.Data.Snapshot == nil || env.Data.Snapshot.Links == nil || env.Data.Snapshot.NodeDBID <= 0 || len(*env.Data.Snapshot.Links) > maxRecords {
		return nil, ErrSnapshot
	}
	wire := env.Data.Snapshot
	if wire.AgentID != "" && wire.AgentID != s.AgentID {
		return nil, ErrAgentMismatch
	}
	snapshot := &Snapshot{NodeDBID: wire.NodeDBID, AgentID: wire.AgentID, Links: *wire.Links}
	if err := snapshot.validate(); err != nil {
		return nil, err
	}
	return snapshot, nil
}

func (s *Snapshot) validate() error {
	if s == nil || s.NodeDBID <= 0 || len(s.Links) > maxRecords {
		return ErrSnapshot
	}
	seen := make(map[string]bool)
	for i := range s.Links {
		cfg := &s.Links[i]
		if cfg.NodeID != s.NodeDBID || seen[cfg.ID] {
			return ErrIdentityMismatch
		}
		if _, _, err := validateConfig(cfg); err != nil {
			return err
		}
		seen[cfg.ID] = true
	}
	return nil
}

// NodeDBID is zero until an authenticated snapshot has bound this cache to a
// Panel numeric node. It survives offline restart inside the encrypted cache.
func (m *Manager) NodeDBID() int64 { m.mu.Lock(); defer m.mu.Unlock(); return m.cache.nodeDBID }

func (m *Manager) bindNode(snapshot *Snapshot) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ErrClosed
	}
	if m.cacheErr != nil {
		return m.cacheErr
	}
	if snapshot.AgentID != "" && snapshot.AgentID != m.cache.agentID {
		return ErrAgentMismatch
	}
	if m.cache.nodeDBID != 0 && m.cache.nodeDBID != snapshot.NodeDBID {
		return ErrIdentityMismatch
	}
	for _, r := range m.records {
		if r.NodeID != 0 && r.NodeID != snapshot.NodeDBID {
			return ErrIdentityMismatch
		}
	}
	m.cache.nodeDBID = snapshot.NodeDBID
	if err := m.cache.save(m.records); err != nil {
		m.cacheErr = ErrCache
		for id := range m.running {
			_ = m.stopLocked(id)
		}
		return ErrCache
	}
	return nil
}

// Reconcile applies a whole, authenticated snapshot and removes omitted ids at
// their current durable generation. Missing links is never an empty snapshot.
func (m *Manager) Reconcile(snapshot *Snapshot) ([]Observation, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if err := snapshot.validate(); err != nil {
		return m.Status(), err
	}
	if err := m.bindNode(snapshot); err != nil {
		return m.Status(), err
	}
	seen := make(map[string]bool)
	var failures []error
	for _, cfg := range snapshot.Links {
		seen[cfg.ID] = true
		if _, err := m.apply(cfg); err != nil {
			failures = append(failures, err)
		}
	}
	for _, o := range m.Status() {
		if !seen[o.ID] && o.State != "removed" {
			if _, err := m.remove(o.ID, o.Generation); err != nil {
				failures = append(failures, err)
			}
		}
	}
	return m.Status(), errors.Join(failures...)
}
