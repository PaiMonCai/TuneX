/**
 * 身份探针（agent 内置）的行为测试。
 *
 * 这些用例钉住两件在本仓**付过学费**的事：
 *   ① **永不跟随重定向**：302 之后那一跳根本不许发出去 —— 否则节点长期凭据会被重发到
 *      跳转目标（task-15 已用两台不同 IP 的 server 实测过旧路径会外发）；
 *   ② **真解析**：`{"data": oops}` / `{"data":42}` 这类"有 data 键但不是一个对象"的
 *      响应体不能算 Panel（旧的 grep 形状匹配会放过它们）。
 */
package identityprobe

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

/** 记录型端点：谁收到请求、有没有带凭据。 */
type recorder struct {
	*httptest.Server
	mu    sync.Mutex
	paths []string
	auths []string
}

func newRecorder(t *testing.T, handler http.HandlerFunc) *recorder {
	t.Helper()
	r := &recorder{}
	r.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		r.paths = append(r.paths, req.URL.Path)
		r.auths = append(r.auths, req.Header.Get("Authorization"))
		r.mu.Unlock()
		handler(w, req)
	}))
	t.Cleanup(r.Close)
	return r
}

func (r *recorder) seen() ([]string, []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.paths...), append([]string(nil), r.auths...)
}

func writeEnv(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.env")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write env: %v", err)
	}
	return path
}

func panelOK(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("content-type", "application/json")
	_, _ = w.Write([]byte(`{"data":{"snapshot":null}}`))
}

func TestRunSendsTheCredentialToThePanelAndReportsAPass(t *testing.T) {
	panel := newRecorder(t, panelOK)
	env := writeEnv(t, CredentialVar+"=node-cred\n")

	got := Run(Options{BaseURL: panel.URL, EnvFile: env, Timeout: 5 * time.Second})
	if got != "http:200:agent" {
		t.Fatalf("verdict = %q, want http:200:agent", got)
	}
	paths, auths := panel.seen()
	if len(paths) != 1 || paths[0] != SnapshotPath {
		t.Fatalf("panel saw %v, want exactly [%s]", paths, SnapshotPath)
	}
	if auths[0] != "Bearer node-cred" {
		t.Fatalf("panel auth = %q", auths[0])
	}
}

func TestRedirectIsNeverFollowedSoTheCredentialStaysOnTheOriginalHost(t *testing.T) {
	// 两台**不同地址**的 server：target 冒充一个"像 Panel"的端点。
	target := newRecorder(t, panelOK)
	panel := newRecorder(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Redirect(w, &http.Request{}, target.URL+SnapshotPath, http.StatusFound)
	})
	env := writeEnv(t, CredentialVar+"=node-cred\n")

	got := Run(Options{BaseURL: panel.URL, EnvFile: env, Timeout: 5 * time.Second})
	if got != "http:302" {
		t.Fatalf("verdict = %q, want http:302", got)
	}
	if paths, _ := target.seen(); len(paths) != 0 {
		t.Fatalf("redirect target received %v — the credential left the node", paths)
	}
	// 原 host 仍然必须收到那一次（带凭据的）请求，否则这条校验没有意义。
	if paths, auths := panel.seen(); len(paths) != 1 || !strings.HasPrefix(auths[0], "Bearer ") {
		t.Fatalf("panel saw %v / %v", paths, auths)
	}
}

func TestStatusCodesMapToTheFrozenVocabulary(t *testing.T) {
	for _, code := range []int{301, 302, 401, 403, 404, 500} {
		panel := newRecorder(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(code) })
		got := Run(Options{BaseURL: panel.URL, Credential: "c", Timeout: 5 * time.Second})
		if want := fmt.Sprintf("http:%d", code); got != want {
			t.Fatalf("status %d → %q, want %q", code, got, want)
		}
	}
}

func TestBodyMustBeRealPanelJSON(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"data 是对象", `{"data":{"snapshot":null}}`, "http:200:agent"},
		{"data 是对象（有内容）", `{"data":{"snapshot":{"tunnels":[],"used_ports":[]}}}`, "http:200:agent"},
		{"有 data 键但不是合法 JSON", `{"data": oops}`, "unverified:not_panel_json"},
		{"data 不是对象", `{"data":42}`, "unverified:not_panel_json"},
		{"data 是 null", `{"data":null}`, "unverified:not_panel_json"},
		{"data 是数组", `{"data":[]}`, "unverified:not_panel_json"},
		{"data 是字符串", `{"data":"x"}`, "unverified:not_panel_json"},
		{"顶层是数组", `[{"data":{}}]`, "unverified:not_panel_json"},
		{"没有 data 键", `{"foo":"bar"}`, "unverified:not_panel_json"},
		{"HTML 200", `<html><body>panel portal</body></html>`, "unverified:not_panel_json"},
		{"坏 JSON", `{oops`, "unverified:not_panel_json"},
		{"空体", ``, "unverified:not_panel_json"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			panel := newRecorder(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("content-type", "application/json")
				_, _ = w.Write([]byte(tc.body))
			})
			got := Run(Options{BaseURL: panel.URL, Credential: "c", Timeout: 5 * time.Second})
			if got != tc.want {
				t.Fatalf("body %q → %q, want %q", tc.body, got, tc.want)
			}
		})
	}
}

func TestNoResponseOnTimeoutOrUnreachablePanel(t *testing.T) {
	slow := newRecorder(t, func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(300 * time.Millisecond)
		panelOK(w, nil)
	})
	if got := Run(Options{BaseURL: slow.URL, Credential: "c", Timeout: 50 * time.Millisecond}); got != "unverified:no_response" {
		t.Fatalf("timeout → %q, want unverified:no_response", got)
	}
	// 关掉的端点 = 连接被拒。
	dead := httptest.NewServer(http.NotFoundHandler())
	url := dead.URL
	dead.Close()
	if got := Run(Options{BaseURL: url, Credential: "c", Timeout: time.Second}); got != "unverified:no_response" {
		t.Fatalf("refused → %q, want unverified:no_response", got)
	}
}

func TestCredentialAndPanelURLComeFromTheEnvFile(t *testing.T) {
	panel := newRecorder(t, panelOK)
	env := writeEnv(t, "# comment\n"+CredentialVar+"=from-file\n"+PanelURLVar+"="+panel.URL+"\n")
	if got := Run(Options{EnvFile: env, Timeout: 5 * time.Second}); got != "http:200:agent" {
		t.Fatalf("verdict = %q, want http:200:agent (URL from env file)", got)
	}
	if _, auths := panel.seen(); auths[0] != "Bearer from-file" {
		t.Fatalf("auth = %q", auths[0])
	}
}

func TestEnvFileProblemsAreVerdictsNotPanics(t *testing.T) {
	if got := Run(Options{EnvFile: filepath.Join(t.TempDir(), "nope")}); got != "unverified:env_unreadable" {
		t.Fatalf("missing env → %q", got)
	}
	empty := writeEnv(t, "OTHER=1\n")
	if got := Run(Options{EnvFile: empty, BaseURL: "http://panel.invalid"}); got != "unverified:no_credential" {
		t.Fatalf("no credential in env → %q", got)
	}
	cred := writeEnv(t, CredentialVar+"=c\n")
	if got := Run(Options{EnvFile: cred}); got != "unverified:no_panel_url" {
		t.Fatalf("no panel url → %q", got)
	}
	if got := Run(Options{BaseURL: "http://panel.invalid", EnvFile: cred, Credential: ""}); got != "unverified:no_response" {
		// 有 URL、有凭据，但地址不可达 ⇒ no_response（不是 not_panel_json）。
		t.Fatalf("unreachable → %q", got)
	}
}

func TestQuotedValuesAreUnquotedAndOtherKeysIgnored(t *testing.T) {
	panel := newRecorder(t, panelOK)
	env := writeEnv(t, "export "+CredentialVar+"=\"quoted-cred\"\n"+PanelURLVar+"='"+panel.URL+"'\nUNRELATED=x\n")
	if got := Run(Options{EnvFile: env, Timeout: 5 * time.Second}); got != "http:200:agent" {
		t.Fatalf("verdict = %q", got)
	}
	if _, auths := panel.seen(); auths[0] != "Bearer quoted-cred" {
		t.Fatalf("auth = %q (quotes must be stripped)", auths[0])
	}
}

func TestPanelPayloadShapeGuardMatchesTheBackendContract(t *testing.T) {
	// 后端 `/api/internal/node/snapshot` 的真实形状（`c.json({ data: { snapshot } })`）：
	// 这条用例把它写下来，避免哪天有人把探针的判据改成"只要有 data 键"。
	body, err := json.Marshal(map[string]any{"data": map[string]any{"snapshot": nil}})
	if err != nil {
		t.Fatal(err)
	}
	if !isPanelJSON(body) {
		t.Fatalf("real panel shape rejected: %s", body)
	}
}
