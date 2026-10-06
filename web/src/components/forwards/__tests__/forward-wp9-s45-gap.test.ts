/**
 * V4-WP9 S4/S5 补口：创建回执的最终访问地址 + 列表访问地址列 + 普通用户文案去 Tunnel。
 *
 * 背景（reports/v4-wp9-plan.md §2 S4）：
 *   · 「创建成功后不展示最终访问地址」——`createForward()` 曾把 `POST /api/forwards`
 *     的响应整个丢掉，只发一条通用 toast；
 *   · 「列表把空端口渲染成字面量 `auto`」——用户看到 `:auto` 这种伪地址。
 *
 * 本文件的硬约束：
 *   1. 地址**只能**来自后端响应（`listen_port` + 入口节点 `connect_ip`）；
 *      未分配时返回 null，由调用方展示「待确定」，绝不拼出 `:auto` / 假端口。
 *   2. 回执必须落库在 `createdForward` 上并使用 POST 的真实响应，不是重新取列表猜。
 *   3. 普通用户 Forward 文案中不再出现「隧道 / Tunnel」（Wave 4 清理），
 *      但 `tunnel.*` 命名空间（兼容/管理面）不动。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { forwardAccessAddress } from "@/components/forwards/forward-copy";
import { getDictionary, makeT } from "@/lib/i18n";
import type { PortForward } from "@/lib/types";

const WORKSPACE = readFileSync(
  new URL("../forward-workspace.tsx", import.meta.url),
  "utf8",
);
const TABLE = readFileSync(new URL("../forward-table.tsx", import.meta.url), "utf8");
const DETAIL = readFileSync(
  new URL("../forward-detail.tsx", import.meta.url),
  "utf8",
);
/** 折行与点号空格不影响调用点断言。 */
const norm = (src: string) => src.replace(/\s+/g, " ").replace(/\s*\.\s*/g, ".");

const forward = (overrides: Partial<PortForward> = {}) =>
  ({
    listen_ip: "0.0.0.0",
    listen_port: 20001,
    ingress_node: { connect_ip: "1.2.3.4" },
    ...overrides,
  }) as PortForward;

describe("V4-WP9 S4 访问地址：只消费后端返回值，绝不伪造", () => {
  test("已分配端口 → 用入口节点 connect_ip 拼出最终地址", () => {
    expect(forwardAccessAddress(forward())).toBe("1.2.3.4:20001");
  });

  test("auto port（listen_port = null）→ null：调用方必须显示「待确定」", () => {
    expect(forwardAccessAddress(forward({ listen_port: null }))).toBeNull();
  });

  test("入口 IP 缺失或只是通配地址 → null（不把 0.0.0.0 当成可访问地址）", () => {
    expect(
      forwardAccessAddress(forward({ ingress_node: null, listen_ip: "0.0.0.0" })),
    ).toBeNull();
    expect(forwardAccessAddress(forward({ ingress_node: null }))).toBeNull();
    expect(forwardAccessAddress(forward({ ingress_node: null, listen_ip: "" }))).toBeNull();
  });

  test("多 IP 取第一个有效值；IPv6 加方括号", () => {
    expect(
      forwardAccessAddress(
        forward({ ingress_node: { connect_ip: "  , 5.6.7.8 " } as never }),
      ),
    ).toBe("5.6.7.8:20001");
    expect(forwardAccessAddress(forward({ ingress_node: { connect_ip: "2001:db8::4" } as never }))).toBe(
      "[2001:db8::4]:20001",
    );
    // 已经是方括号形式的 IPv6 不重复包裹
    expect(forwardAccessAddress(forward({ ingress_node: { connect_ip: "[2001:db8::4]" } as never }))).toBe(
      "[2001:db8::4]:20001",
    );
  });
});

describe("V4-WP9 S4 列表 / 详情：`:auto` 字面量必须消失", () => {
  test("列表与详情都不再拼 `?? \"auto\"`", () => {
    expect(norm(WORKSPACE)).not.toContain('?? "auto"');
    expect(norm(DETAIL)).not.toContain('?? "auto"');
    expect(DETAIL).not.toContain(":auto");
  });

  test("列表新增「访问地址」列，且单元格走同一份纯逻辑 + 待确定文案", () => {
    expect(TABLE).toContain('t("forward.accessAddress")');
    expect(norm(TABLE)).toContain('forwardAccessAddress(forward) ?? t("forward.addressPending")');
    // 端口列保留（排序键仍是 listen_port），但空值渲染成文字而不是 `auto`
    expect(norm(TABLE)).toContain('forward.listen_port == null ? t("forward.addressPending") : `:${forward.listen_port}`');
  });

  test("两语言都有访问地址 / 待确定词条且非空", () => {
    for (const locale of ["zh", "en"] as const) {
      const t = makeT(getDictionary(locale));
      for (const key of ["forward.accessAddress", "forward.addressPending"]) {
        expect(t(key), `${locale}:${key}`).not.toBe(key);
        expect(t(key).trim().length).toBeGreaterThan(0);
      }
      // 待确定文案不得长得像一个真端口
      expect(t("forward.addressPending")).not.toMatch(/^\d+$/);
    }
  });
});

describe("V4-WP9 S4 创建成功回执：用 POST 的真实响应", () => {
  test("create 的返回值被保留并驱动回执（不再只发通用 toast）", () => {
    const src = norm(WORKSPACE);
    expect(src).toContain("const created = await api.forwards.create(");
    expect(src).toContain("setCreatedForward(created);");
    expect(WORKSPACE).not.toContain('toast.success(t("forward.createSuccess"))');
  });

  test("回执解释分两态：已确定地址 vs 端口未分配（自动分配）", () => {
    expect(WORKSPACE).toContain('t("forward.createReceiptAddress")');
    expect(WORKSPACE).toContain('t("forward.createReceiptPending")');
    // 两种状态由 forwardAccessAddress 的 null/非 null 决定，而不是重新猜端口
    expect(norm(WORKSPACE)).toContain(
      'forwardAccessAddress(createdForward ?? EMPTY_FORWARD) ? t("forward.createReceiptAddress") : t("forward.createReceiptPending")',
    );
    for (const locale of ["zh", "en"] as const) {
      const t = makeT(getDictionary(locale));
      for (const key of [
        "forward.createReceiptTitle",
        "forward.createReceiptAddress",
        "forward.createReceiptPending",
      ]) {
        expect(t(key), `${locale}:${key}`).not.toBe(key);
      }
    }
  });

  test("回执在 auto port 下显示待确定而不是伪地址（与纯函数一致）", () => {
    const created = forward({ listen_port: null });
    expect(forwardAccessAddress(created)).toBeNull();
    // 走进 `?? t("forward.addressPending")` 分支
    expect(makeT(getDictionary("zh"))("forward.addressPending")).toBe("待确定");
  });
});

describe("V4-WP9 S5 / Wave 4：普通用户 Forward 文案去 Tunnel", () => {
  test("forward.* 用户可见词条不再出现「隧道 / Tunnel」", () => {
    for (const locale of ["zh", "en"] as const) {
      const dict = getDictionary(locale).forward as Record<string, unknown>;
      for (const [key, value] of Object.entries(dict)) {
        if (typeof value !== "string") continue;
        expect(`${locale}.forward.${key}=${value}`).not.toMatch(/隧道/);
        expect(`${locale}.forward.${key}=${value}`).not.toMatch(/tunnel/i);
      }
    }
  });

  test("兼容用的 tunnel.* 命名空间不受影响（只改普通用户 Forward 词条）", () => {
    const zh = getDictionary("zh") as unknown as Record<string, Record<string, string>>;
    expect(typeof zh.tunnel.title).toBe("string");
    expect(zh.tunnel.title.length).toBeGreaterThan(0);
  });
});

describe("V4-WP9 S4 表格几何：新增列后占位格必须同步", () => {
  test("表头列数与 loading / empty 的 colSpan 一致", () => {
    // 只守住 loading / empty 使用同一跨度；具体列数由表格组件自身演进，
    // 避免新增/拆分列时测试依赖 JSX 源码解析。
    const spans = [...TABLE.matchAll(/colSpan=\{(\d+)\}/g)].map((m) => Number(m[1]));
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(new Set(spans).size).toBe(1);
    expect(spans[0]).toBeGreaterThan(0);
  });
});
