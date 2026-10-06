/**
 * DDNS 的**视图选择**（纯函数）：把"权限事实 + 取数事实"折成离散视图，交给展示层画出。
 *
 * 单独成模块的理由是纪律本身：权限三态（loading / granted / denied）与取数三态
 * （loading / ready / unavailable）必须**互不冒充**——
 *   · 权限还没读出来 ≠ 没有权限（先只读，不是拒绝提示）；
 *   · 取不到 ≠ 没有（`unavailable` 与"空列表 / 未绑定"是两个分支）；
 *   · 服务端给了读不出来的载荷（未知 state）≠ 未绑定，走 `unavailable`。
 * 把这些分支写成一个可被测试直接枚举的函数，比散在 JSX 里更难写错。
 */
import type { DnsBindingReadResult, DnsBindingState, DnsProviderView } from "@/lib/types/ddns";
import type { DdnsReadState } from "./ddns-reader";

/* ============================ DNS 服务商列表 ============================ */

export type DnsProvidersView =
  | { kind: "permission_loading" }
  | { kind: "permission_denied" }
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; providers: DnsProviderView[] };

export function dnsProvidersView(input: {
  permissionsLoading: boolean;
  canRead: boolean;
  read: DdnsReadState<DnsProviderView[]>;
}): DnsProvidersView {
  if (input.permissionsLoading) return { kind: "permission_loading" };
  if (!input.canRead) return { kind: "permission_denied" };
  if (input.read.status === "loading") return { kind: "loading" };
  if (input.read.status === "unavailable") return { kind: "unavailable", message: input.read.message };
  return { kind: "ready", providers: input.read.value };
}

/* ============================ Forward 前门状态 ============================ */

export type ForwardDnsView =
  | { kind: "permission_loading" }
  | { kind: "permission_denied" }
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; binding: DnsBindingState };

export function forwardDnsView(input: {
  permissionsLoading: boolean;
  canRead: boolean;
  read: DdnsReadState<DnsBindingReadResult>;
}): ForwardDnsView {
  if (input.permissionsLoading) return { kind: "permission_loading" };
  if (!input.canRead) return { kind: "permission_denied" };
  if (input.read.status === "loading") return { kind: "loading" };
  if (input.read.status === "unavailable") return { kind: "unavailable", message: input.read.message };
  // 载荷读不出来（未知 state / 非对象）⇒ "取不到"，**绝不**当成未绑定。
  if (!input.read.value.ok) return { kind: "unavailable", message: input.read.value.message };
  return { kind: "ready", binding: input.read.value.state };
}

/** 只有 `unbound` 允许出现绑定表单；已绑定时只给解绑入口（改绑 = 先解绑，语义单一）。 */
export function canSubmitBinding(binding: DnsBindingState | null): boolean {
  return binding === null || binding.state === "unbound";
}
