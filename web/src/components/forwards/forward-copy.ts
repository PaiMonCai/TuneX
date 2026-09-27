/**
 * V4-WP9：复制 Forward + auto-port 语义的**纯逻辑**（无 React / 无网络）。
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

/** 编辑器 / 创建表单共用的草稿形状（全字符串，便于受控输入与表单预检）。 */
export type ForwardDraft = {
  name: string;
  mode: "direct" | "relay";
  ingressId: string;
  egressId: string;
  listenPort: string;
  targetHost: string;
  targetPort: string;
};

/** 后端 `ForwardCreateSchema` 的字段集（`.strict()`：键集合必须完全一致）。 */
export const FORWARD_CREATE_KEYS = [
  "name",
  "mode",
  "ingress_node_id",
  "egress_node_id",
  "listen_port",
  "target_host",
  "target_port",
] as const;

/**
 * 复制时**禁止**继承的字段：主键、运行状态、流量统计、revision 轨迹。
 * 这些全部由后端在创建时重新生成 —— 测试按此清单逐条断言，防止有人「顺手」
 * 把源行整行 spread 进 create（那会让 `.strict()` 400，或更糟：污染运行态）。
 */
export const FORWARD_COPY_FORBIDDEN_FIELDS = [
  "id",
  "status",
  "desired_status",
  "apply_status",
  "apply_error",
  "apply_error_code",
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
 */
export function forwardCopyDraft(forward: PortForward, suffix: string): ForwardDraft {
  const mode: "direct" | "relay" = forward.mode === "relay" ? "relay" : "direct";
  return {
    name: forwardCopyName(forward, suffix),
    mode,
    ingressId: forward.ingress_node_id ? String(forward.ingress_node_id) : "",
    // direct 不允许带出口：后端对 `direct` + `egress_node_id` 直接
    // 400 `mode_topology_mismatch`（V4-WP1 不变量）。
    egressId:
      mode === "relay" && forward.egress_node_id ? String(forward.egress_node_id) : "",
    listenPort: "", // 自动分配：绝不复制源端口
    targetHost: forward.target_host ?? "",
    targetPort: forward.target_port != null ? String(forward.target_port) : "",
  };
}

/**
 * 复制草稿 → create payload。
 *
 * 键集合恒等于 {@link FORWARD_CREATE_KEYS}（逐个赋值，不 spread）——源转发上的
 * 任何运行态字段都不可能泄漏进创建请求。
 */
export function forwardCopyCreateInput(draft: ForwardDraft): ForwardCreateInput {
  const listen = draft.listenPort.trim() ? Number(draft.listenPort.trim()) : null;
  const egress = draft.mode === "relay" && draft.egressId ? Number(draft.egressId) : null;
  return {
    name: draft.name.trim().slice(0, FORWARD_NAME_MAX),
    mode: draft.mode,
    ingress_node_id: Number(draft.ingressId),
    egress_node_id: egress,
    listen_port: listen,
    target_host: draft.targetHost.trim(),
    target_port: Number(draft.targetPort.trim()),
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
