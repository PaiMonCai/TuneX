/**
 * V5.5 Federation —— 审计（契约 §2.5）。
 *
 * 代码事实（Lead 调研已核实）：`AuditActorType` 只有 5 个取值（user / super_admin /
 * admin / system / anonymous），**没有** peer/panel；`AuditLog` **没有 workspace 维度**。
 * 因此：
 *   · 不扩 enum（MySQL enum 加值会让旧二进制读到未知值时失败，§3.4）；
 *   · 跨面板动作一律 `actor_type = "system"`，身份通过 metadata 表达；
 *   · 当动作涉及某个 workspace 时，**额外**写一条 `AuditEvent`（那张表才有
 *     workspace 维度，是 workspace 审计视图的数据源）。
 *
 * metadata 只允许 allowlist 字段：禁止写入任何密钥材料、token 明文、请求体原文。
 */
import { db } from "../../db.ts";
import { writeAudit } from "../audit.ts";

export interface FederationAuditInput {
  /** 归一化的动作名，如 `grant.create` / `lease.apply` / `trust.handshake`。 */
  action: string;
  direction: "inbound" | "outbound" | "local";
  peer_panel_id: string;
  /** 跨面板消息 id；本地动作可为 null。 */
  message_id?: string | null;
  status: number;
  method?: string;
  path?: string;
  /** 涉及 workspace 时一并写 workspace 维度的 AuditEvent。 */
  workspace_id?: number | null;
  /** 结构化细节（allowlist：只放 ref/id/epoch/错误码这类非敏感标量）。 */
  detail?: Record<string, unknown> | null;
}

/** metadata 深度清洗：只保留标量，禁止嵌套对象（避免把整份请求体带进日志）。 */
export function sanitizeFederationAuditDetail(detail: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 191);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 记一条联邦审计。**永不抛**：审计失败不得改变业务结果
 * （与 `writeAudit` 的既有取向一致），但会 console.warn 留痕。
 */
export async function recordFederationAudit(input: FederationAuditInput): Promise<void> {
  const metadata = {
    actor_kind: "federation_peer",
    peer_panel_id: input.peer_panel_id,
    direction: input.direction,
    message_id: input.message_id ?? null,
    workspace_id: input.workspace_id ?? null,
    ...(sanitizeFederationAuditDetail(input.detail) ?? {}),
  };
  try {
    await writeAudit({
      actor_type: "system",
      actor_id: null,
      actor_email: null,
      action: `FEDERATION ${input.action}`,
      resource: "federation",
      resource_id: input.peer_panel_id.slice(0, 64),
      method: input.method ?? "POST",
      path: (input.path ?? `/api/federation/v1/${input.action}`).slice(0, 255),
      status: input.status,
      ip: null,
      user_agent: null,
      metadata,
    });
  } catch (e) {
    console.warn("[federation] audit write failed:", e instanceof Error ? e.message : e);
  }

  // workspace 维度：只有确实涉及 workspace 的动作才写，避免产生一堆
  // workspace 无关的噪声行；失败同样不影响业务。
  if (typeof input.workspace_id === "number" && input.workspace_id > 0) {
    try {
      await db.auditEvent.create({
        data: {
          workspace_id: input.workspace_id,
          actor_user_id: null,
          action: `federation.${input.action}`.slice(0, 100),
          resource_type: "federation",
          resource_id: input.peer_panel_id.slice(0, 191),
          ip: null,
          detail: metadata as never,
        },
      });
    } catch (e) {
      console.warn("[federation] workspace audit write failed:", e instanceof Error ? e.message : e);
    }
  }
}
