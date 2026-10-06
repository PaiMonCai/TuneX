/**
 * V5-WP19-F —— 源码级机械守卫：**凡重建上报/读视图形状处，都必须带上 per-tunnel `diag`**。
 *
 * 为什么要有这条守卫（既有缺陷的形态）：`diag` 这条链的失败**极其安静** —— Agent 一直在
 * 上报、`node_state_report.tunnels` 里一直有值、写它的每一层看起来都正常，但面板侧
 * 「重建形状」的那些点（类型化 runtime 列表、遥测视图、上报投影）逐字段拷贝时没有它，
 * 于是读的人永远看不到：**一个把每个报文都丢掉的出口，和一个空闲的出口长得一模一样**。
 * 这与 WP5-B2 的 `hop_local_addr` 是同一种缺陷（见
 * `src/services/__tests__/v5-wp5-b2-ack-field-flow.test.ts` 的六个边界），所以用同一种
 * 守卫：**锚点 + 窗口内必须有代码级片段**，而不是靠注释或 code review 记住。
 *
 * 守卫分三类：
 *   A. **重建点**：窗口里必须出现 diag 的**代码**（不是注释里的字）——
 *      改动一旦把 diag 从重建里拿掉，这里立刻红；
 *   B. **原样透传点**：整块 `tunnels` JSON 必须原样带走（禁止在这里逐字段重建：
 *      `forbidden` 里点名了逐字段重建的特征片段）；
 *   C. **原始通路读点**：① 的出口取证纠正（`datagramHopPeerFor`）与调度/回收下发
 *      **必须继续读原始上报**的 `tunnels[].diag`；谁把它们换成类型化视图，必须是有意识的
 *      决定 —— 那就得同时改这条守卫（`forbidden` 会先红）。
 *
 * 最后一条测试断言守卫自身**不空转**：每个锚点都必须真的定位到（出现次数与预期一致），
 * 否则窗口检查会在错误的位置"通过"。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 本文件在 `backend/src/services/__tests__/v5-wp19/`：回到 `backend/` 是四层。 */
const BACKEND = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** 窗口：锚点行起算的行数（比 WP5-B2 守卫的 14 略宽，容纳 diag 的注释与展开行）。 */
const WINDOW = 22;

interface DiagBoundary {
  readonly site: string;
  /** 相对 `backend/` 的路径（仓库其它目录用 `../` 前缀，join 会归一）。 */
  readonly file: string;
  readonly anchor: string;
  /** 窗口内必须出现的代码级片段（注释不算：这些是标识符/表达式，不是文字）。 */
  readonly required: readonly string[];
  /** 窗口内**不得**出现的片段（防"重建掉了 diag 还看起来等价"）。 */
  readonly forbidden?: readonly string[];
  /** 锚点应出现的次数（缺省 1 = 必须唯一）。 */
  readonly occurrences?: number;
}

const BOUNDARIES: readonly DiagBoundary[] = [
  {
    site: "① 落库投影：per-tunnel diag 必须被显式带过去",
    file: "src/services/node-state.ts",
    anchor: "export function projectReportedTunnels(",
    // 坏形状（非对象）整键丢弃，其余原样带走 —— 这两个片段就是"带没带"的代码证据。
    required: ['Object.hasOwn(record, "diag")', "{ diag: _dropped, ...rest }"],
  },
  {
    site: "② 上报投影白名单：走投影函数，不再裸传 b.tunnels",
    file: "src/services/node-state.ts",
    anchor: "tunnels: projectReportedTunnels(",
    required: ["projectReportedTunnels(b.tunnels as ReportedTunnel[]"],
  },
  {
    site: "③ 快照读取：整块 tunnels 原样取（diag 在其中）",
    file: "src/services/node-state.ts",
    anchor: "tunnels: true,",
    required: ["tunnels"],
    // 逐字段重建的特征：一旦有人在这里展开隧道字段，diag 就没了。
    forbidden: ["ingress_port"],
  },
  {
    site: "④ 重连快照（重放面）：tunnels 整块回给 Agent",
    file: "src/services/node-state.ts",
    anchor: "tunnels: snap.tunnels ?? [],",
    required: ["snap.tunnels"],
    forbidden: ["ingress_port", "egress_port"],
  },
  {
    site: "⑤ 面板读路径：runtime 列表必须带上 diag",
    file: "src/services/node-health.ts",
    anchor: "export function parseReportedRuntimes(",
    required: ["normalizeTunnelDiag(o.diag)", "...(diag ? { diag } : {})"],
  },
  {
    site: "⑥ 面板接口：health 遥测视图暴露按 runtime 索引的 diag",
    file: "src/services/node-health-service.ts",
    anchor: "diags: Object.fromEntries(",
    required: ["running.filter((r) => r.diag !== undefined)"],
  },
  {
    site: "⑦ 原始通路读点（① 的出口取证纠正）：仍读原始 tunnels[].diag",
    file: "src/services/forward-contract.ts",
    anchor: "const diag = record.diag as { hop_local_addr?: unknown }",
    required: ["addressPartOfEndpoint(diag?.hop_local_addr)"],
    // 这条通路必须**继续**读原始块：类型化视图（facts/protocol）没有 hop_local_addr 的位置语义，
    // 谁要换过去，等于同时改出口取证纠正 —— 必须是有意识的决定（先改这条守卫）。
    forbidden: ["normalizeTunnelDiag", "tunnelDiagsById"],
  },
  {
    site: "⑧ 调度/下发：把原始上报 tunnels 传给取证地址推导",
    file: "src/services/scheduler.ts",
    anchor: "ingressReportedTunnels:",
    required: ["state_report?.tunnels"],
    forbidden: ["tunnelDiagsById"],
    occurrences: 2,
  },
  {
    site: "⑨ 回收/下发行投影：state_report 取整块 tunnels（原始通路，不是类型化投影）",
    file: "src/services/runtime-reconcile-sink.ts",
    anchor: "state_report: { select: { tunnels: true } }",
    required: ["tunnels: true"],
    // 与 ⑦⑧ 同一条纪律：这里读的是**原始上报**（下游 `datagramHopPeerFor` 要从
    // `tunnels[].diag.hop_local_addr` 推出口取证地址）。改成类型化视图 = 改了口径，
    // 必须是有意识的决定（先改这条守卫）。
    forbidden: ["ingress_port", "normalizeTunnelDiag", "tunnelDiagsById"],
  },
  {
    site: "⑩ Agent 侧线上键名：JSON 键必须还是 `diag`（改名 = 面板静默读不到）",
    file: "../agent/internal/reporter/heartbeat.go",
    anchor: "Diag *forwarder.ProtocolDiagnostics",
    required: ['json:"diag,omitempty"'],
  },
];

function linesOf(file: string): string[] {
  return readFileSync(join(BACKEND, file), "utf8").split("\n");
}

function windowsOf(file: string, anchor: string): { index: number; text: string }[] {
  const lines = linesOf(file);
  const out: { index: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(anchor)) out.push({ index: i, text: lines.slice(i, i + WINDOW).join("\n") });
  }
  return out;
}

describe("V5-WP19-F: per-tunnel diag survives every place that rebuilds the reported shape", () => {
  for (const b of BOUNDARIES) {
    test(`${b.site} 仍然带着它`, () => {
      const found = windowsOf(b.file, b.anchor);
      expect(found.length, `${b.file} 里找不到锚点：${b.anchor}`).toBeGreaterThan(0);
      for (const hit of found) {
        for (const needle of b.required) {
          expect(hit.text, `${b.site}（${b.file}:${hit.index + 1}）的窗口里缺少 ${needle}`).toContain(needle);
        }
        for (const needle of b.forbidden ?? []) {
          expect(hit.text, `${b.site}（${b.file}:${hit.index + 1}）的窗口里出现了应当禁止的 ${needle}`).not.toContain(
            needle,
          );
        }
      }
    });
  }

  test("守卫不是空转：每个锚点都真的被定位到了，且出现次数与预期一致", () => {
    // 锚点不唯一（或已消失）时，上面的窗口检查会在错误位置"通过"——这正是守卫空转的形态。
    for (const b of BOUNDARIES) {
      const hits = linesOf(b.file).filter((l) => l.includes(b.anchor)).length;
      const expected = b.occurrences ?? 1;
      expect(hits, `${b.file} 里锚点「${b.anchor}」出现 ${hits} 次（应为 ${expected}）`).toBe(expected);
    }
  });
});
