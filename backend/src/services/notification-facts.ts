/**
 * V5-WP18.1 —— 通知派生的**纯函数**核心（契约 §F1 / §F2 / §F4 / §7 DoD1）。
 *
 * ── 这个模块存在的理由 ──
 * 「发通知」最容易做错的地方不是投递，而是**判定**：一旦通知层自己回答「这台机器算
 * 不算离线」「这条转发算不算失败」，同一个事实就有了两份判定，面板说健康、邮件说故障
 * （§13.4.4 明令禁止的第二套真相，契约 C1/F8）。
 *
 * 因此本模块的输入**不是**数据库行，而是既有判定链的**结论**：
 *   · 事实与原因码 —— `services/attention.ts` 的 `collectAttention()` 产出
 *     （它已经把节点连接态交给 `deriveConnection`、把转发失败交给 `scheduler.isRetryable`，
 *      并且原因码一律取自既有词表）；
 *   · 发生时刻 —— 来源表上的既有时间戳（`node.last_seen_at` / `tunnel.updated_at`），
 *     由调用方随种子一起传入。
 * 本层只做三件事：**加来源标识**（source_kind/source_id）、**算幂等键**、**把关拒绝**。
 * 它不碰 db / redis / 网络，是纯函数，可以在无依赖环境里逐字段断言（DoD1）。
 *
 * ── 三条不变量 ──
 *  1. **不新造原因码**：`reason_code` 的类型就是 `AttentionReasonCode`（同一个类型别名，
 *     不是"看起来一样"的另一份联合类型），运行期白名单由 `REASON_CODE_REGISTRY` 给出 ——
 *     它写成 `Record<AttentionReasonCode, true>`，attention 若新增码而这里没跟上，
 *     **编译期**就会红（见 {@link NOTIFICATION_REASON_CODES}）。
 *  2. **不重新评级**：`severity` 直传 attention 的结论。通知层再判一次严重度就等于第二套
 *     判定，而且必然与面板不一致。
 *  3. **fail-closed**（契约 C3）：未知来源、缺 source_id、未知原因码、坏作用域、坏时间戳
 *     一律**不进候选集**，并且把拒绝原因结构化返回 —— 不抛错（旁路不得拖挂主业务，
 *     `audit.ts` / `mail.ts` 同一取向），也不静默当作"没有事实"（那正是 C3 禁止的降级）。
 *
 * ── 与 WP18.2 的边界 ──
 * 本模块只回答「有哪些事实值得投递、它们的幂等键是什么」；静默期的 Redis 读写、投递账本、
 * 渠道与渲染都在 `notification-delivery.ts`。`NOTIFICATION_COOLDOWN_SECONDS` 放在这里，
 * 是因为**幂等键的时间窗就是静默期**（`window_start` 由它分桶），两处若各存一份数值，
 * 就会出现「键按 5 分钟分桶、静默期按 15 分钟拦」这种自相矛盾的配置。
 */
import { createHash } from "node:crypto";
import { scopeId, scopeTag, scopedKey } from "../tenant-scope.ts";
import type { AttentionItem, AttentionReasonCode, AttentionSeverity } from "./attention.ts";

/* ================================================================== */
/* 作用域                                                             */
/* ================================================================== */

/**
 * 通知作用域。**用结构表达边界**（与契约 F6.2 对公告的取向一致）：
 * `kind === "platform"` 时 `workspace_id` 只能是 `null`，所以「平台事实挂到某个租户」
 * 在类型层面就写不出来，不需要靠约定或调用方自觉。
 */
export type NotificationScope =
  | { readonly kind: "platform"; readonly workspace_id: null }
  | { readonly kind: "workspace"; readonly workspace_id: number };

/** 平台作用域（全局面）。没有 workspace 归属的键走 `ws:global`（tenant-scope 的显式选择）。 */
export function platformNotificationScope(): NotificationScope {
  return { kind: "platform", workspace_id: null };
}

/**
 * 租户作用域。`workspace_id` 非正整数直接抛错：这是**调用方的编程错误**，
 * 与「数据里出现坏字段」（走 {@link buildNotificationFact} 的拒绝通道）是两类问题，
 * 混在一起会让一个拼错的 id 悄悄变成平台级通知（发给所有人）。
 */
export function workspaceNotificationScope(workspaceId: number): NotificationScope {
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
    throw new Error("notification scope: workspace_id must be a positive integer");
  }
  return { kind: "workspace", workspace_id: workspaceId };
}

/** 运行期形状校验（外部输入 / JSON 边界用；坏的 scope 一律拒绝）。 */
export function isNotificationScope(value: unknown): value is NotificationScope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { kind?: unknown; workspace_id?: unknown };
  if (v.kind === "platform") return v.workspace_id === null;
  if (v.kind === "workspace") return typeof v.workspace_id === "number" && Number.isInteger(v.workspace_id) && v.workspace_id > 0;
  return false;
}

/** 幂等键里的作用域段：`ws:global` / `ws:7`（与 tenant-scope 的键前缀同源）。 */
export function notificationScopeKey(scope: NotificationScope): string {
  return `ws:${scopeTag(scope.workspace_id)}`;
}

/* ================================================================== */
/* 触发源（封闭枚举，契约 F2）                                         */
/* ================================================================== */

/**
 * 触发源白名单（契约 F2 的 N1–N6）。
 *
 * 为什么是闭集而不是自由字符串：`source_kind` 是 C3「未知来源一律拒绝」的判据，
 * 也参与幂等键。放开成任意字符串，一次拼写错误（`"nodes"`）就会静默产生一套
 * 全新的幂等键域 —— 同一事实被投递两次，而唯一索引不会再拦住它。
 *
 * 本期**只有 N1/N2 有派生实现**（节点 / 转发，经 attention 的结论）。其余四项
 * 已在枚举里占位但没有任何派生入口，原因写成各自的注释 —— 它们缺的不是代码，
 * 而是**持久事实源**（N3 的 findings 今天只在日志里，见契约 §1.3-G）。
 */
export const NOTIFICATION_SOURCE_KINDS = [
  /** N1 节点连接类（离线 / 待安装 / 管理态挡业务），经 attention + deriveConnection。 */
  "node",
  /** N2 Forward 下发被拒 / 期望落后，经 attention + tunnel.apply_* + scheduler.isRetryable。 */
  "forward",
  /** N3 对账 findings —— 待其**先落成持久行**（今天只有日志，日志不能当真相）。 */
  "reconcile_finding",
  /** N4 租户业务事件 —— 来源 `audit_event`，但「哪些 action 人要立刻知道」尚未冻结。 */
  "workspace_event",
  /** N5 联邦到期 / 撤销 / 停服 —— 来源 `federation.*` 审计行。 */
  "federation_event",
  /** N6 公告发布 —— 来源公告表自身（WP18.5）。 */
  "announcement",
] as const;
export type NotificationSourceKind = (typeof NOTIFICATION_SOURCE_KINDS)[number];

/** 触发源是否已有派生实现（没有 ⇒ 该 source_kind 的种子一律被拒绝，fail-closed）。 */
export const DERIVABLE_SOURCE_KINDS: readonly NotificationSourceKind[] = ["node", "forward"];

/* ================================================================== */
/* 原因码与严重度（只读消费既有词表）                                   */
/* ================================================================== */

/**
 * 原因码 = **同一份** `AttentionReasonCode`。
 *
 * 这里刻意用类型别名而不是重抄一遍字符串联合：重抄的版本在 attention 增删码时不会报错，
 * 于是「通知说 forward_apply_error、面板说 runtime_revision_behind」这种分叉会悄悄上线。
 */
export type NotificationReasonCode = AttentionReasonCode;

/**
 * 运行期白名单。写成 `Record<AttentionReasonCode, true>` 是**编译期**同源守卫：
 * `attention.ts` 里新增一个原因码而没有在这里登记 → `tsc --noEmit` 直接失败，
 * 不存在"忘了同步"的空间（单测里另有一条源码扫描，双向钉住集合相等）。
 */
const REASON_CODE_REGISTRY: Record<AttentionReasonCode, true> = {
  node_waiting_install: true,
  node_in_maintenance: true,
  node_disabled: true,
  node_retiring: true,
  connection_offline: true,
  forward_apply_error: true,
  runtime_revision_behind: true,
  forward_pending_apply: true,
};

/** 可投递的原因码全集（顺序 = 登记顺序，便于快照断言）。 */
export const NOTIFICATION_REASON_CODES: readonly AttentionReasonCode[] = Object.freeze(
  Object.keys(REASON_CODE_REGISTRY) as AttentionReasonCode[],
);

const REASON_CODE_SET: ReadonlySet<string> = new Set<string>(NOTIFICATION_REASON_CODES);

/** 该码是否在本层认可的词表里（unknown ⇒ 拒绝，C3）。 */
export function isNotificationReasonCode(value: unknown): value is NotificationReasonCode {
  return typeof value === "string" && REASON_CODE_SET.has(value);
}

/** 严重度：与 `AttentionSeverity` 同名同值（直传，不重新评级）。 */
export const NOTIFICATION_SEVERITIES = ["info", "warning", "error"] as const;
export type NotificationSeverity = AttentionSeverity;
export const DEFAULT_NOTIFICATION_SEVERITY: NotificationSeverity = "warning";

const SEVERITY_SET: ReadonlySet<string> = new Set<string>(NOTIFICATION_SEVERITIES);

function isNotificationSeverity(value: unknown): value is NotificationSeverity {
  return typeof value === "string" && SEVERITY_SET.has(value);
}

/* ================================================================== */
/* 静默期（Lead 裁决 O2，2026-10-05）                                  */
/* ================================================================== */

/**
 * 每个原因码的静默期（秒）。**数值集中在这一处**（R1），每一项注明它保护什么。
 *
 * 取值来自契约 §5.0 的 Lead 裁决：节点离线/恢复 5 分钟、下发被拒 15 分钟、其余 30 分钟。
 * 为什么允许"其余"走 30 分钟：这些码（待安装 / 维护中 / 期望落后 / 下发中）描述的是
 * **需要人处理的中间态**，它们的变化节奏由用户动作驱动，30 分钟内重复提醒只会训练用户忽略通知。
 *
 * 注意静默期的方向性（O2 的另一半）：它是**抑制**机制。抑制失效时应当**多报**，
 * 因此 Redis 不可用时**照发**并标 `degraded`（见 `notification-delivery.ts`）——
 * 漏报一次真实故障比重复报一次危险得多。
 */
export const NOTIFICATION_COOLDOWN_SECONDS = Object.freeze({
  /** 节点离线：5 分钟。太短会被 flap 刷屏；这是运维最需要立刻知道的一类事实。 */
  connection_offline: 300,
  /** 下发被拒：15 分钟。节点侧重试/编排修复通常以分钟计，短于此会与编排的自身节奏打架。 */
  forward_apply_error: 900,
});
/** 未单列的原因码走这里（契约 O2 的「其余 30 分钟」）。 */
export const DEFAULT_NOTIFICATION_COOLDOWN_SECONDS = 1_800;

/** 取某个原因码的静默期（秒）。未知码**不猜**：回落默认值并保持幂等键可用。 */
export function cooldownSecondsForReason(reasonCode: string): number {
  const table: Record<string, number> = NOTIFICATION_COOLDOWN_SECONDS;
  const value = table[reasonCode];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_NOTIFICATION_COOLDOWN_SECONDS;
}

/**
 * 幂等键的时间窗下界：`floor(occurred_at / 静默期) * 静默期`（epoch 对齐的固定桶）。
 *
 * **它为什么按固定桶而不是按"上一次投递时刻 + 静默期"**：本层是纯函数，没有"上一次"
 * 这个输入；滑动窗口需要持久状态，那是 Redis 那一层的职责（`notificationCooldownKey`）。
 * 两层是互补的：这里保证**同一条事实重复派生**得到同一个键（DB 唯一索引只落一行），
 * Redis 那层保证**连续派生**被真正静默。
 *
 * 已知性质（写进契约，不是 bug）：桶边界两侧相隔 1ms 的两个事实会得到两个键、投递两次。
 * 这是**有意的**方向 —— 与 O2 同一条理由，宁可多报一次，也不要把两次真实故障折叠成一次（R2）。
 */
export function notificationWindowStartMs(occurredAtMs: number, cooldownSeconds: number): number {
  const windowMs = cooldownSeconds * 1_000;
  return Math.floor(occurredAtMs / windowMs) * windowMs;
}

/* ================================================================== */
/* NotificationFact                                                   */
/* ================================================================== */

/**
 * 一条可投递的通知事实（契约 F1 的字段表 + `window_start`）。
 *
 * `scope` / `source_kind` / `source_id` 三者是 F8-B 的可断言部分：任何通知行都必须能
 * 指回**既有表里的某一行**（`source_id`），否则它就是凭空造出来的第二条真相。
 *
 * `window_start` 是新增的显式字段（契约 F1 只列了 `dedupe_key`）：幂等键把时间窗哈希掉了，
 * 只看键无法回答「同一事实的下一条要等多久」「为什么这两次投递被合并了」。落库时它是
 * 诊断列，不参与任何判定。
 */
export interface NotificationFact {
  readonly scope: NotificationScope;
  readonly source_kind: NotificationSourceKind;
  /** 既有表主键（字符串形态，便于跨表统一落库）。 */
  readonly source_id: string;
  readonly reason_code: NotificationReasonCode;
  readonly severity: NotificationSeverity;
  /** 指向的具体资源（今天与 source 同行；N3 这类来源两者会分离，见 F1）。 */
  readonly resource_type: string;
  readonly resource_id: string;
  /**
   * 资源展示名（节点 `node_id` / 转发 `name`）。
   *
   * 契约 F1 的字段表没列它，但 F10 明确允许把「节点/转发名」插进邮件正文 ——
   * 一封只有主键的通知（"tunnel 31 出错了"）对收件人没有意义。名字**只用于渲染**：
   * 它不进幂等键，也不参与任何判定；渲染前按 F10 剥 CRLF + 截断。
   */
  readonly resource_name: string | null;
  /** 事实的发生时刻（来源表上的既有时间戳，ISO 8601）。 */
  readonly occurred_at: string;
  /** 幂等键的时间窗下界（ISO 8601）。 */
  readonly window_start: string;
  /** 幂等键：`sha256(scope, source_kind, source_id, reason_code, window_start)`。 */
  readonly dedupe_key: string;
  /**
   * 更细的**既有**诊断码（今天只有 `tunnel.apply_error_code`，来自
   * `scheduler.SCHEDULER_ERROR_CODES`）。它**不进幂等键**：契约 F4.2 把键的组成写死为
   * 五段，把细码塞进去会让同一个 `reason_code` 的配额按错误码分裂，与 F4.4
   * 「不同 reason_code 各有一条配额」的口径不一致。细码只用于渲染与排障。
   */
  readonly detail_code: string | null;
}

/** 来源表名（既有 schema 的名字，不造产品名）：`Forward` 的落库表就是 `tunnel`。 */
const RESOURCE_TYPE_BY_SOURCE: Record<string, string> = {
  node: "node",
  forward: "tunnel",
};

/** 幂等键的规范串。用 JSON 数组而不是分隔符拼接：任何含 `:`/`|` 的业务值都无法伪造出段边界
 * （与 `tenant-scope.ts` 的 escapeSegment 同一条理由：键的解析必须无歧义）。 */
function canonicalDedupeInput(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

/** 计算幂等键（导出供测试与 18.2 复用；形状即契约 F4.2）。 */
export function notificationDedupeKey(input: {
  scope: NotificationScope;
  source_kind: string;
  source_id: string;
  reason_code: string;
  window_start_ms: number;
}): string {
  return createHash("sha256")
    .update(
      canonicalDedupeInput([
        notificationScopeKey(input.scope),
        input.source_kind,
        input.source_id,
        input.reason_code,
        String(input.window_start_ms),
      ]),
    )
    .digest("hex");
}

/* ================================================================== */
/* 派生                                                               */
/* ================================================================== */

/** 派生种子：既有判定链的结论 + 该结论在来源表上的发生时刻。 */
export interface NotificationFactSeed {
  readonly item: AttentionItem;
  /**
   * 发生时刻。**必须来自来源表**（`node.last_seen_at` / `tunnel.updated_at`），
   * 不能用「本次扫描的时刻」：那样每扫一次时间窗就前进一格，幂等键随之改变 ——
   * 一条持续存在的故障会变成每 30 分钟一条新通知，静默期形同虚设（DoD3 的反例）。
   */
  readonly occurred_at: Date;
  /** 更细的诊断码（可选；缺省取 `item.apply_error_code`）。 */
  readonly detail_code?: string | null;
}

/** 拒绝原因（闭集，便于断言与落库统计）。 */
export const NOTIFICATION_REJECTION_REASONS = [
  /** source_kind 不在封闭枚举里（C3）。 */
  "unknown_source_kind",
  /** 该 source_kind 尚无派生实现（N3–N6，见 DERIVABLE_SOURCE_KINDS）。 */
  "source_kind_not_derivable",
  /** 缺 source_id / 不是正整数主键 —— 没有来源的通知就是第二份真相（F8-B）。 */
  "missing_source_id",
  /** 原因码不在既有词表里（绝不为了一条通知新造码）。 */
  "unknown_reason_code",
  /** 严重度不合法。 */
  "unknown_severity",
  /** 作用域形状不合法（platform 带 workspace_id / workspace 带坏 id）。 */
  "invalid_scope",
  /** 发生时刻不是有效 Date。 */
  "invalid_occurred_at",
] as const;
export type NotificationRejectionReason = (typeof NOTIFICATION_REJECTION_REASONS)[number];

export interface RejectedNotificationSeed {
  /** 在输入数组里的下标（0 基），便于调用方定位到具体行。 */
  readonly index: number;
  readonly reason: NotificationRejectionReason;
}

export type NotificationFactResult =
  | { readonly ok: true; readonly fact: NotificationFact }
  | { readonly ok: false; readonly reason: NotificationRejectionReason };

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * 单条种子的派生（纯）。校验顺序是**固定的**（先来源、再作用域、再事实字段），
 * 这样同一条坏数据无论从哪条路径进来都得到同一个拒绝原因 —— 拒绝原因本身也是可断言的事实。
 */
export function buildNotificationFact(
  scope: NotificationScope,
  seed: NotificationFactSeed,
): NotificationFactResult {
  const item = seed.item;
  const kind = typeof item?.kind === "string" ? item.kind : "";

  if (!(NOTIFICATION_SOURCE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: "unknown_source_kind" };
  }
  if (!DERIVABLE_SOURCE_KINDS.includes(kind as NotificationSourceKind)) {
    return { ok: false, reason: "source_kind_not_derivable" };
  }
  if (!isPositiveInteger(item.id)) return { ok: false, reason: "missing_source_id" };
  if (!isNotificationScope(scope)) return { ok: false, reason: "invalid_scope" };
  if (!isNotificationReasonCode(item.reason_code)) return { ok: false, reason: "unknown_reason_code" };
  if (!isNotificationSeverity(item.severity)) return { ok: false, reason: "unknown_severity" };

  const occurredAt = seed.occurred_at;
  if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
    return { ok: false, reason: "invalid_occurred_at" };
  }

  const sourceId = String(item.id);
  const windowStartMs = notificationWindowStartMs(
    occurredAt.getTime(),
    cooldownSecondsForReason(item.reason_code),
  );
  const detail = seed.detail_code ?? item.apply_error_code ?? null;

  return {
    ok: true,
    fact: {
      scope,
      source_kind: kind as NotificationSourceKind,
      source_id: sourceId,
      reason_code: item.reason_code,
      severity: item.severity,
      resource_type: RESOURCE_TYPE_BY_SOURCE[kind]!,
      resource_id: sourceId,
      resource_name: typeof item.name === "string" && item.name !== "" ? item.name : null,
      occurred_at: occurredAt.toISOString(),
      window_start: new Date(windowStartMs).toISOString(),
      dedupe_key: notificationDedupeKey({
        scope,
        source_kind: kind,
        source_id: sourceId,
        reason_code: item.reason_code,
        window_start_ms: windowStartMs,
      }),
      detail_code: detail,
    },
  };
}

export interface DeriveNotificationFactsInput {
  readonly scope: NotificationScope;
  readonly seeds: readonly NotificationFactSeed[];
}

export interface DeriveNotificationFactsOutput {
  /** 可投递的事实，**保持输入顺序**（attention 已经给出确定性排序；重排就是第二套顺序口径）。 */
  readonly facts: readonly NotificationFact[];
  readonly rejected: readonly RejectedNotificationSeed[];
}

/**
 * 批量派生（纯，DoD1）。同一输入两次调用逐字段一致（含 `dedupe_key`）。
 * 坏种子既不抛错也不静默丢弃 —— 进 `rejected`，调用方可计数并留痕（C3 的可见形式）。
 */
export function deriveNotificationFacts(
  input: DeriveNotificationFactsInput,
): DeriveNotificationFactsOutput {
  const facts: NotificationFact[] = [];
  const rejected: RejectedNotificationSeed[] = [];

  input.seeds.forEach((seed, index) => {
    const result = buildNotificationFact(input.scope, seed);
    if (result.ok) facts.push(result.fact);
    else rejected.push({ index, reason: result.reason });
  });

  return { facts, rejected };
}

/* ================================================================== */
/* 静默期键（Redis，经 tenant-scope 的 scopedKey）                      */
/* ================================================================== */

/**
 * 静默期键：`ws:<scope>:notification:cooldown:<source_kind>:<source_id>:<reason_code>`
 * （契约 F4.5）。
 *
 * 粒度是 **(scope, source_kind, source_id, reason_code, channel_kind)**，**不含时间窗** ——
 * 这正是与 `dedupe_key` 的分工：「离线」与「恢复」各有各的配额（F4.4），不同原因码
 * 互不吞掉；而同一原因码在静默期内只投递一次，靠的就是这个键存在。
 *
 * 落 Redis 而不是进程内 Map 的理由（F4.5）：api 与 worker 是**两个进程**，进程内 Map
 * 会让同一事件投递两次，且重启即失忆（Forwardx `hostStatusNotifier` 的反面教材）。
 *
 * scope 只取 `workspace_id`（platform → `ws:global`），与 tenant-scope 的归一化同源：
 * 平台级通知也不能落进某个租户的键域。
 *
 * 注：`redis.ts` 的 `RedisKeys` 登记表不在本 WP 的文件范围内（见契约写回），
 * 但键**仍**只经 `scopedKey` 生成 —— 业务代码手拼键名是这个仓库明令禁止的。
 */
export function notificationCooldownKey(
  // 结构性入参（不是 `Pick<NotificationFact, …>`）：投递层在 WP18.5 放宽成
  // `DeliverableNotification`（公告也要走同一条投递路径），而键**只**取这几个字段，
  // 所以把类型写成它真正用到的东西，既保住"同一份键形状"，也不强迫公告伪装成
  // `NotificationFact`。`NotificationFact` 结构上满足它，18.1/18.2 的调用点未变。
  fact: { scope: NotificationScope; source_kind: string; source_id: string; reason_code: string },
  /**
   * **渠道**。必填（不是可选、没有默认值）：见下面"键为什么必须带渠道"。
   * 写成必填是有意的 —— 漏传会编译不过，于是"只改了一半调用点"这种半修状态不存在。
   */
  channelKind: string,
): string {
  return scopedKey(
    scopeId(fact.scope.workspace_id),
    "notification",
    "cooldown",
    fact.source_kind,
    fact.source_id,
    fact.reason_code,
    channelKind,
  );
}

/*
 * ── 键为什么必须带渠道（WP18.5 修的真实缺陷）──
 *
 * F4.4 的措辞是"同一 `(scope, source_kind, source_id, reason_code)` 在静默期内只投递一次"，
 * 于是第一版把键落成了这四个字段。当时**只有一个渠道**（email），所以看不出来。
 * 18.3/18.4 把 webhook/telegram 加进注册表之后，这个键变成了一个会静默生效的缺陷：
 * 同一个事实循环到第 2 个渠道时，`SET NX` 已经被第 1 个渠道置位 ⇒ 第 2 个渠道拿到
 * `suppressed`（**不是失败**，账本里连一行都不会有）。实测（WP18.5 接线时用两个假渠道跑
 * `deliverNotificationFacts`）：`email:sent`、`telegram:suppressed`、账本 1 行。
 * 也就是说：**打开 webhook 会把 telegram 静音**，而账本看不出任何异常。
 *
 * 正确粒度是**每渠道**，理由全在契约里：
 *   · F3：每渠道各自一条投递记录，"不做「扇出 N 渠道后聚合出一个成功」的模糊判定"；
 *   · F6.5：免打扰是 `(用户 × 渠道 × 类别)` —— 用户靠**静音某个渠道**来少收通知；
 *     若静默期跨渠道生效，"给不给这个渠道发"就取决于渠道顺序，用户没有可用的旋钮；
 *   · F4.6：账本记的是"**这个渠道**给谁发过"，而目标本来就不一定同一个（邮件给运维、
 *     telegram 给绑定用户、webhook 给机器）。
 * 所以 F4.4 的"只投递一次"在**每渠道**这个粒度上成立：一次事件可以在多个渠道各投一次，
 * 但同一渠道在静默期内不会重复打扰。
 *
 * 升级影响（写清楚，不含糊）：键形状变了 ⇒ 部署前已存在的旧键不再匹配，最坏情况是升级后
 * 每个"事件 × 渠道"多投一次。当期是 v5 未发布形态，可接受；若要严格避免，可在升级窗口把
 * Redis 里的 `ws:*:notification:cooldown:*` 一并清掉。
 */
