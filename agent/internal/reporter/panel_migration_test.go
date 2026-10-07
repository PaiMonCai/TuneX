// 面板迁移回退在 **Reporter 侧**的行为（task-44/45）。
//
// 判据真值表已随实现搬到 internal/panelroute（那个包里逐条断言阈值/期限/清零/地址）。
// 这里钉的是 reporter 与共享切换器的**接线**：
//
//	· 主地址连续失败 ⇒ 下一拍真的打到备用地址，载荷如实说明"在备用 + 哪个迁移"；
//	· 未配置回退 ⇒ 失败多少次都不改地址，载荷不带迁移字段；
//	· 注入的共享 Router 才是地址来源（reporter 不得自建一份私有状态，否则命令拉取
//	  仍然盯着主地址 —— 那正是 task-45 修掉的 P1）。
package reporter

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/tunex/agent/internal/panelroute"
)

var errTestPanelUnreachable = errors.New("test: panel unreachable")

func testMigration(over func(*panelroute.PanelMigration)) panelroute.PanelMigration {
	m := panelroute.PanelMigration{
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

// task-45 的回归钉：注入的**共享** Router 才是地址来源。
//
// 两个方向都要成立，否则 P1 会以另一种形态回来：
//
//	· 别的出站面（命令拉取）先失败切到备用 ⇒ 上报必须立刻跟着打备用（不再自己判定）；
//	· 上报自己失败到阈值 ⇒ 共享 Router 也进入回退态，命令拉取下一次就能看到。
func TestReporter_UsesInjectedSharedRouter(t *testing.T) {
	migration := testMigration(nil)
	router := panelroute.New(panelroute.Config{
		PrimaryURL: "http://panel-primary:3000",
		Migration:  migration,
		NodeID:     "node-1",
	})

	// 方向一：路由已被**别的模块**推进到备用（模拟命令拉取连续失败）。
	router.NoteOutcome(panelroute.PanelOutcomeFailure, at(0))
	router.NoteOutcome(panelroute.PanelOutcomeFailure, at(1))
	if !router.InFallback() {
		t.Fatal("precondition: the shared router should be in fallback")
	}

	var hits []string
	r := New(Config{
		PanelURL:   "http://panel-primary:3000",
		AgentID:    "agent-1",
		NodeID:     "node-1",
		Credential: "cred",
		Panels:     migration,
		Router:     router,
	}, WithNow(func() time.Time { return at(2) }))
	WithPostResponse(func(ctx context.Context, url string, body []byte, headers map[string]string) ([]byte, error) {
		hits = append(hits, url)
		return []byte(`{"data":{}}`), nil
	})(&r.cfg)

	r.sendState(context.Background())
	if len(hits) != 1 || !strings.Contains(hits[0], "panel-fallback") {
		t.Fatalf("the report must follow the shared active address, got %v", hits)
	}
	if got := r.StatePayload().PanelURLInUse; got != "http://panel-fallback:3000" {
		t.Fatalf("panel_url_in_use = %q", got)
	}

	// 方向二：接线上报自己的失败，共享 Router 必须看到（不是私有副本）。
	fresh := panelroute.New(panelroute.Config{PrimaryURL: "http://panel-primary:3000", Migration: migration})
	r2 := New(Config{
		PanelURL:   "http://panel-primary:3000",
		Credential: "cred",
		Panels:     migration,
		Router:     fresh,
	}, WithNow(func() time.Time { return at(3) }))
	WithPostResponse(func(ctx context.Context, url string, body []byte, headers map[string]string) ([]byte, error) {
		return nil, errTestPanelUnreachable
	})(&r2.cfg)
	r2.sendState(context.Background())
	r2.sendState(context.Background())
	if !fresh.InFallback() {
		t.Fatal("the report's failures must reach the injected shared router")
	}
	if got := fresh.ActiveURL(); got != "http://panel-fallback:3000" {
		t.Fatalf("shared router url = %q", got)
	}
}
