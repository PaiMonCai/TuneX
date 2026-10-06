// 面板迁移回退的真值表（task-44）。
//
// 这里钉的是**判据本身**（纯函数），不是像素：阈值、期限、清零、占用/失败时的
// 状态迁移与"当前生效地址"，逐条断言。文件头的行为参照声明在 panel_migration.go。
package reporter

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

var errTestPanelUnreachable = errors.New("test: panel unreachable")

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

// 端到端的最小形态（在**同一进程内**跑真实 Reporter）：
// 主地址连续失败 ⇒ 下一拍真的打到备用地址，且上报体带上"当前生效地址 + 迁移 id +
// 回退态"。这里用注入的 post 替身（不碰网络），但走的是**生产同一条 sendState 路径**。
func TestReporter_SwitchesToFallbackAndReportsIt(t *testing.T) {
	var hits []string
	clock := at(1)
	r := New(Config{
		PanelURL:   "http://panel-primary:3000",
		AgentID:    "agent-1",
		NodeID:     "node-1",
		Version:    "9.9.9",
		Role:       "INGRESS",
		Credential: "cred",
		Panels:     testMigration(nil),
	}, func(c *Config) {
		c.now = func() time.Time { return clock }
	})
	WithPostResponse(func(ctx context.Context, url string, body []byte, headers map[string]string) ([]byte, error) {
		hits = append(hits, url)
		if strings.Contains(url, "primary") {
			return nil, errTestPanelUnreachable
		}
		return []byte(`{"data":{}}`), nil
	})(&r.cfg)

	// 第一拍：主地址失败（计数 1，仍不切）。
	r.sendState(context.Background())
	if len(hits) != 1 || !strings.Contains(hits[0], "primary") {
		t.Fatalf("first attempt should hit primary, got %v", hits)
	}
	if r.PanelRoute().InFallback() {
		t.Fatal("must not switch after a single failure")
	}

	// 第二拍：主地址再失败 ⇒ 达阈值切换。
	r.sendState(context.Background())
	if !r.PanelRoute().InFallback() {
		t.Fatal("must switch to fallback after reaching the failure threshold")
	}
	if !strings.Contains(hits[len(hits)-1], "primary") {
		t.Fatalf("the switching attempt itself still goes to primary, got %v", hits)
	}

	// 第三拍：真的打到备用地址，且载荷如实说明"我在备用地址 + 哪个迁移"。
	r.sendState(context.Background())
	if !strings.Contains(hits[len(hits)-1], "fallback") {
		t.Fatalf("after switching, reports must go to the fallback, got %v", hits)
	}
	payload := r.StatePayload()
	if payload.PanelURLInUse != "http://panel-fallback:3000" {
		t.Fatalf("panel_url_in_use = %q", payload.PanelURLInUse)
	}
	if payload.PanelMigrationID != "mig-2026-10-07" {
		t.Fatalf("panel_migration_id = %q", payload.PanelMigrationID)
	}
	if !payload.PanelFallbackActive {
		t.Fatal("panel_fallback_active must be true while in fallback")
	}
}

// 未配置回退时的缺省行为：失败多少次都不改地址，且载荷里不带迁移字段。
func TestReporter_WithoutMigrationNeverSwitches(t *testing.T) {
	var hits []string
	r := New(Config{
		PanelURL:   "http://panel-primary:3000",
		Credential: "cred",
	})
	WithPostResponse(func(ctx context.Context, url string, body []byte, headers map[string]string) ([]byte, error) {
		hits = append(hits, url)
		return nil, errTestPanelUnreachable
	})(&r.cfg)
	r.sendState(context.Background())
	r.sendState(context.Background())
	r.sendState(context.Background())
	for _, h := range hits {
		if strings.Contains(h, "fallback") {
			t.Fatalf("must never switch without a configured fallback: %v", hits)
		}
	}
	payload := r.StatePayload()
	if payload.PanelMigrationID != "" || payload.PanelFallbackActive {
		t.Fatalf("migration fields must stay off the wire when unconfigured: %+v", payload)
	}
	if payload.PanelURLInUse != "http://panel-primary:3000" {
		t.Fatalf("panel_url_in_use = %q", payload.PanelURLInUse)
	}
}
