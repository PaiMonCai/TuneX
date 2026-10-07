package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tunex/agent/internal/agentconfig"
	"github.com/tunex/agent/internal/control"
	"github.com/tunex/agent/internal/manager"
	"github.com/tunex/agent/internal/panelroute"
	"github.com/tunex/agent/internal/reporter"
	"github.com/tunex/agent/internal/restore"
	"github.com/tunex/agent/internal/selfinfo"
)

// task-45 的端到端回归钉（P1）：主地址不可达、备用可达时，**四条出站控制面**
// 必须全部落到备用地址，而不是只有状态上报切过去。
//
//	· 状态上报  POST /api/internal/node/state
//	· 命令拉取  GET  /api/internal/node/commands
//	· ACK 回执  POST /api/internal/node/ack
//	· 重连对账  GET  /api/internal/node/desired（reconcileWithPanel 的真实路径）
//
// 两个 httptest 服务器：主地址对一切请求回 502（"主地址不可达"），备用地址正常应答。
// 这里用的是**生产同一套接线**（共享 panelroute.Router 注入 reporter + control，
// Reconnected 调 reconcileWithPanel），不是替身，所以任何"某个模块自己拿
// cfg.PanelHTTPURL 拼请求"的回归都会在这里失败。

const (
	commandsPath = "/api/internal/node/commands"
	ackPath      = "/api/internal/node/ack"
	desiredPath  = "/api/internal/node/desired"
	statePath    = reporter.StatePath
)

type hitEntry struct {
	path string
	auth string
	body string
}

type hitLog struct {
	mu      sync.Mutex
	entries []hitEntry
}

func (h *hitLog) add(r *http.Request) {
	var body string
	if r.Body != nil {
		raw, _ := io.ReadAll(io.LimitReader(r.Body, reporter.MaxAnswerBytes))
		body = string(raw)
	}
	h.mu.Lock()
	h.entries = append(h.entries, hitEntry{path: r.URL.Path, auth: r.Header.Get("Authorization"), body: body})
	h.mu.Unlock()
}

func (h *hitLog) count(path string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, e := range h.entries {
		if e.path == path {
			n++
		}
	}
	return n
}

func (h *hitLog) saw(path string) bool { return h.count(path) > 0 }

func (h *hitLog) bodies(path string) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for _, e := range h.entries {
		if e.path == path {
			out = append(out, e.body)
		}
	}
	return out
}

func (h *hitLog) credentials() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.entries))
	for _, e := range h.entries {
		out = append(out, e.auth)
	}
	return out
}

// unreachablePanel is reachable at the TCP level and never answers anything usable.
func unreachablePanel(hits *hitLog) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.add(r)
		w.WriteHeader(http.StatusBadGateway)
	}))
}

// healthyPanel answers every control-plane endpoint the agent uses.
func healthyPanel(hits *hitLog) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.add(r)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case commandsPath:
			_, _ = io.WriteString(w, `{"data":{"command":{"envelope":{"command_id":"cmd-1","resource_id":"node-1","revision":7,"action":"collect_diagnostics"}}}}`)
		case ackPath:
			_, _ = io.WriteString(w, `{"data":{}}`)
		case desiredPath:
			// Authoritative "nothing is desired here": valid, and prune-safe.
			_, _ = io.WriteString(w, `{"data":{"snapshot":{"version":"v1","tunnels":[]}}}`)
		case statePath:
			_, _ = io.WriteString(w, `{"data":{"leases":[]}}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

// panelHarness is the production wiring of one process: ONE shared router, one
// reporter and one control client, both pointed at it.
type panelHarness struct {
	primary, fallback         *httptest.Server
	primaryHits, fallbackHits *hitLog
	router                    *panelroute.Router
	client                    *control.Client
	heart                     *reporter.Reporter
}

func newPanelHarness(t *testing.T, withFallback bool) *panelHarness {
	t.Helper()

	primaryHits, fallbackHits := &hitLog{}, &hitLog{}
	primary := unreachablePanel(primaryHits)
	t.Cleanup(primary.Close)
	fallback := healthyPanel(fallbackHits)
	t.Cleanup(fallback.Close)

	cfg := &agentconfig.Config{
		PanelHTTPURL:   primary.URL,
		NodeCredential: "cred",
		NodeID:         "node-1",
		AgentID:        "agent-1",
	}

	migration := panelroute.PanelMigration{}
	if withFallback {
		migration = panelroute.PanelMigration{
			PrimaryURL:  primary.URL,
			FallbackURL: fallback.URL,
			MigrationID: "mig-2026-10-07",
		}
	}

	// The shared router is built before either component, exactly like runtime.go.
	router := panelroute.New(panelroute.Config{
		PrimaryURL: primary.URL,
		Migration:  migration,
		NodeID:     "node-1",
	})

	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")

	client := control.New(control.Config{
		PanelURL:   primary.URL,
		Credential: "cred",
		Router:     router,
		DescribeSelf: func() selfinfo.Facts {
			return selfinfo.Facts{Version: "test"}
		},
		Reconnected: func(rctx context.Context) {
			reconcileWithPanel(rctx, cfg, router, tunnels, egress, restore.LKG{})
		},
	}, tunnels, egress)

	heart := reporter.New(reporter.Config{
		PanelURL:   primary.URL,
		Panels:     migration,
		Router:     router,
		AgentID:    "agent-1",
		NodeID:     "node-1",
		Version:    "test",
		Role:       "BOTH",
		Credential: "cred",
	})

	return &panelHarness{
		primary: primary, fallback: fallback,
		primaryHits: primaryHits, fallbackHits: fallbackHits,
		router: router, client: client, heart: heart,
	}
}

func waitFor(t *testing.T, what string, deadline time.Duration, ok func() bool) {
	t.Helper()
	end := time.Now().Add(deadline)
	for time.Now().Before(end) {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func assertCredentialBoundary(t *testing.T, hits *hitLog, server string) {
	t.Helper()
	for _, auth := range hits.credentials() {
		if auth != "Bearer cred" {
			t.Fatalf("%s received %q, want the per-node credential", server, auth)
		}
	}
}

// 状态上报的失败先触发切换，随后命令拉取 / ACK / desired 对账都必须跟着切换。
//
// 这正是 task-44 的缺口：上报切了，控制面没有。旧代码在这里会看到主地址收到
// /commands（而它已经 502），也就是节点"面板上在线、命令永远收不到"。
func TestPanelFallback_ReportFailureMovesEveryControlPlane(t *testing.T) {
	h := newPanelHarness(t, true)
	ctx := context.Background()

	// 两次上报失败 ⇒ 达到阈值，切到备用。
	_ = h.heart.ReportOnce(ctx)
	if h.router.InFallback() {
		t.Fatal("must not switch after a single failure")
	}
	_ = h.heart.ReportOnce(ctx)
	if !h.router.InFallback() {
		t.Fatalf("report failures must switch the shared router, state=%+v", h.router.State())
	}
	if h.primaryHits.count(statePath) != 2 {
		t.Fatalf("expected both trigger reports on the primary, got %d", h.primaryHits.count(statePath))
	}

	// 控制面随后启动（模拟"重启后先跟主地址说话、失败、再切"）：它一次都不许
	// 打向已死的主地址，desired 对账也必须走备用。
	h.client.MarkStartupFromCache()
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() { _ = h.client.Run(runCtx) }()

	waitFor(t, "control plane on the fallback", 10*time.Second, func() bool {
		return h.fallbackHits.saw(commandsPath) &&
			h.fallbackHits.saw(ackPath) &&
			h.fallbackHits.saw(desiredPath)
	})
	cancel()

	// 上报也必须跟着共享地址走（不需要重新判定）。
	if err := h.heart.ReportOnce(ctx); err != nil {
		t.Fatalf("the post-switch report must be accepted by the fallback: %v", err)
	}
	if !h.fallbackHits.saw(statePath) {
		t.Fatalf("the state report must reach the fallback, hits=%+v", h.fallbackHits.entries)
	}

	// 主地址在切换之后不得再收到任何控制面请求。
	if h.primaryHits.saw(commandsPath) || h.primaryHits.saw(ackPath) || h.primaryHits.saw(desiredPath) {
		t.Fatalf("the dead primary must not receive control traffic after the switch: commands=%d ack=%d desired=%d",
			h.primaryHits.count(commandsPath), h.primaryHits.count(ackPath), h.primaryHits.count(desiredPath))
	}
	assertCredentialBoundary(t, h.fallbackHits, "fallback")

	// ACK 必须是这次命令的真实回执，而不是"打到了但内容空"。
	acks := h.fallbackHits.bodies(ackPath)
	if len(acks) == 0 || !strings.Contains(acks[len(acks)-1], `"command_id":"cmd-1"`) {
		t.Fatalf("the ACK body must answer the pulled command, got %v", acks)
	}
	// 上报体必须如实说明"我在备用地址 + 哪个迁移"。
	states := h.fallbackHits.bodies(statePath)
	if len(states) == 0 {
		t.Fatal("no state payload recorded on the fallback")
	}
	var payload reporter.StatePayload
	if err := json.Unmarshal([]byte(states[len(states)-1]), &payload); err != nil {
		t.Fatalf("state payload is not JSON: %v", err)
	}
	if payload.PanelURLInUse != h.fallback.URL {
		t.Fatalf("panel_url_in_use = %q, want %q", payload.PanelURLInUse, h.fallback.URL)
	}
	if !payload.PanelFallbackActive || payload.PanelMigrationID != "mig-2026-10-07" {
		t.Fatalf("state payload must report the fallback state: %+v", payload)
	}
}

// 命令拉取自己的连续失败也能触发切换（控制面共用同一个判定），切换后四条链路
// 一起落到备用。
func TestPanelFallback_ControlFailureSwitchesAndReconciles(t *testing.T) {
	h := newPanelHarness(t, true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() { _ = h.client.Run(ctx) }()

	waitFor(t, "pull/ack/desired on the fallback", 10*time.Second, func() bool {
		return h.fallbackHits.saw(commandsPath) &&
			h.fallbackHits.saw(ackPath) &&
			h.fallbackHits.saw(desiredPath)
	})

	if !h.router.InFallback() {
		t.Fatalf("pull failures must switch the shared router, state=%+v", h.router.State())
	}
	if h.primaryHits.count(commandsPath) < 2 {
		t.Fatalf("the switch must be triggered by failed pulls on the primary, got %d",
			h.primaryHits.count(commandsPath))
	}
	if err := h.heart.ReportOnce(ctx); err != nil {
		t.Fatalf("the state report must be accepted by the fallback: %v", err)
	}
	if !h.fallbackHits.saw(statePath) {
		t.Fatal("the state report must follow the shared active address")
	}
	assertCredentialBoundary(t, h.fallbackHits, "fallback")
}

// 未配置回退：一切照旧走主地址，失败只累计、不换地址（缺省部署行为不变）。
func TestPanelFallback_WithoutMigrationStaysOnPrimary(t *testing.T) {
	h := newPanelHarness(t, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 上报：失败多次也不得改地址，载荷不得带迁移字段。
	for i := 0; i < 3; i++ {
		_ = h.heart.ReportOnce(ctx)
	}
	if h.router.InFallback() {
		t.Fatal("must never switch without a configured fallback")
	}
	if got := h.router.ActiveURL(); got != h.primary.URL {
		t.Fatalf("active url = %q, want the primary %q", got, h.primary.URL)
	}
	states := h.primaryHits.bodies(statePath)
	if len(states) != 3 {
		t.Fatalf("expected 3 reports on the primary, got %d", len(states))
	}
	var payload reporter.StatePayload
	if err := json.Unmarshal([]byte(states[len(states)-1]), &payload); err != nil {
		t.Fatalf("state payload is not JSON: %v", err)
	}
	if payload.PanelFallbackActive || payload.PanelMigrationID != "" {
		t.Fatalf("no migration fields may ride the wire when unconfigured: %+v", payload)
	}
	if payload.PanelURLInUse != h.primary.URL {
		t.Fatalf("panel_url_in_use = %q, want %q", payload.PanelURLInUse, h.primary.URL)
	}

	// 命令拉取同样只打主地址。
	go func() { _ = h.client.Run(ctx) }()
	waitFor(t, "failed pulls against the primary", 10*time.Second, func() bool {
		return h.primaryHits.count(commandsPath) >= 3
	})
	if h.fallbackHits.count(commandsPath) != 0 || h.fallbackHits.count(ackPath) != 0 ||
		h.fallbackHits.count(desiredPath) != 0 || h.fallbackHits.count(statePath) != 0 {
		t.Fatalf("an unconfigured fallback must not be contacted: %+v", h.fallbackHits.entries)
	}
}

// 共享切换器必须早于两条出站 goroutine 建好，且两条链路拿到的是**同一个**指针。
// 这个测试钉的是"接线"本身：注入错一个（比如给 reporter 传了 nil）就会退化。
func TestPanelFallback_HarnessSharesOneRouter(t *testing.T) {
	h := newPanelHarness(t, true)
	if h.router.ActiveURL() != h.primary.URL {
		t.Fatalf("fresh router url = %q", h.router.ActiveURL())
	}
	// 由上报侧驱动一次切换，控制面 client 必须立刻看到（不需要重启）。
	h.router.NoteOutcome(panelroute.PanelOutcomeFailure, time.Now())
	h.router.NoteOutcome(panelroute.PanelOutcomeFailure, time.Now())
	if h.router.ActiveURL() != h.fallback.URL {
		t.Fatalf("router url after switch = %q", h.router.ActiveURL())
	}
	if h.heart.StateEndpoint() != h.fallback.URL+statePath {
		t.Fatalf("reporter endpoint = %q", h.heart.StateEndpoint())
	}
}
