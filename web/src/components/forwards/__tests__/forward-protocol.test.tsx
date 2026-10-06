/**
 * V5-WP5-A1 §6.1 — Forward 协议面（tcp / tls / ws）的契约单测。
 *
 * 这个文件盯的是「前端协议面 == 后端契约」这件事，全部可离线运行：
 *
 *  A. 白名单：创建表单的协议选项**逐字**来自 `FORWARD_PROTOCOLS`，与后端
 *     `forward-contract.ts` 同一集合；没有第四个值，也**没有 `wss`**
 *     （§6.1：分帧 `ws` 与传输安全 `tls` 是两个维度，`wss` 是 WP0 拆掉的合并名）。
 *  A2/A3. 传输维度（V5.1b §6.2）：`udp` 是 datagram，**不是** stream 协议；它的
 *     工作单位是报文映射而不是连接，且它**没有**任何协议专属配置（不像 tls 的路径）。
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
  draftTlsPathErrors,
  draftToPatch,
} from "@/components/forwards/forward-edit-dialog";
import {
  FORWARD_CREATE_KEYS,
  FORWARD_TLS_CREATE_KEYS,
  forwardCopyCreateInput,
  forwardCopyDraft,
} from "@/components/forwards/forward-copy";
import {
  DEFAULT_FORWARD_PROTOCOL,
  FORWARD_PROTOCOLS,
  FORWARD_PROTOCOL_SPECS,
  FORWARD_TLS_PATH_MAX,
  FORWARD_TRANSPORTS,
  FORWARD_TRANSPORT_SPECS,
  forwardProtocolFact,
  forwardProtocolFields,
  forwardProtocolForCreate,
  forwardProtocolHasConnections,
  forwardProtocolLabel,
  forwardProtocolNote,
  forwardProtocolPatchFields,
  forwardProtocolSupported,
  forwardTransportFor,
  forwardTransportLifecycle,
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
const CREATE_DIALOG = WEB("components/forwards/forward-create-dialog.tsx");
const TABLE = WEB("components/forwards/forward-table.tsx");
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
    // V5.1b：udp 已经**是**契约值（它过去被用作「枚举里有、运行时没开」的例子，
    // 那个例子现在由 quic/mtcp 之类的值承担）。
    expect([...FORWARD_PROTOCOLS]).toEqual(["tcp", "tls", "ws", "udp"]);
  });

  test("FORWARD_TRANSPORTS / 每协议的 transport + lifecycle 逐条等于后端", () => {
    const source = BACKEND("src/services/forward-contract.ts");
    const transports = /export const FORWARD_TRANSPORTS = \[([^\]]*)\] as const;/
      .exec(source)?.[1];
    expect(transports).toBeTruthy();
    expect([...FORWARD_TRANSPORTS]).toEqual(
      [...(transports ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    );

    // 后端 `FORWARD_PROTOCOL_SPECS` 的每一行：协议 → transport（+ legacy 列）
    for (const protocol of FORWARD_PROTOCOLS) {
      const row = new RegExp(
        `${protocol}: \\{ transport: "([a-z]+)", legacy_tunnel_type: (null|"[a-z]+") \\}`,
      ).exec(source);
      expect(row, `${protocol} 在 FORWARD_PROTOCOL_SPECS 里`).not.toBe(null);
      expect(FORWARD_PROTOCOL_SPECS[protocol].transport).toBe(row?.[1]);
      const legacy = row?.[2] === "null" ? null : row?.[2]?.replace(/"/g, "");
      expect(FORWARD_PROTOCOL_SPECS[protocol].legacy_tunnel_type).toBe(legacy);
    }
    // 生命周期取值同样镜像（datagram 的 mapping 是这一维度存在的全部理由）
    for (const transport of FORWARD_TRANSPORTS) {
      const lifecycle = new RegExp(
        `${transport}: \\{ lifecycle: "(connection|mapping)" \\}`,
      ).exec(source)?.[1];
      expect(lifecycle, `${transport} 的 lifecycle`).toBeTruthy();
      expect(FORWARD_TRANSPORT_SPECS[transport].lifecycle).toBe(lifecycle);
    }
    expect(FORWARD_PROTOCOL_SPECS.udp).toEqual({
      transport: "datagram",
      legacy_tunnel_type: "udp",
    });
  });

  test("白名单里没有 `wss`（`wss = ws + TLS 终止`，不是协议名）", () => {
    expect((FORWARD_PROTOCOLS as readonly string[]).includes("wss")).toBe(false);
    // 表单/契约模块里都不许出现把 wss 当成可创建协议值的写法
    expect(WEB("lib/forward-protocol.ts")).not.toMatch(/FORWARD_PROTOCOLS[\s\S]{0,80}"wss"/);
    expect(WORKSPACE).not.toContain('value="wss"');
  });

  test("创建表单的协议下拉**由常量渲染**，不是手抄的选项列表", () => {
    // 选项来自 FORWARD_PROTOCOLS（后端加协议时前端只需更新常量，不会漏一个下拉项）
    expect(CREATE_DIALOG).toMatch(/FORWARD_PROTOCOLS\.map\(\(value\)\s*=>/);
    expect(CREATE_DIALOG).toContain('data-testid="forward-protocol-select"');
    // 没有手抄的选项值（udp 也必须是常量渲染出来的，不能是硬编码的一项）
    expect(CREATE_DIALOG).not.toMatch(/<SelectItem value="(tcp|tls|ws|udp|quic|wss|mtls|mwss|mtcp|tunex)"/);
  });

  test("isForwardProtocol / forwarded protocol fact 的判定与后端同一口径", () => {
    for (const value of FORWARD_PROTOCOLS) expect(isForwardProtocol(value)).toBe(true);
    for (const value of ["wss", "quic", "mtcp", "tcp ", "TCP", "", null, undefined, 7]) {
      expect(isForwardProtocol(value)).toBe(false);
    }
    // `forward_protocol` 优先，legacy `tunnel_type` 只是回落（V5-WP0 的持久化事实口径）
    expect(forwardProtocolFact("ws", "wss")).toBe("ws");
    expect(forwardProtocolFact(null, "tls")).toBe("tls");
    expect(forwardProtocolFact(undefined, undefined)).toBe(DEFAULT_FORWARD_PROTOCOL);
    expect(forwardProtocolSupported("ws", "wss")).toBe(true);
    expect(forwardProtocolSupported("udp", "udp")).toBe(true);
    expect(forwardProtocolSupported("wss", "wss")).toBe(false);
    expect(forwardProtocolSupported(null, "quic")).toBe(false);
  });

  test("历史协议不能被原样再创建（后端 z.enum 会 400）；udp 现在可以", () => {
    expect(forwardProtocolForCreate("tls")).toBe("tls");
    expect(forwardProtocolForCreate("ws")).toBe("ws");
    expect(forwardProtocolForCreate("udp")).toBe("udp");
    // 未开放的枚举名（含历史的 wss）仍然不能原样再创建
    expect(forwardProtocolForCreate("wss")).toBeNull();
    expect(forwardProtocolForCreate("quic")).toBeNull();
    expect(forwardProtocolForCreate("mtcp")).toBeNull();
  });
});

describe("A2. 传输维度：udp 是 datagram，**不是** stream 协议（V5.1b §6.2）", () => {
  test("三个 stream 协议 + 一个 datagram 协议（逐条断言，防止有人把 udp 挪回 stream）", () => {
    expect(forwardTransportFor("tcp")).toBe("stream");
    expect(forwardTransportFor("tls")).toBe("stream");
    expect(forwardTransportFor("ws")).toBe("stream");
    expect(forwardTransportFor("udp")).toBe("datagram");
    // 未开放的协议**没有**可声明的传输（fail-closed，不回落成 stream）
    expect(forwardTransportFor("wss")).toBeNull();
    expect(forwardTransportFor(null)).toBeNull();
  });

  test("生命周期：stream = connection，datagram = mapping", () => {
    expect(forwardTransportLifecycle("tcp")).toBe("connection");
    expect(forwardTransportLifecycle("udp")).toBe("mapping");
    expect(forwardTransportLifecycle("wss")).toBeNull();
  });

  test("只有 stream 协议有「连接」；udp 明确回答「没有」，未知协议回答「不知道」", () => {
    expect(forwardProtocolHasConnections("tcp")).toBe(true);
    expect(forwardProtocolHasConnections("tls")).toBe(true);
    expect(forwardProtocolHasConnections("ws")).toBe(true);
    expect(forwardProtocolHasConnections("udp")).toBe(false);
    expect(forwardProtocolHasConnections("wss")).toBeNull();
  });

  test("udp 的协议说明不提 TCP/stream，并且明说没有连接与显式关闭", () => {
    for (const locale of ["zh", "en"] as const) {
      const note = forwardProtocolNote(locale, "udp");
      expect(note.toLowerCase()).not.toContain("tcp");
      // 说「没有连接」是这段文案存在的理由（§6.2：不得假装存在连接）
      expect(note).toMatch(locale === "zh" ? /没有连接/ : /no connection/);
      expect(note.length).toBeGreaterThan(0);
    }
  });

  test("tcp/tls/ws 的协议说明逐字未变（datagram 的加入不改变既有协议的界面）", () => {
    const zh = forwardProtocolNote("zh", "tcp");
    const en = forwardProtocolNote("en", "tcp");
    expect(zh).toBe("普通 TCP 入口监听。");
    expect(en).toBe("A plain TCP ingress listener.");
    expect(forwardProtocolNote("zh", "tls")).toBe(
      "入口监听为 TLS（证书在入口节点本地文件里），跨节点一跳仍为普通 TCP。",
    );
    expect(forwardProtocolNote("zh", "ws")).toBe(
      "客户端以 WebSocket 连接入口，解帧后的字节流按普通 TCP 转发。",
    );
  });

  test("协议说明的 switch 是穷尽的：新增协议而不写文案 = tsc 错误，不会落进 TCP 兜底", () => {
    const code = WEB("lib/forward-protocol.ts");
    const note = code.slice(
      code.indexOf("export function forwardProtocolNote"),
      code.indexOf("/* ================================================================== */", code.indexOf("export function forwardProtocolNote")),
    );
    // 每一个契约值都必须有自己的分支……
    for (const protocol of FORWARD_PROTOCOLS) {
      expect(note).toContain(`case "${protocol}":`);
    }
    // ……而且**没有** default 分支（曾经的 default 会把 udp 说成「普通 TCP 入口监听」）
    expect(note).not.toMatch(/\bdefault:/);
  });
});

describe("A3. udp 没有协议专属配置（§6.2）：选它不需要、也不会发任何额外字段", () => {
  test("payload 只有 protocol；tls 的路径键结构上不存在", () => {
    expect(forwardProtocolFields("udp", "", "")).toEqual({ protocol: "udp" });
    // 就算调用方硬塞路径，udp 也带不出去（非 tls 一律丢弃）
    expect(forwardProtocolFields("udp", "/etc/tunex/a.crt", "/etc/tunex/a.key")).toEqual({
      protocol: "udp",
    });
    expect(Object.keys(forwardProtocolFields("udp", "", ""))).toEqual(["protocol"]);
  });

  test("路径规则把 udp 与 tcp/ws 一样拒掉（只有 tls 能有路径）", () => {
    expect(tlsPathFieldErrors("udp", "/etc/tunex/a.crt", "/etc/tunex/a.key")).toEqual({
      tls_cert_path: "forward.tlsPathNotAllowed",
      tls_key_path: "forward.tlsPathNotAllowed",
    });
    expect(tlsPathFieldErrors("udp", "", "")).toEqual({});
  });

  test("创建 udp 的完整 payload：键集合 = 创建字段集（不含任何 tls_*）", () => {
    const draft = {
      name: "udp front",
      mode: "direct" as const,
      ingressId: "1",
      egressId: "",
      listenPort: "",
      targetHost: "10.0.0.7",
      targetPort: "53",
      protocol: "udp" as const,
      tlsCertPath: "",
      tlsKeyPath: "",
    };
    const input = forwardCopyCreateInput(draft) as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual([...FORWARD_CREATE_KEYS].sort());
    expect(input.protocol).toBe("udp");
    expect(Object.keys(input)).not.toContain("tls_cert_path");
  });

  test("udp + relay 不再暴露旧的 DIRECT-only 产品警告", () => {
    expect(WORKSPACE).not.toContain("datagramRelayWarningKey");
    expect(WORKSPACE).not.toContain("forward-datagram-relay-warning");
    expect(EDIT_DIALOG).not.toContain("datagramRelayWarningKey");
    expect(EDIT_DIALOG).not.toContain("forward-datagram-relay-warning");
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

  test("复制：tls 转发仍是 tls，且路径随源行带过（视图现在投影这两列）", () => {
    const source = {
      id: 7,
      name: "tls 前端",
      protocol: "tls",
      protocol_supported: true,
      tls_cert_path: "/etc/tunex/tls/a.crt",
      tls_key_path: "/etc/tunex/tls/a.key",
      mode: "direct",
      ingress_node_id: 1,
      egress_node_id: null,
      listen_port: 20002,
      target_host: "10.0.0.21",
      target_port: 22,
    } as unknown as PortForward;
    const draft = forwardCopyDraft(source, "（副本）");
    expect(draft.protocol).toBe("tls");
    expect(draft.tlsCertPath).toBe("/etc/tunex/tls/a.crt");
    expect(draft.tlsKeyPath).toBe("/etc/tunex/tls/a.key");
    expect(tlsPathFieldErrors(draft.protocol, draft.tlsCertPath, draft.tlsKeyPath)).toEqual({});
    const input = forwardCopyCreateInput(draft) as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(
      [...FORWARD_CREATE_KEYS, ...FORWARD_TLS_CREATE_KEYS].sort(),
    );
  });

  test("复制：源行缺路径（历史行）时不猜 —— 草稿留空，由预检拦下提交", () => {
    const legacyTls = {
      id: 8,
      name: "历史 tls",
      protocol: "tls",
      protocol_supported: true,
      tls_cert_path: null,
      tls_key_path: null,
      mode: "direct",
      ingress_node_id: 1,
      egress_node_id: null,
      listen_port: 20003,
      target_host: "10.0.0.21",
      target_port: 22,
    } as unknown as PortForward;
    const draft = forwardCopyDraft(legacyTls, "（副本）");
    expect(draft.tlsCertPath).toBe("");
    expect(tlsPathFieldErrors(draft.protocol, draft.tlsCertPath, draft.tlsKeyPath)).toEqual({
      tls_cert_path: "forward.tlsPathRequired",
      tls_key_path: "forward.tlsPathRequired",
    });
  });

  test("复制：udp 源行不带任何协议专属字段（它一个都没有）", () => {
    const udpRow = {
      id: 9,
      name: "udp 前端",
      protocol: "udp",
      protocol_supported: true,
      tls_cert_path: null,
      tls_key_path: null,
      mode: "direct",
      ingress_node_id: 1,
      egress_node_id: null,
      listen_port: 20010,
      target_host: "10.0.0.7",
      target_port: 53,
    } as unknown as PortForward;
    const draft = forwardCopyDraft(udpRow, "（副本）");
    expect(draft.protocol).toBe("udp");
    const input = forwardCopyCreateInput(draft) as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual([...FORWARD_CREATE_KEYS].sort());
    expect(input.tls_cert_path).toBeUndefined();
  });

  test("复制：历史协议（wss/quic）不会被原样再创建 —— 草稿回到缺省协议，用户显式改选", () => {
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
    // 这里只守住组件边界：预检结果控制提交；具体协议校验/字段构造由上面的纯函数测试覆盖。
    expect(CREATE_DIALOG).toContain("forwardCreateProtocolErrors(draft)");
    expect(CREATE_DIALOG).toContain("!protocolReady");
    expect(WORKSPACE).toContain("forwardProtocolFields(createDraft.protocol");
    // 切走 tls 的清空语义由 changeForwardCreateProtocol 的行为测试负责，组件只需调用它。
    expect(CREATE_DIALOG).toContain("changeForwardCreateProtocol(draft, value as ForwardProtocol)");
  });

  test("tls 的两个路径输入只在 protocol==='tls' 时出现，且标了必填", () => {
    expect(CREATE_DIALOG).toContain('{draft.protocol === "tls" ? (');
    const start = CREATE_DIALOG.indexOf('{draft.protocol === "tls" ?');
    const end = CREATE_DIALOG.indexOf('<Field label={t("forward.ingressNode")}>');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = CREATE_DIALOG.slice(start, end);
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

  test("四个契约值都渲染成自己的名字", () => {
    expect(render({ protocol: "tcp", protocol_supported: true }, "zh")).toContain("TCP");
    expect(render({ protocol: "tls", protocol_supported: true }, "zh")).toContain("TLS");
    expect(render({ protocol: "ws", protocol_supported: true }, "zh")).toContain("WS");
    expect(render({ protocol: "udp", protocol_supported: true }, "zh")).toContain("UDP");
  });

  test("徽标带上传输事实：udp = datagram，其余 = stream，未开放 = 不声明", () => {
    expect(render({ protocol: "udp", protocol_supported: true }, "zh")).toContain(
      'data-transport="datagram"',
    );
    for (const protocol of ["tcp", "tls", "ws"] as const) {
      expect(render({ protocol, protocol_supported: true }, "zh")).toContain(
        'data-transport="stream"',
      );
    }
    const legacy = render({ protocol: "wss", protocol_supported: false }, "zh");
    expect(legacy).not.toContain("data-transport");
  });

  test("历史协议（wss/quic）照实渲染 + 标出「未开放」，不是 unknown、也不是 tcp", () => {
    for (const protocol of ["wss", "quic"]) {
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
    expect(TABLE).toContain("<ForwardProtocolBadge forward={forward} />");
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

  test("编辑器里协议只读（后端 patch 仍不接受 protocol），并给出原因", () => {
    expect(EDIT_DIALOG).toContain('data-testid="forward-edit-protocol"');
    expect(EDIT_DIALOG).toContain("forward.protocolFixedHint");
    // 编辑 patch 里不得混入协议字段（后端 ForwardPatchSchema 是 .strict()）
    expect(EDIT_DIALOG).not.toContain("patch.protocol");
    const patchBlock =
      /const ForwardPatchSchema = z([\s\S]*?)\.strict\(\)/.exec(BACKEND("src/routes/forwards.ts"))?.[1] ?? "";
    expect(patchBlock).not.toBe("");
    // 协议仍然不可编辑：schema 里没有 protocol 字段（把 tcp 改成 tls 不是一次编辑）。
    // 注释里当然会**提到** protocol，所以先剥注释再断言字段声明不存在。
    const patchCode = patchBlock.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(patchCode).not.toContain("protocol");
    // 但 tls 的路径**已经**可编辑（A1 修订）：schema 必须接受这两列，规则与创建相同
    expect(patchBlock).toContain(
      'tls_cert_path: z.string().trim().min(1).max(512).startsWith("/").optional()',
    );
    expect(patchBlock).toContain(
      'tls_key_path: z.string().trim().min(1).max(512).startsWith("/").optional()',
    );
  });

  test("编辑 tls 路径：只有 tls 行会发出，且只发真的改过、非空的值", () => {
    const current = { cert: "/etc/a.crt", key: "/etc/a.key" };
    // 没改 → 不发（与 draftToPatch 的增量语义一致）
    expect(
      forwardProtocolPatchFields("tls", current, { cert: "/etc/a.crt", key: "/etc/a.key" }),
    ).toEqual({});
    // 改一个 → 只发那一个（后端 `mergeForwardCandidate` 会与当前值合成完整一对）
    expect(
      forwardProtocolPatchFields("tls", current, { cert: "/etc/b.crt", key: "/etc/a.key" }),
    ).toEqual({ tls_cert_path: "/etc/b.crt" });
    expect(
      forwardProtocolPatchFields("tls", current, { cert: "/etc/a.crt", key: "/etc/b.key" }),
    ).toEqual({ tls_key_path: "/etc/b.key" });
    // 首尾空白在发出前 trim（后端 zod 也 trim）
    expect(
      forwardProtocolPatchFields("tls", current, { cert: "  /etc/c.crt  ", key: "/etc/a.key" }),
    ).toEqual({ tls_cert_path: "/etc/c.crt" });
    // 清空不是一次可提交的编辑：空串永远不进 patch（后端 zod 是 .min(1)）
    expect(forwardProtocolPatchFields("tls", current, { cert: "", key: "" })).toEqual({});
    // 非 tls 行（含 udp）结构上带不了路径
    for (const protocol of ["tcp", "ws", "udp", "wss"] as const) {
      expect(
        forwardProtocolPatchFields(protocol, { cert: null, key: null }, {
          cert: "/etc/a.crt",
          key: "/etc/a.key",
        }),
      ).toEqual({});
    }
  });

  test("draftToPatch：tls 行改路径才进 patch；udp/tcp 行永远不带这两个键", () => {
    const row = (over: Record<string, unknown>) =>
      ({
        id: 1,
        name: "front",
        mode: "direct",
        ingress_node_id: 1,
        egress_node_id: null,
        listen_port: 20001,
        target_host: "10.0.0.9",
        target_port: 8443,
        protocol: "tls",
        protocol_supported: true,
        tls_cert_path: "/etc/a.crt",
        tls_key_path: "/etc/a.key",
        ...over,
      }) as unknown as PortForward;
    const draft = (over: Record<string, unknown>) => ({
      name: "front",
      mode: "direct" as const,
      ingressId: "1",
      egressId: "",
      listenPort: "20001",
      targetHost: "10.0.0.9",
      targetPort: "8443",
      tlsCertPath: "/etc/a.crt",
      tlsKeyPath: "/etc/a.key",
      ...over,
    });

    // 未改：patch 为空（增量语义：没改的字段一个都不发）
    expect(Object.keys(draftToPatch(row({}), draft({})))).toEqual([]);
    // 只改证书：只发 tls_cert_path（后端 merge 会与当前 key 合成完整一对）
    expect(
      Object.keys(draftToPatch(row({}), draft({ tlsCertPath: "/etc/b.crt" }))),
    ).toEqual(["tls_cert_path"]);
    // 非 tls 行（udp / tcp）：草稿里即便有路径也一个都不发
    for (const protocol of ["udp", "tcp", "ws"]) {
      const patch = draftToPatch(
        row({ protocol, tls_cert_path: null, tls_key_path: null }),
        draft({}),
      );
      expect(Object.keys(patch)).toEqual([]);
    }
  });

  test("编辑器的 tls 路径预检与创建表单同一份规则（成对 + 绝对路径）", () => {
    const tls = { protocol: "tls" };
    expect(Object.keys(draftTlsPathErrors(tls, { tlsCertPath: "", tlsKeyPath: "" }))).toEqual([
      "tls_cert_path",
      "tls_key_path",
    ]);
    expect(
      draftTlsPathErrors(tls, { tlsCertPath: "/etc/a.crt", tlsKeyPath: "/etc/a.key" }),
    ).toEqual({});
    expect(
      draftTlsPathErrors(tls, { tlsCertPath: "etc/a.crt", tlsKeyPath: "/etc/a.key" })
        .tls_cert_path,
    ).toBe("forward.tlsPathAbsolute");
    // 非 tls 行不渲染、也不校验路径
    expect(draftTlsPathErrors({ protocol: "udp" }, { tlsCertPath: "", tlsKeyPath: "" })).toEqual(
      {},
    );
    // 编辑器接线：路径输入只在 tls 行出现，并参与保存闸门
    expect(EDIT_DIALOG).toContain('{isTlsForward ? (');
    expect(EDIT_DIALOG).toContain("draftTlsPathErrors(forward, draft)");
    expect(EDIT_DIALOG).toContain("hasTlsError ||");
  });
});

describe("F. 措辞接线：凡假设「连接」的地方都按传输切换（列表/详情/仪表盘/影响面）", () => {
  test("详情页：datagram 行说「会话模型」，tls 行展示证书/私钥路径", () => {
    const detail = WEB("components/forwards/forward-detail.tsx");
    expect(detail).toContain("forwardProtocolHasConnections(forward.protocol) === false");
    expect(detail).toContain("datagram ? (");
    expect(detail).toContain('t("forward.sessionModel")');
    expect(detail).toContain('t("forward.sessionModelMapping")');
    expect(detail).toContain("isTls ? (");
    expect(detail).toContain("forward.tls_cert_path");
    expect(detail).toContain("forward.tls_key_path");
    // 组件不自己比较协议名（"udp" 只许出现在注释里）
    const code = detail.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain('=== "udp"');
    expect(code).not.toContain('"udp"');
  });

  test("编辑器影响面按传输切换：datagram 不再复用 stream 的连接措辞", () => {
    expect(EDIT_DIALOG).toContain(
      'datagram ? t("forward.impactListenerDatagram") : t("forward.impactListener")',
    );
    expect(EDIT_DIALOG).toContain(
      'datagram ? t("forward.impactTargetDatagram") : t("forward.impactTarget")',
    );
    // 传输取值来自契约模块，不是组件里写死的协议名
    expect(EDIT_DIALOG).toContain('forwardTransportFor(forward.protocol) === "datagram"');
  });

  test("datagram 的两条影响面文案与「会话模型」都明说没有连接", () => {
    const zh = makeT(getDictionary("zh"));
    const en = makeT(getDictionary("en"));
    expect(zh("forward.impactListenerDatagram")).toMatch(/没有连接/);
    expect(en("forward.impactListenerDatagram")).toMatch(/no connections/i);
    expect(zh("forward.impactTargetDatagram")).toMatch(/没有连接/);
    expect(en("forward.impactTargetDatagram")).toMatch(/no connection/i);
    expect(zh("forward.sessionModelMapping")).toMatch(/不存在连接/);
    expect(en("forward.sessionModelMapping")).toMatch(/no connection/i);
    // 两条 stream 文案保持原样（tcp/tls/ws 必须与改动前一致）
    expect(zh("forward.impactListener")).toContain("存量连接被 drain");
    expect(en("forward.impactTarget")).toContain("existing connections stay");
  });

  test("tls 路径的 metadata-only 陷阱被显式说出来（条件挂后端的 metadata_only）", () => {
    expect(EDIT_DIALOG).toContain('t("forward.impactMetadataOnlyTlsPaths")');
    expect(EDIT_DIALOG).toContain("patch.tls_cert_path !== undefined");
    expect(EDIT_DIALOG).toContain("if (impact.metadata_only)");
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
    // datagram（udp）生命周期措辞
    "sessionModel",
    "sessionModelMapping",
    "impactListenerDatagram",
    "impactTargetDatagram",
    "impactMetadataOnlyTlsPaths",
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
