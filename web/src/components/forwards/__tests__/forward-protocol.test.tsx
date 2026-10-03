/**
 * V5-WP5-A1 §6.1 — Forward 协议面（tcp / tls / ws）的契约单测。
 *
 * 这个文件盯的是「前端协议面 == 后端契约」这件事，全部可离线运行：
 *
 *  A. 白名单：创建表单的协议选项**逐字**来自 `FORWARD_PROTOCOLS`，与后端
 *     `forward-contract.ts` 同一集合；没有第四个值，也**没有 `wss`**
 *     （§6.1：分帧 `ws` 与传输安全 `tls` 是两个维度，`wss` 是 WP0 拆掉的合并名）。
 *  B. tls 路径：`tls` 必须同时给出证书与私钥的节点本地绝对路径；非 tls 携带
 *     路径一律拒绝（与后端 `tlsPathsForProtocol` / zod schema 同一口径）。
 *  C. 渲染：`tls` / `ws` / 历史 `wss` / `udp` 四个取值都**照事实**渲染，
 *     不存在 "unknown protocol" 兜底，也不会把历史行谎报成 tcp。
 *  D. 接线：列表 / 详情 / Dashboard 三处共用同一枚协议徽标（不各写一段 switch）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import { ForwardProtocolBadge } from "@/components/forwards/forward-protocol-badge";
import {
  FORWARD_CREATE_KEYS,
  FORWARD_TLS_CREATE_KEYS,
  forwardCopyCreateInput,
  forwardCopyDraft,
} from "@/components/forwards/forward-copy";
import {
  DEFAULT_FORWARD_PROTOCOL,
  FORWARD_PROTOCOLS,
  FORWARD_TLS_PATH_MAX,
  forwardProtocolFact,
  forwardProtocolFields,
  forwardProtocolForCreate,
  forwardProtocolLabel,
  forwardProtocolSupported,
  isForwardProtocol,
  tlsPathFieldErrors,
} from "@/lib/forward-protocol";
import { getDictionary, makeT } from "@/lib/i18n";
import type { PortForward } from "@/lib/types";

/** 读 web/src 下的源码（相对路径以 `web/src` 为根）。 */
const WEB = (relative: string) =>
  readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");
/** 读后端源码：契约断言的唯一依据是后端的实现，不是前端的假设。 */
const BACKEND = (relative: string) =>
  readFileSync(new URL(`../../../../../backend/${relative}`, import.meta.url), "utf8");

const WORKSPACE = WEB("components/forwards/forward-workspace.tsx");
const EDIT_DIALOG = WEB("components/forwards/forward-edit-dialog.tsx");
const PROTOCOL_BADGE = WEB("components/forwards/forward-protocol-badge.tsx");

describe("A. 协议白名单：前端镜像后端契约，不多不少", () => {
  test("FORWARD_PROTOCOLS 逐字等于后端 forward-contract.ts 的白名单", () => {
    const source = BACKEND("src/services/forward-contract.ts");
    const match = /export const FORWARD_PROTOCOLS = \[([^\]]*)\] as const;/.exec(source);
    expect(match).not.toBe(null);
    const backendValues = [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(backendValues.length).toBeGreaterThan(0);
    expect([...FORWARD_PROTOCOLS]).toEqual(backendValues);
    expect([...FORWARD_PROTOCOLS]).toEqual(["tcp", "tls", "ws"]);
  });

  test("白名单里没有 `wss`（`wss = ws + TLS 终止`，不是协议名）", () => {
    expect((FORWARD_PROTOCOLS as readonly string[]).includes("wss")).toBe(false);
    // 表单/契约模块里都不许出现把 wss 当成可创建协议值的写法
    expect(WEB("lib/forward-protocol.ts")).not.toMatch(/FORWARD_PROTOCOLS[\s\S]{0,80}"wss"/);
    expect(WORKSPACE).not.toContain('value="wss"');
  });

  test("创建表单的协议下拉**由常量渲染**，不是手抄的选项列表", () => {
    // 选项来自 FORWARD_PROTOCOLS（后端加协议时前端只需更新常量，不会漏一个下拉项）
    expect(WORKSPACE).toContain("{FORWARD_PROTOCOLS.map((value) => (");
    expect(WORKSPACE).toContain('data-testid="forward-protocol-select"');
    // 没有硬编码的第四个值 / 没有 wss
    expect(WORKSPACE).not.toMatch(/<SelectItem value="(udp|quic|wss|mtls|mwss|mtcp|tunex)"/);
  });

  test("isForwardProtocol / forwarded protocol fact 的判定与后端同一口径", () => {
    for (const value of FORWARD_PROTOCOLS) expect(isForwardProtocol(value)).toBe(true);
    for (const value of ["udp", "wss", "quic", "tcp ", "TCP", "", null, undefined, 7]) {
      expect(isForwardProtocol(value)).toBe(false);
    }
    // `forward_protocol` 优先，legacy `tunnel_type` 只是回落（V5-WP0 的持久化事实口径）
    expect(forwardProtocolFact("ws", "wss")).toBe("ws");
    expect(forwardProtocolFact(null, "tls")).toBe("tls");
    expect(forwardProtocolFact(undefined, undefined)).toBe(DEFAULT_FORWARD_PROTOCOL);
    expect(forwardProtocolSupported("ws", "wss")).toBe(true);
    expect(forwardProtocolSupported("wss", "wss")).toBe(false);
    expect(forwardProtocolSupported(null, "udp")).toBe(false);
  });

  test("历史协议不能被原样再创建（后端 z.enum 会 400）", () => {
    expect(forwardProtocolForCreate("tls")).toBe("tls");
    expect(forwardProtocolForCreate("ws")).toBe("ws");
    expect(forwardProtocolForCreate("wss")).toBeNull();
    expect(forwardProtocolForCreate("udp")).toBeNull();
  });
});

describe("B. tls 路径规则：与后端 tlsPathsForProtocol / zod schema 同形", () => {
  test("tls 必须同时给出证书与私钥（少一个就拦下）", () => {
    expect(tlsPathFieldErrors("tls", "", "")).toEqual({
      tls_cert_path: "forward.tlsPathRequired",
      tls_key_path: "forward.tlsPathRequired",
    });
    expect(Object.keys(tlsPathFieldErrors("tls", "/etc/tunex/a.crt", ""))).toEqual([
      "tls_key_path",
    ]);
    expect(Object.keys(tlsPathFieldErrors("tls", "", "/etc/tunex/a.key"))).toEqual([
      "tls_cert_path",
    ]);
    expect(tlsPathFieldErrors("tls", "/etc/tunex/a.crt", "/etc/tunex/a.key")).toEqual({});
  });

  test("路径必须是节点本地绝对路径，且不超过后端 max(512)", () => {
    expect(tlsPathFieldErrors("tls", "etc/tunex/a.crt", "/etc/tunex/a.key").tls_cert_path).toBe(
      "forward.tlsPathAbsolute",
    );
    expect(tlsPathFieldErrors("tls", "./a.crt", "/etc/tunex/a.key").tls_cert_path).toBe(
      "forward.tlsPathAbsolute",
    );
    const tooLong = `/${"x".repeat(FORWARD_TLS_PATH_MAX)}`;
    expect(tlsPathFieldErrors("tls", tooLong, "/etc/tunex/a.key").tls_cert_path).toBe(
      "forward.tlsPathTooLong",
    );
  });

  test("非 tls 协议携带路径 = 拒绝（不是「发出去让 Agent 忽略」）", () => {
    for (const protocol of ["tcp", "ws"] as const) {
      const errors = tlsPathFieldErrors(protocol, "/etc/tunex/a.crt", "/etc/tunex/a.key");
      expect(errors).toEqual({
        tls_cert_path: "forward.tlsPathNotAllowed",
        tls_key_path: "forward.tlsPathNotAllowed",
      });
      // 只带一个也算
      expect(tlsPathFieldErrors(protocol, "/etc/tunex/a.crt", "").tls_cert_path).toBe(
        "forward.tlsPathNotAllowed",
      );
    }
    // 无路径时非 tls 是正常的
    expect(tlsPathFieldErrors("tcp", "", "")).toEqual({});
    expect(tlsPathFieldErrors("ws", "", "")).toEqual({});
  });

  test("后端 schema 的形状（可选 / 绝对路径 / 512）与前端预检一致", () => {
    const routes = BACKEND("src/routes/forwards.ts");
    expect(routes).toContain("z.enum(FORWARD_PROTOCOLS).optional()");
    expect(routes).toContain('tls_cert_path: z.string().trim().min(1).max(512).startsWith("/").optional()');
    expect(routes).toContain('tls_key_path: z.string().trim().min(1).max(512).startsWith("/").optional()');
    // 同一份路径规则的唯一实现（后端）
    const contract = BACKEND("src/services/forward-contract.ts");
    expect(contract).toContain("export function tlsPathsForProtocol(");
    expect(contract).toContain("只有 tls 转发可以携带证书/私钥路径");
    expect(contract).toContain("tls 转发必须提供证书与私钥路径");
  });
});

describe("C. payload：tls 带路径，tcp/ws 结构上带不了", () => {
  test("forwardProtocolFields：协议总是显式携带；非 tls 没有路径键", () => {
    const tcp = forwardProtocolFields("tcp", "/etc/tunex/a.crt", "/etc/tunex/a.key");
    expect(Object.keys(tcp)).toEqual(["protocol"]);
    expect(tcp.protocol).toBe("tcp");
    expect(JSON.stringify(tcp)).not.toContain("tls_cert_path");

    const ws = forwardProtocolFields("ws", "", "");
    expect(Object.keys(ws)).toEqual(["protocol"]);

    const tls = forwardProtocolFields("tls", "  /etc/tunex/a.crt  ", "/etc/tunex/a.key");
    expect(tls).toEqual({
      protocol: "tls",
      tls_cert_path: "/etc/tunex/a.crt",
      tls_key_path: "/etc/tunex/a.key",
    });
  });

  test("tls 缺路径时**不发空串**（该状态由预检拦下，不静默降级）", () => {
    expect(forwardProtocolFields("tls", "", "/etc/tunex/a.key")).toEqual({
      protocol: "tls",
      tls_key_path: "/etc/tunex/a.key",
    });
  });

  test("键集合与后端 .strict() schema 对齐：tcp/ws 只多一个 protocol", () => {
    expect(Object.keys(forwardProtocolFields("ws", "", "")).sort()).toEqual(["protocol"]);
    // tls 的键集合 = 基础集 + 两个路径键（由 forward-copy 的完整 payload 断言）
    const draft = {
      name: "web",
      mode: "direct" as const,
      ingressId: "1",
      egressId: "",
      listenPort: "",
      targetHost: "10.0.0.5",
      targetPort: "8443",
      protocol: "tls" as const,
      tlsCertPath: "/etc/tunex/a.crt",
      tlsKeyPath: "/etc/tunex/a.key",
    };
    const input = forwardCopyCreateInput(draft) as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(
      [...FORWARD_CREATE_KEYS, ...FORWARD_TLS_CREATE_KEYS].sort(),
    );
    expect(input.protocol).toBe("tls");
  });

  test("复制：tls 转发复制出来仍是 tls（不悄悄降级成 tcp），路径留空待重填", () => {
    const source = {
      id: 7,
      name: "tls 前端",
      protocol: "tls",
      protocol_supported: true,
      mode: "direct",
      ingress_node_id: 1,
      egress_node_id: null,
      listen_port: 20002,
      target_host: "10.0.0.21",
      target_port: 22,
    } as unknown as PortForward;
    const draft = forwardCopyDraft(source, "（副本）");
    expect(draft.protocol).toBe("tls");
    expect(draft.tlsCertPath).toBe("");
    expect(draft.tlsKeyPath).toBe("");
    // 未填路径时预检会拦住提交（不是发一条没有证书的 tls 配置）
    expect(tlsPathFieldErrors(draft.protocol, draft.tlsCertPath, draft.tlsKeyPath)).toEqual({
      tls_cert_path: "forward.tlsPathRequired",
      tls_key_path: "forward.tlsPathRequired",
    });
    // 填齐后落到 create 契约
    const filled = { ...draft, tlsCertPath: "/etc/tunex/a.crt", tlsKeyPath: "/etc/tunex/a.key" };
    const input = forwardCopyCreateInput(filled) as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(
      [...FORWARD_CREATE_KEYS, ...FORWARD_TLS_CREATE_KEYS].sort(),
    );
  });

  test("复制：历史协议（wss/udp）不会被原样再创建 —— 草稿回到缺省协议，用户显式改选", () => {
    const legacy = {
      id: 8,
      name: "历史 wss",
      protocol: "wss",
      protocol_supported: false,
      mode: "direct",
      ingress_node_id: 1,
      egress_node_id: null,
      listen_port: 20020,
      target_host: "192.168.1.99",
      target_port: 8080,
    } as unknown as PortForward;
    const draft = forwardCopyDraft(legacy, "（副本）");
    expect(draft.protocol).toBe(DEFAULT_FORWARD_PROTOCOL);
    expect(FORWARD_PROTOCOLS as readonly string[]).toContain(draft.protocol);
  });

  test("创建表单接线：提交按钮按同一份预检禁用，且路径经纯函数进入 payload", () => {
    expect(WORKSPACE).toContain("tlsPathFieldErrors(protocol, tlsCertPath, tlsKeyPath)");
    expect(WORKSPACE).toContain("!protocolReady");
    expect(WORKSPACE).toContain("...forwardProtocolFields(protocol, tlsCertPath, tlsKeyPath),");
    // 切走 tls 必须清空路径（否则残留路径会被后端 400）
    expect(WORKSPACE).toContain('setTlsCertPath("")');
    expect(WORKSPACE).toContain('setTlsKeyPath("")');
  });

  test("tls 的两个路径输入只在 protocol==='tls' 时出现，且标了必填", () => {
    expect(WORKSPACE).toContain('{protocol === "tls" ? (');
    const block = WORKSPACE.slice(
      WORKSPACE.indexOf('{protocol === "tls" ? ('),
      WORKSPACE.indexOf('<Field label={t("forward.ingressNode")}'),
    );
    expect(block).toContain('data-testid="forward-tls-cert-path"');
    expect(block).toContain('data-testid="forward-tls-key-path"');
    expect(block).toContain("protocolErrors.tls_cert_path");
    expect(block).toContain("protocolErrors.tls_key_path");
    // 必填语义（表单没有原生 submit，闸门在提交按钮上；这里给无障碍树同样的信息）
    expect(block).toContain("required");
    expect(block).toContain("aria-invalid");
    // 非 tls 时整个路径块不渲染 → 结构上不可能把路径发给 tcp/ws
    expect(block).not.toContain("tcp");
  });
});

describe("D. 渲染：tls / ws / 历史值都照事实，不存在 unknown 兜底", () => {
  const render = (forward: Pick<PortForward, "protocol" | "protocol_supported">, locale: "zh" | "en") =>
    renderToStaticMarkup(
      <I18nProvider locale={locale} dict={getDictionary(locale)}>
        <ForwardProtocolBadge forward={forward as PortForward} />
      </I18nProvider>,
    );

  test("三个契约值都渲染成自己的名字", () => {
    expect(render({ protocol: "tcp", protocol_supported: true }, "zh")).toContain("TCP");
    expect(render({ protocol: "tls", protocol_supported: true }, "zh")).toContain("TLS");
    expect(render({ protocol: "ws", protocol_supported: true }, "zh")).toContain("WS");
  });

  test("历史协议（wss/udp）照实渲染 + 标出「未开放」，不是 unknown、也不是 tcp", () => {
    for (const protocol of ["wss", "udp"]) {
      const html = render({ protocol, protocol_supported: false }, "zh");
      expect(html).toContain(protocol.toUpperCase());
      expect(html).toContain('data-testid="forward-protocol-unsupported"');
      expect(html.toLowerCase()).not.toContain("unknown");
      expect(html).not.toContain("TCP");
    }
    const en = render({ protocol: "wss", protocol_supported: false }, "en");
    expect(en).toContain("WSS");
    expect(en.toLowerCase()).not.toContain("unknown");
  });

  test("label / supported 纯函数：不发明取值，也不把缺字段当成未开放", () => {
    expect(forwardProtocolLabel("tls")).toBe("TLS");
    expect(forwardProtocolLabel("ws")).toBe("WS");
    expect(forwardProtocolLabel("wss")).toBe("WSS");
    expect(forwardProtocolLabel(undefined)).toBe("TCP");
    // 缺字段（旧 fixture）= 「不知道」→ 按开放处理，不把正常转发画成异常
    const html = render({ protocol: "tls" } as Pick<PortForward, "protocol" | "protocol_supported">, "zh");
    expect(html).toContain("TLS");
    expect(html).not.toContain("forward-protocol-unsupported");
  });

  test("三处渲染共用同一枚徽标（列表 / 详情 / Dashboard 不允许各写一套 switch）", () => {
    expect(WORKSPACE).toContain("<ForwardProtocolBadge forward={forward} />");
    expect(WEB("components/forwards/forward-detail.tsx")).toContain(
      "<ForwardProtocolBadge forward={forward} />",
    );
    expect(WEB("components/dashboard/dashboard-body.tsx")).toContain(
      "<ForwardProtocolBadge forward={forward} />",
    );
    // 徽标本身没有任何「未知协议 → 某个兜底文案」的分支（注释先剥掉：注释里
    // 正是在说明「不许出现 unknown 这种兜底」，不该被当成代码断言）。
    const badgeCode = PROTOCOL_BADGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    expect(badgeCode).toContain("forwardProtocolLabel(forward.protocol)");
    expect(badgeCode).not.toMatch(/unknown/i);
    expect(badgeCode).not.toContain('?? "tcp"');
    expect(badgeCode).not.toContain("switch (");
    // 编辑器只**引用**它，不自己再画一遍
    expect(EDIT_DIALOG).toContain('from "@/components/forwards/forward-protocol-badge"');
  });

  test("新增列不会破表格几何：Dashboard 前 5 条表的表头数 == colSpan", () => {
    const body = WEB("components/dashboard/dashboard-body.tsx");
    const header = /<TableHeader>([\s\S]*?)<\/TableHeader>/.exec(body)?.[1] ?? "";
    const columns = (header.match(/<TableHead\b/g) ?? []).length;
    expect(columns).toBe(7); // id / name / mode / protocol / port / traffic / status
    const spans = [...body.matchAll(/colSpan=\{(\d+)\}/g)].map((m) => Number(m[1]));
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) expect(span).toBe(columns);
  });

  test("编辑器里协议只读（后端 patch 不接受 protocol），并给出原因", () => {
    expect(EDIT_DIALOG).toContain('data-testid="forward-edit-protocol"');
    expect(EDIT_DIALOG).toContain("forward.protocolFixedHint");
    // 编辑草稿/ patch 里不得混入协议字段（后端 ForwardPatchSchema 是 .strict()）
    expect(EDIT_DIALOG).not.toContain("patch.protocol");
    const patchSchema = BACKEND("src/routes/forwards.ts");
    // 契约缺口（已在任务回报中记录）：patch schema 目前不接受 protocol / tls_*
    const patchBlock = /const ForwardPatchSchema = z([\s\S]*?)\.strict\(\)/.exec(patchSchema);
    expect(patchBlock).not.toBe(null);
    expect(patchBlock?.[1]).not.toContain("protocol");
    expect(patchBlock?.[1]).not.toContain("tls_cert_path");
  });
});

describe("E. 新增词条：中英双语齐备且不画成原始 key", () => {
  const KEYS = [
    "protocol",
    "protocolUnsupported",
    "protocolFixedHint",
    "tlsCertPath",
    "tlsKeyPath",
    "tlsPathsHint",
    "tlsPathRequired",
    "tlsPathAbsolute",
    "tlsPathTooLong",
    "tlsPathNotAllowed",
  ] as const;

  test("每个新词条在两个语言里都存在且非空（且不是回落的 key）", () => {
    for (const locale of ["zh", "en"] as const) {
      const dict = getDictionary(locale).forward as Record<string, unknown>;
      const t = makeT(getDictionary(locale));
      for (const key of KEYS) {
        expect(typeof dict[key], `${locale}.${key}`).toBe("string");
        expect((dict[key] as string).length, `${locale}.${key}`).toBeGreaterThan(0);
        expect(t(`forward.${key}`), `${locale}.${key}`).not.toBe(`forward.${key}`);
      }
    }
  });

  test("界面把预检返回的 key 都翻成人话（tlsPathRequired 等）", () => {
    const t = makeT(getDictionary("zh"));
    expect(t("forward.tlsPathRequired")).toContain("证书");
    expect(t("forward.tlsPathNotAllowed")).not.toBe("forward.tlsPathNotAllowed");
  });

  test("forward.* 词条仍然不含「隧道 / tunnel」（V4-WP9 的用户文案约束）", () => {
    for (const locale of ["zh", "en"] as const) {
      const dict = getDictionary(locale).forward as Record<string, unknown>;
      for (const [key, value] of Object.entries(dict)) {
        if (typeof value !== "string") continue;
        expect(`${locale}.forward.${key}`).not.toMatch(/隧道/);
        expect(`${locale}.forward.${key}`).not.toMatch(/tunnel/i);
      }
    }
  });
});
