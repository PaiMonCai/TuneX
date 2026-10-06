/**
 * V5.5 Federation —— 入站请求鉴权中间件（WP14）。
 *
 * 位置：与 `/api/internal/node/*`（节点凭据）同层 —— 免**用户**认证，但绝不免**身份**。
 * 身份就是"某个已建立信任的 peer Panel 的 Ed25519 签名"，判定逻辑在
 * `services/federation/signing.ts`，本文件只做三件事：
 *   1. 开关与验签的顺序编排；
 *   2. 回执（replay 防护 + 幂等）：首次执行、重复返回首次响应快照、在途返回可重试冲突；
 *   3. 把 peer 身份放进 context，供路由使用。
 *
 * 为什么把回执放在中间件而不是每个 handler：漏掉一个 handler 就是一条可重放的写路径，
 * 而"每条路由自己记得去重"正是这类漏洞最典型的成因。
 */
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isFederationEnabled } from "../services/federation/identity.ts";
import { federationErrorBody, federationStatus } from "../services/federation/errors.ts";
import { claimInboundMessage, completeInboundMessage, releaseInboundMessage } from "../services/federation/receipts.ts";
import { verifyInboundRequest, type VerifiedPeer } from "../services/federation/signing.ts";

export interface FederationContext {
  peer: VerifiedPeer;
  messageId: string;
  message_key: string | null;
}

/**
 * 验签 + 去重中间件。已通过验签的请求在 handler 返回后写回响应快照。
 */
export function federationAuth(): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    if (!(await isFederationEnabled())) {
      return c.json(
        federationErrorBody("federation_disabled", "本机联邦功能未开启"),
        federationStatus("federation_disabled") as ContentfulStatusCode,
      );
    }

    // 先克隆再读：读掉原始流会让 handler 拿到空 body。
    const rawBody = await c.req.raw.clone().text();
    const verified = await verifyInboundRequest({ headers: c.req.raw.headers, rawBody, path, method: c.req.method });
    if (!verified.ok) {
      return c.json(
        federationErrorBody(verified.code, verified.message, verified.peer_panel_id, verified.messageId ?? undefined),
        verified.status as ContentfulStatusCode,
      );
    }

    const claim = await claimInboundMessage({
      peer_panel_id: verified.peer.peer_panel_id,
      message_id: verified.messageId,
      path,
    });
    if (claim.kind === "duplicate_done") {
      // 幂等：不重复执行，原样返回首次结果（契约 §2.3 第 4 步）。
      return c.json(claim.body as never, claim.status as ContentfulStatusCode);
    }
    if (claim.kind === "duplicate_in_flight") {
      return c.json(
        federationErrorBody("duplicate_message", "同一条消息正在处理中，请稍后重试", verified.peer.peer_panel_id),
        federationStatus("duplicate_message") as ContentfulStatusCode,
      );
    }

    c.set("federation", {
      peer: verified.peer,
      messageId: verified.messageId,
      message_key: claim.messageKey,
    } satisfies FederationContext);

    await next();

    // 瞬态失败**不留快照**：否则对端带着同一个 message_id 重试时，会永远拿到
    // 这一次抖动的缓存结果 —— 一次 5xx 被永久化，且现象与"对方一直坏着"无法区分。
    if (c.res.status >= 500 || c.res.status === 429) {
      await releaseInboundMessage(claim.messageKey);
      return;
    }

    // 写回响应快照（解析失败就存 null：快照是给重复请求用的，不是数据真相）。
    let body: unknown = null;
    try {
      const text = await c.res.clone().text();
      if (text.length > 0) body = JSON.parse(text);
    } catch {
      body = null;
    }
    await completeInboundMessage({ message_key: claim.messageKey, status: c.res.status, body });
  };
}

export type FederationVariables = { federation?: FederationContext };
