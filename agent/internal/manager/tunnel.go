// Package manager owns the tunnel lifecycle: what runs, on which ports, at
// which revision.
//
// TunnelManager is the map[id]Forwarder registry plus the revision rules
// ("newer revision atomic apply, equal revision idempotent, older revision
// stale-reject"). EgressManager owns the target pools and hands out the
// (swappable) load balancers the egress forwarders use. LoadBalancer itself
// lives here too in manager/lb.go.
//
// Ports: a BOTH node runs ingress and egress tunnels in
// one process and the two pools can overlap numerically, so a single shared
// guard describes each socket protocol and bind scope. It is derived from this
// single registry and its bounded teardown notes; EGRESS uses the same owner.
package manager

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/logx"
	"github.com/tunex/agent/internal/portlease"
)

// Revision rules (enforced by the manager so the command layer
// stays transport-specific):
//
//	cfg.Revision >  current -> apply
//	cfg.Revision == current -> idempotent no-op (return the running forwarder)
//	cfg.Revision <  current -> ErrStaleRevision
//
// A Revision of 0 means "source does not track revisions" and always applies.
const (
	revisionUnknown = int64(0)
)

// ErrStaleRevision is returned when a command carries a revision older than
// the applied one. The command must be rejected by the caller, not applied.
var ErrStaleRevision = fmt.Errorf("manager: stale revision")

// ErrTunnelNotFound is returned by Remove/Get for an unknown tunnel id.
var ErrTunnelNotFound = fmt.Errorf("manager: tunnel not found")

// entry is one running tunnel: the config it was built from plus its runtime.
//
// The runtime is forwarder.Runtime (start/stop/running), NOT forwarder.Forwarder:
// there is more than one transport contract behind a tunnel, and a
// datagram runtime must not be forced to implement stream-only methods
// (SetUpstream/Drain) to sit in this registry — forwarder.StreamRuntime's own
// doc comment and the datagram contract §4.1 both forbid that. Everything
// transport-specific is an interface assertion at the call site.
type entry struct {
	cfg forwarder.TunnelConfig
	fwd forwarder.Runtime
}

// TunnelManager is the concurrency-safe registry of running tunnels.
type TunnelManager struct {
	mu      sync.RWMutex
	tunnels map[string]*entry
	// removedRevision is a versioned delete tombstone. Once a control-plane
	// remove at revision N is acknowledged, an apply snapshot at revision <= N
	// must not be able to resurrect that runtime merely because the live entry
	// is no longer present in the registry.
	removedRevision map[string]int64
	usedPort        map[string]bool // "<socket namespace>:<port>@<bind scope>" derived guard

	// stoppingPorts 记录"Stop 已经发起、但监听还没真正关闭"的端口 —— 带**截止时间**的挂账。
	//
	// 为什么需要它：端口守卫是**派生状态** —— 它必须恰好等于"还有 runtime 在听这个端口"。
	// 而"还在听"包含两类：`tunnels` 里的 entry，以及正在 drain 的旧 entry（它的监听还没关，
	// 内核层面这个端口仍被占）。只按 `tunnels` 重建会在 drain 期间把端口错放出去
	// （下一次 bind 直接 `address already in use`）；只按手工 mark/release 维护则会**漏**
	// （实测：runtime 早已 removed，`used_ports` 里还留着 22001/21003，于是复用该端口的下一条
	// 路由被 Agent 拒绝，而面板的端口租约早已释放 —— 两边对"端口归谁"给了不同答案）。
	//
	// 截止时间是**第二道自愈**：正常路径下挂账由 Stop 返回时清掉（drain 上界只有 3s），
	// 但"清账动作因为任何原因没跑到"不能等于"这个端口永远不可用" —— 那正是本次事故的形态
	// （端口早已无人监听，守卫却一直占着）。超过 {@link stoppingPortGrace} 后挂账自动失效，
	// 以内核为准：内核里真占着，bind 会如实失败；已经不占了，端口就该能被复用。
	stoppingPorts map[string]stoppingNote
	// externalPorts are process reservations made by the Link runner. They use
	// this manager's lock and derived guard, without inventing native tunnel IDs.
	// The runner retains old bindings until every owning process has stopped.
	externalPorts map[string][]portlease.Binding

	egress *EgressManager
	// listenHost is the interface ingress/egress tunnels bind when the config
	// does not pin one. Empty means all interfaces.
	listenHost string

	// targetDial is the dialer EGRESS pools use for target resolution.
	// nil keeps Go's own dialer, which is also what
	// every existing test and a build without the resolver wired gets.
	targetDial forwarder.DialFunc

	// closing is the shutdown latch: once set, Apply refuses new work so a
	// config arriving mid-teardown cannot rebind a port that was just closed.
	closing bool
	// shutdownMu guards the running shutdown tallies (written from one
	// goroutine per tunnel).
	shutdownMu      sync.Mutex
	lastShutdown    ShutdownReport
	lastShutdownIDs []string

	// mutationHook is notified — outside every lock — after a mutation actually
	// changed the running registry. It exists so the durable last-known-good
	// cache is refreshed by an event rather than only by a periodic
	// sample: "ACK durable success but cache the previous state" is exactly the
	// window this closes. One hook here covers the control loop, the local admin
	// API and startup restore, which is why it lives in the manager rather than
	// in each caller.
	mutationHook func()

	// ownership is the activation gate (ownership.Guard): the epoch
	// fence plus the lease clock. It runs on BOTH activation entries, before any
	// lock or listener, so every path that can start serving a tunnel — the
	// control dispatch, the reconnect snapshot, startup restore and the local
	// admin plane — is fenced by one implementation instead of four. nil means
	// "this node does not fence" (an older build, or a test).
	ownership OwnershipGuard
}

// OwnershipGuard is the fencing gate an activation must pass before anything is
// bound. It is an interface (not ownership.Guard) so the manager keeps knowing
// nothing about epochs and leases: it asks one question and reports the answer.
//
// The returned error is expected to be a typed refusal (ownership.Refusal) whose
// code the control path carries back to the panel; the manager only propagates
// it.
type OwnershipGuard interface {
	Admit(cfg forwarder.TunnelConfig) error
}

// SetOwnershipGuard installs the activation gate. It is safe to call at any time
// and passing nil removes the gate. It is a setter rather than a constructor
// argument because the guard is built after the managers (it needs their
// registry) and because every existing caller of NewTunnelManager keeps working
// unfenced.
func (m *TunnelManager) SetOwnershipGuard(g OwnershipGuard) {
	m.mu.Lock()
	m.ownership = g
	m.mu.Unlock()
}

// AdmitActivation runs the fencing gate WITHOUT applying anything.
//
// The manager already gates its own apply entries (so no caller can bypass it);
// this exported form exists for a caller that mutates something else first. The
// control path stages an EGRESS target pool before it can build the forwarder,
// and staging it for an activation that is about to be refused would briefly
// rewrite a RUNNING pool's targets — a mutation of a fenced tunnel, which is
// exactly what "the refusal happens before any mutation" forbids. Calling this
// first makes the refusal free of side effects; the gate inside Apply then
// re-checks under the same monotone rules.
func (m *TunnelManager) AdmitActivation(cfg forwarder.TunnelConfig) error {
	return m.admitOwnership(cfg)
}

// admitOwnership runs the activation gate outside the manager's lock: the guard
// may write a durable file, and holding m.mu across an fsync would stall every
// other tunnel operation behind one activation.
func (m *TunnelManager) admitOwnership(cfg forwarder.TunnelConfig) error {
	m.mu.RLock()
	guard := m.ownership
	m.mu.RUnlock()
	if guard == nil {
		return nil
	}
	return guard.Admit(cfg)
}

// SetMutationHook installs the post-mutation observer. It is safe to call at any
// time; passing nil removes it.
func (m *TunnelManager) SetMutationHook(fn func()) {
	m.mu.Lock()
	m.mutationHook = fn
	m.mu.Unlock()
}

// fingerprint summarises the running registry (id, revision, protocol and scope). It is
// compared before/after a mutation so an idempotent apply — same revision, no
// listener churn — does not wake the hook.
func (m *TunnelManager) fingerprint() string {
	m.mu.RLock()
	parts := make([]string, 0, len(m.tunnels))
	for id, e := range m.tunnels {
		parts = append(parts, fmt.Sprintf("%s:%d:%s:%s", id, e.cfg.Revision, e.cfg.Protocol, portGuardKey(e.cfg)))
	}
	m.mu.RUnlock()
	sort.Strings(parts)
	return strings.Join(parts, ",")
}

// notifyIfChanged fires the hook when the registry really changed.
func (m *TunnelManager) notifyIfChanged(before string) {
	if before == m.fingerprint() {
		return
	}
	m.mu.RLock()
	hook := m.mutationHook
	m.mu.RUnlock()
	if hook != nil {
		hook()
	}
}

// NewTunnelManager builds a manager. egress may be nil on a pure ingress node;
// EGRESS tunnels are then rejected. listenHost may be empty.
func NewTunnelManager(egress *EgressManager, listenHost string) *TunnelManager {
	return &TunnelManager{
		tunnels:         make(map[string]*entry),
		removedRevision: make(map[string]int64),
		usedPort:        make(map[string]bool),
		stoppingPorts:   make(map[string]stoppingNote),
		externalPorts:   make(map[string][]portlease.Binding),
		egress:          egress,
		listenHost:      listenHost,
	}
}

// portGuardKey is the usedPorts key for a bound port.
//
// The key is namespaced by the OS socket family the listener actually binds
// ("tcp:" / "udp:") because the key is also a REPORTED FACT: labelling a UDP
// bind "tcp:" would say the node owns a TCP listener it does not (§5.3 of the
// datagram contract). tls/ws are TCP sockets, so all three stream protocols
// share one namespace; only a datagram runtime gets "udp:".
func portGuardKey(cfg forwarder.TunnelConfig) string {
	return portBinding(cfg).Key()
}

func portBinding(cfg forwarder.TunnelConfig) portlease.Binding {
	return portlease.New(string(cfg.Protocol), cfg.ListenPort(), cfg.ListenHost)
}

// checkPortAvailableLocked checks the single runtime registry and its existing
// teardown notes. Only the entry actually being replaced is exempt; a same-id
// replacement cannot bypass another rule's reservation. Caller must hold m.mu.
func (m *TunnelManager) checkPortAvailableLocked(cfg forwarder.TunnelConfig, replacedID string) error {
	m.rebuildPortGuardLocked()
	if m.bindingConflictLocked(portBinding(cfg), replacedID, "") {
		return portConflict(cfg)
	}
	return nil
}

func (m *TunnelManager) bindingConflictLocked(wanted portlease.Binding, replacedID, externalOwner string) bool {
	for id, e := range m.tunnels {
		if id != replacedID && wanted.Conflicts(portBinding(e.cfg)) {
			return true
		}
	}
	for key := range m.stoppingPorts {
		if stopping, ok := portlease.ParseKey(key); ok && wanted.Conflicts(stopping) {
			return true
		}
	}
	for owner, bindings := range m.externalPorts {
		if owner == externalOwner {
			continue
		}
		for _, binding := range bindings {
			if wanted.Conflicts(binding) {
				return true
			}
		}
	}
	return false
}

// ReserveExternal atomically replaces an external owner's COMPLETE binding
// list. The owner must include all prepared, active and stopping process sockets
// until their stop is confirmed. A refusal preserves the previous list.
func (m *TunnelManager) ReserveExternal(owner string, bindings []portlease.Binding) error {
	owner = strings.TrimSpace(owner)
	if owner == "" {
		return fmt.Errorf("manager: external port owner is required")
	}
	normalized := make([]portlease.Binding, 0, len(bindings))
	seen := make(map[string]bool, len(bindings))
	for _, binding := range bindings {
		binding = portlease.New(binding.Network, binding.Port, binding.Host)
		if (binding.Network != "tcp" && binding.Network != "udp") || binding.Port <= 0 || binding.Port > 65535 {
			return fmt.Errorf("manager: invalid external binding for %s: %+v", owner, binding)
		}
		if !seen[binding.Key()] {
			normalized = append(normalized, binding)
			seen[binding.Key()] = true
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return ErrNodeShuttingDown
	}
	m.rebuildPortGuardLocked()
	for _, binding := range normalized {
		if m.bindingConflictLocked(binding, "", owner) {
			return fmt.Errorf("manager: external owner %s: %s port %d bind scope %q is already reserved", owner, binding.Network, binding.Port, binding.Host)
		}
	}
	if len(normalized) == 0 {
		delete(m.externalPorts, owner)
	} else {
		m.externalPorts[owner] = normalized
	}
	m.rebuildPortGuardLocked()
	return nil
}

// ReleaseExternal is called only after the runner confirms every owner process
// has stopped. It never releases a native or another external owner's binding.
func (m *TunnelManager) ReleaseExternal(owner string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.externalPorts, strings.TrimSpace(owner))
	m.rebuildPortGuardLocked()
}

func portConflict(cfg forwarder.TunnelConfig) error {
	logx.Warn("apply rejected: port is guarded by another runtime",
		"id", cfg.ID, "port", cfg.ListenPort(), "protocol", string(cfg.Protocol),
		"listen_host", cfg.ListenHost, "revision", cfg.Revision)
	return fmt.Errorf("manager: port %d is already used by another tunnel (%s bind scope %q)",
		cfg.ListenPort(), portBinding(cfg).Network, cfg.ListenHost)
}

// normalizeConfig applies the manager default before canonicalizing the host
// used by both the socket and the guard. Caller holds m.mu or m.mu.RLock.
func (m *TunnelManager) normalizeConfig(cfg forwarder.TunnelConfig) (forwarder.TunnelConfig, error) {
	normalized := cfg.Clone()
	if strings.TrimSpace(normalized.ListenHost) == "" {
		normalized.ListenHost = m.listenHost
	}
	normalized.ListenHost = portlease.NormalizeHost(normalized.ListenHost)
	err := normalized.Validate()
	return normalized, err
}

// New builds the runtime for cfg without starting it. It is exported so the
// API layer / tests can inspect what a config would produce.
func (m *TunnelManager) New(cfg forwarder.TunnelConfig) (forwarder.Runtime, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	normalized, err := m.normalizeConfig(cfg)
	if err != nil {
		return nil, err
	}
	fwd, err := m.buildLocked(normalized)
	if err != nil {
		return nil, err
	}
	m.attachLedger(normalized, fwd)
	return fwd, nil
}

// DiagnosticsByTunnel returns the protocol-specific facts of every running tunnel
// that exposes any protocol diagnostics.
//
// A tunnel whose protocol has nothing to report is simply absent from the map,
// not present with zeroed counters: the panel must be able to say "this protocol
// has no such facts" rather than "nothing went wrong yet" — the same
// absent-versus-empty rule the capability facts follow.
func (m *TunnelManager) DiagnosticsByTunnel() map[string]forwarder.ProtocolDiagnostics {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]forwarder.ProtocolDiagnostics, len(m.tunnels))
	for id, e := range m.tunnels {
		report, ok := e.fwd.(forwarder.Diagnostician)
		if !ok {
			continue
		}
		diag, present := report.ProtocolDiagnostics()
		if !present {
			continue
		}
		out[id] = diag
	}
	return out
}

// attachLedger links an egress forwarder's per-target health view to its pool,
// so EgressManager.TargetStats can report what the running forwarder observed.
// A non-egress tunnel (or a pool-less one) is a no-op.
func (m *TunnelManager) attachLedger(cfg forwarder.TunnelConfig, fwd forwarder.Runtime) {
	if cfg.Mode != forwarder.ModeEgress || m.egress == nil {
		return
	}
	reader, ok := fwd.(interface {
		TargetStats() []forwarder.TargetStats
	})
	if !ok {
		return
	}
	if pool, err := m.egress.poolFor(cfg.ID); err == nil {
		pool.SetLedger(reader.TargetStats)
	}
}

// Apply creates or replaces the tunnel described by cfg, applying the revision
// rules. On success the tunnel is running and cfg.ID is owned by this manager.
//
// Equal revision returns (nil, nil) after a read-only check; the caller can
// ACK it as an idempotent no-op.
//
// The revision gate and the port guard live here (and in ReplaceListener,
// which shares applyLocked); the ordering inside is applyLocked's job, and it
// uses the same admission check for both entry points so the two cannot drift.
func (m *TunnelManager) Apply(cfg forwarder.TunnelConfig) (forwarder.Runtime, error) {
	before := m.fingerprint()
	fwd, err := m.applyInner(cfg)
	if err == nil {
		m.notifyIfChanged(before)
	}
	return fwd, err
}

// applyInner is Apply's locked body. Splitting it out keeps the fingerprint
// comparison on the outside of the lock: the hook must never run while m.mu is
// held, because it re-reads the registry.
func (m *TunnelManager) applyInner(cfg forwarder.TunnelConfig) (forwarder.Runtime, error) {
	// The ownership gate runs before the lock and before anything can
	// bind, so a refused activation is never half-applied.
	if err := m.admitOwnership(cfg); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	normalized, err := m.normalizeConfig(cfg)
	if err != nil {
		return nil, err
	}

	// Refuse work once shutdown has begun. Checked before the revision
	// gate so a config cannot "win" by carrying a newer revision.
	if m.closing {
		return nil, ErrNodeShuttingDown
	}

	if removed, ok := m.removedRevision[normalized.ID]; ok &&
		normalized.Revision != revisionUnknown &&
		normalized.Revision <= removed {
		return nil, ErrStaleRevision
	}
	if cur, ok := m.tunnels[normalized.ID]; ok {
		if isStale(normalized.Revision, cur.cfg.Revision) {
			return nil, ErrStaleRevision
		}
		if normalized.Revision == cur.cfg.Revision && normalized.Revision != revisionUnknown {
			// Idempotent: the very same revision is already live. Do not
			// churn listeners or reassign ports.
			return cur.fwd, nil
		}
	}
	fwd, err := m.applyLocked(normalized)
	if err == nil {
		delete(m.removedRevision, normalized.ID)
	}
	return fwd, err
}

// buildLocked builds the data-plane runtime. Caller must hold m.mu.
//
// Construction goes through the forwarder's runtime factory, which
// resolves protocol + transport FIRST and fails closed for anything this binary
// has not opened. The manager keeps owning desired state, revisions, the port
// guard and the single registry; only the "which runtime class" question moved
// into the factory, and it is asked before anything can bind.
//
// The factory answers for both stream and datagram transports (forwarder.BuildRuntime):
// the manager does not branch on the protocol, so opening a datagram protocol
// cannot silently land in the stream builder — or the other way round.
//
// The egress selector is passed as a lazy closure rather than resolved here, so
// the factory decides whether this build needs a pool at all (DIRECT/RELAY must
// not be made to fail because EgressManager is absent in a mode-only build).
func (m *TunnelManager) buildLocked(cfg forwarder.TunnelConfig) (forwarder.Runtime, error) {
	return forwarder.BuildRuntime(cfg, forwarder.BuildDeps{
		StreamBuildDeps: forwarder.StreamBuildDeps{
			// Use the target resolver's dialer when the runtime wired one.
			Dial: m.targetDial,
			SelectorFor: func(tunnelID string) (forwarder.TargetSelector, error) {
				if m.egress == nil {
					return nil, fmt.Errorf("manager: EGRESS tunnel %s has no egress manager wired", tunnelID)
				}
				return m.egress.SelectorFor(tunnelID)
			},
			// egressObserver is nil-safe, so a mode-only build loses nothing but
			// the log line; tests can leave the observer unset.
			Observer: egressObserver(cfg.ID),
			ReportCertError: func(err error) {
				// A failed certificate rotation must be visible: the tunnel keeps
				// serving the last good certificate, so the only symptom is this line
				// plus a certificate that never changes.
				logx.Error("tls certificate rotation failed", "tunnel", cfg.ID, "err", err.Error())
			},
		},
		// Datagram options stay at the package defaults: the idle timeout and the
		// mapping ceiling are product decisions (§9.2/§9.3) with no per-Forward
		// column yet, so inventing values here would put a second, invisible copy
		// of them in the control plane's way.
		//
		// What a datagram runtime DOES need from its owner is the same pool the
		// stream egress reads; for datagram relay traffic: the destination of a datagram exit is
		// never on the wire, so the selector is the only thing that can name one.
		// Until this was wired, an EGRESS datagram config reached the factory with
		// nothing to resolve and had to be refused there.
		Datagram: forwarder.DatagramBuildDeps{
			SelectorFor: func(tunnelID string) (forwarder.TargetSelector, error) {
				if m.egress == nil {
					return nil, fmt.Errorf("manager: EGRESS tunnel %s has no egress manager wired", tunnelID)
				}
				return m.egress.SelectorFor(tunnelID)
			},
			Observer: egressObserver(cfg.ID),
		},
	})
}

// egressObserver builds the target-failure observer for one egress tunnel.
// It logs every failed dial for target-health observability so a
// broken target is visible in the agent log the moment it breaks, while the
// per-target ledger stays the machine-readable source of truth.
func egressObserver(tunnelID string) forwarder.TargetObserver {
	return func(stats forwarder.TargetStats) {
		logx.Warn("egress target dial failed",
			"tunnel", tunnelID,
			"target", stats.Addr(),
			"dial_ok", stats.DialOK,
			"dial_failed", stats.DialFailed,
			"err", stats.LastErr,
		)
	}
}

// startLocked starts fwd and reserves its port. Caller must hold m.mu.
// The port guard is checked here AND the bind itself is the authoritative check
// (a foreign process holding the port makes net.Listen fail), so a race with
// the OS cannot be hidden by the map.
//
// When this Apply replaces the tunnel that currently owns the port, the old
// runtime must already have released it: Apply then does the replace in two
// steps (release the old port, bind the new one) rather than failing on a port
// the node itself holds. Same-port replacement is exactly the hot-update case
// the panel hits when it re-sends a tunnel with a new revision — including the
// case where the new revision changes the listener's TRANSPORT (a udp binding
// replaced by a tcp one on the same number). Other owners are checked before
// the old runtime is touched, using the destination protocol and bind scope.
func (m *TunnelManager) startLocked(cfg forwarder.TunnelConfig, fwd forwarder.Runtime) error {
	port := cfg.ListenPort()
	if port <= 0 {
		return fwd.Start()
	}
	if err := m.checkPortAvailableLocked(cfg, cfg.ID); err != nil {
		return err
	}
	// Same-number Apply retains its rebuild semantics. Check every OTHER
	// owner first, including a rule on the destination socket protocol, before
	// stopping the old runtime. Disjoint listener moves use bind-first Replace.
	if old, ok := m.tunnels[cfg.ID]; ok && old.cfg.ListenPort() == port {
		_ = old.fwd.Stop()
	}
	return fwd.Start()
}

// markPortUsedLocked records the port of a now-running tunnel. Caller must hold
// m.mu.
func (m *TunnelManager) markPortUsedLocked(cfg forwarder.TunnelConfig) {
	if p := cfg.ListenPort(); p > 0 {
		m.usedPort[portGuardKey(cfg)] = true
	}
}

// stoppingPortGrace 是"挂账"的存活上界：正常 drain 由 forwarder 的 drainTimeout(3s) 界定，
// 这里留一个远大于它的余量，只用来兜住"清账动作没跑到"这种故障，而不是用来延长占用。
const stoppingPortGrace = 30 * time.Second

// stoppingNote 是一个端口的挂账：重数（并发/重复登记）与失效时刻。
type stoppingNote struct {
	count int
	until time.Time
}

// noteStoppingLocked records that this config's listener is being torn down and its
// port is therefore not yet reclaimable. Caller must hold m.mu.
func (m *TunnelManager) noteStoppingLocked(cfg forwarder.TunnelConfig) {
	if cfg.ListenPort() <= 0 {
		return
	}
	m.stoppingPorts[portGuardKey(cfg)] = stoppingNote{
		count: m.stoppingPorts[portGuardKey(cfg)].count + 1,
		until: time.Now().Add(stoppingPortGrace),
	}
}

// clearStoppingLocked is the matching decrement, run once Stop returned (the
// listener is closed and the port is genuinely free at the OS level).
func (m *TunnelManager) clearStoppingLocked(cfg forwarder.TunnelConfig) {
	if cfg.ListenPort() <= 0 {
		return
	}
	key := portGuardKey(cfg)
	if n := m.stoppingPorts[key]; n.count > 1 {
		m.stoppingPorts[key] = stoppingNote{count: n.count - 1, until: n.until}
	} else {
		delete(m.stoppingPorts, key)
	}
}

// rebuildPortGuardLocked 从**事实**重新推导端口守卫：
//
//	守卫 = {还有 runtime 在听的端口} ∪ {Stop 已发起但尚未返回的端口}
//
// 这是这次修复的核心：守卫是派生状态，不该由散落在各处的 mark/release 手工维护 ——
// 只要漏掉一条路径（或有并发交错），就会留下一个"没人监听、却谁也拿不到"的端口，
// 而它的症状出现在很远的地方（下一条复用该端口的路由被拒，日志里看起来像端口分配有 bug）。
// 每次改动 `tunnels` 之后重建一次，这类漂移就不可能持续存在。Caller must hold m.mu.
func (m *TunnelManager) rebuildPortGuardLocked() {
	next := make(map[string]bool, len(m.tunnels)+len(m.stoppingPorts))
	for _, e := range m.tunnels {
		if e.cfg.ListenPort() > 0 {
			next[portGuardKey(e.cfg)] = true
		}
	}
	for _, bindings := range m.externalPorts {
		for _, binding := range bindings {
			next[binding.Key()] = true
		}
	}
	now := time.Now()
	for key, n := range m.stoppingPorts {
		if n.count <= 0 {
			delete(m.stoppingPorts, key)
			continue
		}
		if !now.Before(n.until) {
			// 挂账过期：清账动作没跑到（或 Stop 卡住）不能等于"这个端口永远不可用"。
			delete(m.stoppingPorts, key)
			continue
		}
		next[key] = true
	}
	m.usedPort = next
}

// releasePortLocked frees the port held by cfg. Caller must hold m.mu.
func (m *TunnelManager) releasePortLocked(cfg forwarder.TunnelConfig) {
	if p := cfg.ListenPort(); p > 0 {
		delete(m.usedPort, portGuardKey(cfg))
	}
}

// stopEntryAsync starts teardown without blocking the manager lock. Paths that
// registered a stopping note supply its matching completion hook; an already
// stopped same-binding replacement supplies nil and cannot clear another note.
func (m *TunnelManager) stopEntryAsync(e *entry, onStopped func()) {
	// 注意：**不在这里加锁**。调用方可能仍持有 m.mu（applyLocked 的 defer 就是这种情形），
	// 同步取锁会直接死锁（实测把整个套件挂住 30s+）。"正在关闭"的登记由**持锁的改动路径**
	// 负责（removeInnerIf / applyLocked 的换端口分支），这里只负责在 Stop 返回后清账。
	go func() {
		if err := e.fwd.Stop(); err != nil {
			logx.Warn("tunnel stop failed", "id", e.cfg.ID, "err", err.Error())
			// Fall through anyway: the forwarder is out of the registry, so
			// the port is ours to keep or free whatever Stop managed to do.
		}
		if onStopped != nil {
			onStopped()
		}
		logx.Info("tunnel removed", "id", e.cfg.ID, "mode", string(e.cfg.Mode), "port", e.cfg.ListenPort())
	}()
}

// releasePortAfterStop releases the ports held by cfg once the forwarder that
// still owns them has actually stopped. The reservation lives under m.mu, so
// the release takes the write lock rather than being dispatched at teardown
// time: the guard is manager state, never the teardown goroutine's.
//
// The release is owner-aware and therefore safe to run late. A listener move
// back onto the port being drained is legal (X -> Y, then Y -> X), and by the
// time the drained forwarder's Stop returns, the newer entry may already have
// reserved that port. Blindly deleting the key would hand a live tunnel's port
// to whoever asks next, so the key is dropped only while no registered tunnel
// holds it.
func (m *TunnelManager) releasePortAfterStop(cfg forwarder.TunnelConfig) func() {
	return func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.clearStoppingLocked(cfg)
		// Rebuild instead of deleting a key: a late teardown may have the
		// same ID and scope as a newer runtime, or share its numeric port.
		m.rebuildPortGuardLocked()
	}
}

// isStale reports whether next is older than current.
func isStale(next, current int64) bool {
	return current != revisionUnknown && next != revisionUnknown && next < current
}

// Remove stops and forgets the tunnel with the given id. It is a no-op returning
// nil when the id is unknown, so a duplicate remove_tunnel command from the
// panel cannot erase a tunnel that was legitimately recreated.
func (m *TunnelManager) Remove(id string) error {
	_, err := m.RemoveIf(id, nil)
	return err
}

// RemoveAtRevision is the versioned control-plane remove. It records the
// acknowledged remove revision even after the live entry is gone, preventing a
// stale desired snapshot from rebuilding the listener after deletion.
func (m *TunnelManager) RemoveAtRevision(id string, revision int64) error {
	before := m.fingerprint()
	removed, err := m.removeInnerIf(id, nil, revision)
	if err == nil && removed {
		m.notifyIfChanged(before)
	}
	return err
}

// RemoveIf removes a tunnel only while cond still holds for its live config.
//
// Lease-clock removals are intentionally unversioned: they are local safety
// decisions, not a control-plane revision statement.
func (m *TunnelManager) RemoveIf(id string, cond func(forwarder.TunnelConfig) bool) (bool, error) {
	before := m.fingerprint()
	removed, err := m.removeInnerIf(id, cond, revisionUnknown)
	if err == nil && removed {
		m.notifyIfChanged(before)
	}
	return removed, err
}

func (m *TunnelManager) removeInner(id string) error {
	_, err := m.removeInnerIf(id, nil, revisionUnknown)
	return err
}

// removeInnerIf is the locked body of Remove/RemoveIf/RemoveAtRevision.
// Caller must not hold m.mu.
func (m *TunnelManager) removeInnerIf(
	id string,
	cond func(forwarder.TunnelConfig) bool,
	revision int64,
) (bool, error) {
	m.mu.Lock()
	e, ok := m.tunnels[id]
	if !ok {
		if revision != revisionUnknown && revision > m.removedRevision[id] {
			m.removedRevision[id] = revision
		}
		m.mu.Unlock()
		return false, nil
	}
	if cond != nil && !cond(e.cfg) {
		// The tunnel changed under us (renewed or replaced): leave it alone.
		m.mu.Unlock()
		return false, nil
	}
	if revision != revisionUnknown &&
		e.cfg.Revision != revisionUnknown &&
		revision < e.cfg.Revision {
		m.mu.Unlock()
		return false, ErrStaleRevision
	}
	delete(m.tunnels, id)
	if revision != revisionUnknown && revision > m.removedRevision[id] {
		m.removedRevision[id] = revision
	}
	// Keep this scope reserved until Stop really releases the socket. Desired
	// deletion and the revision tombstone still take effect immediately.
	m.noteStoppingLocked(e.cfg)
	m.rebuildPortGuardLocked()
	m.mu.Unlock()

	m.stopEntryAsync(e, m.releasePortAfterStop(e.cfg))
	return true, nil
}

// Get returns the live cfg for a tunnel.
func (m *TunnelManager) Get(id string) (forwarder.TunnelConfig, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.tunnels[id]
	if !ok {
		return forwarder.TunnelConfig{}, false
	}
	return e.cfg.Clone(), true
}

// List returns every running tunnel, ordered by id for deterministic output.
func (m *TunnelManager) List() []forwarder.TunnelConfig {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]forwarder.TunnelConfig, 0, len(m.tunnels))
	for _, e := range m.tunnels {
		out = append(out, e.cfg.Clone())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// IDs returns the running tunnel ids.
func (m *TunnelManager) IDs() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]string, 0, len(m.tunnels))
	for id := range m.tunnels {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Len returns the number of running tunnels.
func (m *TunnelManager) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.tunnels)
}

// Stats returns the forwarded bytes for one tunnel (0 when unknown).
//
// A stream runtime answers with its own bidirectional byte counter. A datagram
// runtime is asked for the DELIVERED byte total of both directions instead
// (bytes_in + bytes_out): the value means the same thing, and returning 0 just
// because the transport's Stats() has a different shape would report an idle
// tunnel for one that is relaying. Callers that need the datagram facts
// separately (packets, mappings, drops) use DatagramStats.
func (m *TunnelManager) Stats(id string) int64 {
	m.mu.RLock()
	e, ok := m.tunnels[id]
	m.mu.RUnlock()
	if !ok {
		return 0
	}
	type byteCounter interface{ Stats() int64 }
	if c, ok := e.fwd.(byteCounter); ok {
		return c.Stats()
	}
	if d, ok := e.fwd.(forwarder.DatagramRuntime); ok {
		s := d.Stats()
		return s.BytesIn + s.BytesOut
	}
	return 0
}

// DatagramStats returns the structured datagram facts of a tunnel, and whether
// this tunnel is a datagram one at all. The second return value is the
// absent-versus-empty flag: a stream tunnel is not a datagram tunnel that is
// currently idle, and a caller must be able to tell those apart.
func (m *TunnelManager) DatagramStats(id string) (forwarder.DatagramStats, bool) {
	m.mu.RLock()
	e, ok := m.tunnels[id]
	m.mu.RUnlock()
	if !ok {
		return forwarder.DatagramStats{}, false
	}
	d, ok := e.fwd.(forwarder.DatagramRuntime)
	if !ok {
		return forwarder.DatagramStats{}, false
	}
	return d.Stats(), true
}

// MaxRevision returns the newest config revision among the running tunnels
// (0 when none or when the source does not track revisions). It is what the
// The state report sends as reported_revision so the panel can tell
// "this node is behind" (revision < tunnel.config_revision) from "no data".
func (m *TunnelManager) MaxRevision() int64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var max int64
	for _, e := range m.tunnels {
		if e.cfg.Revision > max {
			max = e.cfg.Revision
		}
	}
	return max
}

// LiveConns returns how much work the tunnel has in flight right now (0 when
// unknown). For a stream tunnel that is its live connections — the observable
// the disconnect-cleanup guard needs: after every client hangs up the count must
// fall back to zero.
//
// A datagram tunnel has no connections and must NOT be answered with a silent 0
// (§4.4.1): 0 would read as "nothing in flight" for a tunnel that is relaying,
// which is the failure mode this project treats as the worst kind. Its in-flight
// work is its mappings, so that is what is returned, and LiveMappings is the
// explicit form callers should prefer when they know the transport.
func (m *TunnelManager) LiveConns(id string) int {
	live, ok := m.LiveMappings(id)
	if ok {
		return live
	}
	m.mu.RLock()
	e, ok := m.tunnels[id]
	m.mu.RUnlock()
	if !ok {
		return 0
	}
	type counter interface{ LiveConns() int }
	if c, ok := e.fwd.(counter); ok {
		return c.LiveConns()
	}
	return 0
}

// LiveMappings returns the number of ingress mappings a datagram tunnel is
// holding, and whether this tunnel is a datagram one. Report the second value:
// "0 mappings" and "this transport has no mappings" are different facts.
func (m *TunnelManager) LiveMappings(id string) (int, bool) {
	m.mu.RLock()
	e, ok := m.tunnels[id]
	m.mu.RUnlock()
	if !ok {
		return 0, false
	}
	d, ok := e.fwd.(forwarder.DatagramRuntime)
	if !ok {
		return 0, false
	}
	return d.LiveMappings(), true
}

// StopAll tears down every tunnel. A stream tunnel drains its connections; a
// datagram tunnel drops its mappings (there is nothing to drain, §4.1). Used on
// shutdown.
func (m *TunnelManager) StopAll() {
	m.mu.Lock()
	entries := make([]*entry, 0, len(m.tunnels))
	for id, e := range m.tunnels {
		entries = append(entries, e)
		delete(m.tunnels, id)
	}
	m.usedPort = make(map[string]bool)
	m.stoppingPorts = make(map[string]stoppingNote)
	m.mu.Unlock()

	var wg sync.WaitGroup
	for _, e := range entries {
		wg.Add(1)
		go func(e *entry) {
			defer wg.Done()
			_ = e.fwd.Stop()
		}(e)
	}
	wg.Wait()
	logx.Info("all tunnels stopped", "count", len(entries))
}

// UsedPorts returns a copy of the shared port guard (for /health and tests).
//
// The flat view is the union of all socket protocols and bind scopes. TCP and
// UDP can share a number; callers needing that distinction use the protocol view.
func (m *TunnelManager) UsedPorts() map[int]bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rebuildPortGuardLocked()
	out := make(map[int]bool, len(m.usedPort))
	for k := range m.usedPort {
		_, port := splitPortGuardKey(k)
		if port > 0 {
			out[port] = true
		}
	}
	return out
}

// UsedPortsByProtocol returns the guard grouped by OS socket family ("tcp" /
// "udp"), the protocol-dimension view of the same facts (§5.3: the namespaces
// must be preserved somewhere, not flattened away everywhere).
func (m *TunnelManager) UsedPortsByProtocol() map[string]map[int]bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rebuildPortGuardLocked()
	out := map[string]map[int]bool{"tcp": {}, "udp": {}}
	for k := range m.usedPort {
		namespace, port := splitPortGuardKey(k)
		if port <= 0 {
			continue
		}
		name := strings.TrimSuffix(namespace, ":")
		if out[name] == nil {
			out[name] = map[int]bool{}
		}
		out[name][port] = true
	}
	return out
}

// splitPortGuardKey parses a protocol:port@scope (or legacy protocol:port) key. An
// unparseable key returns a zero port, which every caller treats as "not a
// binding" rather than as port 0 being taken.
func splitPortGuardKey(key string) (namespace string, port int) {
	binding, ok := portlease.ParseKey(key)
	if !ok {
		return "", 0
	}
	return binding.Network + ":", binding.Port
}

// SetTargetDialer installs the dialer EGRESS pools use for their upstreams.
//
// It is a setter rather than a constructor argument for the same reason
// SetOwnershipGuard is: the resolver is built after the managers (it is wired
// into the runtime) and every existing caller keeps working undialed. It only
// affects egress forwarders BUILT AFTER the call — an already-running pool keeps
// the dialer it was built with, which is the honest behaviour: swapping the
// dialer under a live forwarder would change how in-flight retries resolve
// without anything recording that it happened.
func (m *TunnelManager) SetTargetDialer(dial forwarder.DialFunc) {
	m.mu.Lock()
	m.targetDial = dial
	m.mu.Unlock()
}

// SetListenHost overrides the interface tunnels bind. Running tunnels keep
// their listener until the next Apply of that tunnel; callers that want the
// change live should use it before the first Apply.
func (m *TunnelManager) SetListenHost(host string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.listenHost = host
}

// compile-time check that the manager satisfies what the API layer needs.
var _ interface {
	Apply(forwarder.TunnelConfig) (forwarder.Runtime, error)
	Remove(string) error
	Get(string) (forwarder.TunnelConfig, bool)
	List() []forwarder.TunnelConfig
} = (*TunnelManager)(nil)
