/**
 * 复制 Forward + auto-port 的纯逻辑（无 React / 无网络）。
 *
 * 契约边界：
 *  · 复制走**真实** create 契约（后端 `ForwardCreateSchema`，`.strict()` —— 多一个
 *    键就 400）。因此这里用「显式逐字段构造」而不是展开源对象：`id` / `*_status` /
 *    `traffic*` / revision 等运行态与统计字段结构上**进不来**。
 *  · 复制后 `listen_port` 一律留空（= 自动分配）：沿用源端口会和源转发抢同一个入口
 *    端口（后端 `port_conflict`）。
 *  · `listen_port` 为空是「自动分配」语义，UI 必须给明确提示；**不得**把空值渲染成
 *    具体端口号（占位符也必须是文字，而不是看起来像真值的 `20001`）。
 *
 * 说明：后端当前没有独立的 copy 端点，也不需要 —— 复制就是「用同一份 create 契约
 * 再建一条」，所以本模块不新增任何 API 调用。
 */
import type { ForwardCreateInput, PortForward } from "@/lib/types";
import { FORWARD_POLICY_FIELDS, forwardPolicyDraft, forwardPolicyDraftValues, type ForwardPolicyDraft } from "@/lib/forward-policy";
import {
  DEFAULT_FORWARD_PROTOCOL,
  forwardProtocolFields,
  forwardProtocolForCreate,
  type ForwardProtocol,
} from "@/lib/forward-protocol";

/** 编辑器 / 创建表单共用的草稿形状（全字符串，便于受控输入与表单预检）。 */
export type ForwardDraft = ForwardPolicyDraft & {
  name: string;
  mode: "direct" | "relay";
  ingressId: string;
  egressId: string;
  listenPort: string;
  targetHost: string;
  targetPort: string;
};

/**
 * 创建/复制草稿 = 编辑草稿 + 协议字段。
 *
 * 创建协议受契约白名单约束；编辑草稿另接受持久化协议事实，只开放普通
 * tcp / udp / 原生 both 切换，TLS / WS / 历史协议仍然固定。
 *
 * （tls 的证书路径**可以**编辑，所以编辑器草稿里另有这两个字段 —— 见
 * `forward-edit-dialog.tsx` 的编辑草稿类型。）
 */
export type ForwardCopyDraft = ForwardDraft & {
  protocol: ForwardProtocol;
  /**
   * 节点本地证书/私钥路径。
   *
   * V5-WP5-A1 的后续修订：后端 `forwardView` **已经投影**这两列（否则详情页只能说
   * 「TLS」而说不出用的是哪张证书），所以复制可以照抄源行的路径 —— 复制一条 tls
   * 转发不再要求运维把同一份路径重敲一遍。源行若没有路径（历史行），草稿就是空的，
   * 由表单预检拦下：复制**不猜**任何路径。
   */
  tlsCertPath: string;
  tlsKeyPath: string;
};

/** 后端 `ForwardCreateSchema` 的字段集（`.strict()`：键集合必须完全一致）。 */
export const FORWARD_CREATE_KEYS = [
  ...FORWARD_POLICY_FIELDS,
  "name",
  "mode",
  "protocol",
  "ingress_node_id",
  "egress_node_id",
  "listen_port",
  "target_host",
  "target_port",
] as const;

/** `protocol=tls` 时才允许出现的键（非 tls 的请求里它们**不存在**）。 */
export const FORWARD_TLS_CREATE_KEYS = ["tls_cert_path", "tls_key_path"] as const;

/**
 * 复制时**禁止**继承的字段：主键、运行状态、流量统计、revision 轨迹。
 * 这些全部由后端在创建时重新生成 —— 测试按此清单逐条断言，防止有人「顺手」
 * 把源行整行 spread 进 create（那会让 `.strict()` 400，或更糟：污染运行态）。
 */
export const FORWARD_COPY_FORBIDDEN_FIELDS = [
  "link_resource_id",
  "id",
  "status",
  "desired_status",
  "apply_status",
  "apply_error",
  "apply_error_code",
  "protocol_supported",
  "traffic",
  "traffic_cost",
  "online",
  "config_revision",
  "applied_revision",
  "latest_revision",
  "desired_revision_id",
  "last_applied_at",
  "listen_ip",
  "target_weight",
  "created_at",
  "updated_at",
] as const;

/** 后端 `name` 上限（`ForwardCreateSchema`: `max(60)`）。 */
export const FORWARD_NAME_MAX = 60;

/**
 * 复制后的名称：`<原名><后缀>`。
 *
 * 后缀来自 i18n（"（副本）" / " (copy)"），长度随语言变化，所以先把原名截断到
 * `60 - suffix.length`，否则长名复制会在后端被 400 挡回。
 */
export function forwardCopyName(forward: PortForward, suffix: string): string {
  const base = (forward.name ?? "").trim();
  const max = Math.max(0, FORWARD_NAME_MAX - suffix.length);
  const trimmed = `${base.slice(0, max)}${suffix}`.trim();
  return trimmed || suffix.trim();
}

/**
 * 源 Forward → 复制草稿。
 *
 * mode / ingress / egress / target 原样带过（这些就是要复制的业务配置）；
 * `listen_port` 置空 = 自动分配。
 *
 * 协议与协议专属配置：
 *   · 源行的协议事实在契约白名单里 → 原样带过（复制一条 tls 转发必须还是 tls，
 *     悄悄降级成 tcp 等于把入口的传输安全偷偷关掉）；
 *   · 历史协议（`wss` / `quic` …）**不能**被再创建（`z.enum` 会 400），此时草稿回到
 *     缺省协议，用户必须在表单里显式改选 —— 表单里协议下拉是可见的，所以这不是
 *     静默改写；
 *   · tls 的证书/私钥路径随源行带过（后端 `forwardView` 现在投影这两列），源行缺
 *     路径时留空并由表单预检拦下；
 *   · udp 没有任何协议专属配置 → 草稿里也不产生额外字段（`forwardProtocolFields`
 *     对非 tls 只返回 protocol）。
 */
export function forwardCopyDraft(forward: PortForward, suffix: string): ForwardCopyDraft {
  const mode: "direct" | "relay" = forward.mode === "relay" ? "relay" : "direct";
  const protocol = forwardProtocolForCreate(forward.protocol) ?? DEFAULT_FORWARD_PROTOCOL;
  return {
    ...forwardPolicyDraft(forward),
    name: forwardCopyName(forward, suffix),
    mode,
    ingressId: forward.ingress_node_id ? String(forward.ingress_node_id) : "",
    // direct 不允许带出口：后端对 `direct` + `egress_node_id` 直接
    // 保持 mode 与拓扑一致，否则后端返回 mode_topology_mismatch。
    egressId:
      mode === "relay" && forward.egress_node_id ? String(forward.egress_node_id) : "",
    listenPort: "", // 自动分配：绝不复制源端口
    targetHost: forward.target_host ?? "",
    targetPort: forward.target_port != null ? String(forward.target_port) : "",
    protocol,
    // 非 tls 的源行在视图里就是 null，这里天然得到空串（不会被发出去）。
    tlsCertPath: protocol === "tls" ? (forward.tls_cert_path ?? "") : "",
    tlsKeyPath: protocol === "tls" ? (forward.tls_key_path ?? "") : "",
  };
}

/**
 * 复制草稿 → create payload。
 *
 * 键集合恒等于 {@link FORWARD_CREATE_KEYS}（`tls` 时再加上
 * {@link FORWARD_TLS_CREATE_KEYS}）——逐个赋值，不 spread，源转发上的任何运行态
 * 字段都不可能泄漏进创建请求；非 tls 协议**结构上**带不了证书路径。
 */
export function forwardCopyCreateInput(draft: ForwardCopyDraft): ForwardCreateInput {
  const listen = draft.listenPort.trim() ? Number(draft.listenPort.trim()) : null;
  const egress = draft.mode === "relay" && draft.egressId ? Number(draft.egressId) : null;
  return {
    ...forwardPolicyDraftValues(draft),
    name: draft.name.trim().slice(0, FORWARD_NAME_MAX),
    mode: draft.mode,
    ingress_node_id: Number(draft.ingressId),
    egress_node_id: egress,
    listen_port: listen,
    target_host: draft.targetHost.trim(),
    target_port: Number(draft.targetPort.trim()),
    ...forwardProtocolFields(draft.protocol, draft.tlsCertPath, draft.tlsKeyPath),
  };
}

/* ------------------------------------------------------------------ */
/* auto-port 展示语义（空值 = 自动分配，绝不渲染假端口号）               */
/* ------------------------------------------------------------------ */

/** 监听端口草稿是否为空（= 交给系统自动分配）。 */
export function isAutoPort(value: string): boolean {
  return value.trim() === "";
}

/**
 * 监听端口字段下方的提示 key。
 * 空 → 明确的「自动分配」提示；非空 → 说明已固定端口的约束。
 */
export function listenPortHintKey(
  value: string,
): "forward.autoPortNotice" | "forward.listenPortFixed" {
  return isAutoPort(value) ? "forward.autoPortNotice" : "forward.listenPortFixed";
}

/**
 * 监听端口输入框的占位符 key。
 * 空 → 文字「自动分配」；非空 → 一个示例端口号（此时它是占位示例，不是回显值）。
 */
export function listenPortPlaceholderKey(
  value: string,
): "forward.autoPortPlaceholder" | "forward.portPlaceholder" {
  return isAutoPort(value) ? "forward.autoPortPlaceholder" : "forward.portPlaceholder";
}

/**
 * Forward 的用户访问地址。自动端口尚未由后端/runtime 确定时返回 null，
 * 调用方必须展示「待确定」而不是拼出 `:auto` 这样的伪地址。
 */
export function forwardAccessAddress(forward: Pick<PortForward, "listen_ip" | "listen_port" | "ingress_node">): string | null {
  if (forward.listen_port == null) return null;
  const host = (forward.ingress_node?.connect_ip ?? forward.listen_ip ?? "").split(",").map((ip) => ip.trim()).find(Boolean);
  if (!host || host === "0.0.0.0" || host === "::" || host === "*") return null;
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${normalizedHost}:${forward.listen_port}`;
}
