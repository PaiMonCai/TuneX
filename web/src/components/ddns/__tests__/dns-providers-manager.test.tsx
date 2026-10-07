/**
 * 设置页「DNS 服务商」的**渲染行为**测试。
 *
 * 要点：
 *   ① 五个视图分支互不冒充（权限未定 / 无权限 / 加载中 / 取不到 / 空列表 / 有列表）；
 *   ② **凭据只写不读**：输入框是非受控的（HTML 里没有 `value=`），页面任何地方都
 *      不存在凭据值；服务商行里也没有凭据字段（形状里就没有）；
 *   ③ 无 `settings:manage` 时新增与删除都禁用（不是隐藏后仍可点）。
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import { getDictionary } from "@/lib/i18n";
import { DnsProvidersBody, type ProviderFormState } from "@/components/ddns/dns-providers-manager";
import type { DnsProvidersView } from "@/components/ddns/dns-view";
import type { DnsProviderView } from "@/lib/types/ddns";

const noop = () => undefined;
const FORM: ProviderFormState = { name: "", type: "cloudflare", endpoint: "" };

const ROWS: DnsProviderView[] = [
  { id: 7, name: "生产 CF", type: "cloudflare", workspace_id: 1, platform_level: false, has_credential: true, created_at: "2026-10-01T00:00:00.000Z" },
  { id: 8, name: "平台华为", type: "huawei", workspace_id: null, platform_level: true, has_credential: false, created_at: null },
];

function body(over: {
  view?: DnsProvidersView;
  canManage?: boolean;
  form?: ProviderFormState;
  creating?: boolean;
  deletingId?: number | null;
} = {}) {
  const html = renderToStaticMarkup(
    <I18nProvider locale="zh" dict={getDictionary("zh")}>
      <DnsProvidersBody
        view={over.view ?? { kind: "ready", providers: ROWS }}
        canManage={over.canManage ?? true}
        form={over.form ?? FORM}
        creating={over.creating ?? false}
        deletingId={over.deletingId ?? null}
        credentialRef={{ current: null }}
        onFormChange={noop}
        onCreate={noop}
        onRequestDelete={noop}
        onRetry={noop}
      />
    </I18nProvider>,
  );
  return html;
}

/** 是否**真的**带 disabled 属性（不能用 includes("disabled")：class 里有 `disabled:opacity-50`）。 */
function hasDisabledAttr(tag: string): boolean {
  return /\sdisabled(=""|\s|>)/.test(tag);
}

function tagOf(html: string, testid: string): string {
  const at = html.indexOf(`data-testid="${testid}"`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at));
}

describe("五个视图分支互不冒充", () => {
  test("ready + 有行：名称/类型/凭据状态/创建时间都渲染", () => {
    const html = body();
    expect(html).toContain("生产 CF");
    expect(html).toContain("Cloudflare");
    expect(html).toContain("凭据已保存");
    expect(html).toContain("平台华为");
    expect(html).toContain("平台级");
    expect(html).toContain("华为云 DNS");
    expect(html).toContain("凭据异常（未封存）");
    expect(html).toContain("2026-10-01T00:00:00.000Z");
    expect(html).toContain('data-testid="ddns-provider-row-7"');
    expect(html).toContain('data-testid="ddns-provider-row-8"');
    expect(html).not.toContain('data-testid="ddns-providers-empty"');
  });

  test("ready + 空列表：明说「列表为空 ≠ 平台没配」，且不是「取不到」", () => {
    const html = body({ view: { kind: "ready", providers: [] } });
    expect(html).toContain('data-testid="ddns-providers-empty"');
    expect(html).toContain("只说明你可见的列表为空");
    expect(html).toContain("不代表平台级配置不存在");
    expect(html).not.toContain('data-testid="ddns-providers-unavailable"');
  });

  test("取不到：独立分支，带后端原句，不是「没有服务商」", () => {
    const html = body({ view: { kind: "unavailable", message: "工作空间角色无权操作" } });
    expect(html).toContain('data-testid="ddns-providers-unavailable"');
    expect(html).toContain("取不到 DNS 服务商列表");
    expect(html).toContain("工作空间角色无权操作");
    expect(html).not.toContain('data-testid="ddns-providers-empty"');
    expect(html).toContain('data-testid="ddns-providers-retry"');
  });

  test("加载中 / 权限未定 / 无权限：三个独立分支", () => {
    const loading = body({ view: { kind: "loading" } });
    expect(loading).toContain('data-testid="ddns-providers-loading"');

    const unknown = body({ view: { kind: "permission_loading" } });
    expect(unknown).toContain('data-testid="ddns-providers-permission-loading"');
    expect(unknown).not.toContain('data-testid="ddns-providers-permission-denied"');
    expect(unknown).not.toContain("只有查看权限");

    const denied = body({ view: { kind: "permission_denied" } });
    expect(denied).toContain('data-testid="ddns-providers-permission-denied"');
    expect(denied).toContain("settings:read");
  });
});

describe("凭据只写不读", () => {
  test("凭据输入框是密码框、非受控（HTML 里没有 value=），且不自动填充", () => {
    const html = body();
    const tag = tagOf(html, "ddns-provider-token");
    expect(tag).toContain('type="password"');
    expect(tag.toLowerCase()).toContain('autocomplete="off"');
    expect(tag).not.toContain("value=");
  });

  test("页面里不存在任何凭据材料（token / config / 封存串）", () => {
    const html = body();
    expect(html).not.toContain("token=");
    expect(html).not.toContain("sealed");
    expect(html).not.toContain("v1.");
    // 服务商行只有 has_credential 这个状态位，没有凭据本体
    expect(html).not.toContain("credential:");
  });

  test("词条明说「只写不读、提交后清除」", () => {
    const html = body();
    expect(html).toContain("只写不读");
    expect(html).toContain("不回填");
  });
});

describe("权限：无 settings:manage 时禁用写操作", () => {
  test("新增按钮与删除按钮都带 disabled", () => {
    const html = body({ canManage: false });
    expect(hasDisabledAttr(tagOf(html, "ddns-provider-create"))).toBe(true);
    expect(hasDisabledAttr(tagOf(html, "ddns-provider-delete-7"))).toBe(true);
    expect(hasDisabledAttr(tagOf(html, "ddns-provider-token"))).toBe(true);
  });

  test("有 settings:manage 时按钮可用", () => {
    const html = body({ canManage: true });
    expect(hasDisabledAttr(tagOf(html, "ddns-provider-create"))).toBe(false);
    expect(hasDisabledAttr(tagOf(html, "ddns-provider-delete-7"))).toBe(false);
  });
});

describe("类型选择只给后端支持的两个枚举", () => {
  test("下拉里只有 cloudflare / huawei", () => {
    const html = body();
    const select = html.slice(html.indexOf('data-testid="ddns-provider-type"'));
    expect(select).toContain('value="cloudflare"');
    expect(select).toContain('value="huawei"');
    expect(select).not.toContain("route53");
    expect(select).not.toContain("dnspod");
  });
});
