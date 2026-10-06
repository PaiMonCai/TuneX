package control

import (
	"sort"
	"sync"

	"github.com/tunex/agent/internal/diag"
)

// Control-protocol negotiation.
//
// The Panel must never send an action this Agent does not implement, and it must
// be able to tell "this agent implements X" from "this agent never told me".
// Both facts travel on the existing state report:
//
//	control_protocol_version : the version of the control contract below
//	capabilities             : the actions the execute() switch really implements
//
// Capabilities are derived from the same constants the switch dispatches on, and
// TestAdvertisedCapabilitiesMatchExecute drives every advertised action through
// execute to prove the two cannot drift. An aspirational list would be worse than
// no list: the panel would queue a command the node answers with
// `unsupported_action`, and the resulting timeout would be diagnosed as a
// network problem.

// ProtocolVersion is the control-contract version this agent implements. It is
// monotone: the panel may require a minimum version before using a new action.
//
// Version 2 adds `capability_manifest` to the state report. Bumping the version
// lets an older Panel tell
// "this agent speaks a contract I only partly understand" without having to
// parse the manifest first.
const ProtocolVersion = 2

// Action names on the wire. They are constants so the dispatch switch and the
// advertised capability list cannot disagree by typo.
const (
	ActionApplyTunnel    = "apply_tunnel"
	ActionRemoveTunnel   = "remove_tunnel"
	ActionSuspendTunnel  = "suspend_tunnel"
	ActionDiagnoseTunnel = "diagnose_tunnel"
	// ActionCollectDiagnostics is the Node-level sibling: it reports what the
	// process itself is running, instead of probing a target path.
	ActionCollectDiagnostics = "collect_diagnostics"
	// ActionLookingGlass is the one action whose target comes from
	// **user input** rather than from the panel's own desired state. That is why
	// it is a separate action instead of a diagnose: it needs its own admission
	// (public-only literals, enforced on both sides), its own caps and its own
	// audit story. See internal/diag/lookingglass.go for the agent-side half.
	ActionLookingGlass = "looking_glass"
)

// advertisedActions is the single source of truth for what this agent
// implements. Adding a name here without implementing it in execute() is caught
// by TestAdvertisedCapabilitiesMatchExecute, not by production.
var advertisedActions = []string{
	ActionApplyTunnel,
	ActionRemoveTunnel,
	ActionSuspendTunnel,
	ActionDiagnoseTunnel,
	ActionCollectDiagnostics,
	ActionLookingGlass,
}

// Capabilities returns the actions this agent implements, sorted. The caller
// gets a copy: a state report must not be able to mutate the agent's own list.
func Capabilities() []string {
	out := make([]string, len(advertisedActions))
	copy(out, advertisedActions)
	// 方法级能力：`looking_glass` 这个动作内部还有方法维（tcp_connect / ping / ping6），
	// 而"能不能真的执行"是**运行环境事实**（镜像里有没有 ping 二进制、内核允不允许
	// 非特权 ICMP）。只把真的能执行的上报出去 —— 面板据此算它的 `caps.methods`，
	// 于是"服务端支持而 agent 没实现"在结构上不可能出现。
	for _, availability := range lookingGlassMethodAvailability() {
		if availability.Reason == "" {
			out = append(out, ActionLookingGlass+":"+availability.Method)
		}
	}
	sort.Strings(out)
	return out
}

// lookingGlassMethodAvailability 只探测一次（文件存在性 + 内核权限位，零发包）。
var lookingGlassMethodAvailability = sync.OnceValue(diag.DetectLookingGlassMethods)

// Implements reports whether this agent implements action. It exists so the
// command loop can answer a command the panel should not have sent with the same
// reason the panel would have used to refuse sending it.
func Implements(action string) bool {
	for _, a := range advertisedActions {
		if a == action {
			return true
		}
	}
	return false
}
