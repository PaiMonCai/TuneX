/**
 * V5.5 Federation Admin Console —— 页面/组件的**渲染不变量**（无浏览器、无网络）。
 *
 * 用 `renderToStaticMarkup` 直接渲染真实组件（仓库既有做法），盯的是契约要求，
 * 不是界面口味：
 *
 *   A. **不把异常压成一个 ERROR**：不同后端错误码渲染出不同的码、不同的「下一步」、
 *      不同的 retryable 标记；未知码显式标注「未知错误码」而不是冒充已知语义；
 *   B. **token 只显示一次**：确认后组件不再渲染明文，且纯逻辑断言已丢弃；
 *   C. **unattributed 单独成桶**：两桶互斥、各自计数，未归因行带显著标记；
 *   D. **revision 两个都摊开**：applied < requested 时有「尚未收敛」标记；
 *   E. **终态与失败可辨**：failed / revoked / expired 徽章互不相同；
 *   F. **内部概念只在 Admin**：Admin 侧存在联邦入口；User Console 的导航与文案
 *      不出现 federation / trust / grant / lease / epoch（延展 WP13.5A 的回归断言）。
 *
 * 跑法（web 目录）：bun test src/components/admin/__tests__/
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FEDERATION_TABS,
  FederationErrorNotice,
  FederationTable,
  FederationTabs,
  StatusPill,
  TokenOncePanel,
} from "@/components/admin/federation/federation-ui";
import { FederationLeasesManager } from "@/components/admin/federation/leases-manager";
import { FederationUsageManager } from "@/components/admin/federation/usage-manager";
import {
  FEDERATION_ERROR_ACTION,
  capacitySummary,
  dismissInvitation,
  federationErrorAction,
  federationErrorInfo,
  formatBytesBig,
  grantStatusText,
  invitationTokenForDisplay,
  isLiveLease,
  leaseRevisionView,
  leaseStateText,
  NO_INVITATION,
  revealInvitation,
  scopeSummary,
  splitUsage,
} from "@/components/admin/federation/federation-status";
import { ApiError } from "@/lib/api";
import { attributionHintText } from "@/components/admin/federation/federation-status";
import {
  FEDERATION_ATTRIBUTION_HINTS,
  FEDERATION_ERROR_CODES,
  FEDERATION_LEASE_STATES,
  type FederationErrorCode,
  type FederationLease,
  type FederationUsageRecord,
} from "@/lib/types";
import { CONSOLE_ROUTE_GROUPS, expectedConsolePageFile, visibleNavGroups, visibleNavItems } from "@/lib/nav";

const APP_DIR = resolve(import.meta.dir, "..", "..", "..", "app");

const errorBody = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  message: `${code} from backend`,
  retryable: code === "peer_unreachable",
  peer_panel_id: "peer-1",
  correlation_id: "corr-1",
  ...extra,
});

describe("A. 错误分层：不同码 = 不同界面", () => {
  test("六种典型失败的码与「下一步」各不相同", () => {
    const codes = [
      "peer_unreachable",
      "peer_revoked",
      "key_unknown",
      "grant_expired",
      "quota_exhausted",
      "handshake_invalid",
    ];
    const rendered = codes.map((code) => {
      const info = federationErrorInfo(new ApiError(502, `${code} from backend`, errorBody(code)));
      return {
        code,
        html: renderToStaticMarkup(<FederationErrorNotice error={info} locale="zh" />),
        action: federationErrorAction("zh", code),
      };
    });
    // 每个码都渲染出自己的码与自己的下一步
    for (const item of rendered) {
      expect(item.html).toContain(`data-error-code="${item.code}"`);
      expect(item.html).toContain(item.action);
    }
    // 「下一步」两两不同（不是同一句 "操作失败"）
    expect(new Set(rendered.map((r) => r.action)).size).toBe(codes.length);
  });

  test("可重试与不可重试在 DOM 上可区分", () => {
    const retryable = renderToStaticMarkup(
      <FederationErrorNotice error={federationErrorInfo(new ApiError(502, "x", errorBody("peer_unreachable")))} locale="zh" />,
    );
    const fatal = renderToStaticMarkup(
      <FederationErrorNotice error={federationErrorInfo(new ApiError(403, "x", errorBody("peer_revoked")))} locale="zh" />,
    );
    expect(retryable).toContain('data-retryable="true"');
    expect(fatal).toContain('data-retryable="false"');
    expect(retryable).toContain("可重试");
    expect(fatal).toContain("不可重试");
  });

  test("闭集外的码显式标成「未知错误码」，不冒充已知语义", () => {
    const info = federationErrorInfo(new ApiError(500, "x", errorBody("brand_new_code")));
    expect(info.known).toBe(false);
    const html = renderToStaticMarkup(<FederationErrorNotice error={info} locale="zh" />);
    expect(html).toContain("未知错误码");
    expect(html).toContain("未知错误码：拿 correlation id 查面板日志");
    expect(html).toContain("brand_new_code");
  });

  test("correlation_id / peer_panel_id 必须出现在界面上（跨面板排障要用）", () => {
    const html = renderToStaticMarkup(
      <FederationErrorNotice error={federationErrorInfo(new ApiError(502, "x", errorBody("peer_unreachable")))} locale="zh" />,
    );
    expect(html).toContain("corr-1");
    expect(html).toContain("peer-1");
  });

  test("每个闭集码都有穷尽「下一步」文案（后端加码这里编译失败）", () => {
    for (const code of FEDERATION_ERROR_CODES) {
      const entry = FEDERATION_ERROR_ACTION[code as FederationErrorCode];
      expect({ code, zh: entry.zh.length > 0, en: entry.en.length > 0 }).toEqual({ code, zh: true, en: true });
      expect(entry.zh).not.toBe(entry.en);
    }
    expect(Object.keys(FEDERATION_ERROR_ACTION).sort()).toEqual([...FEDERATION_ERROR_CODES].sort());
  });
});

describe("B. 邀请 token 只显示一次", () => {
  const invitation = {
    token: "fedinv_deadbeefdeadbeefdeadbeefdeadbeef",
    peer_id: 9,
    expires_at: "2026-10-05T03:00:00.000Z",
    panel_id: "panel-a",
    key_id: "k_1",
  };

  test("拿到响应时渲染明文 + 带外传递提示", () => {
    const state = revealInvitation(invitation);
    const html = renderToStaticMarkup(<TokenOncePanel state={state} locale="zh" onDismiss={() => {}} />);
    expect(html).toContain(invitation.token);
    expect(html).toContain('data-token-visible="true"');
    expect(html).toContain("只显示这一次");
    expect(html).toContain("带外渠道");
  });

  test("确认之后明文从状态与 DOM 里一起消失", () => {
    const dismissed = dismissInvitation(revealInvitation(invitation));
    expect(invitationTokenForDisplay(dismissed)).toBeNull();
    const html = renderToStaticMarkup(<TokenOncePanel state={dismissed} locale="zh" onDismiss={() => {}} />);
    expect(html).toBe("");
    expect(html).not.toContain(invitation.token);
    // 空状态也渲染不出任何东西
    expect(renderToStaticMarkup(<TokenOncePanel state={NO_INVITATION} locale="zh" onDismiss={() => {}} />)).toBe("");
  });

  test("纯逻辑只暴露一个读点（别处拿不到明文）", () => {
    const shown = revealInvitation(invitation);
    expect(invitationTokenForDisplay(shown)).toBe(invitation.token);
    expect(dismissInvitation(shown)).toEqual({ ...NO_INVITATION, acknowledged: true });
  });
});

describe("C. 用量的 unattributed 单独成桶", () => {
  const rows: FederationUsageRecord[] = [
    {
      usage_id: "u1",
      peer_panel_id: "peer-a",
      lease_ref: "l1",
      forward_ref: "f1",
      tunnel_id: 10,
      window_start: "2026-10-05T00:00:00.000Z",
      window_end: "2026-10-05T00:30:00.000Z",
      bytes_in: "1024",
      bytes_out: "2048",
      connections: 7,
      attribution: "attributed",
      attribution_hint: null,
      received_at: "2026-10-05T00:31:00.000Z",
    },
    {
      usage_id: "u2",
      peer_panel_id: "peer-a",
      lease_ref: "l-orphan",
      forward_ref: null,
      tunnel_id: null,
      window_start: "2026-10-05T00:00:00.000Z",
      window_end: "2026-10-05T00:30:00.000Z",
      bytes_in: "4096",
      bytes_out: "8192",
      connections: 2,
      attribution: "unattributed",
      attribution_hint: "no_local_placement",
      received_at: "2026-10-05T00:31:00.000Z",
    },
  ];

  test("两桶互斥且各自计数", () => {
    const split = splitUsage(rows);
    expect(split.attributed.map((r) => r.usage_id)).toEqual(["u1"]);
    expect(split.unattributed.map((r) => r.usage_id)).toEqual(["u2"]);
    expect(split.attributedTotals.records).toBe(1);
    expect(split.unattributedTotals.records).toBe(1);
    expect(split.attributedTotals.bytes_in).toBe("1024");
    expect(split.unattributedTotals.bytes_in).toBe("4096");
  });

  test("渲染：未归因行只在未归因区块，且带显著告警", () => {
    const html = renderToStaticMarkup(<FederationUsageManager initial={rows} locale="zh" />);
    expect(html).toContain('data-testid="federation-usage-unattributed-alert"');
    expect(html).toContain('data-attribution="unattributed"');
    expect(html).toContain('data-attribution="attributed"');
    expect(html).toContain("l-orphan");
    // 已归因区块不出现未归因的租约引用
    const attributedSection = html.slice(
      html.indexOf('data-testid="federation-usage-attributed-section"'),
      html.indexOf('data-testid="federation-usage-unattributed-section"'),
    );
    expect(attributedSection).not.toContain("l-orphan");
    expect(attributedSection).toContain("f1");
  });

  test("未归因行展示后端判据（attribution_hint）而不是我们猜的原因", () => {
    const split = splitUsage(rows);
    expect(split.unattributed[0].attribution_hint).toBe("no_local_placement");
    const html = renderToStaticMarkup(<FederationUsageManager initial={rows} locale="zh" />);
    expect(html).toContain('data-testid="federation-usage-hint"');
    expect(html).toContain('data-hint="no_local_placement"');
    expect(html).toContain("本机没有这条租约的放置记录");
    // 已归因行不带判据（后端对 attributed 恒返回 null）
    expect(html).toContain("received");
  });

  test("判据文案穷尽且可验证（冲突型与无轨迹型说法不同）", () => {
    const zh = FEDERATION_ATTRIBUTION_HINTS.map((h) => attributionHintText("zh", h)!);
    const en = FEDERATION_ATTRIBUTION_HINTS.map((h) => attributionHintText("en", h)!);
    expect(new Set(zh).size).toBe(zh.length);
    expect(new Set(en).size).toBe(en.length);
    expect(attributionHintText("zh", "placement_conflict")).toContain("两侧说法冲突");
    expect(attributionHintText("zh", "no_local_placement")).toContain("本地无轨迹");
    // 未知判据原样回显（不冒充已知语义）
    expect(attributionHintText("zh", "something_new")).toBe("something_new");
    expect(attributionHintText("zh", null)).toBeNull();
  });

  test("字节数不经过 Number：>2^53 也不丢精度", () => {
    const huge = "9007199254740993"; // 2^53 + 1
    expect(formatBytesBig(huge)).not.toContain("9007199254740992");
    expect(formatBytesBig("0")).toBe("0 B");
    expect(formatBytesBig("1024")).toBe("1.0 KB");
    expect(formatBytesBig("1536")).toBe("1.5 KB");
    expect(formatBytesBig("1073741824")).toBe("1.0 GB");
    expect(formatBytesBig("not-a-number")).toBe("—");
    const split = splitUsage([
      { ...rows[0], usage_id: "a", bytes_in: huge, bytes_out: "0" },
      { ...rows[0], usage_id: "b", bytes_in: "1", bytes_out: "0" },
    ]);
    expect(split.attributedTotals.bytes_in).toBe("9007199254740994"); // BigInt 精确相加
  });
});

describe("D/E. 租约：revision 摊开 + 状态可辨", () => {
  const base: FederationLease = {
    lease_ref: "l_1",
    grant_id: 1,
    peer_panel_id: "peer-a",
    forward_ref: "f1",
    intent_id: "i1",
    state: "active",
    lease_epoch: 2,
    hop_role: "egress",
    node_id: 5,
    listen_port: 24001,
    requested_revision: 5,
    applied_revision: 5,
    last_error_code: null,
    expires_at: "2030-01-01T00:00:00.000Z",
    released_at: null,
  };

  test("applied 落后 → 两个数字都渲染 + 「尚未收敛」标记", () => {
    const lagging = { ...base, lease_ref: "l_lag", requested_revision: 9, applied_revision: 7 };
    const html = renderToStaticMarkup(<FederationLeasesManager initial={[lagging]} placements={[]} locale="zh" />);
    expect(html).toContain('data-lagging="true"');
    expect(html).toContain("尚未收敛");
    expect(html).toContain("7");
    expect(html).toContain("9");
    const view = leaseRevisionView(lagging, "zh");
    expect(view).toMatchObject({ applied: 7, requested: 9, lagging: true, synced: false });
  });

  test("applied 为空不等于已同步", () => {
    const never = { ...base, applied_revision: null, requested_revision: 3 };
    const view = leaseRevisionView(never, "zh");
    expect(view.synced).toBe(false);
    expect(view.lagging).toBe(true);
    expect(view.text).toContain("尚未下发");
  });

  test("failed / revoked / expired 用不同徽章（不压成一个 ERROR）", () => {
    const labels = FEDERATION_LEASE_STATES.map((state) => leaseStateText("zh", state).label);
    expect(new Set(labels).size).toBe(FEDERATION_LEASE_STATES.length);
    expect(leaseStateText("zh", "failed").tone).toBe("destructive");
    expect(leaseStateText("zh", "revoked").tone).toBe("destructive");
    expect(leaseStateText("zh", "expired").tone).toBe("outline");
    expect(leaseStateText("zh", "active").tone).toBe("success");
    expect(leaseStateText("zh", "unknown_state").label).toContain("unknown_state");
  });

  test("last_error_code 原样渲染（不翻译、不吞掉）", () => {
    const failing = { ...base, lease_ref: "l_fail", state: "failed", last_error_code: "peer_unreachable" };
    const html = renderToStaticMarkup(<FederationLeasesManager initial={[failing]} placements={[]} locale="zh" />);
    expect(html).toContain("peer_unreachable");
    expect(html).toContain('data-testid="federation-last-error-code"');
  });

  test("只有非终态才算 live（终态不再被当作占用中）", () => {
    expect(isLiveLease({ state: "active" })).toBe(true);
    expect(isLiveLease({ state: "reserved" })).toBe(true);
    expect(isLiveLease({ state: "releasing" })).toBe(true);
    for (const terminal of ["released", "expired", "revoked"] as const) {
      expect({ terminal, live: isLiveLease({ state: terminal }) }).toEqual({ terminal, live: false });
    }
  });

  test("home 侧镜像与 host 租约同页可见（对账信号）", () => {
    const html = renderToStaticMarkup(
      <FederationLeasesManager
        initial={[base]}
        placements={[
          {
            peer_panel_id: "peer-a",
            forward_ref: "f1",
            tunnel_id: 10,
            intent_id: "i1",
            lease_ref: "l_1",
            lease_epoch: 2,
            hop_role: "egress",
            desired_revision: 5,
            applied_revision: 4,
            state: "degraded",
            peer_node_ref: "sg-egress-01",
            peer_port: 24001,
            last_error_code: "peer_unreachable",
            expires_at: null,
          },
        ]}
        locale="zh"
      />,
    );
    expect(html).toContain('data-testid="federation-placements-section"');
    expect(html).toContain("sg-egress-01");
    expect(html).toContain("home 侧镜像");
  });
});

describe("F. 内部概念只在 Admin Console", () => {
  test("Admin 侧联邦入口全是真链接（不再是 planned 禁用项）", () => {
    const federation = visibleNavGroups("admin", { paymentsEnabled: true }).find((g) => g.id === "federation")!;
    expect(federation).toBeDefined();
    const hrefs = federation.items.map((i) => i.href);
    expect(hrefs).toContain("/admin/federation");
    for (const href of [
      "/admin/federation/peers",
      "/admin/federation/trust",
      "/admin/federation/grants",
      "/admin/federation/remote-leases",
      "/admin/federation/usage",
    ]) {
      expect(hrefs).toContain(href);
    }
    expect(federation.items.every((i) => (i.status ?? "available") === "available")).toBe(true);
    // 每条 entry 都能落到真实文件（route group 不产生 URL 段）
    for (const href of hrefs) {
      expect(expectedConsolePageFile(href)).toBe(`(admin)/admin/federation${href.replace("/admin/federation", "")}/page.tsx`);
    }
  });

  test("六条联邦页面文件真实存在", () => {
    for (const href of [
      "/admin/federation",
      "/admin/federation/peers",
      "/admin/federation/trust",
      "/admin/federation/grants",
      "/admin/federation/remote-leases",
      "/admin/federation/usage",
    ]) {
      const rel = href === "/admin/federation" ? "(admin)/admin/federation/page.tsx" : `(admin)/admin/federation${href.replace("/admin/federation", "")}/page.tsx`;
      expect({ href, exists: readFileSync(resolve(APP_DIR, rel), "utf8").length > 0 }).toEqual({ href, exists: true });
    }
    expect(CONSOLE_ROUTE_GROUPS.admin).toBe("(admin)");
  });

  test("User Console 导航与文案里没有任何联邦内部概念（延展 WP13.5A 回归）", () => {
    const forbidden = ["federation", "trust", "grant", "lease", "epoch", "peer"];
    for (const group of visibleNavGroups("user", { paymentsEnabled: true })) {
      for (const word of forbidden) expect(group.id.includes(word)).toBe(false);
      for (const item of group.items) {
        for (const word of forbidden) {
          expect({ href: item.href, word, hit: item.href.toLowerCase().includes(word) }).toEqual({ href: item.href, word, hit: false });
          const labels = [item.labelKey ?? "", item.labelZh ?? "", item.labelEn ?? ""].join(" ").toLowerCase();
          expect({ href: item.href, word, hit: labels.includes(word) }).toEqual({ href: item.href, word, hit: false });
        }
      }
    }
    // 用户端可导航项里没有任何 /admin/federation* 路径
    for (const item of visibleNavItems("user", { paymentsEnabled: true })) {
      expect(item.href.startsWith("/admin")).toBe(false);
    }
  });

  test("联邦页面挂在 (admin) group 下（结构与权限边界一致）", () => {
    for (const tab of FEDERATION_TABS) {
      expect(expectedConsolePageFile(tab.href).startsWith("(admin)/")).toBe(true);
    }
    expect(FEDERATION_TABS.map((t) => t.id)).toEqual(["overview", "peers", "trust", "grants", "remote-leases", "usage"]);
  });

  test("子导航渲染当前项（服务端传入 active，不依赖 router）", () => {
    const html = renderToStaticMarkup(<FederationTabs active="grants" locale="zh" />);
    expect(html).toContain('data-active="grants"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("授予");
    for (const tab of FEDERATION_TABS) expect(html).toContain(`data-federation-tab="${tab.id}"`);
  });
});

describe("G. 展示件基础不变量", () => {
  test("状态徽章把 tone 暴露成 data 属性（可测试、可主题化）", () => {
    const html = renderToStaticMarkup(<StatusPill label="已撤销" tone="destructive" testId="pill" />);
    expect(html).toContain('data-tone="destructive"');
    expect(html).toContain("已撤销");
  });

  test("空列表渲染空态而不是空白表", () => {
    const html = renderToStaticMarkup(
      <FederationTable columns={[{ key: "a", label: "A" }]} empty="没有数据。" rowCount={0}>
        {null}
      </FederationTable>,
    );
    expect(html).toContain("没有数据。");
  });

  test("有行时不渲染空态", () => {
    const html = renderToStaticMarkup(
      <FederationTable columns={[{ key: "a", label: "A" }]} empty="没有数据。" rowCount={1}>
        <tr>
          <td>x</td>
        </tr>
      </FederationTable>,
    );
    expect(html).not.toContain("没有数据。");
  });

  test("scope / capacity 缺省语义是「拒绝」而不是「不限」", () => {
    expect(scopeSummary("zh", { node_group_ids: [], hop_roles: [], allow_target_policy: null })).toContain("无（拒绝）");
    expect(capacitySummary("zh", { max_legs: null, max_bandwidth_mbps: null, max_connections: null })).toContain("不限");
    expect(capacitySummary("zh", { max_legs: 3, max_bandwidth_mbps: 100, max_connections: 50 })).toBe("legs 3 · 100 Mbps · conns 50");
    expect(scopeSummary("zh", { node_group_ids: [2, 3], hop_roles: ["egress"], allow_target_policy: ["fixed"] })).toContain("节点组 [2, 3]");
  });

  test("grant 状态四态各自可辨", () => {
    const labels = ["active", "suspended", "revoked", "expired"].map((s) => grantStatusText("zh", s).label);
    expect(new Set(labels).size).toBe(4);
    expect(grantStatusText("zh", "suspended").tone).not.toBe(grantStatusText("zh", "revoked").tone);
  });
});
