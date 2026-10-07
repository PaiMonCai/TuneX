package control

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tunex/agent/internal/manager"
	"github.com/tunex/agent/internal/panelroute"
	"github.com/tunex/agent/internal/selfinfo"
)

// task-45 的回归钉：命令拉取与 ACK 必须跟**共享切换器**走，而不是各拿一份
// cfg.PanelURL。
//
// 两个 httptest 服务器：主地址一律 502（不可达），备用地址正常应答。触发切换的
// 失败由本轮的 pull 自己产生（control 也把结果喂给同一个判定），所以这里不需要
// 借助 reporter —— 这正是"不在每个模块复制切换判定"的意思：判定只有一处，
// 谁出站谁喂结果，谁出站谁读当前地址。

// twoPanels is the migration triple as agentconfig parses it: the primary as
// configured, the fallback as the (here: real httptest) fallback address.
func twoPanels(primaryURL, fallbackURL string) panelroute.PanelMigration {
	return panelroute.PanelMigration{
		PrimaryURL:  primaryURL,
		FallbackURL: fallbackURL,
		MigrationID: "mig-2026-10-07",
	}
}

// hitLog records what a stub panel received. Handlers run on server goroutines, so
// every read/write is behind a mutex (the tests run under -race).
type hitLog struct {
	mu    sync.Mutex
	paths []string
	auth  []string
}

func (h *hitLog) add(r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.paths = append(h.paths, r.URL.Path)
	h.auth = append(h.auth, r.Header.Get("Authorization"))
}

func (h *hitLog) saw(path string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, p := range h.paths {
		if p == path {
			return true
		}
	}
	return false
}

func (h *hitLog) count(path string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, p := range h.paths {
		if p == path {
			n++
		}
	}
	return n
}

func (h *hitLog) allCredentials() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.auth...)
}

// deadPanel is a reachable TCP endpoint that never manages to answer a usable
// response — the "primary is unreachable" shape without killing the listener.
func deadPanel(hits *hitLog) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.add(r)
		w.WriteHeader(http.StatusBadGateway)
	}))
}

// livePanel answers the control endpoints the way a healthy panel does: one
// collect_diagnostics command to hand out, ACKs accepted.
func livePanel(hits *hitLog) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.add(r)
		switch r.URL.Path {
		case commandsPath:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"command":{"envelope":{"command_id":"cmd-1","resource_id":"node-1","revision":7,"action":"collect_diagnostics"}}}}`))
		case ackPath:
			_, _ = w.Write([]byte(`{"data":{}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func newSharedClient(t *testing.T, router *panelroute.Router, primaryURL string) *Client {
	t.Helper()
	egress := manager.NewEgressManager()
	return New(Config{
		PanelURL:   primaryURL,
		Credential: "cred",
		Router:     router,
		DescribeSelf: func() selfinfo.Facts {
			return selfinfo.Facts{Version: "test"}
		},
	}, manager.NewTunnelManager(egress, "127.0.0.1"), egress)
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

func TestPullAndAckFollowSharedFallbackRouter(t *testing.T) {
	var primaryHits, fallbackHits hitLog
	primary := deadPanel(&primaryHits)
	defer primary.Close()
	fallback := livePanel(&fallbackHits)
	defer fallback.Close()

	router := panelroute.New(panelroute.Config{
		PrimaryURL: primary.URL,
		Migration:  twoPanels(primary.URL, fallback.URL),
		NodeID:     "node-1",
	})
	client := newSharedClient(t, router, primary.URL)

	stop := startRun(client)
	waitFor(t, "commands pulled from the fallback", 10*time.Second, func() bool {
		return fallbackHits.count(commandsPath) > 0 && fallbackHits.count(ackPath) > 0
	})
	stop()

	if !router.InFallback() {
		t.Fatalf("pull failures must drive the shared router into fallback, state=%+v", router.State())
	}
	if got := router.ActiveURL(); got != fallback.URL {
		t.Fatalf("active url = %q, want the fallback %q", got, fallback.URL)
	}
	if !fallbackHits.saw(commandsPath) {
		t.Fatal("the command pull must reach the fallback")
	}
	if !fallbackHits.saw(ackPath) {
		t.Fatal("the ACK must reach the fallback")
	}
	// 认证边界不变：每一条到备用地址的请求都带同一个 per-node 凭据。
	for _, auth := range fallbackHits.allCredentials() {
		if auth != "Bearer cred" {
			t.Fatalf("fallback request carried %q, want the node credential", auth)
		}
	}
	// 切换确实由本轮的失败触发：主地址先收到过请求。
	if primaryHits.count(commandsPath) < 1 {
		t.Fatal("the primary must have been tried before the switch")
	}
}

// 未配置回退：pull/ACK 永远走原地址，失败只累计不切地址。
func TestPullAndAckStayOnPrimaryWithoutMigration(t *testing.T) {
	var primaryHits, fallbackHits hitLog
	primary := deadPanel(&primaryHits)
	defer primary.Close()
	fallback := livePanel(&fallbackHits)
	defer fallback.Close()

	// 只给主地址：即便备用服务器还活着，也没有任何配置指向它。
	router := panelroute.New(panelroute.Config{PrimaryURL: primary.URL})
	client := newSharedClient(t, router, primary.URL)

	stop := startRun(client)
	waitFor(t, "failed pulls against the primary", 10*time.Second, func() bool {
		return primaryHits.count(commandsPath) >= 3
	})
	stop()

	if router.InFallback() {
		t.Fatalf("must never switch without a configured fallback, state=%+v", router.State())
	}
	if got := router.ActiveURL(); got != primary.URL {
		t.Fatalf("active url = %q, want the primary %q", got, primary.URL)
	}
	if fallbackHits.saw(commandsPath) || fallbackHits.saw(ackPath) {
		t.Fatalf("unconfigured fallback must not be contacted: %+v", fallbackHits.paths)
	}
}

// 地址是**每次请求**取的：切换发生后不需要重建 client、更不需要重启进程。
func TestBaseURLFollowsRouterSwitchWithoutRebuild(t *testing.T) {
	router := panelroute.New(panelroute.Config{
		PrimaryURL: "http://panel-primary.invalid",
		Migration: panelroute.PanelMigration{
			FallbackURL: "http://panel-fallback.invalid",
			MigrationID: "mig-2026-10-07",
		},
	})
	client := newSharedClient(t, router, "http://panel-primary.invalid")

	if got := client.baseURL(); got != "http://panel-primary.invalid" {
		t.Fatalf("base url before switch = %q", got)
	}
	router.NoteOutcome(panelroute.PanelOutcomeFailure, time.Now())
	router.NoteOutcome(panelroute.PanelOutcomeFailure, time.Now())
	if !strings.HasSuffix(client.baseURL(), "panel-fallback.invalid") {
		t.Fatalf("base url after switch = %q", client.baseURL())
	}
	// 已切则不自动切回；一次成功只清零计数。
	router.NoteOutcome(panelroute.PanelOutcomeSuccess, time.Now())
	if !strings.HasSuffix(client.baseURL(), "panel-fallback.invalid") {
		t.Fatalf("a success must not move the agent back: %q", client.baseURL())
	}
}
