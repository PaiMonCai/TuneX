/**
 * V5.1b WP5-B2 源码级守卫：**ACK 字段要穿过五个边界，少一个就静默失效**。
 *
 * `hop_local_addr` 从 Agent 的响应体走到编排层，一路上经过了五个**逐字段重建**的边界：
 *
 *   ① `routes/internal-node.ts`            —— HTTP 入口，把响应体重建成 `AgentCommandAck`
 *   ② `services/agent-command-bus.ts`      —— 存进 Redis 前再重建一次
 *   ③ `services/agent-command-bus.ts`      —— 传输层返回给 `send()` 的对象
 *   ④ `services/orchestrator.ts`           —— `parseAgentAck` 读出响应体字段
 *   ⑤ `services/orchestrator.ts`           —— 合成 `command_ack` 信封（账本的唯一入口）
 *   （外加账本 `recordAck`：字段要在 `rememberAck` **之前**落上去，否则重放会丢）
 *
 * 这条链的失败形态极其安静：**每一层看起来都正常**，Agent 也确实发了
 *（实测 `type=*forwarder.DatagramRelay diag_ok=true hop=172.41.20.10:56588`），
 * 但面板侧读到的永远是 `null`，于是"出口取证地址纠正"一次都不触发，而控制面全绿。
 * 我为了找出它，在这条链上补了四处代码、加过两轮临时探针 —— 所以把它钉成机械断言：
 * **任何重建 ACK 形状的地方，都必须同时带上这个字段。**
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 一次边界：在 `file` 里找到 `anchor`，其前后 `WINDOW` 行内必须出现全部 `required` 片段。 */
interface AckBoundary {
  readonly site: string;
  readonly file: string;
  readonly anchor: string;
  readonly required: readonly string[];
}

const WINDOW = 14;

const BOUNDARIES: readonly AckBoundary[] = [
  {
    site: "① HTTP 入口重建 ACK",
    file: "routes/internal-node.ts",
    anchor: "await storeAgentCommandAck(auth.scope",
    required: ["applied_revision", "hop_local_addr"],
  },
  {
    site: "② 入 Redis 前的重建",
    file: "services/agent-command-bus.ts",
    anchor: "command_id: commandId,",
    required: ["applied_revision", "hop_local_addr"],
  },
  {
    site: "③ 传输层返回值",
    file: "services/agent-command-bus.ts",
    anchor: "applied_revision: ack.applied_revision,",
    required: ["hop_local_addr"],
  },
  {
    site: "④ parseAgentAck 读出响应体",
    file: "services/orchestrator.ts",
    anchor: "const rev = r.applied_revision ?? r.revision;",
    required: ["hop_local_addr"],
  },
  {
    site: "⑤ 合成 command_ack 信封",
    file: "services/orchestrator.ts",
    anchor: "applied_revision: ack.applied_revision ?? envelope.revision,",
    // 注意：`acked_command_id: envelope.command_id,` 在成功与失败两条合成路径里各出现一次，
    // 而只有**成功**那条需要带跳端点（失败 ack 没有端点可带）——所以锚点取成功路径独有的那一行。,
    required: ["hop_local_addr"],
  },
  {
    site: "⑥ 账本 recordAck（必须在 rememberAck 之前落字段）",
    file: "services/control-protocol/validator.ts",
    anchor: "cmd.payload.state ?? null,",
    required: ["hop_local_addr", "rememberAck"],
  },
];

function window(file: string, anchor: string): string {
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const at = lines.findIndex((l) => l.includes(anchor));
  expect(at, `${file} 里找不到锚点：${anchor}`).toBeGreaterThanOrEqual(0);
  return lines.slice(at, at + WINDOW).join("\n");
}

describe("V5.1b WP5-B2: hop_local_addr survives every ACK boundary (source-level guard)", () => {
  for (const b of BOUNDARIES) {
    test(`${b.site} 仍然带着它`, () => {
      const text = window(b.file, b.anchor);
      for (const needle of b.required) {
        expect(text, `${b.site} 的窗口里缺少 ${needle}`).toContain(needle);
      }
    });
  }

  test("守卫不是空转：六个边界都真的被定位到了", () => {
    // 每个锚点都必须唯一存在，否则上面的窗口检查会在错误的位置通过。
    for (const b of BOUNDARIES) {
      const lines = readFileSync(join(ROOT, b.file), "utf8").split("\n");
      const hits = lines.filter((l) => l.includes(b.anchor)).length;
      expect(hits, `${b.file} 里锚点「${b.anchor}」出现 ${hits} 次（应为 1）`).toBe(1);
    }
  });
});
