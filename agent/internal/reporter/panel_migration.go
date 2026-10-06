// 面板迁移回退 —— 切换判据（**纯函数**，无 IO、无时钟读取）。
//
// ── 行为参照声明 ────────────────────────────────────────────────────────────
// 本文件的行为参照 ForwardX（AGPL-3.0）的 `agent/panel_migration.go`：备用面板
// 地址 + 迁移 id + 迁移起始时间的三元组、阈值 `fallbackFailures = 2`、
// 期限 `fallbackDeadline = 3min`、**任一次成功即清零**、以及"已建立事件流期间不切"。
// TuneX 侧为**独立实现**：判据被抽成纯函数 + 显式状态机（便于真值表测试与审计），
// 命名、状态与上报口径按本项目契约重写，未逐字复制。
//
// ── 与参照实现的两处**刻意偏离**（都写在报告里，不是遗漏）──
//  1. **期限不是"单独成立就切"**。参照实现是「失败 ≥2 **或** 距 startedAt ≥3min」。
//     在 TuneX 里，"距 startedAt 已过 3 分钟"单独成立并不构成"主地址不可达"的证据：
//     一次已经完成的面板迁移会让所有健康节点在 3 分钟后集体切走。这里要求期限**与
//     至少一次失败同时成立**（见 decideLocked 的 `deadline && failures > 0`）。
//  2. **在备用地址上成功不自动切回主地址**。"切回"只由人在配置面完成（重新下发
//     agent.env 后重启，或换一个迁移 id）。理由是避免面板抖动时来回切换造成上报空档；
//     同一个节点反复切地址会让面板侧看到"同一 node 在两个地址间闪"。
//
// ── TuneX 没有"事件流" ──
// 参照实现有一类"长连接/事件流存活期间不切"的判据。TuneX 的 Agent **只主动出站**
// （命令轮询 + 状态上报），面板从不回拨，因此没有等价的"流"。本文件把这个信号保留
// 为显式输入（`StreamAlive`）：调用方若将来引入长连接，只需把它置 true 即可复用同一
// 判据；当前生产路径恒为 false，并在注释里写明这一点，避免"看起来有、其实没有"。
package reporter

import (
	"strings"
	"time"
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
// 零值（两个字段都空）= 本能力未配置；此时 RoutePanel 只做失败计数，永不切换。
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

// Ready 返回可直接用于首次运行的初始状态（主地址）。
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
// 判据（真值表见 panel_migration_test.go）：
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
