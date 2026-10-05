/**
 * V5-WP18.2 —— 投递账本 + 静默期 + 渠道接口（契约 §F3 / §F4 / §F5 的最小实现面）。
 *
 * ── 这一层解决什么 ──
 * WP18.1 回答"有哪些事实值得投递"，本层回答"发出去没有、发给谁、发了几次"。三件事必须
 * 同时成立，缺一件就会出运维事故：
 *   ① **至少一次 + 幂等**（F4.1/F4.2）：api 与 worker 是**两个进程**，同一事实可能被两边
 *      同时派生 → 投递表唯一索引 `(dedupe_key, channel_kind)` 兜底，抢占失败就放弃投递；
 *   ② **静默期**（F4.4/F4.5）：同一 `(scope, source_kind, source_id, reason_code)` 在
 *      `NOTIFICATION_COOLDOWN_SECONDS` 内只投递一次，键落 **Redis** 且经 `scopedKey()`
 *      ——进程内 Map 会在两个进程里各发一次、重启即失忆（F4.5 明令禁止）；
 *   ③ **失败可见、主业务不受影响**（F4.6）：每次尝试留一行（目标/渠道/结果/错误摘要），
 *      任何异常都收敛成结果，**永不抛出**（`mail.ts` / `audit.ts` 同一取向）。
 *
 * ── 三条刻意的"不"──
 *  · **不重写发信**：email 渠道就是 `mail.ts` 的 `sendMail()` 本身。第二份 SMTP 实现意味着
 *    第二份注入防护（CRLF 剥离 / `^\.` 转义）与第二份凭据处理，迟早会分叉。
 *  · **不假装成功**：未配置的渠道（`not_configured`）、没解析到收件人（`rejected_target`）、
 *    本期没实现的渠道类型（`unsupported_channel`）都是**失败**，都落一行账。
 *    宁可显示"没发出去"，也不显示"已通知"（C3 / F3）。
 *  · **不把账本当真相**：这张表只描述"尝试投递"。删光它不影响任何判定（C2）；
 *    通知的真相永远在它派生的那张既有表上。
 *
 * ── 静默期降级（Lead 裁决 O2，2026-10-05）──
 * Redis 不可用时**仍然发送**，去重降级为进程内近似并在这行记录里标 `degraded`。
 * 理由：静默期是**抑制**机制，抑制失效时应当多报——漏报一次真实故障比重复报一次危险得多。
 * 注意这与 F4.5「禁止进程内 Map」不矛盾：禁的是**拿进程内 Map 当主去重层**；
 * 这里是 Redis 失效时的替代路径，且它**不假装自己是真相**（每个降级投递都留痕）。
 */
import { isMailConfigured, sendMail, type MailMessage, type MailResult } from "./mail.ts";
import type { NotificationFact, NotificationScope } from "./notification-facts.ts";
import { cooldownSecondsForReason, notificationCooldownKey } from "./notification-facts.ts";
import { createWebhookChannel } from "./notification-webhook.ts";

/* ================================================================== */
/* 渠道类型与结果（F3）                                                */
/* ================================================================== */

/** 渠道类型（封闭枚举；三个实现见 IMPLEMENTED_CHANNEL_KINDS）。 */
export const NOTIFICATION_CHANNEL_KINDS = ["email", "webhook", "telegram"] as const;
export type NotificationChannelKind = (typeof NOTIFICATION_CHANNEL_KINDS)[number];

/**
 * 本期**已实现契约**的渠道（`kind` 落在闭集之外的、或尚未实现的，一律拒绝并留失败记录
 * —— 不做"注册了就算支持"的假装）。清单随各 WP 的落地而增长：
 * WP18.2 email、WP18.3 webhook、WP18.4 telegram。
 */
export const IMPLEMENTED_CHANNEL_KINDS: readonly NotificationChannelKind[] = ["email", "webhook"];

/** 投递失败/拒绝原因（`ChannelResult.reason` 的闭集；对应契约 F3 的 `{sent, reason}`）。 */
export type NotificationFailureReason =
  | "not_configured"
  | "transport_error"
  | "rejected_target"
  | "unsupported_channel"
  /** 账本写不进去（DB 不可用）——不投递，见 {@link deliverNotificationFacts} 的顺序说明。 */
  | "ledger_unavailable";

export const NOTIFICATION_FAILURE_REASONS = [
  "not_configured",
  "transport_error",
  "rejected_target",
  "unsupported_channel",
  "ledger_unavailable",
] as const;

/** 渠道发送结果：沿用 `mail.ts` 的 `{sent, reason}` 语义，不引入第三态（F3）。 */
export interface ChannelResult {
  sent: boolean;
  reason?: NotificationFailureReason;
  /** 错误摘要（已截断、已剥换行；**绝不含凭据**）。 */
  detail?: string | null;
}

/** 渠道配置/目标的校验结论。 */
export type ChannelConfigCheck = { ok: true } | { ok: false; reason: NotificationFailureReason };

/** 渲染好的通知内容：纯文本（F10 —— 不做 HTML 邮件，那会多出一处要净化的地方）。 */
export interface RenderedNotification {
  subject: string;
  text: string;
}

/**
 * 渠道接口（契约 F3）。三个方法缺一不可：
 *  · `isConfigured` —— 未配置 = 不可用，不得假装成功；
 *  · `validateConfig` —— 目标地址形状校验（fail-closed：不确定就拒绝）；
 *  · `send` —— 只负责"发一次"，不做自己的账本（F3：只有一张投递表）。
 */
export interface NotificationChannel {
  readonly kind: NotificationChannelKind;
  isConfigured(scope: NotificationScope): boolean;
  validateConfig(input: { target: string | null | undefined }): ChannelConfigCheck;
  send(rendered: RenderedNotification, target: string): Promise<ChannelResult>;
  /**
   * 可选：把目标脱敏成**可落账本**的形态（WP18.3 追加）。
   *
   * 为什么需要它：账本是"给谁发过"的证据，而 webhook URL **本身就是凭据**
   * （Slack / Discord 的 hook URL 拿到就能发消息）。18.2 的 `target` 列注释已经写明
   * "webhook 的密钥不得出现在这里，URL 必须由渠道自己脱敏后回传"，但写这行的
   * `deliverNotificationFacts` 只有 `valid.join(",")` —— 渠道没有插手的余地。
   * 因此加一个**可选**钩子：渠道有它就用来写账本，没有就沿用原值
   * （email 的收件人地址是投递目标本身，F10 没把它列为凭据，行为不变）。
   */
  redactTarget?(target: string): string;
}

/* ================================================================== */
/* 渲染（F10：白名单插值 + 剥 CRLF + 截断）                             */
/* ================================================================== */

/**
 * 渲染长度上限。**每一处都防一件事**：
 *  · 正文上限 —— 一次故障可能带出几千字错误原文，邮件正文不是日志转储；
 *  · 插值上限 —— 节点名/转发名是用户可控字段，不截断就能用一封信把收件箱撑爆；
 *  · 主题上限 —— 主题过长会被 MTA 截断，截断点由我们决定比由中间设备决定好。
 */
export const NOTIFICATION_RENDER_LIMITS = Object.freeze({
  SUBJECT_MAX: 200,
  /** 单个插值字段（资源名 / 诊断码 / 时间）的最大长度。 */
  INTERPOLATED_MAX: 120,
  TEXT_MAX: 4_000,
});

/** 剥换行 + 折叠空白 + 截断。**换行是注入面**（邮件头的 CRLF 注入、日志的伪造行）。 */
export function sanitizeInterpolation(value: unknown, max: number = NOTIFICATION_RENDER_LIMITS.INTERPOLATED_MAX): string {
  const raw = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, Math.max(0, max));
}

/** 用户可读时间（UTC，ISO 8601）。不用本地时区：面板与邮件必须显示同一个时刻。 */
function renderTime(iso: string): string {
  return sanitizeInterpolation(iso);
}

/**
 * 纯函数渲染（无 IO，可离线断言）。只插值**白名单字段**（F10）：
 * 资源名、原因码、严重度、资源标识、诊断码、时间。
 *
 * 注意正文里**没有**"人类可读文案"：`attention.ts` 的取向是文案归前端
 * （`reasonAction`），后端再抄一份就会分叉。邮件里给的是**码**——码是可查、可对上工单的。
 */
export function renderNotificationText(fact: NotificationFact): RenderedNotification {
  const subject = sanitizeInterpolation(
    `[TuneX][${fact.severity}] ${fact.reason_code}`,
    NOTIFICATION_RENDER_LIMITS.SUBJECT_MAX,
  );

  const lines = [
    `TuneX 通知`,
    ``,
    `原因码：${sanitizeInterpolation(fact.reason_code)}`,
    `严重度：${sanitizeInterpolation(fact.severity)}`,
    `资源：${sanitizeInterpolation(fact.resource_type)} ${sanitizeInterpolation(fact.resource_id)}${
      fact.resource_name ? `（${sanitizeInterpolation(fact.resource_name)}）` : ""
    }`,
    `来源：${sanitizeInterpolation(fact.source_kind)} #${sanitizeInterpolation(fact.source_id)}`,
    `发生时间：${renderTime(fact.occurred_at)}`,
  ];
  if (fact.detail_code) lines.push(`诊断码：${sanitizeInterpolation(fact.detail_code)}`);
  lines.push(
    ``,
    `— 本邮件由 TuneX 控制面自动发出（投递明细见通知投递账本，不在正文里回显凭据）。`,
  );

  return { subject, text: lines.join("\n").slice(0, NOTIFICATION_RENDER_LIMITS.TEXT_MAX) };
}

/* ================================================================== */
/* email 渠道（复用 sendMail）                                         */
/* ================================================================== */

/** 收件人地址上限（RFC 5321 的 path 上限 256，取 254 与业界一致）。 */
export const EMAIL_TARGET_MAX = 254;

/**
 * 地址形状校验。刻意**不**追求 RFC 全量（那是无穷无尽的正则）：这里只回答
 * "能不能安全地交给 `sendMail`"——有且仅有一个 `@`、两侧非空、域名有点、无空格/控制字符。
 * 更严格的合法性由 MTA 判定，而**不安全**的形状（CRLF、尖括号、逗号）必须在本地拒掉：
 * 它们是 SMTP 头注入的原料（F10 只剥了 To/Subject 的 CRLF，本层不依赖那一层兜底）。
 */
export function isValidEmailTarget(target: string): boolean {
  if (target.length === 0 || target.length > EMAIL_TARGET_MAX) return false;
  if (/[\s\r\n<>,;:"\\]/.test(target)) return false;
  const at = target.indexOf("@");
  if (at <= 0 || at !== target.lastIndexOf("@")) return false;
  const domain = target.slice(at + 1);
  return domain.length > 0 && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

/** email 渠道的依赖（测试注入用；生产走默认值）。 */
export interface EmailChannelDeps {
  /** 默认 `mail.ts` 的 `sendMail`（**同一个实现**，不另写发信通道）。 */
  send?: (message: MailMessage) => Promise<MailResult>;
  /** 默认 `mail.ts` 的 `isMailConfigured`。 */
  configured?: () => boolean;
}

/**
 * email 渠道。`isConfigured` 是**实例级**判断（SMTP 五项凭据齐备），不看 scope：
 * SMTP 凭据今天来自 env，是全实例一份的部署配置；"按租户/按作用域的渠道凭据"
 * 是 F5 的 `notification_channel` 表，归 WP18.3/18.4/18.6，不在本期。
 */
export function createEmailChannel(deps: EmailChannelDeps = {}): NotificationChannel {
  const transport = deps.send ?? sendMail;
  const configured = deps.configured ?? isMailConfigured;

  return {
    kind: "email",
    isConfigured() {
      return configured();
    },
    validateConfig(input) {
      if (typeof input.target !== "string" || !isValidEmailTarget(input.target)) {
        return { ok: false, reason: "rejected_target" };
      }
      return { ok: true };
    },
    async send(rendered, target) {
      // `sendMail` 自己已经"永不抛出"（失败收敛成 {sent:false,reason}），这里再兜一层
      // try/catch 是因为**注入的**替身可能抛错，而本层对调用方承诺同样永不抛出。
      try {
        const result = await transport({ to: target, subject: rendered.subject, text: rendered.text });
        if (result.sent) return { sent: true };
        return {
          sent: false,
          reason: result.reason === "smtp_not_configured" ? "not_configured" : "transport_error",
          detail: result.reason ?? null,
        };
      } catch (err) {
        return { sent: false, reason: "transport_error", detail: errorSummary(err) };
      }
    },
  };
}

/**
 * 默认渠道注册表。**每一个渠道都有自己的闸门**（email = SMTP 凭据齐备、webhook = 部署开关），
 * 未配置的渠道会留下一条 `not_configured` 失败行、零出站 —— 可见，不假装成功。
 *
 * 接线（WP18.6）如果只想给"本安装真正打开的渠道"记账，应当显式传 `channels`，
 * 免得上线后账本被一堆 `not_configured` 行填满而失去"失败可见"的意义。
 */
export function defaultNotificationChannels(): NotificationChannel[] {
  return [createEmailChannel(), createWebhookChannel()];
}

/* ================================================================== */
/* 静默期（Redis，经 scopedKey）                                        */
/* ================================================================== */

/** 静默期存储：`SET NX EX` 语义。抛错 = 该存储不可用（由调用方决定降级，不在这里吞）。 */
export interface NotificationCooldownStore {
  acquire(key: string, ttlSeconds: number): Promise<boolean>;
}

/** 进程内降级表的容量上限：Redis 长时间不可用时不能变成内存泄漏。 */
export const DEGRADED_COOLDOWN_MAX_ENTRIES = 5_000;

/**
 * 进程内降级去重（**只在 Redis 不可用**时使用，O2 裁决）。
 *
 * 它**不是**第二个真相：进程重启即失忆、两个进程各有一份，所以每一次走它的投递都会在
 * 账本里标 `degraded=true`。容量上限 + 到期淘汰用插入顺序（Map 保序）扫一遍即可，
 * 不做定时器（定时器是新的生命周期负担，而这里只是"尽量少发一点"）。
 */
export function createDegradedCooldown(options: { now?: () => number } = {}): (key: string, ttlSeconds: number) => boolean {
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, number>();
  return (key, ttlSeconds) => {
    const t = now();
    const expiresAt = entries.get(key);
    if (expiresAt !== undefined && expiresAt > t) return false;
    // 淘汰：先清过期项；仍然超限就把最旧的丢掉（插入顺序 = 大致的时间顺序）。
    if (entries.size >= DEGRADED_COOLDOWN_MAX_ENTRIES) {
      for (const [k, exp] of entries) {
        if (exp <= t) entries.delete(k);
      }
      while (entries.size >= DEGRADED_COOLDOWN_MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    }
    entries.set(key, t + ttlSeconds * 1_000);
    return true;
  };
}

/** 默认静默期存储：平台 Redis。惰性 import 以避免单测拉起真实连接。 */
export function createRedisCooldownStore(): NotificationCooldownStore {
  return {
    async acquire(key, ttlSeconds) {
      const { redis } = await import("../redis.ts");
      const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");
      return result !== null;
    },
  };
}

/* ================================================================== */
/* 投递账本                                                            */
/* ================================================================== */

/**
 * 账本一行（写入形态）。字段与 `model NotificationDelivery` 一一对应；
 * 这里用普通对象而不是 Prisma 类型，是为了让本模块**不依赖生成的 client**
 * （与 `attention.ts` 的注入取向一致：只想要投递逻辑的调用方不该被 db 拽进模块图）。
 */
export interface NewNotificationDelivery {
  scope_kind: "platform" | "workspace";
  workspace_id: number | null;
  dedupe_key: string;
  source_kind: string;
  source_id: string;
  reason_code: string;
  severity: string;
  resource_type: string;
  resource_id: string;
  channel_kind: string;
  target: string;
  status: "sending";
  attempts: number;
  degraded: boolean;
  occurred_at: Date;
  window_start: Date;
}

export interface NotificationDeliveryPatch {
  status: "sent" | "failed";
  failure_reason: NotificationFailureReason | null;
  attempts: number;
  degraded: boolean;
  error: string | null;
}

/** 抢占结果：`duplicate` = 这一格（幂等键 × 渠道）已经被别的进程占了。 */
export type LedgerClaimResult = { ok: true; id: number } | { ok: false; duplicate: true };

export interface NotificationLedgerStore {
  claim(row: NewNotificationDelivery): Promise<LedgerClaimResult>;
  settle(id: number, patch: NotificationDeliveryPatch): Promise<void>;
}

/** 唯一约束冲突的鸭子类型判定（Prisma `P2002`）。 */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

/** 默认账本实现：平台 `db`（惰性 import）。 */
export function createPrismaLedgerStore(): NotificationLedgerStore {
  type PrismaLike = {
    notificationDelivery: {
      create(args: unknown): Promise<unknown>;
      update(args: unknown): Promise<unknown>;
    };
  };
  let dbPromise: Promise<PrismaLike> | undefined;
  const load = (): Promise<PrismaLike> => {
    dbPromise ??= import("../db.ts").then((m) => m.db as unknown as PrismaLike);
    return dbPromise;
  };

  return {
    async claim(row) {
      const db = await load();
      try {
        const created = (await db.notificationDelivery.create({ data: row })) as { id?: unknown };
        const id = Number(created?.id);
        if (!Number.isInteger(id) || id <= 0) throw new Error("notification ledger: created row without id");
        return { ok: true, id };
      } catch (err) {
        // 唯一索引命中 = 别的进程（或上一次派生）已经占了这一格：**正常路径**，不是错误。
        if (isUniqueViolation(err)) return { ok: false, duplicate: true };
        throw err;
      }
    },
    async settle(id, patch) {
      const db = await load();
      await db.notificationDelivery.update({ where: { id }, data: patch });
    },
  };
}

/* ================================================================== */
/* 有界重试（F4.3，沿用 mail-tokens.ts 的形态）                         */
/* ================================================================== */

/** 最大尝试次数（含首次）：不做无限重试（F4.3）。 */
export const NOTIFICATION_MAX_ATTEMPTS = 3;
/** 退避基数（ms）：第 N 次重试前等 `BASE * 3^(N-1) + 抖动`（50 → 150）。 */
export const NOTIFICATION_RETRY_BACKOFF_BASE_MS = 50;

/** 错误摘要上限：账本里留摘要，不留日志转储。 */
export const NOTIFICATION_ERROR_MAX = 500;

/** 把任意异常收敛成一行可落库的摘要（剥换行、截断）。 */
export function errorSummary(err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  return sanitizeInterpolation(message, NOTIFICATION_ERROR_MAX);
}

/** 第 `attempt`（从 1 开始）次失败后的等待毫秒数。抖动避免双方同时重试造成二次碰撞。 */
export function notificationRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const step = Math.max(1, Math.trunc(attempt));
  return NOTIFICATION_RETRY_BACKOFF_BASE_MS * 3 ** (step - 1) + Math.floor(random() * NOTIFICATION_RETRY_BACKOFF_BASE_MS);
}

/* ================================================================== */
/* 投递编排                                                            */
/* ================================================================== */

export type NotificationOutcomeStatus = "sent" | "failed" | "duplicate" | "suppressed";

export interface NotificationOutcome {
  dedupe_key: string;
  channel_kind: string;
  status: NotificationOutcomeStatus;
  /** `failed` 时的原因；其余状态为 null。 */
  reason: NotificationFailureReason | null;
  attempts: number;
  degraded: boolean;
}

/**
 * 收件人解析：**由调用方给出**，本层绝不猜。
 *
 * 为什么把它做成必需的注入项：任何"猜收件人"的默认实现都是数据事故
 * （把 A 租户的故障发给 B 的联系人、把未绑定 chat 的用户 id 当 chat id 用——
 * 后者是 WP18.4 明文禁止的）。返回空数组 = 没有收件人 = **不投递**并留一条
 * `rejected_target` 失败记录（fail-closed，可见）。
 */
export type NotificationTargetResolver = (
  fact: NotificationFact,
  channel: NotificationChannel,
) => readonly string[] | Promise<readonly string[]>;

export interface DeliverNotificationDeps {
  /** 渠道注册表（默认 `defaultNotificationChannels()`：email + webhook，各自有闸门）。 */
  channels?: readonly NotificationChannel[];
  resolveTargets: NotificationTargetResolver;
  ledger: NotificationLedgerStore;
  /** 默认平台 Redis；单测注入内存替身。 */
  cooldown?: NotificationCooldownStore;
  /** Redis 不可用时的进程内近似去重（默认 {@link createDegradedCooldown}）。 */
  degradedCooldown?: (key: string, ttlSeconds: number) => boolean;
  /** 等待实现（测试注入，避免真实 sleep）。 */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** 告警出口：任何异常都在这里留痕，**不抛出**。 */
  onWarn?: (message: string, err?: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const defaultWarn = (message: string, err?: unknown): void => {
  console.warn(`[notification] ${message}`, err instanceof Error ? err.message : (err ?? ""));
};

/** 落库的目标字段上限（`target` 列 = 512 字符）。 */
const TARGET_COLUMN_MAX = 512;

function scopeColumns(fact: NotificationFact): { scope_kind: "platform" | "workspace"; workspace_id: number | null } {
  return fact.scope.kind === "platform"
    ? { scope_kind: "platform", workspace_id: null }
    : { scope_kind: "workspace", workspace_id: fact.scope.workspace_id };
}

/**
 * 投递一批事实（契约 F4 的完整语义）。**永不抛出**：每一格（事实 × 渠道）都收敛成一个
 * {@link NotificationOutcome}，失败既不阻断调用方，也不伪装成成功。
 *
 * 单格的处理顺序是**刻意的**：
 *   1. 渠道类型不在闭集 / 本期未实现 → `unsupported_channel`（留账，不发）；
 *   2. 解析收件人，空或全部不合法 → `rejected_target`（留账，不发，**绝不猜**）；
 *   3. 渠道未配置 → `not_configured`（留账，不发）；
 *   4. **静默期**（Redis SET NX）→ 已投过 = `suppressed`，**不新增账本行**（DoD3：
 *      静默期内二次派生不新增投递行）。Redis 抛错 → 降级为进程内近似 + `degraded=true`，
 *      **照发**（O2 裁决）；
 *   5. **抢占账本行**（status=sending）→ 撞唯一索引 = `duplicate`，不发；
 *   6. 有界重试发送（≤3，仅对 `transport_error` 重试——`rejected_target` / `not_configured`
 *      重试一百次也是同一个结果）；
 *   7. 收敛该行（sent/failed + 原因 + 尝试次数 + degraded + 错误摘要）。
 *
 * 顺序里有两个容易做错的点，写明白：
 *  · **静默期在配置校验之后**：渠道没配好就消耗掉静默期，会让"把 SMTP 配好"之后的第一封信
 *    被自己吞掉（用户以为配好了却收不到）。
 *  · **账本抢占在发送之前**：先发后记会让并发下的第二封信无法被唯一索引拦住。
 *    代价是失败的行也占坑 —— 这是有意的：同一时间窗只投一次（F4.2 的幂等键含窗），
 *    要重投就得等下一个窗；否则就得原地改写已有行，而账本是证据，不该被改写。
 *  · **账本写不进去就不发**（`ledger_unavailable`）：账本是"谁收到过什么"的唯一记录，
 *    写不进去还发出去会产生不可审计的投递，且静默期键可能已置位导致这次投递永久丢失。
 */
export async function deliverNotificationFacts(
  facts: readonly NotificationFact[],
  deps: DeliverNotificationDeps,
): Promise<NotificationOutcome[]> {
  const channels = deps.channels ?? defaultNotificationChannels();
  const ledger = deps.ledger;
  const cooldown = deps.cooldown ?? createRedisCooldownStore();
  const degradedCooldown = deps.degradedCooldown ?? createDegradedCooldown();
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const warn = deps.onWarn ?? defaultWarn;
  const outcomes: NotificationOutcome[] = [];

  for (const fact of facts) {
    for (const channel of channels) {
      outcomes.push(await deliverOne(fact, channel));
    }
  }

  return outcomes;

  /* ---------------------------------------------------------------- */

  async function deliverOne(fact: NotificationFact, channel: NotificationChannel): Promise<NotificationOutcome> {
    const base = { dedupe_key: fact.dedupe_key, channel_kind: String(channel.kind) };
    const fail = (reason: NotificationFailureReason, attempts = 0, degraded = false): NotificationOutcome => ({
      ...base,
      status: "failed",
      reason,
      attempts,
      degraded,
    });

    try {
      if (
        !(NOTIFICATION_CHANNEL_KINDS as readonly string[]).includes(channel.kind) ||
        !IMPLEMENTED_CHANNEL_KINDS.includes(channel.kind)
      ) {
        await recordRejection(fact, channel, "unsupported_channel");
        return fail("unsupported_channel");
      }

      const resolved = await deps.resolveTargets(fact, channel);
      const targets = (Array.isArray(resolved) ? resolved : [])
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const valid = targets.filter((t) => channel.validateConfig({ target: t }).ok);
      if (valid.length === 0) {
        await recordRejection(fact, channel, "rejected_target");
        return fail("rejected_target");
      }

      if (!channel.isConfigured(fact.scope)) {
        await recordRejection(fact, channel, "not_configured");
        return fail("not_configured");
      }

      // ── 静默期 ──
      const cooldownKey = notificationCooldownKey(fact);
      const cooldownTtl = cooldownSecondsForReason(fact.reason_code);
      let degraded = false;
      let allowed: boolean;
      try {
        allowed = await cooldown.acquire(cooldownKey, cooldownTtl);
      } catch (err) {
        degraded = true;
        allowed = degradedCooldown(cooldownKey, cooldownTtl);
        warn(`静默期存储不可用，降级为进程内近似去重（degraded=true）：${cooldownKey}`, err);
      }
      if (!allowed) return { ...base, status: "suppressed", reason: null, attempts: 0, degraded };

      // ── 抢占账本行（唯一索引兜底）──
      // 账本落的是**脱敏后**的目标（渠道提供 `redactTarget` 时用它）：webhook URL 本身是凭据，
      // 而账本是可被运维检索的历史证据（F5 / 18.2 的 `target` 列注释）。
      const stored = channel.redactTarget ? valid.map((t) => channel.redactTarget!(t)) : valid;
      const targetField = stored.join(",").slice(0, TARGET_COLUMN_MAX);
      let claimed: LedgerClaimResult;
      try {
        claimed = await ledger.claim({
          ...scopeColumns(fact),
          dedupe_key: fact.dedupe_key,
          source_kind: fact.source_kind,
          source_id: fact.source_id,
          reason_code: fact.reason_code,
          severity: fact.severity,
          resource_type: fact.resource_type,
          resource_id: fact.resource_id,
          channel_kind: channel.kind,
          target: targetField,
          status: "sending",
          attempts: 0,
          degraded,
          occurred_at: new Date(fact.occurred_at),
          window_start: new Date(fact.window_start),
        });
      } catch (err) {
        warn(`投递账本不可用，放弃投递（不产生不可审计的投递）：${fact.dedupe_key}`, err);
        return fail("ledger_unavailable", 0, degraded);
      }
      if (!claimed.ok) {
        return { ...base, status: "duplicate", reason: null, attempts: 0, degraded };
      }

      // ── 发送（有界重试；**只重投失败的目标**，成功的不再发第二封）──
      const rendered = renderNotificationText(fact);
      let attempts = 0;
      let failureReason: NotificationFailureReason | null = null;
      let detail: string | null = null;
      let pending = [...valid];

      while (pending.length > 0 && attempts < NOTIFICATION_MAX_ATTEMPTS) {
        attempts++;
        const failedNow: string[] = [];
        let reason: NotificationFailureReason | null = null;
        let reasonDetail: string | null = null;
        for (const target of pending) {
          const result = await channel.send(rendered, target);
          if (result.sent) continue;
          failedNow.push(target);
          reason ??= result.reason ?? "transport_error";
          reasonDetail ??= result.detail ?? null;
        }
        pending = failedNow;
        failureReason = reason;
        detail = reasonDetail;
        if (pending.length === 0) break;
        // 只对**传输类**失败重试：`rejected_target` / `not_configured` 重试一百次也是同一个结果。
        if (reason !== "transport_error") break;
        if (attempts < NOTIFICATION_MAX_ATTEMPTS) await sleep(notificationRetryDelayMs(attempts, random));
      }

      const sent = pending.length === 0;
      try {
        await ledger.settle(claimed.id, {
          status: sent ? "sent" : "failed",
          failure_reason: sent ? null : (failureReason ?? "transport_error"),
          attempts,
          degraded,
          error: sent ? null : detail,
        });
      } catch (err) {
        // 已经发出去了，账本没收敛：留痕即可（这行会停在 sending，是"结算失败"的标记）。
        warn(`投递结果未落账（该行停留在 sending，可按它排查）：${fact.dedupe_key}`, err);
      }

      return sent
        ? { ...base, status: "sent", reason: null, attempts, degraded }
        : { ...base, status: "failed", reason: failureReason ?? "transport_error", attempts, degraded };
    } catch (err) {
      // 兜底：任何未预料的异常都不抛出（旁路永不拖挂主业务）。
      warn(`投递过程出现未预期异常：${fact.dedupe_key}`, err);
      return fail("transport_error", 0, false);
    }
  }

  /**
   * 拒绝也要留一行（F4.6 / DoD4："一律拒绝并留失败记录"）。
   * 抢占失败说明这一格已经有记录了，不必也不能再写一行。
   */
  async function recordRejection(
    fact: NotificationFact,
    channel: NotificationChannel,
    reason: NotificationFailureReason,
  ): Promise<void> {
    try {
      const claimed = await ledger.claim({
        ...scopeColumns(fact),
        dedupe_key: fact.dedupe_key,
        source_kind: fact.source_kind,
        source_id: fact.source_id,
        reason_code: fact.reason_code,
        severity: fact.severity,
        resource_type: fact.resource_type,
        resource_id: fact.resource_id,
        channel_kind: channel.kind,
        target: "",
        status: "sending",
        attempts: 0,
        degraded: false,
        occurred_at: new Date(fact.occurred_at),
        window_start: new Date(fact.window_start),
      });
      if (!claimed.ok) return;
      await ledger.settle(claimed.id, {
        status: "failed",
        failure_reason: reason,
        attempts: 0,
        degraded: false,
        error: null,
      });
    } catch (err) {
      warn(`拒绝记录未能落账：${fact.dedupe_key}`, err);
    }
  }
}
