import "server-only";
import { cookies } from "next/headers";
import { api } from "@/lib/api";
import type { ID, NodeDetail } from "@/lib/types";

/**
 * 服务端预取节点详情（WP12）：GET /admin/nodes/:id 聚合契约 = 基础字段
 * （含 has_credential / credential_revoked 派生态）+ 出口池 + 最近一条状态上报。
 *
 * 后端 WP10 未合并落地期间前端以 mock 契约先行开发：mock 模式下把请求 cookie
 * 透传给 handler（mock 同样校验 tunex_session 会话），服务端与客户端取数口径一致，
 * 后端合并后 real 分支零改动。
 */
export async function nodeDetailServer(nodeId: ID): Promise<NodeDetail> {
  const cookie = (await cookies()).toString();
  // mock 分支：cookie 原样递给 handler（mock 的 isLoggedIn 就是校验它），
  // 不能用 document.cookie——这是服务端代码。
  return api.admin.nodeDetail(nodeId, cookie);
}
