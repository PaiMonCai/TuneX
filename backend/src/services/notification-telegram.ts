/**
 * V5-WP18.4 —— Telegram 渠道 + `tg_id` 绑定语义（契约 F2-N6 之外的渠道层：F3 / F5 / F6.6）。
 *
 * ── 这个模块回答三个问题，每个都有一条"绝不越界"的线 ──
 *  ① **发给谁**：收件人**只能**来自 `User.tg_id`，未绑定 = **不投递**。
 *     绝不把 `User.id`（或邮箱、或用户名）猜成 chat id —— {@link resolveTelegramChatTarget} 的入参类型里
 *     **没有** user id，"猜用户"在类型层面就写不出来。
 *  ② **用谁的凭据**：bot token 只以密文（`secret_enc`）存在，运行期经
 *     `notification-seal.ts` 的新 HKDF 域解封；**解不开 = `secret_unreadable`**（不是 not_configured，
 *     也不是静默不发）。token 不进目标、不进账本、不进错误摘要 —— 出站 URL 里带 token 是 Telegram
 *     协议的要求，因此错误摘要必须**主动脱敏**（{@link redactTelegramToken}）。
 *  ③ **怎么渲染**：`parse_mode=HTML` 就必须 `escapeHtml`（F6.6），并且截断时**不能切断实体**
 *     （`&amp;` 被截成 `&am` 会被 Telegram 直接拒收）。
 *
 * ── `tg_id` 绑定语义（本期冻结，写进契约交付记录）──
 *   · 判定顺序：trim → 空 = `unbound`；形状非法 = `invalid_tg_id`；通过 = 一个 chat id。
 *   · **未绑定/非法一律不投递**，并留一条 `rejected_target` 失败记录（可见，不是静默丢弃）。
 *   · **已知残余风险（写明白，不含糊）**：`User.tg_id` 今天是一个**用户可自由编辑、且没有任何
 *     验证**的字段（`routes/settings.ts` 的 `PATCH /profile`）。所以"已绑定"只等于"填了一个形状合法
 *     的 chat id"，**不等于**"这个 chat 属于这个用户"。本期因此：
 *       (a) telegram 渠道**部署级开关默认关**（与 Lead 在 O4 给的取向一致：新增的出站通道默认关）；
 *       (b) 收件人由调用方按 scope 解析（18.2 的 `NotificationTargetResolver` 契约），
 *           本模块不做"给所有用户发"这种默认；
 *       (c) **真正的绑定验证需要入站 bot 握手**（`/start` 回传一次性码），而契约 §9.4 明确
 *           本期不做入站 bot —— 缺口记录在此，**不假装验证过**。
 *
 * ── 明确不做 ──
 * 不做入站（长轮询/webhook/命令菜单）、不做 vendor 侧的 429 精细退避（有界重试交回 F4.3）、
 * 不做按租户的自带 bot（O6 未拍板）、不做 Telegram 侧的消息编辑/删除。
 */
import type { NotificationScope } from "./notification-facts.ts";
import type {
  ChannelConfigCheck,
  ChannelResult,
  NotificationChannel,
  RenderedNotification,
} from "./notification-delivery.ts";
import {
  NOTIFICATION_SECRET_PLAINTEXT_MAX,
  notificationSealMasterSecret,
  unsealNotificationSecret,
} from "./notification-seal.ts";

/* ================================================================== */
/* 常量与开关                                                          */
/* ================================================================== */

/**
 * Bot API 端点。**硬编码常量**（不是用户可填的 URL）：
 * Telegram 渠道没有 SSRF 面 —— 目标是 chat id，不是地址。也因此这里用 `fetch` 是安全的，
 * 与 webhook 渠道刻意手写传输（F9.4 要求把连接固定到已校验 IP）不是同一个问题。
 */
export const TELEGRAM_API_BASE = "https://api.telegram.org";
/** `sendMessage` 的正文上限（Telegram 硬限制 4096 字符）。 */
export const TELEGRAM_MESSAGE_MAX = 4_096;
/** 单次出站超时（ms）。Telegram 的分方法超时先例见契约 §2.6（15s/40s），这里取 10s 与联邦握手同口径。 */
export const TELEGRAM_TIMEOUT_MS = 10_000;
/** 错误/描述摘要上限（落账本 `error` 列）。 */
export const TELEGRAM_DETAIL_MAX = 300;
/** 响应体读取上限（端点固定为 api.telegram.org，响应由 Telegram 控制；仍设上限以免替身/中间层喂大包）。 */
export const TELEGRAM_RESPONSE_MAX = 8_192;

/** 部署级开关的 env 名（默认关）。 */
export const TELEGRAM_ENABLED_ENV = "TUNEX_NOTIFICATION_TELEGRAM_ENABLED";

/**
 * bot token 的形状：`<bot_id>:<secret>`，`bot_id` 是 5–15 位十进制，secret 是 25–64 位
 * base64url 字母表。**只判形状**（形状错 = 一定是坏的），不判真伪（那要一次 API 调用）。
 */
export const TELEGRAM_BOT_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{25,64}$/;

/**
 * chat id 的形状：**整数**（私聊是正数，群/频道是负数），最多 19 位。
 * 严格只认十进制整数是刻意的：`@channel_name` 也是合法 chat id，但那要求"用户名 → chat"这一层
 * 解析（又一次网络往返 + 又一次"猜"），本期不收。
 */
export const TELEGRAM_CHAT_ID_RE = /^-?\d{1,19}$/;

/** 开关判定（纯函数，env 注入以便单测；默认读 `process.env`）。 */
export function isTelegramChannelEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[TELEGRAM_ENABLED_ENV] === "true";
}

/** bot token 形状校验（trim 后）。 */
export function isValidTelegramBotToken(token: unknown): boolean {
  return typeof token === "string" && TELEGRAM_BOT_TOKEN_RE.test(token.trim());
}

/** chat id 形状校验（trim 后）。 */
export function isValidTelegramChatId(value: unknown): boolean {
  return typeof value === "string" && TELEGRAM_CHAT_ID_RE.test(value.trim());
}

/* ================================================================== */
/* tg_id 绑定语义                                                      */
/* ================================================================== */

/** 绑定判定结果（闭集；`unbound` 与 `invalid_tg_id` 分开，因为运维动作不同）。 */
export type TelegramBindingResult =
  | { readonly ok: true; readonly chat_id: string }
  | { readonly ok: false; readonly reason: "unbound" | "invalid_tg_id" };

/**
 * 把一条"用户 × tg_id"映射成可投递的 chat id（纯函数）。
 *
 * **注意入参只有 `tg_id`**：不接受 user id / email / nickname，因此"未绑定时拿用户 id 顶上"
 * 这种写法在类型层面不存在。这就是契约要求的「未绑定 = 不投递，绝不猜用户」的可执行形式。
 */
export function resolveTelegramChatTarget(recipient: {
  readonly tg_id?: string | null;
}): TelegramBindingResult {
  const raw = recipient?.tg_id;
  if (raw === null || raw === undefined) return { ok: false, reason: "unbound" };
  if (typeof raw !== "string") return { ok: false, reason: "invalid_tg_id" };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "unbound" };
  if (!TELEGRAM_CHAT_ID_RE.test(trimmed)) return { ok: false, reason: "invalid_tg_id" };
  return { ok: true, chat_id: trimmed };
}

export interface TelegramRecipientResolution {
  /** 可投递的 chat id（**去重、保持输入顺序**）。 */
  readonly chat_ids: readonly string[];
  /** 被跳过的收件人（下标 + 原因）：可见地"没发给谁"，而不是静默丢掉。 */
  readonly skipped: readonly { readonly index: number; readonly reason: "unbound" | "invalid_tg_id" }[];
}

/**
 * 批量解析（纯函数，供调用方构造 `NotificationTargetResolver`）。
 * 同一个 chat 被两个用户绑定 → 只投递一次（去重，避免同一条通知发两遍）。
 */
export function resolveTelegramChatTargets(
  recipients: readonly { readonly tg_id?: string | null }[],
): TelegramRecipientResolution {
  const chat_ids: string[] = [];
  const seen = new Set<string>();
  const skipped: { index: number; reason: "unbound" | "invalid_tg_id" }[] = [];
  recipients.forEach((recipient, index) => {
    const result = resolveTelegramChatTarget(recipient);
    if (!result.ok) {
      skipped.push({ index, reason: result.reason });
      return;
    }
    if (seen.has(result.chat_id)) return;
    seen.add(result.chat_id);
    chat_ids.push(result.chat_id);
  });
  return { chat_ids, skipped };
}

/* ================================================================== */
/* 渠道配置行（F5 的 notification_channel）                             */
/* ================================================================== */

/**
 * F5 的 `notification_channel` 行里，telegram 渠道用得上的三个字段。
 *
 * 表本身由 WP18.6 之前的接线提交落地（见契约 §12.2-D4：schema.prisma 当前被并行改动占用，
 * 硬加会把别人的枚举值扫进本次提交）。这里定义**行 → 渠道依赖**的纯映射，
 * 让 DB 层只需要做 `SELECT`，也让"哪些行算可用"这件事有唯一答案、可离线断言。
 */
export function telegramSealedTokenFromRow(
  row: { readonly kind?: unknown; readonly enabled?: unknown; readonly secret_enc?: unknown } | null | undefined,
): string | null {
  if (!row || typeof row !== "object") return null;
  // kind 不匹配 = 不是这条渠道的配置：不猜（fail-closed）。
  if (row.kind !== "telegram") return null;
  if (row.enabled === false) return null;
  const sealed = row.secret_enc;
  if (typeof sealed !== "string" || sealed.trim() === "") return null;
  return sealed;
}

/* ================================================================== */
/* 渲染（F6.6：HTML 必须转义；截断不得切断实体）                         */
/* ================================================================== */

/** HTML 转义（`parse_mode=HTML` 只要求这三个字符；`&` 必须第一个换，否则会二次转义）。 */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 截断（按**字符数**，Telegram 的上限口径）。**不切断实体**：
 * `Page &amp; Co` 被切在 `&am` 处会让 Telegram 返回 400，而那是一条"我们渲染坏了"的假故障。
 */
export function truncateTelegramHtml(escaped: string, max: number = TELEGRAM_MESSAGE_MAX): string {
  if (escaped.length <= max) return escaped;
  let cut = escaped.slice(0, max);
  const open = cut.lastIndexOf("&");
  if (open !== -1 && !cut.slice(open).includes(";")) cut = cut.slice(0, open);
  return cut;
}

/**
 * 渲染成 Telegram 消息体：首行是主题（加粗），空行后是 F10 的纯文本正文。
 * 主题与正文都来自同一份渲染结果，不新增任何事实（C1）。
 */
export function renderTelegramMessage(rendered: RenderedNotification): string {
  const subject = escapeTelegramHtml(rendered.subject);
  const body = escapeTelegramHtml(rendered.text);
  return truncateTelegramHtml(`<b>${subject}</b>\n\n${body}`);
}

/* ================================================================== */
/* 出站（固定端点 + 注入传输）                                          */
/* ================================================================== */

export interface TelegramTransportRequest {
  readonly url: string;
  readonly body: string;
  readonly timeoutMs: number;
}

export interface TelegramTransportResponse {
  readonly status: number;
  readonly json: unknown;
}

export type TelegramTransport = (request: TelegramTransportRequest) => Promise<TelegramTransportResponse>;

/** 出站 URL（token 在路径里 —— Telegram 的协议如此；**绝不打日志、绝不出现在错误摘要里**）。 */
export function buildTelegramSendUrl(apiBase: string, token: string): string {
  return `${apiBase.replace(/\/+$/, "")}/bot${token}/sendMessage`;
}

/** 摘要的公共清洗：剥换行 + 截断。 */
function collapseDetail(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").trim().slice(0, TELEGRAM_DETAIL_MAX);
}

/**
 * 摘要脱敏：把可能出现的 token（原形与 URL 编码形态）换成 `***`。
 *
 * 为什么必须做：`fetch` 抛出的错误消息/Telegram 的 description 都可能带上完整 URL，
 * 而 `detail` 会落进投递账本的 `error` 列。凭据**任何形态**都不该落在那里（F5）。
 */
export function redactTelegramToken(message: unknown, token?: string | null): string {
  const text = message instanceof Error ? message.message : typeof message === "string" ? message : String(message ?? "");
  let out = text;
  if (typeof token === "string" && token !== "") {
    out = out.split(token).join("***");
    try {
      const encoded = encodeURIComponent(token);
      if (encoded !== token) out = out.split(encoded).join("***");
    } catch {
      /* 脏 token 不该让脱敏本身失败。 */
    }
  }
  return collapseDetail(out);
}

/**
 * 默认传输：`fetch` + `redirect: "manual"`（固定端点；3xx 一律当传输失败，不跟随）。
 * 与 webhook 的区别是有意的：这里的目标地址是常量，没有"用户指定 URL"这回事。
 */
export function createFetchTelegramTransport(): TelegramTransport {
  return async (request) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), request.timeoutMs);
    try {
      const res = await fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: request.body,
        signal: ctrl.signal,
        redirect: "manual",
      });
      const text = (await res.text()).slice(0, TELEGRAM_RESPONSE_MAX);
      let json: unknown = null;
      if (text !== "") {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  };
}

/* ================================================================== */
/* 渠道实现                                                            */
/* ================================================================== */

export interface TelegramChannelDeps {
  /** 部署级开关；默认 {@link isTelegramChannelEnabled}（读 env，**默认关**）。 */
  enabled?: () => boolean;
  /** 密文 bot token（`secret_enc`）；默认 null = 未配置。生产由 F5 的行经 {@link telegramSealedTokenFromRow} 给出。 */
  sealedToken?: () => string | null;
  /** 解封主密钥（AUTH_SECRET）；默认读 env。**明文 token 绝不作为依赖传进来**。 */
  masterSecret?: () => string;
  /** 出站传输；默认 {@link createFetchTelegramTransport}（单测注入替身以断言"零出站"/"token 不泄漏"）。 */
  transport?: TelegramTransport;
  /** Bot API 端点（只为测试替身/自建代理留口；默认 {@link TELEGRAM_API_BASE}）。 */
  apiBase?: string;
  timeoutMs?: number;
}

/**
 * telegram 渠道。
 *
 * `isConfigured` 的判据是「开关开着 **且** 有密文」——注意它**不试解封**：
 * 密文存在但解不开，是 `secret_unreadable`（可排查的坏数据），不是 `not_configured`（没配）。
 * 把两者混在一起，就等于用"看起来没配"掩盖一次密钥轮换事故（C3 禁止的降级）。
 */
export function createTelegramChannel(deps: TelegramChannelDeps = {}): NotificationChannel {
  const enabled = deps.enabled ?? (() => isTelegramChannelEnabled());
  const sealedToken = deps.sealedToken ?? (() => null);
  const masterSecret = deps.masterSecret ?? (() => notificationSealMasterSecret());
  const transport = deps.transport ?? createFetchTelegramTransport();
  const apiBase = deps.apiBase ?? TELEGRAM_API_BASE;
  const timeoutMs = deps.timeoutMs ?? TELEGRAM_TIMEOUT_MS;

  return {
    kind: "telegram",
    isConfigured(_scope: NotificationScope) {
      // 本期只有平台级渠道（O6 冻结方向），因此 token 是实例级一份，不看 scope。
      return enabled() && sealedToken() !== null;
    },
    validateConfig(input): ChannelConfigCheck {
      return isValidTelegramChatId(input.target) ? { ok: true } : { ok: false, reason: "rejected_target" };
    },
    async send(rendered, target): Promise<ChannelResult> {
      if (!isValidTelegramChatId(target)) {
        return { sent: false, reason: "rejected_target", detail: "telegram target is not a chat id" };
      }

      // ── 凭据：密文 → 明文，只在这一步出现；失败一律可见失败，绝不静默降级 ──
      const sealed = sealedToken();
      if (sealed === null) return { sent: false, reason: "not_configured" };
      let token: string;
      try {
        token = unsealNotificationSecret(sealed, masterSecret());
      } catch (err) {
        return { sent: false, reason: "secret_unreadable", detail: redactTelegramToken(err, sealed) };
      }
      if (!isValidTelegramBotToken(token)) {
        // 形状不对 = 存进去的东西不是 bot token（配置事故）：仍然归"凭据不可用"，
        // 而不是"目标被拒"——否则运维会去查 chat id 而不是去查 token。
        return { sent: false, reason: "secret_unreadable", detail: "telegram bot token has invalid shape" };
      }

      const body = JSON.stringify({
        // chat_id 用**字符串**下发：chat id 是 64 位整数，走 JSON number 会在大 id 上丢精度。
        chat_id: target.trim(),
        text: renderTelegramMessage(rendered),
        parse_mode: "HTML",
      });

      let response: TelegramTransportResponse;
      try {
        response = await transport({ url: buildTelegramSendUrl(apiBase, token), body, timeoutMs });
      } catch (err) {
        return { sent: false, reason: "transport_error", detail: redactTelegramToken(err, token) };
      }

      // 3xx：固定端点本不该重定向（`redirect: "manual"` 也不跟随）；当传输失败处理。
      if (response.status >= 300 && response.status < 400) {
        return { sent: false, reason: "transport_error", detail: `telegram http_${response.status}` };
      }

      const payload = (typeof response.json === "object" && response.json !== null ? response.json : {}) as {
        ok?: unknown;
        error_code?: unknown;
        description?: unknown;
      };
      if (payload.ok === true) return { sent: true };

      const description = typeof payload.description === "string" ? payload.description : "";
      const errorCode = typeof payload.error_code === "number" ? payload.error_code : null;
      const detail = redactTelegramToken(`telegram error_code=${errorCode ?? "unknown"} ${description}`, token);

      // 400 / 403 是 Telegram 对"这次请求本身不可接受"的判定（chat not found、bot 被拉黑、
      // 不是群成员…）：重试同样的次数也是同样的结果 ⇒ 归 rejected_target（F4.3 只重试 transport_error）。
      if (errorCode === 400 || errorCode === 403) {
        return { sent: false, reason: "rejected_target", detail };
      }
      return { sent: false, reason: "transport_error", detail };
    },
    /**
     * 账本里只落 chat id；**形状不对的目标一律不落原文**（防的是调用方把 URL/token 误当目标传进来，
     * 那会把凭据写进账本）。chat id 与邮箱地址同口径：它本身就是投递目标，不是凭据。
     */
    redactTarget(target: string) {
      return isValidTelegramChatId(target) ? target.trim() : "***";
    },
  };
}

/** token 明文长度上限的再导出一份，避免接线层各自写一个数字（与 seal 层同源）。 */
export { NOTIFICATION_SECRET_PLAINTEXT_MAX as TELEGRAM_TOKEN_PLAINTEXT_MAX };
