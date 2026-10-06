/**
 * DDNS 域 API 客户端（EXPOSE 既有后端，不新增端点）。
 *
 * 端点（与 `backend/src/routes/ddns.ts` / `routes/forwards.ts` 逐字一致）：
 *   GET    /api/ddns/providers          settings:read   → `{ data: DnsProviderView[] }`
 *   POST   /api/ddns/providers          settings:manage → 201 `{ data: DnsProviderView }`
 *   DELETE /api/ddns/providers/:id      settings:manage → `{ data: { deleted } }`
 *   GET    /api/forwards/:id/dns        forward:read    → `{ data: DnsBindingState }`
 *   POST   /api/forwards/:id/dns        forward:update  → `{ data: DnsBindingState }`（只会是 `pending`）
 *   DELETE /api/forwards/:id/dns        forward:update  → `{ data: DnsBindingState }`（幂等）
 *
 * ── 为什么每个方法都显式要 `workspaceId` ──
 * 子组件 effect 可能早于父级 `WorkspaceProvider` 的 effect 执行；只依赖模块内
 * `activeWorkspaceId` 会让首帧请求落到"没有 `x-workspace-id`"上，后端于是回落到个人空间
 * ——那正是"切了 Workspace 却看到别人的服务商"这一类越权读的入口。作用域**显式传入**。
 *
 * ── 为什么 DNS 前门三个方法返回 `unknown` ──
 * 形状由 `dnsBindingStateFromPayload()` 显式读取：未知 `state` 会被判为**不可读**，
 * 而不是悄悄变成 `unbound`。类型上收紧在这里会让人以为"拿到就一定是五态之一"。
 * Provider 列表没有状态机，直接给出 `DnsProviderView[]`。
 */
import type { DnsBindInput, DnsProviderInput, DnsProviderView } from "../types/ddns";
import { request } from "./core";

export interface DdnsScope {
  workspaceId: number;
  /** 服务端渲染/测试时可显式传 cookie；浏览器里由 fetch 自带。 */
  cookie?: string;
}

export const ddnsApi = {
  /** 本 Workspace 可见的服务商（平台级只在平台管理员下出现）；**响应永不含凭据**。 */
  listProviders: ({ workspaceId, cookie }: DdnsScope) =>
    request<DnsProviderView[]>("/ddns/providers", { method: "GET", workspaceId, cookie }),
  createProvider: ({ workspaceId, cookie }: DdnsScope, input: DnsProviderInput) =>
    request<DnsProviderView>("/ddns/providers", { method: "POST", workspaceId, cookie, body: input }),
  deleteProvider: ({ workspaceId, cookie }: DdnsScope, providerId: number) =>
    request<{ deleted: boolean }>(`/ddns/providers/${providerId}`, { method: "DELETE", workspaceId, cookie }),

  forwardDns: ({ workspaceId, cookie }: DdnsScope, forwardId: number) =>
    request<unknown>(`/forwards/${forwardId}/dns`, { method: "GET", workspaceId, cookie }),
  bindForwardDns: ({ workspaceId, cookie }: DdnsScope, forwardId: number, input: DnsBindInput) =>
    request<unknown>(`/forwards/${forwardId}/dns`, { method: "POST", workspaceId, cookie, body: input }),
  unbindForwardDns: ({ workspaceId, cookie }: DdnsScope, forwardId: number) =>
    request<unknown>(`/forwards/${forwardId}/dns`, { method: "DELETE", workspaceId, cookie }),
};
