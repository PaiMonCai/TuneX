package reporter

import (
	"github.com/tunex/agent/internal/linkrunner"
	"time"
)

func reportedTargetStatus(role string, in []linkrunner.TargetStatus) []linkrunner.TargetStatus {
	if role != "egress" || len(in) > 500 {
		return nil
	}
	out := make([]linkrunner.TargetStatus, 0, len(in))
	seen := map[int64]bool{}
	for _, fact := range in {
		if fact.ForwardID < 1 || fact.ForwardID > 2147483647 || seen[fact.ForwardID] || len(fact.States) < 1 || len(fact.States) > 10 {
			return nil
		}
		seen[fact.ForwardID] = true
		for _, state := range fact.States {
			if fact.LastCheckedAt == nil && state != "unknown" {
				return nil
			}
			switch state {
			case "unknown", "healthy", "suspect", "recovering", "unhealthy":
			default:
				return nil
			}
		}
		for _, index := range []*int{fact.SelectedTCP, fact.SelectedUDP} {
			if index != nil && (*index < 0 || *index >= len(fact.States)) {
				return nil
			}
		}
		switch fact.Reason {
		case "initial", "selected", "target_failed", "target_recovered", "all_unavailable":
		default:
			return nil
		}
		if fact.LastCheckedAt != nil {
			if !trafficAckPattern.MatchString(*fact.LastCheckedAt) {
				return nil
			}
			if _, err := time.Parse(time.RFC3339Nano, *fact.LastCheckedAt); err != nil {
				return nil
			}
		}
		fact.States = append([]string(nil), fact.States...)
		if fact.SelectedTCP != nil {
			n := *fact.SelectedTCP
			fact.SelectedTCP = &n
		}
		if fact.SelectedUDP != nil {
			n := *fact.SelectedUDP
			fact.SelectedUDP = &n
		}
		if fact.LastCheckedAt != nil {
			stamp := *fact.LastCheckedAt
			fact.LastCheckedAt = &stamp
		}
		out = append(out, fact)
	}
	return out
}
