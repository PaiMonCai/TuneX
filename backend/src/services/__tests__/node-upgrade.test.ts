/**
 * V4-WP11B — 升级脚本的不变量。
 *
 * 这段脚本是**操作者会直接复制粘贴到生产节点上执行**的东西，所以测试的重点不是
 * "生成了字符串"，而是"脚本里的每一步顺序、身份复用与失败路径都不能被写错"。
 */
import { describe, expect, test } from "bun:test";
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
  return script.slice(start);
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
  test("reuses the host credential file and the LKG state directory", () => {
    const { script } = render();
    expect(script).toContain("-v /etc/tunex-agent/agent.env:/run/tunex-agent/agent.env:ro");
    expect(script).toContain("-v /var/lib/tunex-agent:/var/lib/tunex-agent");
    expect(script).toContain('--name "$CONTAINER"');
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
    const sourced = block.indexOf(". /run/tunex-agent/agent.env");
    const used = block.indexOf("TUNEX_NODE_CREDENTIAL");
    expect(exec).toBeGreaterThan(-1);
    expect(sourced).toBeGreaterThan(exec);
    expect(used).toBeGreaterThan(sourced);
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

  test("only an explicit HTTP 200 counts as verified", () => {
    const block = identitySection(render().script);
    expect(block.match(/VERIFIED="yes"/g)).toHaveLength(1);
    expect(block.slice(0, block.indexOf('VERIFIED="yes"'))).toMatch(/http:200\)\s*$/);
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
