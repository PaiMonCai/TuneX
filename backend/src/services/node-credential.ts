/**
 * WP7 — per-node credential（生成 / 校验 / 轮换 / 撤销）+ server-side node identity
 *
 * 依据 `DEVELOPMENT.md` §7.10「WP7 — Node Credential / Session / State Report」
 * （Track B/C，依赖 WP6 控制协议）。
 *
 * ── 与 node_group.token 的分工（写死，别再混）──
 *   · `node_group.token`（既有，一组一凭证）回答「这个 Agent 属于哪个组」，
 *     它决定 Socket.IO 配置下发范围，**不**回答「这个 Agent 是哪个节点」。
 *   · 本模块的节点凭据（一节点一凭证）回答「这个 Agent 就是节点 N 本人」，
 *     是控制面 node/agent 资源的身份真相源。WP8/WP9/WP10 指挥 node 前必须
 *     走 {@link authenticateNode} 拿到 `{ node_id, scope }`，而不是信载荷里
 *     自报的 node_id —— 免认证机器端点「不信任自报归属」这条老规矩（见
 *     routes/public.ts 的 observer 批注）在这里升格成「身份与归属都由凭据定」。
 *
 * ── 验收口径逐条落地位置 ──
 *   · A token 不能冒充 B：认证按 `node_credential_hash` 唯一列等值查找，
 *     命中行是哪个节点就返回哪个节点；凭证与节点一对一，无法把 A 的 token
 *     投递成 B 的身份。找不到 / 不匹配一律 401（见 {@link authenticateNode}）。
 *   · revoked token 不能重连：`credential_revoked` 参与 status 判定与
 *     `where` 条件双保险（撤销在两次请求之间生效也拦得住）。
 *   · rotate 后旧 token 失效：rotate 覆盖哈希列，旧哈希立即查不到
 *     （与 rotateKey / rotateEmailToken 同一模式）。
 *   · token 不写日志：本模块不引入任何 console/logger 调用；明文只经
 *     {@link IssueCredentialResult.plaintext} 返回一次，调用方必须只放进
 *     响应体。审计（middlewares/audit.ts）本就只落 method/path/status/ip，
 *     且 `services/audit.ts` 的 SENSITIVE_RE 命中 *token* 会强制丢 metadata。
 *   · NAT Agent 只靠出站连接工作：本模块只解析凭证、不监听端口、不主动
 *     连接 Agent。上报（node-state.ts）由 Agent POST 上来；下发走既有
 *     Socket.IO（Agent 主动出站建连）——与 WP6 §7.9 的 transport 纪律一致。
 *
 * ── 存储 ──
 * 只存 `sha256(token)` hex（`CHAR(64)` 唯一列）。明文 = 32 随机字节 base64url
 * （约 43 字符，URL/header 安全），熵足够且不解码。明文**不落库、不进日志、
 * 不进审计**：issue/rotate 的返回值是它唯一的出现场合。
 *
 * ── 速率限制的边界 ──
 * 认证失败计数走 {@link nodeRegisterBlockKey}（WP1 已就位的 global 段防爆破键，
 * 值只描述「凭据指纹的失败次数」，不描述任何租户资产）。窗口与阈值在本模块
 * 以常量固定，HTTP 侧另有限流规则（middlewares/rate-limit.ts）兜底。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "../db.ts";
import { redis, RedisKeys } from "../redis.ts";
import { nodeScope } from "../tenant-scope.ts";

/* ================================================================== */
/* 常量                                                                */
/* ================================================================== */

/** 明文凭据：32 字节随机 → base64url（43 字符，header 安全）。 */
export const CREDENTIAL_BYTES = 32;

/** 认证防爆破：同一指纹 60s 内最多失败这么多次，超过即对该指纹封禁。 */
export const NODE_AUTH_MAX_FAILURES = 10;
/** 防爆破窗口（秒）。 */
export const NODE_AUTH_WINDOW_SECONDS = 60;
/** 封禁时长（秒）。封禁期间即使凭据正确也拒绝（阻止继续试错）。 */
export const NODE_AUTH_BLOCK_SECONDS = 300;

/* ================================================================== */
/* 纯函数（无 IO，可离线单测）                                          */
/* ================================================================== */

/** 生成一个新明文凭据（32 随机字节 base64url）。 */
export function generateNodeCredential(): string {
  return randomBytes(CREDENTIAL_BYTES).toString("base64url");
}

/**
 * sha256(credential) hex —— 与 {@link generateNodeCredential} 的明文配平。
 *
 * 同时是认证的等值查找键与防爆破指纹键的输入：两者都用**哈希**而不是明文，
 * 于是 Redis 里也不留可用凭据（防爆破键泄露 ≠ 凭据泄露）。
 */
export function hashNodeCredential(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

/** 恒定时间比较（哈希等长时；长度不同直接 false，timingSafeEqual 会抛错）。 */
export function credentialEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** 认证拒绝原因。`blocked` 指防爆破封禁（凭据可能仍有效，但此刻不许试）。 */
export type NodeAuthFailure = "invalid_credential" | "revoked" | "blocked" | "db_unavailable";

export type NodeAuthResult =
  | { ok: false; reason: NodeAuthFailure }
  | ({ ok: true } & NodeIdentity);

/**
 * 认证一态判定（纯函数，无 IO）：给定节点行的凭据相关列 + 提供的哈希 → 是否放行。
 *
 * 三条硬规则都在这一个函数里，调用方（HTTP / Socket.IO / 未来 transport）只
 * 需要把「查到的行」喂进来，不再各自实现判定逻辑：
 *   1. 没签过凭据（`hash === null`）→ invalid_credential。**不回落**到
 *      node_group.token：那会让泄露的组 token 冒充组内任意节点。
 *   2. `revoked` → revoked。撤销优先级高于哈希比对：撤销后即使有人拿到了
 *      有效明文也一律拒绝（GodD）。
 *   3. 哈希不等 → invalid_credential。等长恒定时间比较，无短答侧信道。
 */
export function decideNodeAuth(
  row: { node_credential_hash: string | null; credential_revoked: boolean } | null,
  presentedHash: string,
): { ok: true } | { ok: false; reason: "invalid_credential" | "revoked" } {
  if (!row) return { ok: false, reason: "invalid_credential" };
  if (row.credential_revoked) return { ok: false, reason: "revoked" };
  if (row.node_credential_hash === null) return { ok: false, reason: "invalid_credential" };
  if (!credentialEquals(row.node_credential_hash, presentedHash)) {
    return { ok: false, reason: "invalid_credential" };
  }
  return { ok: true };
}

/** node_id 字符串形态校验（面板侧 `Node.node_id` 是 VarChar(255)）。 */
export function isValidNodeIdFormat(nodeId: string): boolean {
  return nodeId.length > 0 && nodeId.length <= 255;
}

/* ================================================================== */
/* 签发 / 轮换 / 撤销                                                   */
/* ================================================================== */

export interface IssueCredentialResult {
  /** 明文凭据。**只此一次可见**，调用方必须只把它放进响应体。 */
  plaintext: string;
  node_id: number;
  /** 面板可见的节点标识（字符串）。 */
  node_key: string;
}

/**
 * 签发节点凭据（若已存在则拒绝 —— 先 rotate，不静默覆盖）。
 *
 * 幂等性取向与 `rotateKey` 不同：user-keys 的轮换允许「没有也生成一把」，
 * 这里刻意区分 issue / rotate，因为「凭据突然换了一个，没人知道为什么」
 * 在节点场景里比用户场景危险得多（组长 token 不变，节点被重签 = 运维事故）。
 */
export async function issueNodeCredential(nodeDbId: number): Promise<IssueCredentialResult> {
  const plaintext = generateNodeCredential();
  const hashed = hashNodeCredential(plaintext);
  // 只允许对「从未签过 / 已撤销」的节点签发：已持有有效凭据的节点必须走 rotate，
  // 否则管理端误点两次「签发」就会静默让线上 Agent 的凭据失效。
  const existing = await db.node.findUnique({
    where: { id: nodeDbId },
    select: { node_id: true, node_credential_hash: true, credential_revoked: true },
  });
  if (!existing) throw new NodeCredentialError("node_not_found", 404);
  if (existing.node_credential_hash && !existing.credential_revoked) {
    throw new NodeCredentialError("credential_exists", 409);
  }
  await db.node.update({
    where: { id: nodeDbId },
    data: {
      node_credential_hash: hashed,
      credential_revoked: false,
      credential_rotated_at: new Date(),
      // 重新签发视为新一轮：清掉上次的 rejected 时间戳，避免面板显示陈旧告警。
      credential_last_rejected_at: null,
    },
  });
  return { plaintext, node_id: nodeDbId, node_key: existing.node_id };
}

/**
 * 轮换：生成新明文凭据，覆盖哈希列并清 revoked。
 * 返回新明文（仅此一次可见，调用方必须只把它放进响应体）。
 *
 * 旧凭据立即失效：哈希列被覆盖，旧 sha256 在任何查找里都命中不了
 * （GodD「rotate 后旧 token 失效」）。`credential_last_rejected_at` 一并清掉，
 * 因为「旧 token 来敲门」从下一刻起是预期事件（旧 Agent 还没重启），不再是异常。
 */
export async function rotateNodeCredential(nodeDbId: number): Promise<IssueCredentialResult> {
  const plaintext = generateNodeCredential();
  const hashed = hashNodeCredential(plaintext);
  // updateMany 对「零行匹配」返回 count:0 而不是 P2025（那是 update 的行为），
  // 所以这里只需判 count；catch 里的 P2025 兜底留给未来的 update 改写。
  const updated = await db.node
    .updateMany({
      // 守卫条件带 `node_credential_hash: { not: null }`：从没签过凭据的节点
      // 不允许 rotate（先 issue），否则会把「误点一次 rotate」变成静默签发。
      // count===0 统一按 node_not_found 回报，调用方无法区分「节点没了」与
      // 「节点还没凭据」是故意的——两者对调用方的动作都是「去签发」。
      where: { id: nodeDbId, node_credential_hash: { not: null } },
      data: {
        node_credential_hash: hashed,
        credential_revoked: false,
        credential_rotated_at: new Date(),
        credential_last_rejected_at: null,
      },
    })
    .catch((e: unknown) => {
      if ((e as { code?: string })?.code === "P2025") {
        throw new NodeCredentialError("node_not_found", 404);
      }
      throw e;
    });
  if (updated.count === 0) throw new NodeCredentialError("node_not_found", 404);
  return { plaintext, node_id: nodeDbId, node_key: await nodeKeyOf(nodeDbId) };
}

/** 读节点的对外标识（字符串）。rotate 等路径只需这一个字段。 */
async function nodeKeyOf(nodeDbId: number): Promise<string> {
  const row = await db.node.findUnique({ where: { id: nodeDbId }, select: { node_id: true } });
  if (!row) throw new NodeCredentialError("node_not_found", 404);
  return row.node_id;
}

/**
 * 撤销节点凭据：置 `credential_revoked`，**保留哈希列**。
 *
 * 三点理由，写死：
 *   1. `revoked` 拒绝原因只有在哈希还在时才可达 —— 撤销后旧钥匙再来敲门，
 *      面板才能说「是撤销而不是瞎猜」，否则一律 `invalid_credential`，
 *      {@link noteRejection} 也丢了记账对象；
 *   2. 哈希是 sha256(32 随机字节)，暴力反推不可行，留着它不等于「留着凭据」；
 *   3. 认证路径上 `decideNodeAuth` 的 `revoked` 分支优先级高于哈希比对，
 *      所以留着哈希**不会**让撤销失效（fail-closed）。
 * 想彻底抹掉这把钥匙 → {@link rotateNodeCredential} 覆盖哈希列。
 * 重新签发走 {@link issueNodeCredential}。
 */
export async function revokeNodeCredential(nodeDbId: number): Promise<{ node_id: number; node_key: string }> {
  const updated = await db.node
    .updateMany({
      where: { id: nodeDbId },
      data: {
        // 哈希保留（有理：见上方批注），仅置 revoked 位。
        credential_revoked: true,
        // 撤销本身也是「凭据变更」，刷新时间戳供面板展示。
        credential_rotated_at: new Date(),
      },
    })
    .catch((e: unknown) => {
      if ((e as { code?: string })?.code === "P2025") {
        throw new NodeCredentialError("node_not_found", 404);
      }
      throw e;
    });
  if (updated.count === 0) throw new NodeCredentialError("node_not_found", 404);
  return { node_id: nodeDbId, node_key: await nodeKeyOf(nodeDbId) };
}

/* ================================================================== */
/* 认证（server-side node identity）                                    */
/* ================================================================== */

/** 认证成功时返回的身份：数字主键 + workspace scope（由 node_group 归属派生）。 */
export interface NodeIdentity {
  node_id: number;
  node_key: string;
  agent_id: string;
  scope: number;
}

/**
 * 用明文凭据解析节点身份。
 *
 * 顺序是刻意的：
 *   1. 先封禁检查（Redis，global 段）—— 爆破中的指纹不值得打库；
 *   2. 再按哈希查库（唯一列等值，命中行即身份）；
 *   3. scope 沿 `node → node_group → workspace_id` 派生（{@link nodeScope} 的
 *      DB 侧等价物），调用方不得自选；
 *   4. 失败才累加封禁计数（`credential_last_rejected_at` + Redis）。
 *
 * DB 不可用 → `{ ok:false, reason:"db_unavailable" }`：调用方按 503 处理，
 * 不做 fail-open（认证 fail-open 等于没认证）。
 */
export async function authenticateNode(plaintext: string): Promise<NodeAuthResult> {
  const hashed = hashNodeCredential(plaintext);
  const blockKey = RedisKeys.nodeRegisterBlock(hashed);

  try {
    // 1. 封禁检查（Redis 故障时放行到 DB 判定：防爆破是尽力而为，认证才是硬门槛）。
    let blocked: string | null = null;
    try {
      blocked = await redis.get(blockKey);
    } catch {
      blocked = null;
    }
    if (blocked) return { ok: false, reason: "blocked" };

    // 2/3. 哈希等值查找 + scope 派生（一次查询，无 N+1）。
    const row = await db.node.findUnique({
      where: { node_credential_hash: hashed },
      select: {
        id: true,
        node_id: true,
        agent_id: true,
        node_credential_hash: true,
        credential_revoked: true,
        node_group: { select: { workspace_id: true } },
      },
    });
    const decision = decideNodeAuth(row, hashed);
    if (!decision.ok) {
      await noteRejection(hashed, blockKey);
      return decision;
    }
    const scope = nodeScope(row!);
    return { ok: true, node_id: row!.id, node_key: row!.node_id, agent_id: row!.agent_id, scope };
  } catch (e) {
    if (e instanceof NodeCredentialError) throw e;
    return { ok: false, reason: "db_unavailable" };
  }
}

/** 认证失败留痕：节点行记 rejected_at（供 rotate 时识别旧 token 敲门）+ Redis 计数。 */
async function noteRejection(hashed: string, blockKey: string): Promise<void> {
  try {
    await db.node.updateMany({
      where: { node_credential_hash: hashed },
      data: { credential_last_rejected_at: new Date() },
    });
  } catch {
    /* 记账失败不影响拒绝结论 */
  }
  try {
    const count = await redis.incr(blockKey);
    if (count === 1) await redis.expire(blockKey, NODE_AUTH_WINDOW_SECONDS);
    if (count > NODE_AUTH_MAX_FAILURES) {
      await redis.set(blockKey, String(Date.now()), "EX", NODE_AUTH_BLOCK_SECONDS);
    }
  } catch {
    /* Redis 故障：不封禁也不抛错 */
  }
}

/* ================================================================== */
/* 错误类型                                                            */
/* ================================================================== */

export class NodeCredentialError extends Error {
  constructor(
    public code: "node_not_found" | "credential_exists" | "already_revoked",
    public status: number,
  ) {
    super(code);
    this.name = "NodeCredentialError";
  }
}

/** 供 HTTP 层判断「这个错误该回什么码」的纯函数。 */
export function credentialErrorStatus(e: unknown): number | null {
  if (e instanceof NodeCredentialError) return e.status;
  return null;
}
