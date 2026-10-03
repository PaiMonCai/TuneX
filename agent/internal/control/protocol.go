package control

import "sort"

// V4-WP11B control-protocol negotiation.
//
// The panel must never send an action this agent does not implement, and it must
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
const ProtocolVersion = 1

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
}

// Capabilities returns the actions this agent implements, sorted. The caller
// gets a copy: a state report must not be able to mutate the agent's own list.
func Capabilities() []string {
	out := make([]string, len(advertisedActions))
	copy(out, advertisedActions)
	sort.Strings(out)
	return out
}

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
