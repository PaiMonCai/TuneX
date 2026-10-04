package restore

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/manager"
)

// The HTTP source's whole job is classification: only an outage may fall back to
// cached state, and an explicitly empty tunnel list must not be confused with a
// missing snapshot key.

func desiredServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer cred-1" {
			t.Errorf("source must send the node credential, got %q", got)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestHTTPSourceClassifiesResponses(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		kind   FetchErrorKind
	}{
		{"500 is an outage", 500, `{}`, FetchUnreachable},
		{"503 is an outage", 503, `{}`, FetchUnreachable},
		{"401 is authorization, not an outage", 401, `{}`, FetchUnauthorized},
		{"403 is authorization, not an outage", 403, `{}`, FetchUnauthorized},
		{"404 is authorization, not an outage", 404, `{}`, FetchUnauthorized},
		{"300 is a bad payload", 300, `{}`, FetchBadPayload},
		{"200 without snapshot is a bad payload", 200, `{"data":{}}`, FetchBadPayload},
		{"200 with null snapshot is a bad payload", 200, `{"data":{"snapshot":null}}`, FetchBadPayload},
		{"200 without tunnels key is a bad payload", 200, `{"data":{"snapshot":{"version":"v1"}}}`, FetchBadPayload},
		{"200 with invalid json is a bad payload", 200, `{`, FetchBadPayload},
		{"200 with unknown mode is a bad payload", 200, `{"data":{"snapshot":{"version":"v1","tunnels":[{"id":"a","mode":"UDP"}]}}}`, FetchBadPayload},
		{"200 with an id-less tunnel is a bad payload", 200, `{"data":{"snapshot":{"version":"v1","tunnels":[{"mode":"DIRECT"}]}}}`, FetchBadPayload},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := desiredServer(t, tc.status, tc.body)
			src := HTTPSource{PanelURL: srv.URL, Credential: "cred-1"}
			_, err := src.FetchSnapshot(context.Background())
			var fe *FetchError
			if !errors.As(err, &fe) {
				t.Fatalf("expected a classified FetchError, got %v", err)
			}
			if fe.Kind != tc.kind {
				t.Fatalf("expected kind %q, got %q (%v)", tc.kind, fe.Kind, err)
			}
		})
	}
}

// An explicitly empty list IS authoritative: this node simply has no desired
// tunnels, and that must not be treated as a broken answer.
func TestHTTPSourceAcceptsAuthoritativeEmptyList(t *testing.T) {
	srv := desiredServer(t, 200, `{"data":{"snapshot":{"version":"v1","tunnels":[]}}}`)
	src := HTTPSource{PanelURL: srv.URL, Credential: "cred-1"}
	snap, err := src.FetchSnapshot(context.Background())
	if err != nil {
		t.Fatalf("an empty tunnel list is valid: %v", err)
	}
	if snap == nil || len(snap.Tunnels) != 0 {
		t.Fatalf("expected a valid empty snapshot, got %+v", snap)
	}
	if IsOutage(err) {
		t.Fatal("a successful fetch is not an outage")
	}
}

func TestHTTPSourceRejectsOversizedBody(t *testing.T) {
	srv := desiredServer(t, 200, `{"data":{"snapshot":{"version":"v1","tunnels":[{"id":"`+strings.Repeat("x", 500)+`","mode":"DIRECT"}]}}}`)
	src := HTTPSource{PanelURL: srv.URL, Credential: "cred-1", MaxBytes: 64}
	_, err := src.FetchSnapshot(context.Background())
	var fe *FetchError
	if !errors.As(err, &fe) || fe.Kind != FetchBadPayload {
		t.Fatalf("an oversized body must be a bad payload, got %v", err)
	}
}

func TestHTTPSourceTransportFailureIsOutage(t *testing.T) {
	srv := desiredServer(t, 200, `{}`)
	srv.Close() // nothing is listening now
	src := HTTPSource{PanelURL: srv.URL, Credential: "cred-1", Client: &http.Client{Timeout: time.Second}}
	_, err := src.FetchSnapshot(context.Background())
	if !IsOutage(err) {
		t.Fatalf("a dial failure must be an outage, got %v", err)
	}
}

func TestHTTPSourceMissingConfig(t *testing.T) {
	if _, err := (HTTPSource{}).FetchSnapshot(context.Background()); !errors.Is(err, ErrNoPanel) {
		t.Fatalf("no panel configured must be ErrNoPanel, got %v", err)
	}
}

// ── fallback policy ──────────────────────────────────────────────────────────

type stubSource struct {
	snap *Snapshot
	err  error
}

func (s stubSource) FetchSnapshot(context.Context) (*Snapshot, error) { return s.snap, s.err }

func outage() error  { return &FetchError{Kind: FetchUnreachable} }
func denied() error  { return &FetchError{Kind: FetchUnauthorized, Status: 401} }
func badBody() error { return &FetchError{Kind: FetchBadPayload} }

func cacheWith(t *testing.T, agentID string, ids ...string) LKG {
	t.Helper()
	cache := LKG{Path: filepath.Join(t.TempDir(), "desired-lkg.json")}
	if len(ids) > 0 {
		if err := cache.Save(agentID, snap(t, "v1", ids...)); err != nil {
			t.Fatalf("seed cache: %v", err)
		}
	}
	return cache
}

func TestFetchAuthoritativePrefersPanel(t *testing.T) {
	cache := cacheWith(t, "agent-1", "stale")
	got, source, err := FetchAuthoritative(context.Background(), stubSource{snap: snap(t, "v2", "fresh")}, cache, "agent-1")
	if err != nil {
		t.Fatalf("panel answer must be used: %v", err)
	}
	if source != SourcePanel || len(got.Tunnels) != 1 || got.Tunnels[0].ID != "fresh" {
		t.Fatalf("expected the panel snapshot, got source=%q %+v", source, got)
	}
}

func TestFetchAuthoritativeFallsBackOnlyOnOutage(t *testing.T) {
	cache := cacheWith(t, "agent-1", "cached-1")
	got, source, err := FetchAuthoritative(context.Background(), stubSource{err: outage()}, cache, "agent-1")
	if err != nil {
		t.Fatalf("an outage must fall back to the cache: %v", err)
	}
	if source != SourceLKG || len(got.Tunnels) != 1 || got.Tunnels[0].ID != "cached-1" {
		t.Fatalf("expected the cached snapshot, got source=%q %+v", source, got)
	}

	// Authorization failures and unparseable answers must NOT fall back: cached
	// state may describe work the panel has since revoked.
	for name, errIn := range map[string]error{"denied": denied(), "bad payload": badBody()} {
		if _, source, err := FetchAuthoritative(context.Background(), stubSource{err: errIn}, cache, "agent-1"); err == nil {
			t.Fatalf("%s must fail closed, got source=%q", name, source)
		} else if source != "" {
			t.Fatalf("%s must not report a source, got %q", name, source)
		}
	}
}

func TestFetchAuthoritativeOutageWithoutCacheFails(t *testing.T) {
	empty := cacheWith(t, "agent-1")
	if _, _, err := FetchAuthoritative(context.Background(), stubSource{err: outage()}, empty, "agent-1"); !IsOutage(err) {
		t.Fatalf("an outage with no cache must surface the outage, got %v", err)
	}
	// A cache belonging to another agent is not a usable cache either.
	other := cacheWith(t, "agent-2", "not-mine")
	if _, _, err := FetchAuthoritative(context.Background(), stubSource{err: outage()}, other, "agent-1"); !IsOutage(err) {
		t.Fatalf("another agent's cache must not be adopted, got %v", err)
	}
}

func TestFetchAuthoritativeNoSource(t *testing.T) {
	if _, _, err := FetchAuthoritative(context.Background(), nil, LKG{}, "agent-1"); !errors.Is(err, ErrNoPanel) {
		t.Fatalf("no source must be ErrNoPanel, got %v", err)
	}
}

// ── applied-subset caching ───────────────────────────────────────────────────

func TestApplyAndCacheStoresOnlyAppliedTunnels(t *testing.T) {
	up := startEcho(t)
	tm := manager.NewTunnelManager(manager.NewEgressManager(), "127.0.0.1")
	portOK := freePort(t)
	// A port already taken by someone else: this tunnel cannot be applied, so it
	// must never become "last known good".
	taken := heldPort(t)

	desired := &Snapshot{Version: "v1", Tunnels: []forwarder.TunnelConfig{
		{ID: "good", Mode: forwarder.ModeDirect, IngressPort: portOK, RemoteHost: "127.0.0.1", RemotePort: up, Protocol: "tcp", Revision: 1},
		{ID: "bad", Mode: forwarder.ModeDirect, IngressPort: taken, RemoteHost: "127.0.0.1", RemotePort: up, Protocol: "tcp", Revision: 1},
	}}
	cache := LKG{Path: filepath.Join(t.TempDir(), "desired-lkg.json")}

	failed, err := ApplyAndCache(context.Background(), tm, nil, desired, cache, "agent-1")
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if len(failed) != 1 || failed[0] != "bad" {
		t.Fatalf("expected only the unboundable tunnel to fail, got %v", failed)
	}
	loaded, err := cache.Load("agent-1")
	if err != nil {
		t.Fatalf("cache must have been written: %v", err)
	}
	if len(loaded.Tunnels) != 1 || loaded.Tunnels[0].ID != "good" {
		t.Fatalf("cache must contain only the applied tunnel, got %+v", loaded.Tunnels)
	}
}

func TestApplyAndCacheKeepsPreviousCacheWhenNothingApplied(t *testing.T) {
	tm := manager.NewTunnelManager(manager.NewEgressManager(), "127.0.0.1")
	held := heldPort(t)
	desired := &Snapshot{Version: "v1", Tunnels: []forwarder.TunnelConfig{
		{ID: "bad", Mode: forwarder.ModeDirect, IngressPort: held, RemoteHost: "127.0.0.1", RemotePort: 9, Protocol: "tcp", Revision: 1},
	}}
	cache := cacheWith(t, "agent-1", "previous-good")

	if _, err := ApplyAndCache(context.Background(), tm, nil, desired, cache, "agent-1"); err != nil {
		t.Fatalf("apply: %v", err)
	}
	loaded, err := cache.Load("agent-1")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded.Tunnels) != 1 || loaded.Tunnels[0].ID != "previous-good" {
		t.Fatalf("a fully failed apply must not erase the cache: %+v", loaded.Tunnels)
	}
}

func TestSnapshotOfRendersTheRunningRegistry(t *testing.T) {
	tunnels := manager.NewTunnelManager(manager.NewEgressManager(), "127.0.0.1")
	// An empty running registry is a FACT ("this node runs nothing"), not "we do
	// not know": the cache must be able to record it, otherwise the next panel
	// outage resurrects a forward the user already removed.
	empty := SnapshotOf(tunnels, "v1")
	if empty == nil {
		t.Fatal("an empty running registry must still produce a versioned snapshot")
	}
	if len(empty.Tunnels) != 0 {
		t.Fatalf("expected no tunnels, got %d", len(empty.Tunnels))
	}
	if err := empty.Validate(); err != nil {
		t.Fatalf("an empty snapshot must satisfy Validate: %v", err)
	}
	// nil means "there is no manager to ask", which is a different answer.
	if SnapshotOf(nil, "v1") != nil {
		t.Fatal("a nil manager has no snapshot")
	}
}

// ── authoritative reconcile ──────────────────────────────────────────────────

func TestReconcileRemovesOnlyAbsentRuntime(t *testing.T) {
	up := startEcho(t)
	tm := manager.NewTunnelManager(manager.NewEgressManager(), "127.0.0.1")
	for _, id := range []string{"keep", "gone"} {
		if _, err := tm.Apply(forwarder.TunnelConfig{ID: id, Mode: forwarder.ModeDirect, IngressPort: freePort(t), RemoteHost: "127.0.0.1", RemotePort: up, Protocol: "tcp", Revision: 1, ListenHost: "127.0.0.1"}); err != nil {
			t.Fatalf("apply %s: %v", id, err)
		}
	}

	authoritative := &Snapshot{Version: "v1", Tunnels: []forwarder.TunnelConfig{
		{ID: "keep", Mode: forwarder.ModeDirect, IngressPort: 1, RemoteHost: "h", RemotePort: 1, Protocol: "tcp", Revision: 1},
	}}
	removed := Reconcile(context.Background(), tm, nil, authoritative)
	if len(removed) != 1 || removed[0] != "gone" {
		t.Fatalf("only the absent listener may be removed, got %v", removed)
	}
	if _, ok := tm.Get("keep"); !ok {
		t.Fatal("an authorised tunnel must survive reconcile")
	}
	if _, ok := tm.Get("gone"); ok {
		t.Fatal("the absent tunnel must be gone")
	}

	// Idempotent, and a nil snapshot prunes nothing (never guess an empty
	// desired state).
	if removed := Reconcile(context.Background(), tm, nil, authoritative); len(removed) != 0 {
		t.Fatalf("second reconcile must be a no-op, got %v", removed)
	}
	if removed := Reconcile(context.Background(), tm, nil, nil); len(removed) != 0 {
		t.Fatalf("a nil snapshot must not prune, got %v", removed)
	}
}

// An empty running registry is written as a tombstone (v4 audit fix).
//
// The old expectation here ("nothing running means nothing to cache") was the bug:
// after removing the last forward the cache kept describing it, and a panel outage
// at the next restart brought that listener back.
func TestRefreshCacheWritesTombstoneForEmptyRuntime(t *testing.T) {
	cache := LKG{Path: filepath.Join(t.TempDir(), "desired-lkg.json")}
	tm := manager.NewTunnelManager(manager.NewEgressManager(), "127.0.0.1")
	if !RefreshCache(cache, "agent-1", tm, "v1") {
		t.Fatal("an empty runtime must still be recorded")
	}
	cached, err := cache.Load("agent-1")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(cached.Tunnels) != 0 {
		t.Fatalf("expected an empty tombstone, got %d tunnels", len(cached.Tunnels))
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// heldPort keeps the listener bound for the whole test: an apply to it must fail.
func heldPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("hold port: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l.Addr().(*net.TCPAddr).Port
}

// startEcho runs a real TCP target so DIRECT tunnels in these tests have an
// upstream that actually accepts.
func startEcho(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("echo listen: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) { defer c.Close(); _, _ = io.Copy(c, c) }(conn)
		}
	}()
	return l.Addr().(*net.TCPAddr).Port
}

// The bug this pins: after the last forward was removed (or suspended) the cache
// kept describing it, and a panel outage at restart brought the listener back.
func TestCacheRecordsTombstoneAfterLastRemove(t *testing.T) {
	dir := t.TempDir()
	cache := LKG{Path: filepath.Join(dir, "desired-lkg.json")}
	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")

	// One forward runs and is cached.
	cfg := forwarder.TunnelConfig{
		ID: "f1", Mode: forwarder.ModeDirect,
		IngressPort: freePort(t), ListenHost: "127.0.0.1",
		Revision: 1, Protocol: "tcp",
		RemoteHost: "127.0.0.1", RemotePort: 9,
	}
	if _, err := Apply(context.Background(), tunnels, egress, &Snapshot{Version: "v1", Tunnels: []forwarder.TunnelConfig{cfg}}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if !RefreshCache(cache, "agent-1", tunnels, "v1") {
		t.Fatal("the running forward must be cached")
	}

	// The user removes it: the running registry is now empty and the cache must
	// follow, otherwise the removal only lasts until the next outage.
	if err := tunnels.Remove(cfg.ID); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if !RefreshCache(cache, "agent-1", tunnels, "v1") {
		t.Fatal("an empty running registry must still be written")
	}
	cached, err := cache.Load("agent-1")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(cached.Tunnels) != 0 {
		t.Fatalf("a removed forward survived in the cache: %v", cached.Tunnels)
	}
}

// Concurrent writers must not be able to interleave a rename: an older snapshot
// landing after a newer one would silently roll "last known good" backwards.
// Whatever the interleaving, the file must always be a complete, valid snapshot.
func TestConcurrentCacheWritesStayValid(t *testing.T) {
	dir := t.TempDir()
	cache := LKG{Path: filepath.Join(dir, "desired-lkg.json")}

	var wg sync.WaitGroup
	stop := make(chan struct{})
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				snap := &Snapshot{Version: "v1", Tunnels: []forwarder.TunnelConfig{{
					ID: "f1", Mode: forwarder.ModeDirect, IngressPort: 20000 + n, ListenHost: "127.0.0.1",
					RemoteHost: "127.0.0.1", RemotePort: 9, Protocol: "tcp", Revision: int64(n + 1),
				}}}
				_ = cache.Save("agent-1", snap)
			}
		}(i)
	}
	// Wait for the first successful write before reading.
	//
	// The reader loop below is fast enough to finish before any writer completes
	// its FIRST Save (the writers only notice `stop` between iterations). When
	// that happened, the final Load legitimately answered "cache is empty" and the
	// test failed — a flake with nothing to do with concurrent renames, in the one
	// suite whose evidence the durability gates lean on.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := cache.Load("agent-1"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			close(stop)
			wg.Wait()
			t.Fatal("no writer produced a cache file within 5s")
		}
		time.Sleep(2 * time.Millisecond)
	}

	// Readers run at the same time: a torn file would be visible to the node's
	// own restart path, not just to this test.
	for i := 0; i < 200; i++ {
		if _, err := cache.Load("agent-1"); err != nil && !errors.Is(err, ErrLKGEmpty) {
			close(stop)
			wg.Wait()
			t.Fatalf("a concurrent write produced an unreadable cache: %v", err)
		}
	}
	close(stop)
	wg.Wait()

	loaded, err := cache.Load("agent-1")
	if err != nil {
		t.Fatalf("final load: %v", err)
	}
	if len(loaded.Tunnels) != 1 {
		t.Fatalf("final cache must be one complete snapshot, got %+v", loaded.Tunnels)
	}
}

// V5.2 WP7 —— 快照里的健康必须被安装，否则**每次 Agent 重启都会关掉熔断器**。
//
// V5-G2 抓到过这个：恢复路径只装了 targets，于是重启后的节点把连接继续五五开送到
// 面板判定为 unhealthy 的目标上。这不是"少个字段"，是同一个事实有两条入口、只补了
// 一条 —— V5.1 里协议、证书路径各踩过一次。
func TestRestoreInstallsHealthFromTheSnapshot(t *testing.T) {
	// 这条断言在 manager 侧已经由 SetPoolAndHealth 的用例覆盖；这里守的是**调用方
	// 必须走那条路**：一旦 restore 退回 SetPool，重启就会静默丢掉健康信号。
	src, err := os.ReadFile("restore.go")
	if err != nil {
		t.Fatalf("read restore.go: %v", err)
	}
	body := string(src)
	if !strings.Contains(body, "SetPoolAndHealth") {
		t.Fatal("restore must install health from the snapshot (SetPoolAndHealth), not targets alone")
	}
	if !strings.Contains(body, "len(cfg.TargetHealth) > 0") {
		t.Fatal("restore must fall back to the health-less path when the snapshot carries no health")
	}
}

// V5.2 WP7 —— 快照解码器必须认识 `target_health`。
//
// 这是 V5 里第三次"新事实有两条入口、只补了一条"（先是协议，然后证书路径，现在是健康）。
// 解码器丢掉这个字段的症状特别隐蔽：Agent 每次重启都从快照重建 runtime，健康静默消失，
// 熔断器失效，而客户端连接只是"有时候失败"——看起来像网络抖动，不像配置问题。
func TestSnapshotDecoderKnowsTargetHealth(t *testing.T) {
	entries := decodeTargetHealth([]targetHealthPayload{
		{Host: "a.example.com", Port: 443, State: "unhealthy"},
		{Host: "b.example.com", Port: 443, State: "healthy"},
		{Host: "", Port: 443, State: "healthy"},   // 没有地址 → 丢掉（无法归属）
		{Host: "c.example.com", Port: 0, State: "healthy"}, // 没有端口 → 丢掉
	})
	if len(entries) != 2 {
		t.Fatalf("decoded %d health entries, want 2 (addressable ones only)", len(entries))
	}
	if entries[0].Host != "a.example.com" || entries[0].State != "unhealthy" {
		t.Fatalf("first entry lost its fact: %+v", entries[0])
	}
	// 没有健康条目时返回 nil，而不是空切片：调用方据此走"没有信号"的分支。
	if got := decodeTargetHealth(nil); got != nil {
		t.Fatalf("no entries must decode to nil (no signal), got %v", got)
	}
}
