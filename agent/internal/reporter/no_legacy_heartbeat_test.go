// F5（task-6）：Agent 到 Panel 只有**一条**出站通道，即经过认证的 state report。
//
// 背景：`/api/internal/heartbeat` 在 Panel 侧**从未存在过**（backend 的路由表里没有，
// git 历史上也从未出现），所以旧的"legacy heartbeat"每一跳都拿到 404，响应还被丢掉。
// 它不是兼容通道，而是一条死掉的第二生命体征通道 —— 已删除，不再是"未实现但仍在打"。
//
// 这两条用例用**真实 HTTP**（httptest + 生产传输 `httpPost`）钉住删除后的契约，
// 不是读源码字符串：
//  1. Run 只打 StatePath，且每一个请求都带凭据（不存在未鉴权的请求）；
//  2. 没有凭据时 Run 直接返回 ErrNoPanelURL，且**一个请求都不发**（旧行为会照打
//     一个未鉴权的 POST，这正是 404 噪音的来源）。
package reporter

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// recordingPanel 是**真实**的 HTTP 端点：reporter 通过生产传输（httpPost）打它，
// 因此这里记录到的就是网络上真实发生的事。
type recordingPanel struct {
	*httptest.Server
	mu    sync.Mutex
	paths []string
	auths []string
}

func newRecordingPanel(t *testing.T) *recordingPanel {
	t.Helper()
	p := &recordingPanel{}
	p.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		p.paths = append(p.paths, r.URL.Path)
		p.auths = append(p.auths, r.Header.Get(CredentialHeader))
		p.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		// 最小合法应答：state report 的 body 里只有 leases 有契约。
		_, _ = w.Write([]byte(`{"data":{"leases":[]}}`))
	}))
	t.Cleanup(p.Close)
	return p
}

func (p *recordingPanel) seen() (paths []string, auths []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.paths...), append([]string(nil), p.auths...)
}

// waitForRequests 等到至少 n 个请求真的到达端点（等真实事件，不猜时间）。
func (p *recordingPanel) waitForRequests(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if paths, _ := p.seen(); len(paths) >= n {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	paths, _ := p.seen()
	t.Fatalf("panel saw %d requests, want at least %d (%v)", len(paths), n, paths)
}

func TestRunOnlyPostsToTheStateEndpointWithACredential(t *testing.T) {
	panel := newRecordingPanel(t)
	r := New(Config{PanelURL: panel.URL, AgentID: "a1", NodeID: "n1", Credential: "cred"})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- r.Run(ctx) }()
	// Run 的第一次上报是立即的；等它到达真实端点再收摊。
	panel.waitForRequests(t, 1)
	cancel()
	if err := <-done; err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("Run returned %v, want nil or context.Canceled", err)
	}

	paths, auths := panel.seen()
	if len(paths) == 0 {
		t.Fatal("no request reached the panel: the state report never went out")
	}
	for i, path := range paths {
		if path != StatePath {
			t.Fatalf("request %d went to %q, want %q (the Agent has exactly one outbound channel)", i, path, StatePath)
		}
		if strings.Contains(path, "heartbeat") {
			t.Fatalf("request %d still hits a heartbeat endpoint (%q)", i, path)
		}
		if auths[i] != "Bearer cred" {
			t.Fatalf("request %d carried %q, want the node credential (no unauthenticated channel may exist)", i, auths[i])
		}
	}
}

func TestNoCredentialMeansNoRequestAtAll(t *testing.T) {
	panel := newRecordingPanel(t)
	// 只有 PanelURL、没有凭据：旧实现在这种情况下照样每 30s 打一个未鉴权的
	// /api/internal/heartbeat（就是那些 404）。
	r := New(Config{PanelURL: panel.URL, NodeID: "n1"})

	if err := r.Run(context.Background()); !errors.Is(err, ErrNoPanelURL) {
		t.Fatalf("Run = %v, want ErrNoPanelURL (nothing can be reported without a credential)", err)
	}
	paths, _ := panel.seen()
	if len(paths) != 0 {
		t.Fatalf("a credential-less reporter sent %v, want no request at all", paths)
	}
}
