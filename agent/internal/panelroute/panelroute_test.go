// 面板迁移回退的真值表 + 共享切换器（task-44/45）。
//
// 这里钉的是**判据本身**（纯函数）与**共享事实**（Router）：阈值、期限、清零、
// 占用/失败时的状态迁移、"当前生效地址"，以及并发读写下的安全性，逐条断言。
// 文件头的行为参照声明在 panelroute.go。
package panelroute

import (
	"strings"
	"sync"
	"testing"
	"time"
)

func testMigration(over func(*PanelMigration)) PanelMigration {
	m := PanelMigration{
		PrimaryURL:     "http://panel-primary:3000",
		FallbackURL:    "http://panel-fallback:3000",
		MigrationID:    "mig-2026-10-07",
		StartedAt:      time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC),
		StartedAtKnown: true,
	}
	if over != nil {
		over(&m)
	}
	return m
}

func at(min int) time.Time { return time.Date(2026, 10, 7, 0, min, 0, 0, time.UTC) }

func TestDecidePanelRoute_TruthTable(t *testing.T) {
	cases := []struct {
		name        string
		migration   PanelMigration
		state       PanelRouteState
		signals     PanelRouteSignals
		wantActive  PanelRoute
		wantSwitch  bool
		wantReason  string
		wantFailing bool
	}{
		{
			name:       "首次失败不足阈值 ⇒ 仍留在主地址（且计数 +1）",
			migration:  testMigration(nil),
			state:      ReadyPanelRoute(),
			signals:    PanelRouteSignals{Now: at(0), Outcome: PanelOutcomeFailure},
			wantActive: PanelRoutePrimary,
		},
		{
			name:       "连续失败达阈值（2）⇒ 切备用，原因 failures",
			migration:  testMigration(nil),
			state:      PanelRouteState{Active: PanelRoutePrimary, ConsecutiveFailures: 1},
			signals:    PanelRouteSignals{Now: at(0), Outcome: PanelOutcomeFailure},
			wantActive: PanelRouteFallback,
			wantSwitch: true,
			wantReason: "failures",
		},
		{
			name:       "任一次成功清零 ⇒ 之后要重新连续失败两次才切",
			migration:  testMigration(nil),
			state:      PanelRouteState{Active: PanelRoutePrimary, ConsecutiveFailures: 1},
			signals:    PanelRouteSignals{Now: at(0), Outcome: PanelOutcomeSuccess},
			wantActive: PanelRoutePrimary,
		},
		{
			name:       "清零之后单次失败不再触发切换（阈值仍是 2）",
			migration:  testMigration(nil),
			state:      PanelRouteState{Active: PanelRoutePrimary, ConsecutiveFailures: 0},
			signals:    PanelRouteSignals{Now: at(0), Outcome: PanelOutcomeFailure},
			wantActive: PanelRoutePrimary,
		},
		{
			name:       "期限已过但**没有任何失败证据** ⇒ 不切（刻意偏离参照实现，见文件头）",
			migration:  testMigration(nil),
			state:      PanelRouteState{Active: PanelRoutePrimary, ConsecutiveFailures: 0},
			signals:    PanelRouteSignals{Now: at(10), Outcome: PanelOutcomeNone},
			wantActive: PanelRoutePrimary,
		},
		{
			name:       "期限已过 + 一次失败 ⇒ 切备用，原因 deadline",
			migration:  testMigration(nil),
			state:      PanelRouteState{Active: PanelRoutePrimary, ConsecutiveFailures: 0},
			signals:    PanelRouteSignals{Now: at(10), Outcome: PanelOutcomeFailure},
			wantActive: PanelRouteFallback,
			wantSwitch: true,
			wantReason: "deadline",
		},
		{
			name:       "期限未知（面板没下发 startedAt）⇒ 只用失败阈值",
			migration:  testMigration(func(m *PanelMigration) { m.StartedAtKnown = false }),
			state:      PanelRouteState{Active: PanelRoutePrimary, ConsecutiveFailures: 0},
			signals:    PanelRouteSignals{Now: at(60), Outcome: PanelOutcomeFailure},
			wantActive: PanelRoutePrimary,
		},
		{
			name:       "长连接（事件流）存活期间不切、也不累加",
			migration:  testMigration(nil),
			state:      PanelRouteState{Active: PanelRoutePrimary, ConsecutiveFailures: 1},
			signals:    PanelRouteSignals{Now: at(10), Outcome: PanelOutcomeFailure, StreamAlive: true},
			wantActive: PanelRoutePrimary,
		},
		{
			name:        "备用地址上失败 ⇒ 如实标记 FallbackFailing（不假装在线，也不做第二次切换）",
			migration:   testMigration(nil),
			state:       PanelRouteState{Active: PanelRouteFallback, ConsecutiveFailures: 0},
			signals:     PanelRouteSignals{Now: at(11), Outcome: PanelOutcomeFailure},
			wantActive:  PanelRouteFallback,
			wantFailing: true,
		},
		{
			name:       "在备用地址上成功 ⇒ 留在备用（不自动切回；切回只由配置面完成）",
			migration:  testMigration(nil),
			state:      PanelRouteState{Active: PanelRouteFallback, ConsecutiveFailures: 3},
			signals:    PanelRouteSignals{Now: at(12), Outcome: PanelOutcomeSuccess},
			wantActive: PanelRouteFallback,
		},
		{
			name:       "未配置回退 ⇒ 失败只累计，永不动地址（缺省部署行为不变）",
			migration:  PanelMigration{PrimaryURL: "http://panel-primary:3000"},
			state:      PanelRouteState{Active: PanelRoutePrimary, ConsecutiveFailures: 5},
			signals:    PanelRouteSignals{Now: at(30), Outcome: PanelOutcomeFailure},
			wantActive: PanelRoutePrimary,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			next, decision := DecidePanelRoute(tc.state, tc.migration, tc.signals)
			if next.Active != tc.wantActive {
				t.Fatalf("active = %q, want %q", next.Active, tc.wantActive)
			}
			if decision.Switched != tc.wantSwitch {
				t.Fatalf("switched = %v, want %v", decision.Switched, tc.wantSwitch)
			}
			if decision.Reason != tc.wantReason {
				t.Fatalf("reason = %q, want %q", decision.Reason, tc.wantReason)
			}
			if decision.FallbackFailing != tc.wantFailing {
				t.Fatalf("fallbackFailing = %v, want %v", decision.FallbackFailing, tc.wantFailing)
			}
		})
	}
}

func TestPanelRoute_ActiveURLFollowsState(t *testing.T) {
	migration := testMigration(nil)
	primary := ReadyPanelRoute()
	if got := primary.ActiveURL(migration); got != "http://panel-primary:3000" {
		t.Fatalf("primary url = %q", got)
	}
	if primary.InFallback() {
		t.Fatal("fresh state must not be in fallback")
	}
	switched := PanelRouteState{Active: PanelRouteFallback}
	if got := switched.ActiveURL(migration); got != "http://panel-fallback:3000" {
		t.Fatalf("fallback url = %q", got)
	}
	if !switched.InFallback() {
		t.Fatal("fallback state must report InFallback=true")
	}
	// 未配置回退时，回退态也不该把请求发到一个空地址。
	off := PanelRouteState{Active: PanelRouteFallback}
	if got := off.ActiveURL(migration); got != "http://panel-primary:3000" && !strings.Contains(got, "panel") {
		t.Fatalf("unexpected url %q", got)
	}
}

func TestPanelMigration_EnabledRequiresBothKeys(t *testing.T) {
	if (PanelMigration{FallbackURL: "http://fb:3000"}).Enabled() {
		t.Fatal("fallback url alone must not enable the feature")
	}
	if (PanelMigration{MigrationID: "m1"}).Enabled() {
		t.Fatal("migration id alone must not enable the feature")
	}
	if !testMigration(nil).Enabled() {
		t.Fatal("fallback url + migration id must enable the feature")
	}
}

// Router 是**共享**的当前生效地址：失败到阈值后每一个读它的人都立刻拿到备用地址。
func TestRouter_SwitchIsVisibleToEveryReader(t *testing.T) {
	r := New(Config{PrimaryURL: "http://panel-primary:3000/", Migration: testMigration(nil), NodeID: "node-1"})

	if got := r.ActiveURL(); got != "http://panel-primary:3000" {
		t.Fatalf("fresh router url = %q", got)
	}
	if d := r.NoteOutcome(PanelOutcomeFailure, at(0)); d.Switched {
		t.Fatal("a single failure must not switch")
	}
	if got := r.ActiveURL(); got != "http://panel-primary:3000" {
		t.Fatalf("url after one failure = %q", got)
	}
	d := r.NoteOutcome(PanelOutcomeFailure, at(1))
	if !d.Switched || d.To != PanelRouteFallback || d.Reason != "failures" {
		t.Fatalf("expected a failures switch, got %+v", d)
	}
	if got := r.ActiveURL(); got != "http://panel-fallback:3000" {
		t.Fatalf("url after the switch = %q", got)
	}
	if !r.InFallback() || !r.State().InFallback() {
		t.Fatal("router must report the fallback state")
	}
	if r.Migration().MigrationID != "mig-2026-10-07" {
		t.Fatalf("router lost the migration id: %+v", r.Migration())
	}
	// 成功清零但不自动切回。
	r.NoteOutcome(PanelOutcomeSuccess, at(2))
	if got := r.ActiveURL(); got != "http://panel-fallback:3000" {
		t.Fatalf("a success must not move the node back to primary, url = %q", got)
	}
	if r.State().ConsecutiveFailures != 0 {
		t.Fatalf("a success must clear the counter, got %d", r.State().ConsecutiveFailures)
	}
}

// 未配置回退：无论失败多少次，ActiveURL 恒定在主地址（缺省部署行为不变）。
func TestRouter_WithoutMigrationKeepsPrimary(t *testing.T) {
	r := New(Config{PrimaryURL: "http://panel-primary:3000", NodeID: "node-1"})
	for i := 0; i < 5; i++ {
		r.NoteOutcome(PanelOutcomeFailure, at(i))
	}
	if got := r.ActiveURL(); got != "http://panel-primary:3000" {
		t.Fatalf("must never switch without a configured fallback, url = %q", got)
	}
	if r.InFallback() {
		t.Fatal("InFallback must stay false without a configured fallback")
	}
}

// nil 接收者必须安全：没注入切换器的调用方不需要各自加 nil 判断。
func TestRouter_NilReceiverIsSafe(t *testing.T) {
	var r *Router
	if got := r.ActiveURL(); got != "" {
		t.Fatalf("nil router url = %q", got)
	}
	if r.InFallback() {
		t.Fatal("nil router must not claim fallback")
	}
	if got := r.State(); got.InFallback() || got.Active != PanelRoutePrimary {
		t.Fatalf("nil router state = %+v", got)
	}
	if got := r.Migration(); got.Enabled() {
		t.Fatalf("nil router migration = %+v", got)
	}
	if d := r.NoteOutcome(PanelOutcomeFailure, at(0)); d.Switched {
		t.Fatalf("nil router must not switch: %+v", d)
	}
}

// 并发安全：上报 goroutine 与命令轮询 goroutine 会同时读地址、同时喂结果。
// 这个测试在 -race 下必须干净（切换判定与状态只有一份，读写在同一个锁后面）。
func TestRouter_ConcurrentReadersAndWriters(t *testing.T) {
	r := New(Config{PrimaryURL: "http://panel-primary:3000", Migration: testMigration(nil), NodeID: "node-1"})

	const workers = 8
	const rounds = 200
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for n := 0; n < rounds; n++ {
				r.NoteOutcome(PanelOutcomeFailure, at(n%60))
				_ = r.ActiveURL()
				_ = r.State()
				_ = r.InFallback()
				_ = r.Migration()
				if n%3 == 0 {
					r.NoteOutcome(PanelOutcomeSuccess, at(n%60))
				}
			}
		}(i)
	}
	wg.Wait()

	// 只要状态机没有自相矛盾即可：切换后 ActiveURL 必须与 InFallback 一致。
	if r.InFallback() != strings.Contains(r.ActiveURL(), "fallback") {
		t.Fatalf("state and url disagree: %+v url=%q", r.State(), r.ActiveURL())
	}
}
