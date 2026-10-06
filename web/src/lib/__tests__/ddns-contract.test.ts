/**
 * DDNS 契约与文案的**纯函数**行为测试（不读源码字符串，断言真实函数输出）。
 *
 * 钉住的是本切片最容易被做错的判定：
 *   ① 读不出来 ≠ 未绑定（未知/缺失 `state` 必须判 `unreadable`）；
 *   ② 三个 D4 列缺失时 fail-closed（`false` / `null`，**不是** 0 或空串）；
 *   ③ 只有 `synced` 可以出现"已切换"；`synced_unverified` 是"已写入，尚未确认"；
 *   ④ "会重试" ⇔ `auto_resolve === true && next_attempt_at !== null`（只看后者会读错）；
 *   ⑤ 期望地址集为空时给"不可用"的说法，**不**编造地址；
 *   ⑥ G4(a)：`auto_resolve=true && provider_id=null` ⇒ 明说"不会写入"。
 */
import { describe, expect, test } from "bun:test";
import {
  DDNS_ERROR_CODES,
  dnsBindingStateFromPayload,
  ddnsErrorCodeOf,
  type DnsBindingState,
  type DnsState,
} from "@/lib/types/ddns";
import {
  DDNS_DICTS,
  DDNS_KNOWN_ERRORS,
  ddnsErrorText,
  ddnsText,
  dnsAddressAvailable,
  dnsAddressText,
  dnsProviderDisplayText,
  dnsRetryFact,
  dnsRetryText,
  dnsStateCopy,
  dnsWriteWarningText,
  willAutoRetry,
} from "@/lib/ddns-i18n";

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "unbound",
    domain: null,
    record_type: null,
    mode: null,
    provider_id: null,
    expected_values: [],
    confirmed_values: [],
    synced_at: null,
    verified: false,
    last_error: null,
    auto_resolve: false,
    attempt_count: null,
    next_attempt_at: null,
    ...over,
  };
}

/** 只接受读得出来的载荷；读不出来直接让测试失败（避免把 unreadable 混进别的断言）。 */
function read(over: Record<string, unknown> = {}): DnsBindingState {
  const result = dnsBindingStateFromPayload(payload(over));
  if (!result.ok) throw new Error(`载荷被判为不可读：${result.message}`);
  return result.state;
}

const fmt = (iso: string) => `T(${iso})`;

describe("读投影：读不出来 ≠ 未绑定", () => {
  test("未知 state ⇒ unreadable，绝不回落成 unbound", () => {
    const result = dnsBindingStateFromPayload(payload({ state: "healthy" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("healthy");
  });

  test("缺 state / 非对象 / 空值 ⇒ unreadable", () => {
    expect(dnsBindingStateFromPayload({ data: 1 }).ok).toBe(false);
    expect(dnsBindingStateFromPayload(null).ok).toBe(false);
    expect(dnsBindingStateFromPayload("unbound").ok).toBe(false);
    expect(dnsBindingStateFromPayload(payload({ state: undefined })).ok).toBe(false);
  });

  test("五个已知 state 都能读出来", () => {
    for (const state of ["unbound", "pending", "synced", "synced_unverified", "error"] as DnsState[]) {
      expect(read({ state }).state).toBe(state);
    }
  });
});

describe("读投影：三个 D4 列 fail-closed", () => {
  test("字段缺失 ⇒ auto_resolve=false、attempt_count=null、next_attempt_at=null（不是 0/空串）", () => {
    const state = read({ state: "pending", domain: "a.example.com" });
    expect(state.auto_resolve).toBe(false);
    expect(state.attempt_count).toBeNull();
    expect(state.next_attempt_at).toBeNull();
  });

  test("auto_resolve 只有 === true 才算开着（'true'/1 都不算）", () => {
    expect(read({ auto_resolve: true }).auto_resolve).toBe(true);
    expect(read({ auto_resolve: "true" }).auto_resolve).toBe(false);
    expect(read({ auto_resolve: 1 }).auto_resolve).toBe(false);
  });

  test("attempt_count 只接受非负整数；非法值/null ⇒ null", () => {
    expect(read({ attempt_count: 3 }).attempt_count).toBe(3);
    expect(read({ attempt_count: 0 }).attempt_count).toBe(0);
    expect(read({ attempt_count: -1 }).attempt_count).toBeNull();
    expect(read({ attempt_count: 2.5 }).attempt_count).toBeNull();
    expect(read({ attempt_count: "3" }).attempt_count).toBeNull();
    expect(read({ attempt_count: null }).attempt_count).toBeNull();
  });

  test("next_attempt_at 只接受可解析的 ISO；空串/'0' ⇒ null", () => {
    expect(read({ next_attempt_at: "2026-10-07T01:00:00.000Z" }).next_attempt_at).toBe("2026-10-07T01:00:00.000Z");
    expect(read({ next_attempt_at: "" }).next_attempt_at).toBeNull();
    expect(read({ next_attempt_at: "0" }).next_attempt_at).toBeNull();
  });

  test("expected/confirmed 只收字符串，不伪造", () => {
    const state = read({ expected_values: ["1.2.3.4", 7, null], confirmed_values: [] });
    expect(state.expected_values).toEqual(["1.2.3.4"]);
    expect(state.confirmed_values).toEqual([]);
  });
});

describe("五态文案：只有 synced 可以写「已切换」", () => {
  const states: DnsState[] = ["unbound", "pending", "synced", "synced_unverified", "error"];

  test("五态标题互不相同、明细非空", () => {
    for (const locale of ["zh", "en"] as const) {
      const titles = states.map((state) => dnsStateCopy(locale, state).title);
      expect(new Set(titles).size).toBe(states.length);
      for (const state of states) expect(dnsStateCopy(locale, state).detail.length).toBeGreaterThan(4);
    }
  });

  test("zh：非 synced 的四态绝不出现「已切换」；synced_unverified 说「已写入，尚未确认」", () => {
    for (const state of states) {
      const copy = dnsStateCopy("zh", state);
      const blob = `${copy.title}${copy.detail}`;
      if (state === "synced") expect(blob).toContain("已切换");
      else {
        expect(blob).not.toContain("已切换");
        expect(blob).not.toContain("已生效");
      }
    }
    expect(dnsStateCopy("zh", "synced_unverified").title).toBe("已写入，尚未确认");
    expect(dnsStateCopy("zh", "pending").detail).toContain("不等于");
  });

  test("en：非 synced 四态不含 Switched", () => {
    for (const state of states) {
      const copy = dnsStateCopy("en", state);
      const blob = `${copy.title}${copy.detail}`;
      if (state === "synced") expect(blob).toContain("Switched");
      else expect(blob).not.toContain("Switched");
    }
    expect(dnsStateCopy("en", "synced_unverified").title).toBe("Written, not confirmed");
  });
});

describe("退避：判据是服务端两个字段", () => {
  const bound = (over: Record<string, unknown> = {}) => read({ state: "pending", domain: "a.example.com", ...over });

  test("auto_resolve=true 且 next_attempt_at 有值 ⇒ scheduled（时间来自服务端）", () => {
    const state = bound({ auto_resolve: true, next_attempt_at: "2026-10-07T01:00:00.000Z", attempt_count: 2 });
    const fact = dnsRetryFact(state);
    expect(fact.kind).toBe("scheduled");
    expect(willAutoRetry(state)).toBe(true);
    const text = dnsRetryText("zh", state, fmt);
    expect(text).toContain("T(2026-10-07T01:00:00.000Z)");
    expect(text).toContain("将于");
    expect(text).toContain("2");
  });

  test("auto_resolve=true 但 next_attempt_at=null ⇒ 没有待重试的计划", () => {
    const state = bound({ auto_resolve: true, next_attempt_at: null });
    expect(dnsRetryFact(state).kind).toBe("not_scheduled_no_plan");
    expect(willAutoRetry(state)).toBe(false);
    expect(dnsRetryText("zh", state, fmt)).toContain("不会自动重试");
  });

  test("auto_resolve=false 时即使 next_attempt_at 有值也**不**会重试（只看后者会读错）", () => {
    const state = bound({ auto_resolve: false, next_attempt_at: "2026-10-07T01:00:00.000Z" });
    expect(dnsRetryFact(state).kind).toBe("not_scheduled_auto_off");
    expect(willAutoRetry(state)).toBe(false);
    const text = dnsRetryText("zh", state, fmt);
    expect(text).toContain("自动同步已关闭");
    expect(text).not.toContain("将于");
  });

  test("未绑定：忽略其余字段（契约明文），历史退避不许说成「将于 X 重试」", () => {
    const state = read({ state: "unbound", auto_resolve: true, next_attempt_at: "2026-10-07T01:00:00.000Z", attempt_count: 4 });
    expect(dnsRetryFact(state).kind).toBe("not_scheduled_no_plan");
    expect(dnsRetryText("zh", state, fmt)).not.toContain("将于");
  });

  test("三支文案互不相同（scheduled / no-plan / auto-off）", () => {
    const texts = new Set([
      dnsRetryText("zh", bound({ auto_resolve: true, next_attempt_at: "2026-10-07T01:00:00.000Z" }), fmt),
      dnsRetryText("zh", bound({ auto_resolve: true, next_attempt_at: null }), fmt),
      dnsRetryText("zh", bound({ auto_resolve: false, next_attempt_at: null }), fmt),
    ]);
    expect(texts.size).toBe(3);
  });
});

describe("入口地址：空集就说不可用，不猜地址", () => {
  test("expected_values 为空 ⇒ available=false，文案含「服务端没有给出期望地址」且无任何地址", () => {
    const state = read({ state: "unbound", expected_values: [] });
    expect(dnsAddressAvailable(state)).toBe(false);
    const text = dnsAddressText("zh", state.expected_values, "expected");
    expect(text).toContain("服务端没有给出期望地址");
    expect(text).toContain("dns_address_unavailable");
    expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  test("expected_values 非空 ⇒ 原样展示服务端给的地址", () => {
    const state = read({ state: "pending", domain: "a.example.com", expected_values: ["172.33.10.20"] });
    expect(dnsAddressAvailable(state)).toBe(true);
    expect(dnsAddressText("zh", state.expected_values, "expected")).toBe("172.33.10.20");
  });

  test("confirmed 为空时说「还没有读回」，不说 0 个地址", () => {
    expect(dnsAddressText("zh", [], "confirmed")).toContain("还没有读回任何地址");
  });
});

describe("为什么没写入 / 服务商显示（G4）", () => {
  const bound = (over: Record<string, unknown> = {}) => read({ state: "error", domain: "a.example.com", ...over });

  test("auto_resolve=true 且 provider_id=null ⇒ 明说不会写入并给出下一步", () => {
    const text = dnsWriteWarningText("zh", bound({ auto_resolve: true, provider_id: null }));
    expect(text).toContain("不会写入");
    expect(text).toContain("服务商");
  });

  test("选了服务商、或自动同步关着、或未绑定 ⇒ 不出现这条警告", () => {
    expect(dnsWriteWarningText("zh", bound({ auto_resolve: true, provider_id: 7 }))).toBeNull();
    expect(dnsWriteWarningText("zh", bound({ auto_resolve: false, provider_id: null }))).toBeNull();
    expect(dnsWriteWarningText("zh", read({ state: "unbound", auto_resolve: true, provider_id: null }))).toBeNull();
  });

  test("服务商一栏：未选择 / 不在可见列表 / 凭据不可用三种说法互不相同", () => {
    const providers = [
      { id: 7, name: "生产 CF", type: "cloudflare", workspace_id: 1, platform_level: false, has_credential: true, created_at: null },
      { id: 8, name: "坏凭据", type: "huawei", workspace_id: 1, platform_level: false, has_credential: false, created_at: null },
    ];
    const none = dnsProviderDisplayText("zh", bound({ provider_id: null }), providers);
    const missing = dnsProviderDisplayText("zh", bound({ provider_id: 99 }), providers);
    const ok = dnsProviderDisplayText("zh", bound({ provider_id: 7 }), providers);
    const bad = dnsProviderDisplayText("zh", bound({ provider_id: 8 }), providers);
    expect(new Set([none, missing, ok, bad]).size).toBe(4);
    expect(missing).toContain("不在你可见的列表里");
    expect(ok).toContain("生产 CF");
    expect(bad).toContain("凭据不可用");
    // 读不到服务商列表时也不能把"未知"说成"未选择"
    expect(dnsProviderDisplayText("zh", bound({ provider_id: 7 }), null)).toContain("不在你可见的列表里");
  });
});

describe("错误码：未知码原样回落后端 message，绝不编造", () => {
  test("后端 DDNS 错误码都有中文/英文文案", () => {
    for (const code of Object.values(DDNS_ERROR_CODES)) {
      expect(DDNS_KNOWN_ERRORS).toContain(code);
      expect(ddnsErrorText("zh", code, "fallback")).not.toBe("fallback");
      expect(ddnsErrorText("en", code, "fallback")).not.toBe("fallback");
    }
  });

  test("未知码 / 无码 ⇒ 原样回落", () => {
    expect(ddnsErrorText("zh", "dns_quantum_flux", "後端原句")).toBe("後端原句");
    expect(ddnsErrorText("zh", null, "後端原句")).toBe("後端原句");
  });

  test("ddnsErrorCodeOf 只认已知码（其余返回 null，交给 message 回落）", () => {
    expect(ddnsErrorCodeOf({ data: { code: "dns_address_unavailable" } })).toBe("dns_address_unavailable");
    expect(ddnsErrorCodeOf({ data: { code: "invalid_input" } })).toBeNull();
    expect(ddnsErrorCodeOf(new Error("boom"))).toBeNull();
  });
});

describe("词典完整性", () => {
  const flat = (obj: unknown, prefix = ""): string[] => {
    if (obj === null || typeof obj !== "object") return [prefix];
    return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) => flat(value, prefix ? `${prefix}.${key}` : key));
  };

  test("中英词条键集完全一致（不会漏翻）", () => {
    expect(flat(DDNS_DICTS.zh)).toEqual(flat(DDNS_DICTS.en));
  });

  test("五态 / 错误码词条两端都不为空", () => {
    for (const locale of ["zh", "en"] as const) {
      const text = ddnsText(locale);
      for (const state of ["unbound", "pending", "synced", "synced_unverified", "error"] as DnsState[]) {
        expect(text.state[state].title.length).toBeGreaterThan(0);
        expect(text.state[state].detail.length).toBeGreaterThan(0);
      }
      for (const code of DDNS_KNOWN_ERRORS) expect(text.errors[code].length).toBeGreaterThan(0);
    }
  });
});
