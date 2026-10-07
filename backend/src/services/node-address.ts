// 行为参照：ForwardX（AGPL-3.0-only）——「成员自带连接地址（`connectHost`）」这一产品逻辑：
// 可拨号地址不是在创建那一刻定死的，事后可以设置与修改。本模块把这条逻辑实现在我们
// **节点**这一层（不引入成员级第二份地址），代码为本项目改写，未复制其实现。
// 参照溯源：docs/agent/forwardx-code-reuse.md
/**
 * 节点「可拨号地址」（`node.connect_ip`）的写入面与校验。
 *
 * ── 为什么单独一个模块 ──
 * 1. **它必须能被行为测试**：`routes/nodes.ts` 的传递依赖在 import 期就连 Redis
 *    （见 `routes/__tests__/nodes-projection.test.ts` 的说明），所以路由不能挂进单测；
 *    把校验与写入判定抽到这里、用注入的 `db` 缝隙测试，才能钉住每一条拒绝分支；
 * 2. **它是唯一一处**定义"什么算可拨号地址"的地方：RELAY/三跳的创建前置校验
 *    （`services/forward-service.ts`）与 `PATCH /api/nodes/:id` 必须用同一份判据，
 *    否则会出现"补得进去但下发不了"或反之。
 *
 * ── 口径 ──
 * · 地址可以有多条候选（逗号分隔，`forward-contract.ts:firstConnectIp` 取第一个非空项）；
 *   这里逐项校验并把结果规范化成 `a,b`（去掉多余空白）后落库；
 * · `null` = 显式清空；空白串 = **拒绝**（清空要显式，避免"手滑删空"静默生效）；
 * · 清空时若仍有 RELAY/三跳把该节点当跳 ⇒ **fail-closed**（`connect_ip_in_use`），
 *   否则那些转发会在下一次下发时失败，而用户不知道为什么。
 */

import { isIP } from "node:net";

export const NODE_ADDRESS_CODES = {
  invalidConnectIp: "invalid_connect_ip",
  connectIpInUse: "connect_ip_in_use",
  notFound: "not_found",
  /** RELAY/三跳的某一跳缺少可拨号地址（创建路径的前置拒绝）。 */
  hopAddressMissing: "hop_address_missing",
} as const;

/** 合法主机：IPv4 / IPv6（**不带方括号**，落库的是裸地址）/ RFC1123 主机名。 */
export function isDialableHost(value: string): boolean {
  if (isIP(value) !== 0) return !value.startsWith("[") && !value.endsWith("]");
  // 主机名：标签 1..63、总长 ≤253；不允许下划线（DNS 记录与 TLS SNI 都不接受它）。
  return /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
    value,
  );
}

export interface ConnectIpPatchOk {
  readonly ok: true;
  /** 规范化后的值：`null` = 清空；否则是逗号分隔（无空格）的候选列表。 */
  readonly value: string | null;
}
export interface ConnectIpPatchFail {
  readonly ok: false;
  readonly status: 400 | 404 | 409;
  readonly code: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

/**
 * 校验 `PATCH /api/nodes/:id` 的请求体。
 *
 * **只认 `connect_ip` 一个键**：多一个键就 400（静默忽略会让调用方以为改成功了），
 * 这也把"用这个端点偷改 role/区间/生命周期/凭据"这条路堵死 —— 那些字段各有自己的入口与判定。
 */
export function normalizeConnectIpPatch(raw: unknown): ConnectIpPatchOk | ConnectIpPatchFail {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      status: 400,
      code: NODE_ADDRESS_CODES.invalidConnectIp,
      message: "请求体必须是对象，且只含 connect_ip（字符串或 null）。",
    };
  }
  const record = raw as Record<string, unknown>;
  if (!("connect_ip" in record)) {
    return {
      ok: false,
      status: 400,
      code: NODE_ADDRESS_CODES.invalidConnectIp,
      message: "缺少 connect_ip：要清空地址请显式传 null。",
    };
  }
  const extra = Object.keys(record).filter((key) => key !== "connect_ip");
  if (extra.length > 0) {
    return {
      ok: false,
      status: 400,
      code: NODE_ADDRESS_CODES.invalidConnectIp,
      message: `本端点只接受 connect_ip，收到不支持的字段：${extra.join(", ")}。角色/端口区间/生命周期/凭据请走各自的入口。`,
    };
  }
  const value = record.connect_ip;
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return {
      ok: false,
      status: 400,
      code: NODE_ADDRESS_CODES.invalidConnectIp,
      message: "connect_ip 必须是字符串或 null。",
    };
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return {
      ok: false,
      status: 400,
      code: NODE_ADDRESS_CODES.invalidConnectIp,
      message: "connect_ip 不能是空白串：要清空地址请显式传 null。",
    };
  }
  const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !isDialableHost(part))) {
    return {
      ok: false,
      status: 400,
      code: NODE_ADDRESS_CODES.invalidConnectIp,
      message:
        "connect_ip 必须是可拨号的主机地址：IPv4 / IPv6（裸地址，不要方括号）/ 主机名；多个候选用逗号分隔。",
    };
  }
  return { ok: true, value: parts.join(",") };
}

/** 该节点上"可拨号的主机"（无地址时为 `null`）。与 `forward-contract.ts:firstConnectIp` 同口径。 */
export function connectHostOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.split(",").map((s) => s.trim()).find(Boolean) ?? null;
}

export interface HopAddressCandidate {
  readonly id: number;
  readonly name: string;
  readonly position: string;
  readonly connectIp: string | null;
}

/** 缺少可拨号地址的那些跳（空数组 = 每跳都有地址）。 */
export function missingHopAddresses<T extends HopAddressCandidate>(hops: readonly T[]): T[] {
  return hops.filter((hop) => connectHostOf(hop.connectIp) === null);
}

/**
 * 缺地址时的**可操作**文案。
 *
 * 这条替换掉原先的 `502 apply_failed / invariant_violated: RELAY plan needs a <host>:<port> next_hop`：
 * 那句话既没说是哪台机器，也没说该怎么办，用户拿到手完全无从下手。
 */
export function hopAddressMissingMessage(hops: readonly HopAddressCandidate[]): string {
  const detail = hops.map((hop) => `${hop.position}「${hop.name}」(#${hop.id})`).join("、");
  return `${detail} 缺少可拨号地址（node.connect_ip）：RELAY/三跳的每一跳都要有一个可拨号地址，上一跳才拨得进来。请到「节点」页为该节点补上连接地址（PATCH /api/nodes/:id 的 connect_ip 字段）后重试。`;
}

/* ------------------------------------------------------------------ */
/* 写入面（注入 db 缝隙，便于行为测试）                                  */
/* ------------------------------------------------------------------ */

export interface NodeAddressDb {
  node: {
    findFirst: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  };
  tunnel: {
    findMany: (args: unknown) => Promise<unknown>;
  };
}

export interface UpdateConnectIpInput {
  readonly nodeId: number;
  readonly workspaceId: number;
  readonly value: string | null;
  /** 列依赖时最多列几条（消息里只点名前几条，避免一条消息几千字）。 */
  readonly maxDependents?: number;
}

export type UpdateConnectIpResult =
  | { readonly ok: true; readonly node: Record<string, unknown> }
  | ConnectIpPatchFail;

/**
 * 写入 `connect_ip`（清空走同一入口，带 fail-closed 依赖检查）。
 *
 * 依赖判定用的是**转发行**而不是任何缓存/投影：RELAY 或三跳把该节点当出口/中间跳时，
 * 抹掉地址会让它的下一次下发失败 —— 那时用户只会看到一条"昨天还好的转发今天红了"。
 */
export async function updateNodeConnectIp(
  db: NodeAddressDb,
  input: UpdateConnectIpInput,
): Promise<UpdateConnectIpResult> {
  const node = (await db.node.findFirst({
    where: { id: input.nodeId, node_group: { workspace_id: input.workspaceId } },
  })) as Record<string, unknown> | null;
  if (!node) {
    return {
      ok: false,
      status: 404,
      code: NODE_ADDRESS_CODES.notFound,
      message: "节点不存在",
    };
  }

  if (input.value === null) {
    const dependents = (await db.tunnel.findMany({
      where: {
        workspace_id: input.workspaceId,
        tunnel_mode: "relay",
        OR: [{ egress_node_id: input.nodeId }, { middle_node_id: input.nodeId }],
      },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
      take: input.maxDependents ?? 10,
    })) as Array<{ id: number; name: string }>;
    if (dependents.length > 0) {
      return {
        ok: false,
        status: 409,
        code: NODE_ADDRESS_CODES.connectIpInUse,
        message: `该节点当前是这些转发的跳，清空 connect_ip 会让它们无法下发：${dependents
          .map((row) => `#${row.id} ${row.name}`)
          .join("、")}。请先改掉这些转发或换成另一台节点。`,
        data: { forwards: dependents },
      };
    }
  }

  await db.node.update({ where: { id: input.nodeId }, data: { connect_ip: input.value } });
  const updated = (await db.node.findFirst({
    where: { id: input.nodeId, node_group: { workspace_id: input.workspaceId } },
  })) as Record<string, unknown> | null;
  if (!updated) {
    return { ok: false, status: 404, code: NODE_ADDRESS_CODES.notFound, message: "节点不存在" };
  }
  return { ok: true, node: updated };
}
