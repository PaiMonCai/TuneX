/**
 * V4-WP9 §13.6 — 复制 Forward / auto-port 提示 / Binding usage 的纯逻辑与契约单测。
 *
 * 全部可离线运行（无浏览器、无 DB、无网络）：
 *  A. 复制 payload：走**真实** create 契约，键集合恒等于后端 `ForwardCreateSchema`；
 *     id / status / traffic / revision 等运行态字段结构上进不来；端口一律自动分配。
 *  B. auto-port：空值 = 自动分配，必须给明确提示；不得回退成看起来像真值的端口号。
 *  C. Binding usage：前端**只消费**后端下发的 `used_by_forward_count` /
 *     `unbind_blocked`，不重算口径；0 → 可解绑，>0 → 使用中（解绑 409）。
 *  D. 接线契约：读组件源码断言调用点，防止实现悄悄偏离（例如改成先建后改、
 *     或把整行 spread 进 create）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  FORWARD_COPY_FORBIDDEN_FIELDS,
  FORWARD_CREATE_KEYS,
  FORWARD_NAME_MAX,
  forwardCopyCreateInput,
  forwardCopyDraft,
  forwardCopyName,
  isAutoPort,
  listenPortHintKey,
  listenPortPlaceholderKey,
} from "@/components/forwards/forward-copy";
import {
  bindingUsageCount,
  bindingUsageView,
} from "@/components/forwards/forward-binding-usage";
import { getDictionary, makeT } from "@/lib/i18n";
import type { NodeBinding, PortForward } from "@/lib/types";

const DIALOG = readFileSync(
  new URL("../forward-edit-dialog.tsx", import.meta.url),
  "utf8",
);
/** 归一化：折行/点号空格不影响调用点断言。 */
const SRC = DIALOG.replace(/\s+/g, " ").replace(/\s*\.\s*/g, ".");

/** 源转发：带齐运行态与统计字段 —— 复制时这些**必须**一个都不能跟着走。 */
const source: PortForward = {
  id: 7,
  name: "群晖 Web 面板",
  mode: "relay",
  ingress_node_id: 1,
  egress_node_id: 4,
  listen_port: 20001,
  target_host: "nas.lan",
  target_port: 5000,
  traffic: 123456,
  traffic_cost: 42,
  online: true,
  desired_status: "active",
  apply_status: "active",
  config_revision: 9,
  applied_revision: 9,
  latest_revision: 9,
  desired_revision_id: 90,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
} as PortForward;

const suffix = getDictionary("zh").forward.copySuffix;

describe("V4-WP9 复制 Forward — 走真实 create 契约", () => {
  test("payload 键集合 == 后端 ForwardCreateSchema（.strict() 下多一个键就 400）", () => {
    const input = forwardCopyCreateInput(forwardCopyDraft(source, suffix));
    expect(Object.keys(input).sort()).toEqual([...FORWARD_CREATE_KEYS].sort());
  });

  test("不复制 id / status / traffic / revision：运行态与统计字段一个都进不来", () => {
    const input = forwardCopyCreateInput(forwardCopyDraft(source, suffix)) as Record<
      string,
      unknown
    >;
    for (const field of FORWARD_COPY_FORBIDDEN_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(input, field)).toBe(false);
    }
    // 兜底：连序列化后的文本里都不该出现这些键名
    const serialized = JSON.stringify(input);
    for (const field of ['"traffic"', '"apply_status"', '"config_revision"']) {
      expect(serialized).not.toContain(field);
    }
  });

  test("listen_port 一律自动分配（null），绝不沿用源端口（否则撞 port_conflict）", () => {
    expect(source.listen_port).toBe(20001);
    const draft = forwardCopyDraft(source, suffix);
    expect(draft.listenPort).toBe("");
    expect(forwardCopyCreateInput(draft).listen_port).toBeNull();
  });

  test("业务配置照抄：mode / ingress / egress / 目标", () => {
    const input = forwardCopyCreateInput(forwardCopyDraft(source, suffix));
    expect(input.mode).toBe("relay");
    expect(input.ingress_node_id).toBe(1);
    expect(input.egress_node_id).toBe(4);
    expect(input.target_host).toBe("nas.lan");
    expect(input.target_port).toBe(5000);
  });

  test("direct 源即使残留 egress 也不带出去（否则 mode_topology_mismatch 400）", () => {
    const stale = { ...source, mode: "direct" } as PortForward; // 故意留下 egress_node_id
    const draft = forwardCopyDraft(stale, suffix);
    expect(draft.egressId).toBe("");
    expect(forwardCopyCreateInput(draft).egress_node_id).toBeNull();
  });

  test("名称带副本后缀，且截断到后端上限 60（长名不会 400）", () => {
    const short = forwardCopyName(source, suffix);
    expect(short).toBe(`群晖 Web 面板${suffix}`);

    const long = { ...source, name: "x".repeat(120) } as PortForward;
    const name = forwardCopyName(long, suffix);
    expect([...name].length).toBeLessThanOrEqual(FORWARD_NAME_MAX);
    expect(name.endsWith(suffix)).toBe(true);
  });

});

describe("V4-WP9 auto-port — 空值给明确提示，不给假端口号", () => {
  test("空 / 纯空白 = 自动分配", () => {
    expect(isAutoPort("")).toBe(true);
    expect(isAutoPort("   ")).toBe(true);
    expect(isAutoPort("20001")).toBe(false);
  });

  test("提示与占位符随「是否指定端口」切换", () => {
    expect(listenPortHintKey("")).toBe("forward.autoPortNotice");
    expect(listenPortHintKey("20001")).toBe("forward.listenPortFixed");
    expect(listenPortPlaceholderKey("")).toBe("forward.autoPortPlaceholder");
    expect(listenPortPlaceholderKey("20001")).toBe("forward.portPlaceholder");
  });

  test("两个语言的自动分配提示都是可读文案，且占位符不是具体端口号", () => {
    for (const locale of ["zh", "en"] as const) {
      const t = makeT(getDictionary(locale));
      for (const key of [
        "forward.autoPortNotice",
        "forward.listenPortFixed",
        "forward.autoPortPlaceholder",
      ]) {
        expect(t(key)).not.toBe(key); // 词条存在（未回落成 key）
        expect(t(key).trim().length).toBeGreaterThan(0);
      }
      // 关键：自动分配时占位符不能长得像真端口（老实现是 "20001"）
      expect(t("forward.autoPortPlaceholder")).not.toMatch(/^\d+$/);
      expect(t("forward.portPlaceholder")).toMatch(/^\d+$/);
    }
  });

');
  });

  test("preview 报 auto 时显式说明「保存后才确定端口」", () => {
    expect(SRC).toContain(
      'if (impact.port_status === "auto") lines.push(t("forward.impactPortAuto"));',
    );
    for (const locale of ["zh", "en"] as const) {
      expect(makeT(getDictionary(locale))("forward.impactPortAuto")).not.toBe(
        "forward.impactPortAuto",
      );
    }
  });
});

describe("V4-WP9 Binding usage — 只消费后端契约，不重算口径", () => {
  function bindingRow(overrides: Partial<Record<string, unknown>> = {}): NodeBinding {
    return {
      id: 1,
      ingress_node_id: 1,
      egress_node_id: 4,
      egress_node: { node_id: "egress-a" },
      created_at: "2026-09-01T00:00:00Z",
      used_by_forward_count: 0,
      unbind_blocked: false,
      ...overrides,
    } as unknown as NodeBinding;
  }

  test("0 条 → 可解绑；>0 条 → 使用中（两态互斥）", () => {
    const free = bindingUsageView(bindingRow());
    expect(free.used_by_forward_count).toBe(0);
    expect(free.blocked).toBe(false);
    expect(free.state).toBe("deletable");

    const busy = bindingUsageView(
      bindingRow({ used_by_forward_count: 3, unbind_blocked: true }),
    );
    expect(busy.used_by_forward_count).toBe(3);
    expect(busy.blocked).toBe(true);
    expect(busy.state).toBe("in-use");
  });

  test("blocked 以后端 `unbind_blocked` 为准（唯一判定点）", () => {
    // 后端说「可以解绑」，即便计数不为 0，也按后端的判定渲染
    const explicit = bindingUsageView(
      bindingRow({ used_by_forward_count: 2, unbind_blocked: false }),
    );
    expect(explicit.state).toBe("deletable");
  });

  test("字段缺失 / 负数 / NaN 一律归一到 0（不渲染 NaN 或负条数）", () => {
    const missing = { used_by_forward_count: undefined } as unknown as NodeBinding;
    expect(bindingUsageCount(missing)).toBe(0);
    expect(bindingUsageView(missing).state).toBe("deletable");

    expect(bindingUsageCount({ used_by_forward_count: -3 } as NodeBinding)).toBe(0);
    expect(
      bindingUsageCount({ used_by_forward_count: Number.NaN } as NodeBinding),
    ).toBe(0);
  });

  test("口径对齐后端：使用量由后端统计（读真实源码断言，前端不复制这条规则）", () => {
    const service = readFileSync(
      new URL("../../../../../backend/src/services/binding-usage.ts", import.meta.url),
      "utf8",
    );
    // 契约字段名是唯一实现，前端类型/mock/路由都只能认它
    expect(service).toContain("used_by_forward_count");
    expect(service).toContain("unbind_blocked");
    expect(service).toContain("bindingUsage");

    const backend = readFileSync(
      new URL("../../../../../backend/src/routes/nodes.ts", import.meta.url),
      "utf8",
    );
    // bindings 响应带上使用量投影（解绑前就能看到影响面）
    expect(backend).toContain("lookupBindingUsage(");
    expect(backend).toContain("bindingUsageMap(");
    // 解绑闸门只数 relay（与列表使用量同一口径）
    expect(backend).toContain('tunnel_mode: "relay"');
    // 使用中被拒绝时给出机器可读的错误码
    expect(backend).toContain('code: "binding_in_use"');
  });

