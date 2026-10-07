package reporter

import (
	"regexp"
	"time"

	"github.com/tunex/agent/internal/linkrunner"
)

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
	TrafficStatus       *LinkTrafficStatus  `json:"traffic_status,omitempty"`
}

// LinkTrafficStatus is a closed copy of the in-memory capacity observation.
// LastAckAt is a durable statistics receipt, never evidence of runtime Ready.
type LinkTrafficStatus struct {
	RotationSupported bool    `json:"rotation_supported"`
	ProducerCount     int     `json:"producer_count"`
	SampleCount       int     `json:"sample_count"`
	RuleCount         int     `json:"rule_count"`
	SpoolBytes        int64   `json:"spool_bytes"`
	LastAckAt         *string `json:"last_ack_at"`
	State             string  `json:"state"`
}

var trafficAckPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$`)

func reportedTrafficStatus(in *linkrunner.TrafficStatus) *LinkTrafficStatus {
	if in == nil || in.ProducerCount < 0 || in.ProducerCount > 128 ||
		in.SampleCount < 0 || in.SampleCount > 262144 || in.RuleCount < 0 || in.RuleCount > 262144 ||
		in.SpoolBytes < 0 || in.SpoolBytes > 403701760 {
		return nil
	}
	switch in.State {
	case "idle", "collecting", "backlogged", "blocked":
	default:
		return nil
	}
	var ack *string
	if in.LastAckAt != nil {
		if !trafficAckPattern.MatchString(*in.LastAckAt) {
			return nil
		}
		if _, err := time.Parse(time.RFC3339Nano, *in.LastAckAt); err != nil {
			return nil
		}
		value := *in.LastAckAt
		ack = &value
	}
	return &LinkTrafficStatus{RotationSupported: in.RotationSupported, ProducerCount: in.ProducerCount,
		SampleCount: in.SampleCount, RuleCount: in.RuleCount, SpoolBytes: in.SpoolBytes, LastAckAt: ack, State: in.State}
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
			TrafficStatus: reportedTrafficStatus(o.TrafficStatus),
		})
	}
	return &out
}
