// Package panelroute 持有进程内**唯一**的"当前生效面板地址"（task-44/45）。
//
// ── 为什么单独成包（task-45 的 P1 修复）──────────────────────────────────────
// task-44 只把切换判定接进了**状态上报**：Reporter 自己持有一份
// `PanelRouteState`，`StateEndpoint()` 随它切换。但同一条控制链路里的
//
//	· 命令拉取（GET /api/internal/nodes/commands）、
//	· ACK 回执（POST /api/internal/node/ack）、
//	· 重连后的 desired fetch/reconcile（GET /api/internal/node/desired）
//
// 仍然各自用 `cfg.PanelURL`（主地址）拼请求。结果是主地址不可达、备用可达时，
// 节点在面板上"恢复 online"，但命令/ACK/desired 仍然全部打向已死的主地址 ——
// 面板看到健康，节点却再也收不到命令，恢复只能靠重启。
//
// 修法不是给每个模块复制一份切换判定（那会立刻分叉出"上报在备用、命令还在主用"
// 的第二个事实），而是让所有出站控制面共用**同一个 Router**：谁出站谁把结果喂进来
// （NoteOutcome），任何模块要地址就读 ActiveURL()。判定只有一处（DecidePanelRoute），
// 状态只有一份。
//
// ── 行为参照声明 ────────────────────────────────────────────────────────────
// 判据的行为参照 ForwardX（AGPL-3.0）的 `agent/panel_migration.go`：备用面板
// 地址 + 迁移 id + 迁移起始时间的三元组、阈值 `fallbackFailures = 2`、
// 期限 `fallbackDeadline = 3min`、**任一次成功即清零**、以及"已建立事件流期间不切"。
// TuneX 侧为**独立实现**：判据被抽成纯函数 + 显式状态机（便于真值表测试与审计），
// 命名、状态与上报口径按本项目契约重写，未逐字复制。
//
// ── 与参照实现的两处**刻意偏离**（都写在报告里，不是遗漏）──
//  1. **期限不是"单独成立就切"**。参照实现是「失败 ≥2 **或** 距 startedAt ≥3min」。
//     在 TuneX 里，"距 startedAt 已过 3 分钟"单独成立并不构成"主地址不可达"的证据：
//     一次已经完成的面板迁移会让所有健康节点在 3 分钟后集体切走。这里要求期限**与
//     至少一次失败同时成立**（见 DecidePanelRoute 的 `deadline && failures > 0`）。
//  2. **在备用地址上成功不自动切回主地址**。"切回"只由人在配置面完成（重新下发
//     agent.env 后重启，或换一个迁移 id）。理由是避免面板抖动时来回切换造成上报空档；
//     同一个节点反复切地址会让面板侧看到"同一 node 在两个地址间闪"。
//
// ── TuneX 没有"事件流" ──
// 参照实现有一类"长连接/事件流存活期间不切"的判据。TuneX 的 Agent **只主动出站**
// （命令轮询 + 状态上报），面板从不回拨，因此没有等价的"流"。本文件把这个信号保留
// 为显式输入（`StreamAlive`）：调用方若将来引入长连接，只需把它置 true 即可复用同一
// 判据；当前生产路径恒为 false，并在注释里写明这一点，避免"看起来有、其实没有"。
package panelroute

import (
	"strings"
	"sync"
	"time"

	"github.com/tunex/agent/internal/logx"
)

// 切换判据的默认值（与参照实现同量级；调用方可覆盖，便于测试与将来的调参）。
const (
	// DefaultMigrationFallbackFailures 是切到备用地址所需的**连续**失败次数。
	DefaultMigrationFallbackFailures = 2
	// DefaultMigrationFallbackDeadline 是迁移起始后的期限（与失败证据同时成立才切）。
	DefaultMigrationFallbackDeadline = 3 * time.Minute
)

// PanelRoute 是"当前主用哪个地址"。
type PanelRoute string

const (
	// PanelRoutePrimary 主地址（agent.env 的 TUNEX_PANEL_HTTP_URL）。
	PanelRoutePrimary PanelRoute = "primary"
	// PanelRouteFallback 备用地址（TUNEX_PANEL_FALLBACK_URL）。
	PanelRouteFallback PanelRoute = "fallback"
)

// PanelMigration 是**已校验过**的回退配置（由 agentconfig 解析后注入）。
//
// 零值（两个字段都空）= 本能力未配置；此时 DecidePanelRoute 只做失败计数，永不切换。
type PanelMigration struct {
	PrimaryURL  string
	FallbackURL string
	MigrationID string
	StartedAt   time.Time
	// StartedAtKnown=false ⇒ 期限判据不可用（只用连续失败阈值）。
	StartedAtKnown bool
	// Failures / Deadline 是判据阈值；0 值分别回落到上面的默认值。
	Failures int
	Deadline time.Duration
}

// Enabled 报告回退能力是否**真的可用**（备用地址与迁移 id 齐备）。
func (m PanelMigration) Enabled() bool {
	return strings.TrimSpace(m.FallbackURL) != "" && strings.TrimSpace(m.MigrationID) != ""
}

func (m PanelMigration) failures() int {
	if m.Failures > 0 {
		return m.Failures
	}
	return DefaultMigrationFallbackFailures
}

func (m PanelMigration) deadline() time.Duration {
	if m.Deadline > 0 {
		return m.Deadline
	}
	return DefaultMigrationFallbackDeadline
}

// PanelRouteState 是切换器的全部状态（可序列化、可断言；不含时钟）。
type PanelRouteState struct {
	// Active 是**当前实际在用**的地址。
	Active PanelRoute
	// ConsecutiveFailures 是自上一次成功以来连续失败的上报次数（任一次成功清零）。
	ConsecutiveFailures int
	// SwitchedAt 是切到备用地址的时刻（零值 = 从未切换）。
	SwitchedAt time.Time
	// SwitchReason 是切换原因（"failures" | "deadline" | ""）。
	SwitchReason string
}

// ReadyPanelRoute 返回可直接用于首次运行的初始状态（主地址）。
func ReadyPanelRoute() PanelRouteState {
	return PanelRouteState{Active: PanelRoutePrimary}
}

// PanelOutcome 是一次出站尝试的结果。
type PanelOutcome string

const (
	// PanelOutcomeSuccess = 面板给了可用的应答（2xx）。
	PanelOutcomeSuccess PanelOutcome = "success"
	// PanelOutcomeFailure = 传输失败 / 非 2xx / 超时。
	PanelOutcomeFailure PanelOutcome = "failure"
	// PanelOutcomeNone = 这一拍没有出站尝试（只用来重算期限判据）。
	PanelOutcomeNone PanelOutcome = "none"
)

// PanelRouteSignals 是一次判定的输入。
type PanelRouteSignals struct {
	// Now 是判定时刻（由调用方注入，纯函数不读时钟）。
	Now time.Time
	// Outcome 是这一拍的结果。
	Outcome PanelOutcome
	// StreamAlive=true 表示当前有已建立的长连接/事件流；此时**不切**（参照实现语义）。
	// TuneX 生产路径没有长连接，恒为 false。
	StreamAlive bool
}

// PanelRouteDecision 是判定结果里**需要被看见**的部分（用于日志与上报）。
type PanelRouteDecision struct {
	// Switched=true 表示这一拍发生了切换（primary → fallback）。
	Switched bool
	// To 是切换目标（仅在 Switched=true 时有意义）。
	To PanelRoute
	// Reason 是切换原因："failures"（连续失败达阈值）| "deadline"（期限 + 至少一次失败）。
	Reason string
	// FallbackFailing=true 表示当前已在备用地址上又失败了一次（备用也不可用）。
	FallbackFailing bool
}

// DecidePanelRoute 推进状态机。
//
// 判据（真值表见 panelroute_test.go）：
//
//	· 成功            ⇒ 连续失败清零；**已切到备用就不自动切回**（见文件头偏离 ②）。
//	· 失败（主地址）  ⇒ 计数 +1；计数 ≥ 阈值 ⇒ 切备用（reason=failures）；
//	  或期限已过**且**已有失败证据 ⇒ 切备用（reason=deadline）。
//	· 失败（备用）    ⇒ 计数 +1 并标记 FallbackFailing（不假装成功，也不再"切"）。
//	· StreamAlive     ⇒ 不切、也不累加（长连接还在 ⇒ 网络层并未断，单次上报失败
//	  不足以成为切地址的证据）。
func DecidePanelRoute(
	state PanelRouteState,
	migration PanelMigration,
	signals PanelRouteSignals,
) (PanelRouteState, PanelRouteDecision) {
	next := state
	decision := PanelRouteDecision{}
	if next.Active != PanelRouteFallback {
		next.Active = PanelRoutePrimary
	}

	if signals.StreamAlive {
		return next, decision
	}

	switch signals.Outcome {
	case PanelOutcomeSuccess:
		next.ConsecutiveFailures = 0
		return next, decision
	case PanelOutcomeFailure:
		next.ConsecutiveFailures++
		if next.Active == PanelRouteFallback {
			// 备用地址也不可达：如实标记，不做第二次"切换"（没有第三个地址）。
			decision.FallbackFailing = true
			return next, decision
		}
		if !migration.Enabled() {
			// 没配回退：只累计失败，永不动地址（缺省部署行为不变）。
			return next, decision
		}
		reason := ""
		if next.ConsecutiveFailures >= migration.failures() {
			reason = "failures"
		} else if migration.StartedAtKnown && !signals.Now.IsZero() &&
			signals.Now.Sub(migration.StartedAt) >= migration.deadline() {
			reason = "deadline"
		}
		if reason == "" {
			return next, decision
		}
		next.Active = PanelRouteFallback
		next.SwitchedAt = signals.Now
		next.SwitchReason = reason
		decision.Switched = true
		decision.To = PanelRouteFallback
		decision.Reason = reason
		return next, decision
	case PanelOutcomeNone:
		return next, decision
	default:
		return next, decision
	}
}

// ActiveURL 返回当前生效的面板基址（调用方用它拼请求）。
func (s PanelRouteState) ActiveURL(migration PanelMigration) string {
	if s.Active == PanelRouteFallback && migration.Enabled() {
		return strings.TrimRight(migration.FallbackURL, "/")
	}
	return strings.TrimRight(migration.PrimaryURL, "/")
}

// InFallback 是目前**是否在回退态**（上报体里必须带上它）。
func (s PanelRouteState) InFallback() bool {
	return s.Active == PanelRouteFallback
}

// Config 构造一个共享 Router。
type Config struct {
	// PrimaryURL 是主地址（agent.env 的 TUNEX_PANEL_HTTP_URL；尾部斜杠会被去掉）。
	PrimaryURL string
	// Migration 是**已校验过**的回退三元组；零值 = 未配置回退（永不动地址）。
	Migration PanelMigration
	// NodeID 只用于切换日志（可为空）。
	NodeID string
}

// Router 是进程内**唯一**的"当前生效面板地址"。
//
// 它是全部出站控制面（状态上报、命令拉取、ACK、desired fetch/reconcile）共用的
// 事实来源：
//   - 出站前一律 ActiveURL() 取地址（**每次请求都取**，切换因此对同一进程即时生效，
//     不需要重启）；
//   - 出站后把结果喂给 NoteOutcome()，由这里唯一的决定 DecidePanelRoute 推进状态。
//
// 并发安全：全部状态在一把锁后面，读（ActiveURL/State）与写（NoteOutcome）互斥。
// 锁内只做纯计算与赋值 —— 日志在解锁之后打 —— 所以不会出现"持锁回调"或锁死。
// 零值不可用（用 New 构造）；**nil 接收者是安全的**：读返回零值、写是 no-op，
// 这样"没配回退/没注入"的调用方不需要各自加 nil 判断。
type Router struct {
	mu        sync.Mutex
	migration PanelMigration
	nodeID    string
	state     PanelRouteState
}

// New 构造共享切换器。它把主地址补进 migration.PrimaryURL（调用方常常只填回退
// 三元组），因此 ActiveURL() 在任何状态下都能返回一个非空地址（除非主地址本身就空）。
func New(cfg Config) *Router {
	primary := strings.TrimRight(strings.TrimSpace(cfg.PrimaryURL), "/")
	migration := cfg.Migration
	if strings.TrimSpace(migration.PrimaryURL) == "" {
		migration.PrimaryURL = primary
	} else {
		migration.PrimaryURL = strings.TrimRight(strings.TrimSpace(migration.PrimaryURL), "/")
	}
	if migration.Enabled() {
		migration.FallbackURL = strings.TrimRight(strings.TrimSpace(migration.FallbackURL), "/")
	}
	return &Router{
		migration: migration,
		nodeID:    cfg.NodeID,
		state:     ReadyPanelRoute(),
	}
}

// ActiveURL 是当前生效的面板基址（已去尾部斜杠）。nil / 空配置返回 ""。
//
// 每次请求都调用它：切换后同一进程的下一次上报/拉取/ACK/desired 立刻打到备用地址。
func (r *Router) ActiveURL() string {
	if r == nil {
		return ""
	}
	r.mu.Lock()
	state, migration := r.state, r.migration
	r.mu.Unlock()
	return state.ActiveURL(migration)
}

// State 返回当前路由状态（纯读快照）。
func (r *Router) State() PanelRouteState {
	if r == nil {
		return ReadyPanelRoute()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state
}

// Migration 返回本 Router 持有的（已校验）回退配置。
func (r *Router) Migration() PanelMigration {
	if r == nil {
		return PanelMigration{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.migration
}

// InFallback 是目前是否处于回退态。
func (r *Router) InFallback() bool {
	return r.State().InFallback()
}

// NoteOutcome 把一次出站尝试的结果喂给唯一的判定，并在状态真的变化时留下日志
// （切换/备用也不可达都是运维事实，不能只在内存里发生）。
//
// 谁喂：状态上报（每次 sendState / 关闭时的 ReportOnce）与命令拉取（每次 pull）。
// 两条都是"这个地址到底通不通"的真实观测；共用同一个计数器意味着任一成功即清零、
// 连续失败到阈值即切 —— 阈值/期限规则本身没有改变，只是不再只有上报一条证据链。
// ACK 不单独喂：它紧跟在一次成功 pull 之后，单独失败不足以构成第二份证据（下一次
// pull 会立刻给出结论），把它计入会让一次坏 ACK 提前触发切换。
func (r *Router) NoteOutcome(outcome PanelOutcome, now time.Time) PanelRouteDecision {
	if r == nil {
		return PanelRouteDecision{}
	}
	r.mu.Lock()
	// 备用也不可达是一条**持续**状态，不是一次事件：命令轮询每 1s 出站一次，逐次
	// 打日志会把"两个地址都挂了"变成每秒一行的日志洪水。所以只在一条失败链的**起点**
	// 记录（任一次成功会清零计数，因此恢复后再次全挂会重新记录一次）。
	wasFallbackFailing := r.state.Active == PanelRouteFallback && r.state.ConsecutiveFailures > 0
	next, decision := DecidePanelRoute(r.state, r.migration, PanelRouteSignals{Now: now, Outcome: outcome})
	r.state = next
	migration, nodeID := r.migration, r.nodeID
	r.mu.Unlock()

	if decision.Switched {
		logx.Warn("panel migration: switching to the fallback panel",
			"node_id", nodeID,
			"migration_id", migration.MigrationID,
			"fallback_url", migration.FallbackURL,
			"reason", decision.Reason,
			"consecutive_failures", next.ConsecutiveFailures)
		return decision
	}
	if decision.FallbackFailing && !wasFallbackFailing {
		logx.Warn("panel migration: the fallback panel is unreachable too",
			"node_id", nodeID,
			"migration_id", migration.MigrationID,
			"fallback_url", migration.FallbackURL,
			"consecutive_failures", next.ConsecutiveFailures)
	}
	return decision
}
