package control

import (
	"fmt"
	"sort"
	"strings"

	"github.com/tunex/agent/internal/forwarder"
)

// V5-WP1 capability-negotiation v2.
//
// V4-WP11B (see protocol.go) told the panel which *actions* this agent
// implements. That is not enough once the product gains a second protocol: the
// panel also has to know whether this binary can carry that protocol, on which
// transport contract, and which runtime behaviours (hot reload, bounded drain,
// LKG restore) it actually performs.
//
// The rules are the same as WP11B's, and they matter more here because a wrong
// answer dispatches real traffic somewhere the operator did not intend:
//
//   - the manifest is derived from facts the binary can prove (the protocol
//     table the parser itself consults, the actions the execute() switch really
//     implements, and the subsystems the runtime actually constructed);
//   - it is NEVER read from an environment variable, a config file or anything
//     the panel sends, and never bound to a plan/permission;
//   - advertising a protocol/transport with no runtime behind it is a bug the
//     tests catch, not something production discovers.
//
// The manifest is additive next to `capabilities`: the action list keeps its
// wire shape so older panels and support tooling keep reading it.

// ManifestSchemaVersion is the schema version of the v2 capability manifest.
// Bump it only together with a frozen wire contract: the panel treats a version
// it does not implement as "manifest unreadable" (falls back to the V4
// baseline), so a bump silently disables v2 admission until the panel ships.
const ManifestSchemaVersion = 2

// RuntimeFeature names a runtime behaviour this agent implements.
type RuntimeFeature string

const (
	// RuntimeHotReload: a running tunnel's upstream can be swapped without
	// rebuilding the listener (forwarder.Forwarder.SetUpstream).
	RuntimeHotReload RuntimeFeature = "hot_reload"
	// RuntimeGracefulDrain: bounded graceful shutdown — stop accepting, drain
	// in-flight connections, then converge (forwarder.Forwarder.Drain).
	RuntimeGracefulDrain RuntimeFeature = "graceful_drain"
	// RuntimeLKGRestore: restore the last known good applied config while the
	// panel is unreachable (internal/restore).
	RuntimeLKGRestore RuntimeFeature = "lkg_restore"
)

// DiagnosticFeature names a diagnostic capability. This dimension is
// OBSERVATION ONLY: whether a diagnostic may be dispatched is decided by the
// action list (diagnose_tunnel / collect_diagnostics), so that the panel never
// has two sources of truth for the same permission. Advertising one here
// without the matching action would be caught by TestManifestDiagnosticsMatchActions.
type DiagnosticFeature string

const (
	DiagnosticTunnelProbe  DiagnosticFeature = "tunnel_probe"
	DiagnosticNodeSnapshot DiagnosticFeature = "node_snapshot"
)

// Manifest is the v2 capability fact set as it travels on the state report.
//
// Every slice is sorted and de-duplicated so the wire form is stable and the
// panel's normaliser does not have to guess an order.
type Manifest struct {
	SchemaVersion int      `json:"schema_version"`
	Protocols     []string `json:"protocols"`
	Transports    []string `json:"transports"`
	Runtime       []string `json:"runtime"`
	Diagnostics   []string `json:"diagnostics"`
}

// ImplementationFacts is what the runtime wiring actually built. It is the
// input to BuildManifest and exists so the manifest cannot claim a subsystem the
// process never started: the wiring passes what it constructed, not what the
// code could theoretically do.
type ImplementationFacts struct {
	// Protocols/Transports are normally forwarder.ImplementedProtocols() /
	// ImplementedTransports() — derived from the parser's own table.
	Protocols  []string
	Transports []string
	// Runtime lists the runtime behaviours that were really wired up.
	Runtime []RuntimeFeature
	// Diagnostics lists the diagnostics this binary implements.
	Diagnostics []DiagnosticFeature
}

// BuildManifest validates and canonicalises the facts into a wire manifest.
//
// Validation is strict and returns an error rather than dropping an unknown
// name: silently dropping would make a typo'd protocol look like "the agent
// implements nothing", and the panel would then refuse every dispatch on that
// dimension — a failure mode that only shows up in production. The caller
// (runtime wiring) treats a build error as a programming error.
func BuildManifest(facts ImplementationFacts) (Manifest, error) {
	protocols, err := canonicalNames(facts.Protocols, "protocol", func(name string) bool {
		_, ok := forwarder.TransportForProtocol(forwarder.ForwardProtocol(name))
		return ok
	})
	if err != nil {
		return Manifest{}, err
	}
	transports, err := canonicalNames(facts.Transports, "transport", func(name string) bool {
		for _, p := range protocols {
			if t, ok := forwarder.TransportForProtocol(forwarder.ForwardProtocol(p)); ok && string(t) == name {
				return true
			}
		}
		return false
	})
	if err != nil {
		return Manifest{}, err
	}
	runtimeFeatures, err := canonicalNames(enumNames(facts.Runtime), "runtime feature", isKnownRuntimeFeature)
	if err != nil {
		return Manifest{}, err
	}
	diagnostics, err := canonicalNames(enumNames(facts.Diagnostics), "diagnostic", isKnownDiagnosticFeature)
	if err != nil {
		return Manifest{}, err
	}
	return Manifest{
		SchemaVersion: ManifestSchemaVersion,
		Protocols:     protocols,
		Transports:    transports,
		Runtime:       runtimeFeatures,
		Diagnostics:   diagnostics,
	}, nil
}

// canonicalNames trims, de-duplicates, sorts and validates a name list.
func canonicalNames(names []string, what string, known func(string) bool) ([]string, error) {
	seen := make(map[string]bool, len(names))
	out := make([]string, 0, len(names))
	for _, raw := range names {
		name := strings.TrimSpace(raw)
		if name == "" {
			return nil, fmt.Errorf("control: empty %s name in capability manifest", what)
		}
		if !known(name) {
			return nil, fmt.Errorf("control: %s %q has no implementation in this binary", what, name)
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	sort.Strings(out)
	return out, nil
}

func enumNames[T ~string](in []T) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		out = append(out, string(v))
	}
	return out
}

func isKnownRuntimeFeature(name string) bool {
	switch RuntimeFeature(name) {
	case RuntimeHotReload, RuntimeGracefulDrain, RuntimeLKGRestore:
		return true
	default:
		return false
	}
}

func isKnownDiagnosticFeature(name string) bool {
	switch DiagnosticFeature(name) {
	case DiagnosticTunnelProbe, DiagnosticNodeSnapshot:
		return true
	default:
		return false
	}
}

// DiagnosticForAction maps a command action to the diagnostic it backs, or ""
// when the action is not a diagnostic. It is what keeps the manifest's
// diagnostics dimension honest: it is derived from the action list instead of
// being maintained beside it.
func DiagnosticForAction(action string) DiagnosticFeature {
	switch action {
	case ActionDiagnoseTunnel:
		return DiagnosticTunnelProbe
	case ActionCollectDiagnostics:
		return DiagnosticNodeSnapshot
	default:
		return ""
	}
}

// DiagnosticsFromActions derives the diagnostics dimension from the actions the
// agent really implements.
func DiagnosticsFromActions(actions []string) []DiagnosticFeature {
	out := make([]DiagnosticFeature, 0, len(actions))
	seen := map[DiagnosticFeature]bool{}
	for _, action := range actions {
		if d := DiagnosticForAction(action); d != "" && !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	return out
}

// DefaultManifest builds the manifest for a runtime with the full V5-WP0/WP1
// supervisor wired up (hot reload, bounded drain, LKG cache, both diagnostics).
//
// It is a convenience for tests and for the wiring path that constructs every
// subsystem; production wiring should call BuildManifest with the facts it
// actually built, so that a runtime started without (say) the LKG cache does not
// advertise lkg_restore.
func DefaultManifest() (Manifest, error) {
	return BuildManifest(ImplementationFacts{
		Protocols:   forwarder.ImplementedProtocols(),
		Transports:  forwarder.ImplementedTransports(),
		Runtime:     []RuntimeFeature{RuntimeHotReload, RuntimeGracefulDrain, RuntimeLKGRestore},
		Diagnostics: DiagnosticsFromActions(advertisedActions),
	})
}
