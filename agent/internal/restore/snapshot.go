package restore

import (
	"errors"
	"fmt"
	"strings"

	"github.com/tunex/agent/internal/forwarder"
)

// ErrMalformedSnapshot is the "the panel's answer is not a snapshot" sentinel.
// It is deliberately distinct from ErrNoPanel and from an empty tunnel list.
var ErrMalformedSnapshot = errors.New("restore: malformed desired snapshot")

// decodeSnapshot converts the panel's wire payload into the internal snapshot.
//
// A tunnel the agent cannot even parse (empty id, unknown mode) is a contract
// violation, not a partial success: accepting it would apply a config the panel
// never described. Per-tunnel *apply* failures are handled later and separately
// by Apply, which keeps "unreadable" and "could not bind" from being confused.
func decodeSnapshot(version string, tunnels []tunnelPayload) (*Snapshot, error) {
	snap := &Snapshot{Version: version, Tunnels: make([]forwarder.TunnelConfig, 0, len(tunnels))}
	for i, t := range tunnels {
		id := strings.TrimSpace(t.ID)
		if id == "" {
			return nil, fmt.Errorf("%w: tunnel %d has no id", ErrMalformedSnapshot, i)
		}
		mode, err := forwarder.ParseTunnelMode(t.Mode)
		if err != nil {
			return nil, fmt.Errorf("%w: tunnel %s: %v", ErrMalformedSnapshot, id, err)
		}
		protocol, err := forwarder.ParseForwardProtocol(t.Protocol)
		if err != nil {
			return nil, fmt.Errorf("%w: tunnel %s: %v", ErrMalformedSnapshot, id, err)
		}
		cfg := forwarder.TunnelConfig{
			ID:          id,
			Mode:        mode,
			IngressPort: t.IngressPort,
			EgressPort:  t.EgressPort,
			RemoteHost:  t.RemoteHost,
			RemotePort:  t.RemotePort,
			NextHop:     t.NextHop,
			LBStrategy:  forwarder.LBStrategy(t.LBStrategy),
			Protocol:    protocol,
			SpeedLimit:  t.SpeedLimit,
			Revision:    t.Revision,
			ListenHost:  t.ListenHost,
		}
		for _, tg := range t.Targets {
			cfg.Targets = append(cfg.Targets, forwarder.Target{
				Host: tg.Host, Port: tg.Port, Weight: tg.Weight, Order: tg.Order, Remark: tg.Remark,
			})
		}
		snap.Tunnels = append(snap.Tunnels, cfg)
	}
	if err := snap.Validate(); err != nil {
		return nil, err
	}
	return snap, nil
}

// MaxSnapshotTargetsPerTunnel bounds one tunnel's target pool in a snapshot.
// It is separate from the tunnel ceiling: a single EGRESS pool with thousands of
// entries is a different failure than a snapshot with thousands of tunnels.
const MaxSnapshotTargetsPerTunnel = 64

// validVersion accepts a bounded identifier (no whitespace, no path or shell
// metacharacters). The cache and the panel both write this field, and it ends up
// in log lines and evidence, so free-form text is not acceptable.
func validVersion(v string) bool {
	if v == "" || len(v) > 64 || strings.TrimSpace(v) != v {
		return false
	}
	for _, r := range v {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.' || r == '_' || r == '-' || r == '+':
		default:
			return false
		}
	}
	return true
}

// Validate checks a snapshot for the invariants every consumer relies on: a
// version tag, a readable mode and a transport-usable identity per tunnel, and
// the size/tunnel ceilings. It is used for the local cache (which is untrusted
// disk input) and is cheap enough to reuse on fetched payloads.
func (s *Snapshot) Validate() error {
	if s == nil {
		return ErrMalformedSnapshot
	}
	// The version is a bounded identifier, not free-form text. Cache format
	// compatibility is separately enforced by schema_version on disk.
	if !validVersion(s.Version) {
		return fmt.Errorf("%w: invalid version", ErrMalformedSnapshot)
	}
	if len(s.Tunnels) > MaxSnapshotTunnels {
		return fmt.Errorf("%w: %d tunnels exceeds %d", ErrMalformedSnapshot, len(s.Tunnels), MaxSnapshotTunnels)
	}
	seen := make(map[string]bool, len(s.Tunnels))
	for i := range s.Tunnels {
		cfg := s.Tunnels[i].Clone()
		if strings.TrimSpace(cfg.ID) == "" || strings.TrimSpace(cfg.ID) != cfg.ID || len(cfg.ID) > 255 {
			return fmt.Errorf("%w: tunnel %d has invalid id", ErrMalformedSnapshot, i)
		}
		if seen[cfg.ID] {
			return fmt.Errorf("%w: duplicate tunnel id %q", ErrMalformedSnapshot, cfg.ID)
		}
		seen[cfg.ID] = true
		// Durable desired state is revisioned; legacy revision=0 must not bypass
		// stale protection when replayed from disk after an outage.
		if cfg.Revision <= 0 || cfg.Revision > 2147483647 {
			return fmt.Errorf("%w: tunnel %q has invalid revision", ErrMalformedSnapshot, cfg.ID)
		}
		if cfg.SpeedLimit < 0 || len(cfg.Targets) > MaxSnapshotTargetsPerTunnel {
			return fmt.Errorf("%w: tunnel %q exceeds config bounds", ErrMalformedSnapshot, cfg.ID)
		}
		if err := cfg.Validate(); err != nil {
			return fmt.Errorf("%w: tunnel %q: %v", ErrMalformedSnapshot, cfg.ID, err)
		}
	}
	return nil
}

// Clone returns a deep copy so a caller cannot mutate what the cache stored.
func (s *Snapshot) Clone() *Snapshot {
	if s == nil {
		return nil
	}
	out := &Snapshot{Version: s.Version, Tunnels: make([]forwarder.TunnelConfig, 0, len(s.Tunnels))}
	for _, cfg := range s.Tunnels {
		out.Tunnels = append(out.Tunnels, cfg.Clone())
	}
	return out
}

// IDSet returns the tunnel ids in the snapshot.
func (s *Snapshot) IDSet() map[string]bool {
	if s == nil {
		return map[string]bool{}
	}
	out := make(map[string]bool, len(s.Tunnels))
	for _, cfg := range s.Tunnels {
		out[cfg.ID] = true
	}
	return out
}
