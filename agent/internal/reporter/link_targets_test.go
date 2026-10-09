package reporter

import (
	"github.com/tunex/agent/internal/linkrunner"
	"testing"
)

func TestTargetReportIsClosedOwnedAndCopiesPointers(t *testing.T) {
	index := 1
	stamp := "2026-10-08T12:00:00Z"
	in := []linkrunner.TargetStatus{{ForwardID: 101, States: []string{"unhealthy", "healthy"}, SelectedTCP: &index, LastCheckedAt: &stamp, Reason: "target_failed"}}
	out := reportedTargetStatus("egress", in)
	if len(out) != 1 || out[0].States[1] != "healthy" {
		t.Fatal(out)
	}
	*out[0].SelectedTCP = 0
	*out[0].LastCheckedAt = "changed"
	out[0].States[1] = "unknown"
	if index != 1 || stamp != "2026-10-08T12:00:00Z" || in[0].States[1] != "healthy" {
		t.Fatal("mutable provider alias")
	}
	if reportedTargetStatus("ingress", in) != nil {
		t.Fatal("ingress claims target-side health")
	}
	in[0].LastCheckedAt = nil
	if reportedTargetStatus("egress", in) != nil {
		t.Fatal("known health without observation time propagated")
	}
	in[0].LastCheckedAt = &stamp
	in[0].States[1] = "secret"
	if reportedTargetStatus("egress", in) != nil {
		t.Fatal("unknown states propagated")
	}
}
