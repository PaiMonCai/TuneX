// Package identityprobe implements the in-container identity check that the
// Panel-rendered upgrade script runs **inside the recreated agent container**.
//
// Why this exists at all: the check must send the node's long-lived credential to
// `<panel>/api/internal/node/snapshot` and answer one question — "does the Panel
// on the other end still recognise this node?" Doing that from a shell probe
// means picking between `curl`, busybox `wget` and (for the body) `grep` vs `jq`,
// and the three combinations do **not** have the same semantics:
//
//	· busybox wget cannot be told not to follow redirects, and it re-sends
//	  `--header` (i.e. the Bearer credential) to the redirect target — a Panel or
//	  reverse proxy answering `302` to another host therefore **leaks the
//	  credential off the node**;
//	· `grep` can only guess at "looks like Panel JSON", so `{"data": oops}`
//	  passes a shape check that real parsing rejects.
//
// Go's stdlib removes both classes at the root: `CheckRedirect` returning
// `http.ErrUseLastResponse` means the request is never re-sent anywhere, and
// `encoding/json` means the body verdict is a parse, not a guess. The agent
// binary is already in the image, so this costs **zero bytes** over the base
// image (the shell probe's curl+jq dependencies cost ~6.1MB).
//
// The verdict vocabulary is a frozen contract shared with the rendered script
// (`backend/src/services/node-upgrade.ts`):
//
//	http:<code>          a HTTP status line was obtained (non-200)
//	http:200:agent       200 **and** the body is Panel JSON (data is an object)
//	unverified:<reason>  no verdict could be established; <reason> is one of
//	                     env_unreadable / no_credential / no_panel_url /
//	                     no_response / not_panel_json
//
// Nothing here ever prints the credential.
package identityprobe

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// SnapshotPath is the authenticated endpoint the probe asks.
const SnapshotPath = "/api/internal/node/snapshot"

// DefaultEnvFile is the in-container path of the mounted agent.env.
const DefaultEnvFile = "/run/tunex-agent/agent.env"

// DefaultTimeout bounds the whole probe. The upgrade script passes its own
// `--probe-timeout` (CHECK_TIMEOUT), so this is only the CLI default.
const DefaultTimeout = 10 * time.Second

// maxBodyBytes bounds the response body we are willing to read. The snapshot is
// a small JSON document; a panel that streams megabytes at the agent must not be
// able to grow its heap.
const maxBodyBytes = 64 * 1024

// CredentialVar is the agent.env variable carrying the per-node credential.
const CredentialVar = "TUNEX_NODE_CREDENTIAL"

// PanelURLVar is the agent.env fallback for the Panel base URL.
const PanelURLVar = "TUNEX_PANEL_HTTP_URL"

// Options configures one probe run.
type Options struct {
	// BaseURL is the Panel base URL (CLI --probe-url). Empty falls back to
	// PanelURLVar in the env file.
	BaseURL string
	// Timeout bounds the request. Zero means DefaultTimeout.
	Timeout time.Duration
	// EnvFile is the agent.env path read for the credential. Empty means
	// DefaultEnvFile.
	EnvFile string
	// Credential overrides the env file (tests). Empty means "read EnvFile".
	Credential string
	// HTTPClient overrides the transport (tests). nil means the production
	// client, which **never follows redirects**.
	HTTPClient *http.Client
}

// noFollowClient is the production client: it never follows a redirect, so the
// credential can only ever be sent to the URL we were given.
//
// `ErrUseLastResponse` makes Do return the 3xx response itself (no error), which
// is exactly what the verdict vocabulary wants: `http:302`.
func noFollowClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// Run performs one identity probe and returns the single verdict token.
//
// It always answers with a token from the vocabulary above; transport failures
// are reported as verdicts (never as a Go error) because the caller is a shell
// script whose only job is to render that token for the operator.
func Run(o Options) string {
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	envFile := o.EnvFile
	if envFile == "" {
		envFile = DefaultEnvFile
	}

	credential := strings.TrimSpace(o.Credential)
	base := strings.TrimSpace(o.BaseURL)
	if credential == "" {
		// Only read the file when a CLI/env override did not already supply the
		// credential: a test that injects one must not depend on the node filesystem.
		values, err := readEnvFile(envFile)
		if err != nil {
			return "unverified:env_unreadable"
		}
		credential = strings.TrimSpace(values[CredentialVar])
		if credential == "" {
			return "unverified:no_credential"
		}
		if base == "" {
			base = strings.TrimSpace(values[PanelURLVar])
		}
	}
	if base == "" {
		return "unverified:no_panel_url"
	}

	client := o.HTTPClient
	if client == nil {
		client = noFollowClient(timeout)
	}

	url := strings.TrimSuffix(base, "/") + SnapshotPath
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		// A malformed --probe-url is a configuration gap, not a network failure.
		return "unverified:no_panel_url"
	}
	req.Header.Set("Authorization", "Bearer "+credential)

	resp, err := client.Do(req)
	if err != nil {
		// Timeouts, DNS failures, refused connections: no verdict obtainable.
		return "unverified:no_response"
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if resp.StatusCode != http.StatusOK {
		return fmt.Sprintf("http:%d", resp.StatusCode)
	}
	if !isPanelJSON(body) {
		return "unverified:not_panel_json"
	}
	// `:agent` 标记"这条结论来自 agent 内置探针（真解析 + 不跟随重定向）"，
	// 与渲染脚本里的兜底手段（`:jq` / `:grep`）区分开，操作者文案据此措辞。
	return "http:200:agent"
}

// isPanelJSON decides whether a 200 body is Panel JSON.
//
// It is a real parse: the top level must be a JSON object **and** `data` must be
// an object. That rejects HTML, `{oops`, `{"data": oops}` and `{"data":42}` —
// all of which a `grep`-based shape check accepts.
//
// Deliberately not checked: the *inner* structure of `data` (e.g. that
// `snapshot` exists). Pinning that here would copy the Panel's payload schema
// into the node script, so a Panel-side field change would turn every node's
// upgrade into "未校验" — and the question this probe answers is "does the Panel
// still recognise this node", not "is the snapshot schema what I remember".
func isPanelJSON(body []byte) bool {
	if len(body) == 0 {
		return false
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body, &envelope); err != nil {
		return false
	}
	raw, ok := envelope["data"]
	if !ok {
		return false
	}
	// 必须是**对象**：`null` / `42` / `[]` / `"x"` 都解析成功，但都不是 Panel 的信封。
	// （把 `null` 反序列化进 map 不会报错，只会得到 nil —— 所以不能只看 unmarshal 的 err。）
	var data any
	if err := json.Unmarshal(raw, &data); err != nil {
		return false
	}
	_, isObject := data.(map[string]any)
	return isObject
}

// readEnvFile parses an env file into a map. It understands the two shapes the
// installer writes: `KEY=value` lines and blank/`#` comment lines. Values may be
// single- or double-quoted; the quotes are stripped, nothing else is interpreted
// (no variable expansion, no `export`).
func readEnvFile(path string) (map[string]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string)
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(strings.TrimPrefix(key, "export "))
		if key == "" {
			continue
		}
		out[key] = unquote(strings.TrimSpace(value))
	}
	return out, nil
}

func unquote(value string) string {
	if len(value) >= 2 {
		if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
			return value[1 : len(value)-1]
		}
	}
	return value
}
