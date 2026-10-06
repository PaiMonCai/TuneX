package control

import (
	"context"
	"github.com/tunex/agent/internal/diag"
	"slices"
	"strings"
	"testing"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/manager"
	"github.com/tunex/agent/internal/selfinfo"
)

// configStub is a deliberately INVALID DIRECT config (ingress_port 0): reaching
// the apply arm must not bind a port in a unit test, and the arm is still proven
// to exist because the answer is an apply failure rather than unsupported_action.
var configStub = forwarder.TunnelConfig{
	ID:          "tunex-1-direct",
	Mode:        forwarder.ModeDirect,
	IngressPort: 0,
	RemoteHost:  "127.0.0.1",
	RemotePort:  9,
	Protocol:    "tcp",
	Revision:    3,
}

// The advertised capability list is only useful if it describes the same set of
// actions execute() really dispatches. These tests drive the switch directly, so
// a new action added to one side and not the other fails here rather than in
// production (where the symptom would be a command timeout the panel diagnoses
// as a network problem).

func newTestClient(t *testing.T) *Client {
	t.Helper()
	egress := manager.NewEgressManager()
	return New(Config{
		PanelURL:   "http://panel.invalid",
		Credential: "cred",
		// Production wires the real describer in v3runtime; the contract test
		// needs the arm reachable so "advertised implies implemented" is checked
		// against the dispatch switch rather than against a wiring detail.
		DescribeSelf: func() selfinfo.Facts { return selfinfo.Facts{Version: "test"} },
	}, manager.NewTunnelManager(egress, "127.0.0.1"), egress)
}

// advertisedDispatches asserts that execute answers something other than
// `unsupported_action` for the action. The command payload is intentionally
// minimal: what matters is whether the dispatch arm exists at all.
func advertisedDispatches(t *testing.T, action string, cmd *QueuedCommand) bool {
	t.Helper()
	ack := newTestClient(t).execute(context.Background(), cmd)
	return ack.ErrorCode != "unsupported_action"
}

func TestAdvertisedCapabilitiesMatchExecute(t *testing.T) {
	// `Capabilities()` 里有两类条目，语义不同：
	//   · 动作（advertisedActions）—— 面板可以下发它，Agent 必须能执行；
	//   · 方法级标注（`looking_glass:<method>`）—— 同**一个动作内部**的方法维，
	//     它回答的是"这个节点能不能真的执行该方法"（镜像有没有二进制、内核允不允许
	//     非特权 ICMP），面板据此算 caps.methods。它不是一个动作，因此不在这里断言
	//     "execute 认识它"，而在下面单独钉住它的形状与闭集。
	for _, action := range Capabilities() {
		if isMethodAnnotation(action) {
			continue
		}
		cmd := &QueuedCommand{Envelope: Envelope{
			CommandID:  "cmd-" + action,
			ResourceID: "tunex-1-direct",
			Revision:   3,
			Action:     action,
		}}
		if action == ActionApplyTunnel {
			// A minimal DIRECT config so the apply arm is reached and fails on
			// something other than "unsupported".
			cmd.Config = &configStub
		}
		if !advertisedDispatches(t, action, cmd) {
			t.Fatalf("action %q is advertised but execute answers unsupported_action", action)
		}
	}
}

// isMethodAnnotation 识别 `looking_glass:<method>` 形态的方法级标注。
func isMethodAnnotation(capability string) bool {
	return len(capability) > len(ActionLookingGlass)+1 && capability[:len(ActionLookingGlass)+1] == ActionLookingGlass+":"
}

// TestMethodAnnotationsAreHonest 钉住方法级标注的**诚实性**：只标注本二进制真的实现的
// 方法，且当且仅当本节点真的能执行时（不可用时不标注 —— 这就是"不假装支持"的机制）。
func TestMethodAnnotationsAreHonest(t *testing.T) {
	annotations := map[string]bool{}
	for _, capability := range Capabilities() {
		if !isMethodAnnotation(capability) {
			continue
		}
		method := capability[len(ActionLookingGlass)+1:]
		annotations[method] = true
		if !slices.Contains(diag.SupportedLookingGlassMethods(), method) {
			t.Fatalf("标注了本二进制没实现的方法 %q", method)
		}
	}
	// mtr/mtr6 永不标注（镜像无二进制 + 需要 raw socket）。
	for _, forbidden := range []string{"mtr", "mtr6"} {
		if annotations[forbidden] {
			t.Fatalf("%q 不该被标注：本节点无法执行它", forbidden)
		}
	}
	// 标注集合必须与"逐节点可用性枚举"逐条对齐（可用者标注、不可用者不标注）。
	for _, availability := range diag.DetectLookingGlassMethods() {
		want := availability.Reason == ""
		got := annotations[availability.Method]
		if availability.Method == diag.LookingGlassMethodTCPConnect {
			// tcp_connect 是动作本身（`looking_glass`），不需要方法级标注。
			continue
		}
		if got != want {
			t.Fatalf("方法 %q 标注=%v，但本节点可用性=%v（%s）", availability.Method, got, want, availability.Reason)
		}
	}
}

func TestUnadvertisedActionIsRejected(t *testing.T) {
	// A contract action this binary does NOT implement. The panel's negotiation
	// gate should refuse to send it; if one arrives anyway the agent must still
	// answer `unsupported_action` instead of guessing.
	for _, action := range []string{"update_targets", "state_request", "diagnose_forward", "drain_node"} {
		if Implements(action) {
			t.Fatalf("%q must not be advertised: this binary does not implement it", action)
		}
		ack := newTestClient(t).execute(context.Background(), &QueuedCommand{Envelope: Envelope{
			CommandID:  "cmd-x",
			ResourceID: "tunex-1-direct",
			Revision:   1,
			Action:     action,
		}})
		if ack.ErrorCode != "unsupported_action" {
			t.Fatalf("action %q must answer unsupported_action, got %q (%s)", action, ack.ErrorCode, ack.Error)
		}
		if ack.OK {
			t.Fatalf("action %q must not report success", action)
		}
	}
}

func TestCapabilitiesIsASortedCopy(t *testing.T) {
	first := Capabilities()
	if len(first) == 0 {
		t.Fatal("an agent must advertise at least the baseline actions")
	}
	for i := 1; i < len(first); i++ {
		if first[i-1] >= first[i] {
			t.Fatalf("capabilities must be sorted and unique: %v", first)
		}
	}
	first[0] = "mutated"
	if Capabilities()[0] == "mutated" {
		t.Fatal("Capabilities must return a copy: a report must not mutate the agent's list")
	}
}

func TestProtocolVersionIsPositive(t *testing.T) {
	if ProtocolVersion < 1 {
		t.Fatalf("protocol version must be a positive monotone integer, got %d", ProtocolVersion)
	}
}

// Envelope/payload mismatches are refused before anything is applied.
func TestExecuteRejectsEnvelopePayloadMismatch(t *testing.T) {
	base := func() *QueuedCommand {
		cfg := configStub
		return &QueuedCommand{
			Envelope: Envelope{CommandID: "cmd-1", ResourceID: "tunex-1-direct", Revision: 3, Action: ActionApplyTunnel},
			Config:   &cfg,
		}
	}

	t.Run("resource mismatch", func(t *testing.T) {
		cmd := base()
		cmd.Config.ID = "tunex-2-direct"
		ack := newTestClient(t).execute(context.Background(), cmd)
		if ack.ErrorCode != "resource_mismatch" {
			t.Fatalf("expected resource_mismatch, got %q (%s)", ack.ErrorCode, ack.Error)
		}
	})

	t.Run("revision mismatch", func(t *testing.T) {
		cmd := base()
		cmd.Config.Revision = 9
		ack := newTestClient(t).execute(context.Background(), cmd)
		if ack.ErrorCode != "revision_mismatch" {
			t.Fatalf("expected revision_mismatch, got %q (%s)", ack.ErrorCode, ack.Error)
		}
	})

	t.Run("missing resource id", func(t *testing.T) {
		cmd := base()
		cmd.Envelope.ResourceID = "  "
		ack := newTestClient(t).execute(context.Background(), cmd)
		if ack.ErrorCode != "invalid_command" {
			t.Fatalf("expected invalid_command, got %q (%s)", ack.ErrorCode, ack.Error)
		}
	})

	t.Run("unparseable expiry", func(t *testing.T) {
		cmd := base()
		cmd.Envelope.ExpiresAt = "not-a-time"
		ack := newTestClient(t).execute(context.Background(), cmd)
		if ack.ErrorCode != "invalid_command" {
			t.Fatalf("an unparseable expiry must be refused, got %q (%s)", ack.ErrorCode, ack.Error)
		}
		if !strings.Contains(ack.Error, "expires_at") {
			t.Fatalf("the refusal must name the offending field: %q", ack.Error)
		}
	})

	t.Run("expired", func(t *testing.T) {
		cmd := base()
		cmd.Envelope.ExpiresAt = "2000-01-01T00:00:00Z"
		ack := newTestClient(t).execute(context.Background(), cmd)
		if ack.ErrorCode != "command_expired" {
			t.Fatalf("expected command_expired, got %q (%s)", ack.ErrorCode, ack.Error)
		}
	})

	t.Run("missing config", func(t *testing.T) {
		cmd := base()
		cmd.Config = nil
		ack := newTestClient(t).execute(context.Background(), cmd)
		if ack.ErrorCode != "invalid_payload" {
			t.Fatalf("expected invalid_payload, got %q (%s)", ack.ErrorCode, ack.Error)
		}
	})

	t.Run("missing command id", func(t *testing.T) {
		cmd := base()
		cmd.Envelope.CommandID = ""
		ack := newTestClient(t).execute(context.Background(), cmd)
		if ack.ErrorCode != "invalid_command" {
			t.Fatalf("expected invalid_command, got %q (%s)", ack.ErrorCode, ack.Error)
		}
	})
}
