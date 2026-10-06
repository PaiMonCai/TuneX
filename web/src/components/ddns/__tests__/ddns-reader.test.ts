/**
 * DDNS 取数栅栏 + 视图选择的**行为**测试（受控 promise，确定性复现竞态）。
 *
 * 这里守的是两个"看起来有、其实没有"的东西：
 *   ① **切 Workspace 丢晚到响应**：旧作用域的响应不许写进状态（否则用户会看到
 *      上一个工作空间的 DNS 状态，甚至带着它做写操作）；
 *   ② **三态互不冒充**：取不到 ⇒ `unavailable`（不是「未绑定」）；载荷读不出来 ⇒
 *      也是 `unavailable`（不是 `unbound`）；权限还没读出来 ⇒ 既不是「没权限」也不是「没有」。
 */
import { describe, expect, test } from "bun:test";
import { createDdnsReader } from "@/components/ddns/ddns-reader";
import { canSubmitBinding, dnsProvidersView, forwardDnsView } from "@/components/ddns/ddns-view";
import { clearCredential, readCredential } from "@/components/ddns/credential-field";
import { dnsBindingStateFromPayload, type DnsProviderView } from "@/lib/types/ddns";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createDdnsReader：切 Workspace 丢弃晚到响应", () => {
  test("旧作用域响应晚到 ⇒ applied=false 且状态保持 loading", async () => {
    const first = deferred<string>();
    const reader = createDdnsReader<string>(() => first.promise);
    const pending = reader.load(1);
    expect(reader.peek().status).toBe("loading");

    reader.reset(); // 用户切了 Workspace
    first.resolve("ws1");
    const outcome = await pending;

    expect(outcome.applied).toBe(false);
    expect(reader.peek()).toEqual({ status: "loading" });
  });

  test("两次加载：只有最新那次生效（先发后到的旧响应被丢）", async () => {
    const calls: Record<number, ReturnType<typeof deferred<string>>> = { 1: deferred(), 2: deferred() };
    const reader = createDdnsReader<string>((workspaceId) => calls[workspaceId]!.promise);
    const slow = reader.load(1);
    const fast = reader.load(2);
    calls[2]!.resolve("ws2");
    expect((await fast).applied).toBe(true);
    calls[1]!.resolve("ws1");
    expect((await slow).applied).toBe(false);
    expect(reader.peek()).toEqual({ status: "ready", workspaceId: 2, value: "ws2" });
  });

  test("取不到 ⇒ unavailable（带后端原句），不是 ready、更不是空", async () => {
    const failing = deferred<string>();
    const reader = createDdnsReader<string>(() => failing.promise);
    const pending = reader.load(7);
    failing.reject(new Error("工作空间角色无权操作"));
    const outcome = await pending;
    expect(outcome.applied).toBe(true);
    expect(outcome.state).toEqual({ status: "unavailable", workspaceId: 7, message: "工作空间角色无权操作" });
    expect(reader.peek().status).toBe("unavailable");
  });
});

describe("dnsProvidersView：权限三态与取数三态互不冒充", () => {
  const read = { status: "ready" as const, workspaceId: 1, value: [] as DnsProviderView[] };

  test("权限未读出来 ⇒ permission_loading（不显示「没有权限」）", () => {
    expect(dnsProvidersView({ permissionsLoading: true, canRead: false, read }).kind).toBe("permission_loading");
  });

  test("确实没有 settings:read ⇒ permission_denied", () => {
    expect(dnsProvidersView({ permissionsLoading: false, canRead: false, read }).kind).toBe("permission_denied");
  });

  test("读到空列表 ⇒ ready（空列表是事实，不是「取不到」）", () => {
    expect(dnsProvidersView({ permissionsLoading: false, canRead: true, read })).toEqual({
      kind: "ready",
      providers: [],
    });
  });

  test("取不到 ⇒ unavailable（不是空列表）", () => {
    const view = dnsProvidersView({
      permissionsLoading: false,
      canRead: true,
      read: { status: "unavailable", workspaceId: 1, message: "boom" },
    });
    expect(view.kind).toBe("unavailable");
  });
});

describe("forwardDnsView：读不出来 ≠ 未绑定", () => {
  test("载荷 state 未知 ⇒ unavailable，绝不落成 unbound", () => {
    const payload = dnsBindingStateFromPayload({ state: "healthy", domain: "a.example.com" });
    const view = forwardDnsView({
      permissionsLoading: false,
      canRead: true,
      read: { status: "ready", workspaceId: 1, value: payload },
    });
    expect(view.kind).toBe("unavailable");
    if (view.kind === "unavailable") expect(view.message).toContain("healthy");
  });

  test("合法载荷 ⇒ ready，且只有 unbound 允许出现绑定表单", () => {
    const payload = dnsBindingStateFromPayload({ state: "unbound" });
    const view = forwardDnsView({
      permissionsLoading: false,
      canRead: true,
      read: { status: "ready", workspaceId: 1, value: payload },
    });
    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    expect(canSubmitBinding(view.binding)).toBe(true);
    expect(canSubmitBinding({ ...view.binding, state: "pending", domain: "a.example.com" })).toBe(false);
    expect(canSubmitBinding({ ...view.binding, state: "synced", domain: "a.example.com" })).toBe(false);
  });
});

describe("凭据输入：读出即清空", () => {
  test("readCredential 去掉两端空白；空框/缺失返回空串", () => {
    expect(readCredential({ value: "  tok-123  " })).toBe("tok-123");
    expect(readCredential({ value: "   " })).toBe("");
    expect(readCredential(null)).toBe("");
  });

  test("clearCredential 抹掉输入框里的明文（提交后无论成败都调用它）", () => {
    const input = { value: "tok-123" };
    clearCredential(input);
    expect(input.value).toBe("");
    expect(() => clearCredential(null)).not.toThrow();
  });
});
