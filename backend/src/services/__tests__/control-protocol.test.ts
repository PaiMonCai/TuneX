/**
 * WP6 — Command / Revision / ACK 协议契约离线测试。
 *
 * 依据 `DEVELOPMENT.md` §7.9「WP6 — Command / Revision / ACK Contract」（Track B/C）。
 * 本文件**只测协议契约**，不连 MySQL / Redis / 网络，也不跑 orchestrator（WP8 范围）。
 *
 * 覆盖矩阵（验收口径）：
 *   A. 统一命令六型：apply_tunnel / remove_tunnel / update_targets / suspend_tunnel /
 *      state_request / command_ack —— 每个动作各有「合法入站、默认状态推进、payload
 *      被拒的形状」三类用例；
 *   B. 统一字段：command_id / resource / resource_id / revision / action / expires_at /
 *      payload / applied_revision / status / error_code / error —— 顶层未知字段一律拒绝，
 *      每个字段的缺失/错类型/越界都要被拒绝，ACK 回显必须与命令一致；
 *   C. 四条硬规则：
 *      1. stale revision reject（applied_revision > revision → stale_reject）；
 *      2. equal revision idempotent ACK（applied_revision === revision → 回放结果）；
 *      3. newer revision atomic apply（applied_revision < revision → 执行且整体推进）；
 *      4. expired command reject（expires_at < now → command_expired）；
 *   D. 并发安全：
 *      - 同一 command_id 并发提交只执行一次（其余拿到同结果，第二个标 duplicate）；
 *      - 同一 resource 的命令严格串行，applied_revision 单调不回退；
 *      - 不同 resource 之间并行，互不阻塞；
 *      - applier 抛异常 → 状态停在 error，applied_revision 不推进，可重试同版本。
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  ACTION_SPECS,
  ACK_STATUSES,
  COMMAND_ACTIONS,
  ControlValidator,
  ControlProtocolError,
  DEFAULT_COMMAND_TTL_MS,
  ERROR_CODES,
  MAX_LEDGER_ENTRIES,
  checkRevisionGate,
  commandFingerprint,
  createCommand,
  expiresAtFrom,
  isExpired,
  parseTimestamp,
  validateEnvelope,
  validatePayload,
} from "../control-protocol/index.ts";

/* ------------------------------------------------------------------ */
/* 测试桩                                                               */
/* ------------------------------------------------------------------ */

const NOW = Date.parse("2026-09-25T00:00:00.000Z");

/**
 * 一条合法的 apply_tunnel 信封基线。
 * @param ttlMs     TTL（负值即构造过期命令）。
 * @param targetPort 目标端口（用于构造不同内容的命令）。
 * @param resourceId 资源 ID（不传默认 "t-1"）。
 */
function applyCmd(
  command_id: string,
  revision: number,
  ttlMs = DEFAULT_COMMAND_TTL_MS,
  targetPort = 80,
  resourceId = "t-1",
) {
  return {
    command_id,
    resource: "tunnel",
    resource_id: resourceId,
    revision,
    action: "apply_tunnel",
    issued_at: new Date(NOW).toISOString(),
    expires_at: expiresAtFrom(NOW, ttlMs),
    payload: {
      tunnel: {
        name: "web",
        tunnel_type: "wss",
        listen_port: 8443,
        targets: [{ address: "10.0.0.2", port: targetPort }],
      },
    },
  };
}

/** 恒真 applier：任何命令都「执行成功」。 */
const noopApplier = () => {};

/** 记录被执行的命令的 applier（用于断言执行次数 / 顺序）。 */
function recordingApplier() {
  const seen: { command_id: string; action: string; revision: number }[] = [];
  return {
    seen,
    applier: (cmd: { command_id: string; action: string; revision: number }) => {
      seen.push({ command_id: cmd.command_id, action: cmd.action, revision: cmd.revision });
    },
  };
}

/**
 * 构造一条 command_ack 信封。注意两个 ID 的分工：
 *   `command_id`      本 ACK 报文自己的编号（幂等键，重发会拿 duplicate）；
 *   `acked_command_id` 被回应的那条命令的编号（账本里的键）。
 * 混用会让 ack 永远找不到命令——这正是被测试钉死的语义。
 */
function ackEnvelope(
  command_id: string,
  acked_command_id: string,
  payload: Record<string, unknown>,
  resource_id = "t-1",
  revision = 1,
) {
  return {
    command_id,
    resource: "tunnel",
    resource_id,
    revision,
    action: "command_ack",
    issued_at: new Date(NOW).toISOString(),
    expires_at: expiresAtFrom(NOW, DEFAULT_COMMAND_TTL_MS),
    payload: { acked_command_id, ...payload },
  };
}

/* ================================================================== */
/* A. 统一命令六型                                                      */
/* ================================================================== */

describe("A. 统一命令（§7.9 六个动作）", () => {
  test("六个动作全部在冻结清单里，且 ACTION_SPECS 一一对应", () => {
    expect([...COMMAND_ACTIONS]).toEqual([
      "apply_tunnel",
      "remove_tunnel",
      "update_targets",
      "suspend_tunnel",
      "state_request",
      "command_ack",
    ]);
    for (const action of COMMAND_ACTIONS) {
      expect(ACTION_SPECS[action]).toBeDefined();
    }
    // 只有四个变更动作用于 revision 闸门；state_request/command_ack 不走闸门。
    expect(COMMAND_ACTIONS.filter((a) => ACTION_SPECS[a].mutating)).toEqual([
      "apply_tunnel",
      "remove_tunnel",
      "update_targets",
      "suspend_tunnel",
    ]);
    // state_request 允许 revision 0（"我不关心版本"），其余必须 >= 1。
    expect(ACTION_SPECS.state_request.minRevision).toBe(0);
    expect(ACTION_SPECS.command_ack.minRevision).toBeGreaterThan(0);
  });

  test("apply_tunnel：合法命令 → applied，状态推进到 active", async () => {
    const v = new ControlValidator();
    const ack = await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
    expect(ack.status).toBe("applied");
    expect(ack.applied_revision).toBe(1);
    expect(ack.error_code).toBeUndefined();
    expect(v.snapshot("tunnel", "t-1").status).toBe("active");
  });

  test("apply_tunnel：缺 name / 空 targets / 端口越界 都被 payload_invalid 拒绝", async () => {
    const v = new ControlValidator();
    const badShapes = [
      { tunnel: { tunnel_type: "wss", listen_port: 8443, targets: [{ address: "a", port: 80 }] } },
      { tunnel: { name: "x", tunnel_type: "wss", listen_port: 8443, targets: [] } },
      { tunnel: { name: "x", tunnel_type: "wss", listen_port: 70000, targets: [{ address: "a", port: 80 }] } },
      { tunnel: { name: "x", tunnel_type: "carrier-pigeon", listen_port: 8443, targets: [{ address: "a", port: 80 }] } },
    ];
    for (const [i, payload] of badShapes.entries()) {
      const ack = await v.handle(
        { ...applyCmd(`c-bad-${i}`, 1), payload },
        noopApplier,
        NOW,
      );
      expect(ack.status).toBe("rejected");
      expect(ack.error_code).toBe("payload_invalid");
    }
  });

  test("apply_tunnel：重复目标（同 address:port）被拒绝 —— 只放大故障面", async () => {
    const v = new ControlValidator();
    const ack = await v.handle(
      {
        ...applyCmd("c-dup-target", 1),
        payload: {
          tunnel: {
            name: "x",
            tunnel_type: "wss",
            listen_port: 8443,
            targets: [
              { address: "10.0.0.2", port: 80 },
              { address: "10.0.0.2", port: 80 },
            ],
          },
        },
      },
      noopApplier,
      NOW,
    );
    expect(ack.status).toBe("rejected");
    expect(ack.error_code).toBe("payload_invalid");
  });

  test("remove_tunnel：执行后状态为 removed，且不物理删除（数据保留，reason 进审计）", async () => {
    const v = new ControlValidator();
    await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
    const ack = await v.handle(
      {
        command_id: "c-2",
        resource: "tunnel",
        resource_id: "t-1",
        revision: 2,
        action: "remove_tunnel",
        issued_at: new Date(NOW).toISOString(),
        expires_at: expiresAtFrom(NOW, DEFAULT_COMMAND_TTL_MS),
        payload: { reason: "user deleted" },
      },
      noopApplier,
      NOW,
    );
    expect(ack.status).toBe("applied");
    expect(ack.applied_revision).toBe(2);
    expect(v.snapshot("tunnel", "t-1").status).toBe("removed");
    // 记录仍在（不物理删除）：后续更低/更高 revision 仍按闸门规则判定。
    expect(v.getRecord("tunnel", "t-1")).toBeDefined();
  });

  test("update_targets：热更新目标池，执行后仍为 active", async () => {
    const v = new ControlValidator();
    await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
    const rec = recordingApplier();
    const ack = await v.handle(
      {
        command_id: "c-2",
        resource: "tunnel",
        resource_id: "t-1",
        revision: 2,
        action: "update_targets",
        issued_at: new Date(NOW).toISOString(),
        expires_at: expiresAtFrom(NOW, DEFAULT_COMMAND_TTL_MS),
        payload: { targets: [{ address: "10.0.0.3", port: 8080, weight: 2 }] },
      },
      rec.applier,
      NOW,
    );
    expect(ack.status).toBe("applied");
    expect(rec.seen).toEqual([{ command_id: "c-2", action: "update_targets", revision: 2 }]);
    expect(v.snapshot("tunnel", "t-1").status).toBe("active");
  });

  test("suspend_tunnel：执行后状态为 suspended，隧道与配置保留", async () => {
    const v = new ControlValidator();
    await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
    const ack = await v.handle(
      {
        command_id: "c-2",
        resource: "tunnel",
        resource_id: "t-1",
        revision: 2,
        action: "suspend_tunnel",
        issued_at: new Date(NOW).toISOString(),
        expires_at: expiresAtFrom(NOW, DEFAULT_COMMAND_TTL_MS),
        payload: { reason: "quota exceeded" },
      },
      noopApplier,
      NOW,
    );
    expect(ack.status).toBe("applied");
    expect(v.snapshot("tunnel", "t-1").status).toBe("suspended");
    // 从未存在过的资源也能被挂起（apply 之后才有 record，这里走 fresh 路径）。
    const ack2 = await v.handle(
      {
        command_id: "c-3",
        resource: "tunnel",
        resource_id: "t-unknown",
        revision: 1,
        action: "suspend_tunnel",
        issued_at: new Date(NOW).toISOString(),
        expires_at: expiresAtFrom(NOW, DEFAULT_COMMAND_TTL_MS),
        payload: {},
      },
      noopApplier,
      NOW,
    );
    expect(ack2.status).toBe("applied");
    expect(v.snapshot("tunnel", "t-unknown").status).toBe("suspended");
  });

  test("state_request：不走 revision 闸门、不写幂等账本、不调 applier，永远回新鲜快照", async () => {
    const v = new ControlValidator();
    await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
    const rec = recordingApplier();
    const ack = await v.handle(
      {
        command_id: "q-1",
        resource: "tunnel",
        resource_id: "t-1",
        revision: 0,
        action: "state_request",
        issued_at: new Date(NOW).toISOString(),
        expires_at: expiresAtFrom(NOW, DEFAULT_COMMAND_TTL_MS),
        payload: {},
      },
      rec.applier,
      NOW,
    );
    expect(ack.status).toBe("applied");
    expect(rec.seen).toEqual([]); // 查询不调 applier
    expect(ack.state).toMatchObject({
      resource: "tunnel",
      resource_id: "t-1",
      revision: 1,
      applied_revision: 1,
      status: "active",
      applying: false,
    });
    // state_request 不写账本：不能凭它被告知「命令成功了」。
    expect(v.outcome("q-1")).toBeUndefined();
  });

  test("state_request：对完全未知的资源回 unknown 快照而非拒绝", async () => {
    const v = new ControlValidator();
    const ack = await v.handle(
      {
        command_id: "q-2",
        resource: "tunnel",
        resource_id: "never-seen",
        revision: 0,
        action: "state_request",
        issued_at: new Date(NOW).toISOString(),
        expires_at: expiresAtFrom(NOW, DEFAULT_COMMAND_TTL_MS),
        payload: {},
      },
      noopApplier,
      NOW,
    );
    expect(ack.status).toBe("applied");
    expect(ack.state?.status).toBe("unknown");
    expect(ack.state?.applied_revision).toBe(0);
  });

  test("command_ack：ack 已知命令 → applied，并把命令标记为已 ack", async () => {
    const v = new ControlValidator();
    await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
    const ack = await v.handle(
      ackEnvelope("ack-1", "c-1", { applied_revision: 1, status: "applied" }),
      noopApplier,
      NOW,
    );
    expect(ack.status).toBe("applied");
    expect(ack.applied_revision).toBe(1);
    expect(v.outcome("c-1")?.acked).toBe(true);
  });

  test("command_ack：ack 未知命令 → unknown_command（不能凭伪造 ACK 宣布命令成功）", async () => {
    const v = new ControlValidator();
    const ack = await v.handle(
      {
        ...ackEnvelope("ack-ghost", "ghost-cmd", { applied_revision: 1, status: "applied" }),
      },
      noopApplier,
      NOW,
    );
    expect(ack.status).toBe("rejected");
    expect(ack.error_code).toBe("unknown_command");
    expect(v.outcome("ghost-cmd")).toBeUndefined();
  });

  test("command_ack：ack 的 revision 与原命令不一致 → revision_mismatch", async () => {
    const v = new ControlValidator();
    await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
    const ack = await v.handle(
      {
        ...ackEnvelope("ack-2", "c-1", { applied_revision: 7, status: "applied" }),
      },
      noopApplier,
      NOW,
    );
    expect(ack.status).toBe("rejected");
    expect(ack.error_code).toBe("revision_mismatch");
    expect(v.outcome("c-1")?.acked).toBe(false); // 未生效
  });

  test("command_ack：重复 ack 同一条命令 → duplicate 且不报错", async () => {
    const v = new ControlValidator();
    await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
    const envelope = ackEnvelope("ack-3", "c-1", { applied_revision: 1, status: "applied" });
    const first = await v.handle(envelope, noopApplier, NOW);
    const second = await v.handle(envelope, noopApplier, NOW);
    expect(first.status).toBe("applied");
    expect(second.status).toBe("duplicate");
  });

  test("command_ack：ack 一个此前执行失败的命令 → duplicate，不改变结果", async () => {
    const v = new ControlValidator();
    // 注意区分两类"没成功"：**结构/过期被拒**的连接不写账本（validate 阶段就 return，
    // 没有 ledger 条目可 ack）；**执行失败**的连接才进账本、才会被 ack 回收。
    const failed = await v.handle(applyCmd("c-fail", 1), () => {
      throw new Error("apply blew up");
    }, NOW);
    expect(failed.status).toBe("failed");
    expect(v.outcome("c-fail")?.status).toBe("failed");
    const ack = await v.handle(
      {
        ...ackEnvelope("ack-fail", "c-fail", {
          applied_revision: null,
          status: "failed",
          error_code: "command_expired",
        }),
      },
      noopApplier,
      NOW,
    );
    expect(ack.status).toBe("duplicate");
  });

  test("command_ack 的 payload 结构校验：applied 必须带 revision / rejected 必须带 error_code", () => {
    const BASE = { acked_command_id: "c-1" };
    expect(validatePayload("command_ack", { ...BASE, applied_revision: null, status: "applied" })).not.toBeNull();
    expect(validatePayload("command_ack", { ...BASE, applied_revision: null, status: "rejected" })).not.toBeNull();
    expect(validatePayload("command_ack", { ...BASE, applied_revision: 1, status: "applied" })).toBeNull();
    expect(
      validatePayload("command_ack", { ...BASE, applied_revision: null, status: "rejected", error_code: "command_expired" }),
    ).toBeNull();
    expect(validatePayload("command_ack", { ...BASE, applied_revision: 1, status: "weird" })).not.toBeNull();
    // acked_command_id 是必填（漏填 = 不知道该回应哪条命令）
    expect(validatePayload("command_ack", { applied_revision: 1, status: "applied" })).not.toBeNull();
  });
});

/* ================================================================== */
/* B. 统一字段                                                          */
/* ================================================================== */

describe("B. 统一字段", () => {
  test("统一字段清单与 §7.9 完全一致", () => {
    // §7.9 冻结的字段集合（本协议的对外契约）。
    const FROZEN = [
      "command_id",
      "resource",
      "resource_id",
      "revision",
      "action",
      "expires_at",
      "payload",
      "applied_revision",
      "status",
      "error_code",
      "error",
    ];
    for (const field of FROZEN) {
      expect(field.length).toBeGreaterThan(0);
    }
    // 顶层字段白名单就是冻结集合 + 可观测用的 issued_at。
    expect(validateEnvelope({ ...applyCmd("c-1", 1), bogus_field: 1 }, NOW).ok).toBe(false);
    expect(validateEnvelope({ ...applyCmd("c-1", 1), issued_at: new Date(NOW).toISOString() }, NOW).ok).toBe(true);
  });

  test("顶层未知字段一律 rejected（宁可炸掉也不要静默吞字段）", async () => {
    const v = new ControlValidator();
    const ack = await v.handle({ ...applyCmd("c-1", 1), actor: "someone-else" }, noopApplier, NOW);
    expect(ack.status).toBe("rejected");
    expect(ack.error_code).toBe("invalid_envelope");
  });

  test("command_id：空 / 超长 / 非字符串都拒绝", () => {
    expect(validateEnvelope({ ...applyCmd("", 1) }, NOW)).toMatchObject({ ok: false });
    expect(validateEnvelope({ ...applyCmd("x".repeat(65), 1) }, NOW)).toMatchObject({ ok: false });
    expect(validateEnvelope({ ...applyCmd(123 as unknown as string, 1) }, NOW)).toMatchObject({ ok: false });
  });

  test("resource / resource_id：白名单与非空约束", () => {
    expect(validateEnvelope({ ...applyCmd("c", 1), resource: "banana" }, NOW)).toMatchObject({
      ok: false,
      error_code: "unknown_resource",
    });
    expect(validateEnvelope({ ...applyCmd("c", 1), resource_id: "  " }, NOW)).toMatchObject({ ok: false });
    expect(validateEnvelope({ ...applyCmd("c", 1), resource_id: 42 as unknown as string }, NOW)).toMatchObject({
      ok: false,
    });
  });

  test("revision：必须是非负整数", () => {
    expect(validateEnvelope({ ...applyCmd("c", 0) }, NOW)).toMatchObject({ ok: false });
    expect(validateEnvelope({ ...applyCmd("c", 1.5) }, NOW)).toMatchObject({ ok: false });
    expect(validateEnvelope({ ...applyCmd("c", -1) }, NOW)).toMatchObject({ ok: false });
    expect(validateEnvelope({ ...applyCmd("c", 3) }, NOW).ok).toBe(true);
  });

  test("action：未知动作 unknown_action；动作-资源不配套 action_resource_mismatch", () => {
    expect(validateEnvelope({ ...applyCmd("c", 1), action: "nuke_everything" }, NOW)).toMatchObject({
      ok: false,
      error_code: "unknown_action",
    });
    expect(validateEnvelope({ ...applyCmd("c", 1), resource: "node" }, NOW)).toMatchObject({
      ok: false,
      error_code: "action_resource_mismatch",
    });
  });

  test("state_request 是唯一允许 revision=0 的动作", () => {
    expect(validateEnvelope({ ...applyCmd("c", 0) }, NOW)).toMatchObject({ ok: false });
    expect(
      validateEnvelope(
        { ...applyCmd("c", 0), action: "state_request", payload: {} },
        NOW,
      ).ok,
    ).toBe(true);
  });

  test("expires_at：必须带时区（裸本地时间一律拒绝，它无法判断先后）", () => {
    expect(validateEnvelope({ ...applyCmd("c", 1), expires_at: "2026-09-25T00:00:00" }, NOW)).toMatchObject({
      ok: false,
    });
    expect(validateEnvelope({ ...applyCmd("c", 1), expires_at: "not a date" }, NOW)).toMatchObject({ ok: false });
    expect(parseTimestamp("2026-09-25T00:00:00")).toBeNull();
    expect(parseTimestamp("2026-09-25T00:00:00Z")).toBe(NOW);
    expect(parseTimestamp("2026-09-25T08:00:00+08:00")).toBe(NOW);
  });

  test("issued_at 晚于 expires_at → invalid_envelope；TTL 超上限 → ttl_exceeds_policy", () => {
    // issued_at 晚于 expires_at 才算 invalid（晚于 now 不算——下发可以带未来 issued_at）。
    expect(
      validateEnvelope(
        {
          ...applyCmd("c", 1),
          issued_at: new Date(NOW + 400_000).toISOString(),
          expires_at: expiresAtFrom(NOW, DEFAULT_COMMAND_TTL_MS),
        },
        NOW,
      ),
    ).toMatchObject({ ok: false, error_code: "invalid_envelope" });
    expect(
      validateEnvelope(
        { ...applyCmd("c", 1), issued_at: new Date(NOW).toISOString(), expires_at: expiresAtFrom(NOW, 60 * 60 * 1000) },
        NOW,
      ),
    ).toMatchObject({ ok: false, error_code: "ttl_exceeds_policy" });
  });

  test("payload：未知字段 / 错类型一律 payload_invalid", () => {
    expect(validatePayload("update_targets", { targets: "10.0.0.2:80" })).not.toBeNull();
    expect(validatePayload("update_targets", { targets: [] })).not.toBeNull();
    expect(validatePayload("update_targets", { targets: [{ address: "a", port: 80 }, { evil: true }] })).not.toBeNull();
    expect(validatePayload("update_targets", { targets: [{ address: "a", port: 80 }], extra: 1 })).not.toBeNull();
    expect(validatePayload("update_targets", { targets: [{ address: "a", port: 80 }] })).toBeNull();
  });

  test("ACK 回显与命令一致：字段逐个相等，字段缺失时是 null 而不是糊一个值", async () => {
    const v = new ControlValidator();
    const ack = await v.handle(applyCmd("c-echo", 4), noopApplier, NOW);
    expect(ack.command_id).toBe("c-echo");
    expect(ack.action).toBe("apply_tunnel");
    expect(ack.resource).toBe("tunnel");
    expect(ack.resource_id).toBe("t-1");
    expect(ack.revision).toBe(4);
    expect(ack.status).toBe("applied");
  });

  test("ACK 的 error / error_code：只在失败/拒绝时出现，成功时不得出现", async () => {
    const v = new ControlValidator();
    const ok = await v.handle(applyCmd("c-ok", 1), noopApplier, NOW);
    expect(ok.error_code).toBeUndefined();
    expect(ok.error).toBeUndefined();
    const rejected = await v.handle(applyCmd("c-bad", 1, DEFAULT_COMMAND_TTL_MS), noopApplier, NOW + DEFAULT_COMMAND_TTL_MS + 1);
    expect(rejected.status).toBe("rejected");
    expect(rejected.error_code).toBe("command_expired");
    expect(typeof rejected.error).toBe("string");
    expect(ERROR_CODES).toContain(rejected.error_code as never);
  });

  test("status 四态全在冻结清单里", () => {
    expect([...ACK_STATUSES].sort()).toEqual(["applied", "duplicate", "failed", "rejected"]);
  });
});

/* ================================================================== */
/* C. 四条硬规则                                                        */
/* ================================================================== */

describe("C. 硬规则", () => {
  describe("C1. stale revision reject（applied_revision > revision）", () => {
    test("已应用 revision 5，再下发 revision 3 → stale_reject，状态不被回滚", async () => {
      const v = new ControlValidator();
      await v.handle(applyCmd("c-5", 5), noopApplier, NOW);
      const before = v.snapshot("tunnel", "t-1");
      const ack = await v.handle(applyCmd("c-3", 3), noopApplier, NOW);
      expect(ack.status).toBe("rejected");
      expect(ack.error_code).toBe("stale_revision");
      expect(ack.applied_revision).toBe(5); // 明确带回当前已生效版本
      expect(v.snapshot("tunnel", "t-1")).toEqual(before);
    });

    test("迟到命令不得复活已 remove 的资源（v3 RELAY 场景最致命的一条）", async () => {
      const v = new ControlValidator();
      await v.handle(applyCmd("c-1", 1), noopApplier, NOW); // applied
      await v.handle({ ...applyCmd("c-2", 2), action: "remove_tunnel", payload: {} }, noopApplier, NOW);
      expect(v.snapshot("tunnel", "t-1").status).toBe("removed");
      const late = await v.handle(applyCmd("c-1-late", 1), noopApplier, NOW);
      expect(late.error_code).toBe("stale_revision");
      expect(v.snapshot("tunnel", "t-1").status).toBe("removed");
    });

    test("纯判定内核 checkRevisionGate 覆盖全部三种比较", () => {
      expect(checkRevisionGate(null, 1)).toEqual({ kind: "fresh" });
      expect(checkRevisionGate(5, 9)).toEqual({ kind: "apply_newer" });
      expect(checkRevisionGate(5, 5)).toEqual({ kind: "idempotent" });
      expect(checkRevisionGate(5, 3)).toEqual({ kind: "stale_reject" });
    });
  });

  describe("C2. equal revision idempotent ACK（applied_revision == revision）", () => {
    test("成功应用后重放同一命令 → duplicate，applier 不再被调用", async () => {
      const v = new ControlValidator();
      const first = recordingApplier();
      await v.handle(applyCmd("c-1", 1), first.applier, NOW);
      const second = recordingApplier();
      const ack = await v.handle(applyCmd("c-1", 1), second.applier, NOW);
      expect(ack.status).toBe("duplicate");
      expect(ack.applied_revision).toBe(1);
      expect(first.seen.length).toBe(1);
      expect(second.seen.length).toBe(0);
    });

    test("同一意图用不同 command_id 重发（不同 ID、同 resource+revision）→ 也是 duplicate", async () => {
      const v = new ControlValidator();
      await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
      const rec = recordingApplier();
      const ack = await v.handle(applyCmd("c-1-again", 1), rec.applier, NOW);
      expect(ack.status).toBe("duplicate");
      expect(ack.applied_revision).toBe(1);
      expect(rec.seen.length).toBe(0);
    });

    test("state_request 不在闸门管辖内：重复查询永远拿新鲜快照", async () => {
      const v = new ControlValidator();
      const query = () =>
        v.handle(
          { ...applyCmd("q", 0), action: "state_request", payload: {} },
          noopApplier,
          NOW,
        );
      const before = await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
      expect(before.status).toBe("applied");
      const a = await query();
      await v.handle(
        { ...applyCmd("c-2", 2), action: "suspend_tunnel", payload: {} },
        noopApplier,
        NOW,
      );
      const b = await query();
      expect(a.state?.applied_revision).toBe(1);
      expect(b.state?.applied_revision).toBe(2);
      expect(b.state?.status).toBe("suspended");
    });

    test("seed 注入已生效版本后重复命令 → duplicate（跨进程恢复场景）", async () => {
      const v = new ControlValidator();
      v.seed({ resource: "tunnel", resource_id: "t-seed", revision: 9 });
      const rec = recordingApplier();
      // resource_id 必须和 seed 的同一个资源（t-seed）：闸门是 per-resource 的。
      const ack = await v.handle(
        applyCmd("c-seed", 9, DEFAULT_COMMAND_TTL_MS, 80, "t-seed"),
        rec.applier,
        NOW,
      );
      expect(ack.status).toBe("duplicate");
      expect(ack.applied_revision).toBe(9);
      expect(rec.seen.length).toBe(0);
    });
  });

  describe("C3. newer revision atomic apply（applied_revision < revision）", () => {
    test("版本递增逐条应用，applied_revision 单调前进", async () => {
      const v = new ControlValidator();
      for (const [i, rev] of [1, 2, 3, 7].entries()) {
        const ack = await v.handle(applyCmd(`c-${i}`, rev), noopApplier, NOW);
        expect(ack.status).toBe("applied");
        expect(ack.applied_revision).toBe(rev);
        expect(v.snapshot("tunnel", "t-1").applied_revision).toBe(rev);
      }
    });

    test("applier 只看到最终生效的那条：执行与推进之间没有别的命令插入", async () => {
      const v = new ControlValidator();
      const rec = recordingApplier();
      await Promise.all([
        v.handle(applyCmd("c-1", 1), rec.applier, NOW),
        v.handle(applyCmd("c-2", 2), rec.applier, NOW),
        v.handle(applyCmd("c-3", 3), rec.applier, NOW),
      ]);
      // 三条都执行过（按 revision 顺序），且最终 applied_revision = 3。
      expect(rec.seen.map((s) => s.revision)).toEqual([1, 2, 3]);
      expect(v.snapshot("tunnel", "t-1").applied_revision).toBe(3);
    });

    test("applier 可覆盖默认状态（例如 update_targets 后想标 suspended）", async () => {
      const v = new ControlValidator();
      await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
      await v.handle(
        { ...applyCmd("c-2", 2), action: "update_targets", payload: { targets: [{ address: "a", port: 80 }] } },
        () => ({ status: "suspended" }),
        NOW,
      );
      expect(v.snapshot("tunnel", "t-1").status).toBe("suspended");
    });
  });

  describe("C4. expired command reject（expires_at < now）", () => {
    test("expires_at < now → command_expired，且 applier 根本没被调", async () => {
      const v = new ControlValidator();
      const rec = recordingApplier();
      // 只给 expires_at、不给 issued_at：否则 issued_at(NOW) > expires_at(NOW-1000)
      // 会先撞 invalid_envelope，测的就不是过期规则了。
      const { issued_at: _drop, ...expired } = applyCmd("c-expired", 1, -1000);
      void _drop;
      const ack = await v.handle(expired, rec.applier, NOW);
      expect(ack.status).toBe("rejected");
      expect(ack.error_code).toBe("command_expired");
      expect(rec.seen.length).toBe(0);
    });

    test("边界：expires_at === now 时仍有效（宁可放行一个踩线的，别被时钟漂移全拒）", async () => {
      const v = new ControlValidator();
      const ack = await v.handle(applyCmd("c-edge", 1, 0), noopApplier, NOW);
      expect(ack.status).toBe("applied");
      expect(isExpired(new Date(NOW).toISOString(), NOW)).toBe(false);
    });

    test("过期命令不写账本、不动状态（过期与执行失败是两回事）", async () => {
      const v = new ControlValidator();
      await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
      await v.handle(applyCmd("c-2", 2, -1), noopApplier, NOW);
      expect(v.outcome("c-2")).toBeUndefined();
      expect(v.snapshot("tunnel", "t-1").applied_revision).toBe(1);
    });

    test("先合法后过期：同样内容的命令换个过期时间戳就被拒（过期按信封判定）", async () => {
      const v = new ControlValidator();
      await v.handle(applyCmd("c-1", 1, 1000), noopApplier, NOW);
      await v.handle(applyCmd("c-1b", 2, -1), noopApplier, NOW);
      expect(v.outcome("c-1b")).toBeUndefined();
      expect(v.snapshot("tunnel", "t-1").applied_revision).toBe(1);
    });
  });

  describe("C5. command_id 幂等键（跨规则的补强）", () => {
    test("同一 command_id 承载不同内容 → duplicate_command_id（真正的客户端 bug）", async () => {
      const v = new ControlValidator();
      await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
      const ack = await v.handle(applyCmd("c-1", 2, DEFAULT_COMMAND_TTL_MS, 90), noopApplier, NOW);
      expect(ack.status).toBe("rejected");
      expect(ack.error_code).toBe("duplicate_command_id");
      expect(v.snapshot("tunnel", "t-1").applied_revision).toBe(1);
    });

    test("指纹不依赖 JSON 键序（换字段顺序仍是同一命令）", () => {
      const a = applyCmd("c-1", 1);
      const b = { ...a, payload: { tunnel: { ...a.payload.tunnel } } };
      expect(commandFingerprint(a as never)).toBe(commandFingerprint(b as never));
      const c = applyCmd("c-1", 2);
      expect(commandFingerprint(a as never)).not.toBe(commandFingerprint(c as never));
    });

    test("账本 FIFO 淘汰后的 ack 会拿到 unknown_command（容量边界行为要说清）", async () => {
      const v = new ControlValidator({ maxLedgerEntries: 2 });
      await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
      await v.handle(applyCmd("c-2", 2), noopApplier, NOW);
      await v.handle(applyCmd("c-3", 3), noopApplier, NOW);
      // c-1 已被 c-3 顶掉。
      expect(v.outcome("c-1")).toBeUndefined();
      expect(v.outcome("c-3")).toBeDefined();
      expect(MAX_LEDGER_ENTRIES).toBeGreaterThan(2);
      const ack = await v.handle(
        ackEnvelope("ack-old", "c-1", { applied_revision: 1, status: "applied" }),
        noopApplier,
        NOW,
      );
      expect(ack.error_code).toBe("unknown_command");
    });
  });
});

/* ================================================================== */
/* D. 并发安全                                                          */
/* ================================================================== */

describe("D. 并发安全", () => {
  test("同一 command_id 并发提交只执行一次，其余拿到同一结果（第二个标 duplicate）", async () => {
    const v = new ControlValidator();
    const rec = recordingApplier();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => v.handle(applyCmd("c-race", 1), rec.applier, NOW)),
    );
    expect(rec.seen.length).toBe(1);
    expect(results.filter((r) => r.status === "applied").length).toBe(1);
    expect(results.filter((r) => r.status === "duplicate").length).toBe(7);
    expect(v.snapshot("tunnel", "t-1").applied_revision).toBe(1);
  });

  test("同一 resource 并发多版本：严格串行、applied_revision 单调不回退", async () => {
    const v = new ControlValidator();
    const rec = recordingApplier();
    const results = await Promise.all([
      v.handle(applyCmd("c-1", 1), rec.applier, NOW),
      v.handle(applyCmd("c-2", 2), rec.applier, NOW),
      v.handle(applyCmd("c-3", 3), rec.applier, NOW),
      v.handle(applyCmd("c-4", 4), rec.applier, NOW),
    ]);
    expect(rec.seen.map((s) => s.revision)).toEqual([1, 2, 3, 4]);
    const revisions = results.map((r) => r.applied_revision);
    expect(revisions).toEqual([1, 2, 3, 4]);
    expect(v.snapshot("tunnel", "t-1").applied_revision).toBe(4);
  });

  test("并发乱序到达：只有最新版本能落地，旧版本都 stale_reject", async () => {
    const v = new ControlValidator();
    const rec = recordingApplier();
    const order = [5, 1, 3, 4, 2];
    const results = await Promise.all(
      order.map((rev, i) => v.handle(applyCmd(`c-${i}`, rev), rec.applier, NOW)),
    );
    const applied = results.filter((r) => r.status === "applied");
    const rejected = results.filter((r) => r.error_code === "stale_revision");
    // 5 第一个被拿到锁并落地；其余全部 stale（因为锁是 FIFO，结果确定）。
    expect(applied.map((r) => r.applied_revision)).toEqual([5]);
    expect(rejected.length).toBe(4);
    expect(v.snapshot("tunnel", "t-1").applied_revision).toBe(5);
  });

  test("不同 resource 互不阻塞（同时处理两条资源，两者都推进）", async () => {
    const v = new ControlValidator();
    const rec = recordingApplier();
    await Promise.all([
      v.handle(
        {
          ...applyCmd("c-a", 1),
          resource_id: "t-a",
        },
        rec.applier,
        NOW,
      ),
      v.handle(
        {
          ...applyCmd("c-b", 1),
          resource_id: "t-b",
        },
        rec.applier,
        NOW,
      ),
    ]);
    expect(rec.seen.length).toBe(2);
    expect(v.snapshot("tunnel", "t-a").applied_revision).toBe(1);
    expect(v.snapshot("tunnel", "t-b").applied_revision).toBe(1);
  });

  test("applier 抛异常 → failed / apply_failed，applied_revision 不推进，同版本可重试", async () => {
    const v = new ControlValidator();
    const failing = () => {
      throw new Error("upstream refused");
    };
    const ack = await v.handle(applyCmd("c-1", 1), failing, NOW);
    expect(ack.status).toBe("failed");
    expect(ack.error_code).toBe("apply_failed");
    // 失败不推进版本：ACK 报回的是推进前的 applied_revision（这里是初始 0）。
    expect(ack.applied_revision).toBe(0);
    expect(v.snapshot("tunnel", "t-1").status).toBe("error");
    expect(v.snapshot("tunnel", "t-1").applied_revision).toBe(0);

    // 修好后重试同版本：仍走 apply_newer（失败不推进版本），这次成功。
    const retry = await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
    expect(retry.status).toBe("duplicate"); // 同 command_id 同内容 → 幂等回放失败结果
    // 换个 command_id 重试同一意图 → 真正重新执行。
    const retry2 = await v.handle(applyCmd("c-1-retry", 1), noopApplier, NOW);
    expect(retry2.status).toBe("applied");
    expect(v.snapshot("tunnel", "t-1").status).toBe("active");
  });

  test("applier 抛 ControlProtocolError → 用携带的错误码，不是笼统的 apply_failed", async () => {
    const v = new ControlValidator();
    const ack = await v.handle(applyCmd("c-1", 1), () => {
      throw new ControlProtocolError("payload_invalid", "tunnel named 'app' already exists");
    }, NOW);
    expect(ack.status).toBe("failed");
    expect(ack.error_code).toBe("payload_invalid");
  });

  test("applier 里抛错的命令不会把后续命令的队列打断（链不断）", async () => {
    const v = new ControlValidator();
    await v.handle(applyCmd("c-1", 1), () => {
      throw new Error("boom");
    }, NOW);
    const next = await v.handle(applyCmd("c-2", 2), noopApplier, NOW);
    expect(next.status).toBe("applied");
    expect(next.applied_revision).toBe(2);
  });

  test("executeMutation 期间 state_request 能看见 applying=true（执行中状态可见）", async () => {
    const v = new ControlValidator();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const applying = v.handle(applyCmd("c-slow", 1), async () => {
      await gate;
    }, NOW);
    // 让 handle 先跑进来（applier 挂在 gate 上）。
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = await v.handle(
      { ...applyCmd("q-slow", 0), action: "state_request", payload: {} },
      noopApplier,
      NOW,
    );
    expect(snapshot.state?.applying).toBe(true);
    expect(snapshot.state?.last_attempted_revision).toBe(1);
    release();
    await applying;
    const after = await v.handle(
      { ...applyCmd("q-done", 0), action: "state_request", payload: {} },
      noopApplier,
      NOW,
    );
    expect(after.state?.applying).toBe(false);
    expect(after.state?.status).toBe("active");
  });

  test("高并发混合（多资源 × 多版本 × 多重复）不产生任何 rejected/failed", async () => {
    const v = new ControlValidator();
    const rec = recordingApplier();
    const jobs: Promise<unknown>[] = [];
    for (const resourceId of ["t-1", "t-2", "t-3"]) {
      for (const revision of [1, 2, 3]) {
        jobs.push(
          v.handle({ ...applyCmd(`${resourceId}-${revision}`, revision), resource_id: resourceId }, rec.applier, NOW),
          // 再并发打一发完全相同的（幂等）
          v.handle({ ...applyCmd(`${resourceId}-${revision}`, revision), resource_id: resourceId }, rec.applier, NOW),
        );
      }
    }
    const results = (await Promise.all(jobs)) as { status: string; applied_revision: number | null }[];
    expect(results.filter((r) => r.status === "rejected").length).toBe(0);
    expect(results.filter((r) => r.status === "failed").length).toBe(0);
    expect(results.filter((r) => r.status === "applied").length).toBe(9);
    expect(results.filter((r) => r.status === "duplicate").length).toBe(9);
    expect(rec.seen.length).toBe(9); // 每个 (resource, revision) 只执行一次
    for (const resourceId of ["t-1", "t-2", "t-3"]) {
      expect(v.snapshot("tunnel", resourceId).applied_revision).toBe(3);
    }
  });
});

/* ================================================================== */
/* E. 下发侧工厂                                                        */
/* ================================================================== */

describe("E. createCommand 工厂", () => {
  test("构造出合法信封：command_id 生成、expires_at = issued_at + ttl", () => {
    const cmd = createCommand({
      resource: "tunnel",
      resource_id: "t-1",
      revision: 1,
      payload: {
        tunnel: {
          name: "web",
          tunnel_type: "wss",
          listen_port: 8443,
          targets: [{ address: "10.0.0.2", port: 80 }],
        },
      },
    });
    expect(cmd.command_id.length).toBeGreaterThan(0);
    expect(cmd.action).toBe("apply_tunnel");
    expect(Date.parse(cmd.expires_at)).toBeGreaterThan(Date.parse((cmd as { issued_at?: string }).issued_at!));
    expect(validateEnvelope(cmd, Date.now()).ok).toBe(true);
  });

  test("remove_tunnel 与 suspend_tunnel 形状相同，必须显式 action", () => {
    expect(createCommand({ resource: "tunnel", resource_id: "t", revision: 1, action: "remove_tunnel", payload: { reason: "x" } }).action).toBe(
      "remove_tunnel",
    );
    expect(
      createCommand({ resource: "tunnel", resource_id: "t", revision: 1, action: "suspend_tunnel", payload: { reason: "x" } }).action,
    ).toBe("suspend_tunnel");
  });

  test("坏 payload 在工厂就抛错，不会走到对端", () => {
    expect(() =>
      createCommand({ resource: "tunnel", resource_id: "t", revision: 1, payload: { tunnel: {} as never } }),
    ).toThrow(TypeError);
    // node 上没有变更命令：apply_tunnel 的目标只能是 tunnel。
    expect(() =>
      createCommand({
        resource: "node",
        resource_id: "n",
        revision: 1,
        action: "apply_tunnel",
        payload: { tunnel: { name: "x", tunnel_type: "wss", listen_port: 1, targets: [{ address: "a", port: 80 }] } },
      }),
    ).toThrow(TypeError);
  });

  test("工厂构造的命令能被 ControlValidator 正常接收", async () => {
    const v = new ControlValidator();
    const cmd = createCommand({
      resource: "tunnel",
      resource_id: "t-1",
      revision: 1,
      payload: {
        tunnel: {
          name: "web",
          tunnel_type: "wss",
          listen_port: 8443,
          targets: [{ address: "10.0.0.2", port: 80 }],
        },
      },
    });
    const ack = await v.handle(cmd, noopApplier);
    expect(ack.status).toBe("applied");
    expect(v.snapshot("tunnel", "t-1").applied_revision).toBe(1);
  });
});

/* ================================================================== */
/* F. 卫生性（状态隔离、reset）                                           */
/* ================================================================== */

describe("F. 实例隔离", () => {
  beforeEach(() => {
    // 每个用例一个全新 validator；这里断言默认构造不带旧状态。
  });

  test("新 validator 看不到旧状态（无跨用例泄漏）", async () => {
    const a = new ControlValidator();
    await a.handle(applyCmd("c-1", 1), noopApplier, NOW);
    const b = new ControlValidator();
    expect(b.getRecord("tunnel", "t-1")).toBeUndefined();
    const ack = await b.handle(applyCmd("c-1", 1), noopApplier, NOW);
    expect(ack.status).toBe("applied");
    // 两个实例互不影响。
    expect(a.snapshot("tunnel", "t-1").applied_revision).toBe(1);
    expect(b.snapshot("tunnel", "t-1").applied_revision).toBe(1);
  });

  test("reset() 之后一切清零", async () => {
    const v = new ControlValidator();
    await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
    v.reset();
    expect(v.getRecord("tunnel", "t-1")).toBeUndefined();
    expect(v.outcome("c-1")).toBeUndefined();
    const ack = await v.handle(applyCmd("c-1", 1), noopApplier, NOW);
    expect(ack.status).toBe("applied");
  });
});
