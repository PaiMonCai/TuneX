package reporter

import "github.com/tunex/agent/internal/linkrunner"

// LinkPlacement is the closed, secret-free runtime fact sent to the panel.
// It is deliberately separate from Observation, which also contains child logs.
type LinkPlacement struct {
	ID                  string              `json:"id"`
	LinkID              int64               `json:"link_id"`
	WorkspaceID         int64               `json:"workspace_id"`
	NodeID              int64               `json:"node_id"`
	Role                string              `json:"role"`
	Generation          int64               `json:"generation"`
	ObservedGeneration  int64               `json:"observed_generation"`
	ConfigDigest        string              `json:"config_digest"`
	DesiredConfigDigest string              `json:"desired_config_digest"`
	Ready               bool                `json:"ready"`
	State               string              `json:"state"`
	LeaseExpiresAt      string              `json:"lease_expires_at"`
	Ports               []LinkPlacementPort `json:"ports"`
	RuntimeIDs          []string            `json:"runtime_ids"`
}

type LinkPlacementPort struct {
	Protocol string `json:"protocol"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
}

// WithLinkPlacements reads an in-memory runtime snapshot on each report.
// Runtime wiring: reporter.WithLinkPlacements(rt.links.Status).
// A nil provider (or nil snapshot) makes no claim; an empty snapshot is [].
func WithLinkPlacements(provider func() []linkrunner.Observation) Option {
	return func(c *Config) { c.linkPlacements = provider }
}

func reportedLinkPlacements(in []linkrunner.Observation) *[]LinkPlacement {
	if in == nil {
		return nil
	}
	out := make([]LinkPlacement, 0, len(in))
	for _, o := range in {
		// Unknown remove-command fences have no tenant/placement identity and
		// cannot be reported as an owned runtime fact.
		if o.ID == "" || o.LinkID <= 0 || o.WorkspaceID <= 0 || o.NodeID <= 0 || o.Generation <= 0 {
			continue
		}
		ports := make([]LinkPlacementPort, len(o.Ports))
		for i, p := range o.Ports {
			ports[i] = LinkPlacementPort{Protocol: p.Protocol, Host: p.Host, Port: p.Port}
		}
		runtimeIDs := append(make([]string, 0, len(o.RuntimeIDs)), o.RuntimeIDs...)
		out = append(out, LinkPlacement{
			ID: o.ID, LinkID: o.LinkID, WorkspaceID: o.WorkspaceID, NodeID: o.NodeID,
			Role: o.Role, Generation: o.Generation, ObservedGeneration: o.ObservedGeneration,
			ConfigDigest: o.ConfigDigest, DesiredConfigDigest: o.DesiredConfigDigest,
			Ready: o.Ready, State: o.State, LeaseExpiresAt: o.LeaseExpiresAt,
			Ports: ports, RuntimeIDs: runtimeIDs,
		})
	}
	return &out
}
