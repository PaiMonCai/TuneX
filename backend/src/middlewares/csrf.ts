/**
 * CSRF 防护中间件 —— Origin 校验 + 自定义请求头凭证（SEC-02 收尾）
 *
 * ── 威胁模型 ──
 *  会话凭据是 HttpOnly Cookie（`access`，SameSite=Lax）。Lax 只在**顶层导航**放行
 *  跨站 GET，跨站 POST/fetch 不会带 cookie —— 这是第一道墙，但不是全部：
 *   · 顶层导航 GET 仍会带 cookie（a[href]、window.open、meta refresh），
 *     任何「GET 有副作用」的端点都暴露；
 *   · 同站子域 / 被控制的 http 邻居（无 Secure 时）可以伪造跨站请求；
 *   · Lax 是浏览器行为，不是服务器语义 —— 浏览器差异与未来的默认值变更都不该
 *     成为安全边界。
 *  因此服务端必须自己判定「这个变更请求是不是我站点发起的」。
 *
 * ── 判定逻辑（全部命中才放行）──
 *  仅拦截**非安全方法**（POST/PUT/PATCH/DELETE）+ **携带会话 cookie** 的请求：
 *   1. 自定义头凭证：存在 `X-Requested-With: XMLHttpRequest`、`X-TuneX-CSRF`
 *      或 `X-CSRF-Token`（任一非空值）即放行 —— 跨站表单无法设置自定义头，
 *      跨站 fetch 设置它会触发 CORS 预检（生产环境 CORS 关闭，预检必败）。
 *      这是「自定义头方案」的核心：头的存在性本身就是凭证，值无需与 cookie
 *      绑定（浏览器里的非同源页面读不到我们页面发出的头，更遑论伪造它）。
 *   2. 否则校验 Origin / Referer：必须存在且 host 与请求的 Host 一致。
 *      缺失 Origin（同站表单的旧浏览器、curl）时拒绝 —— 浏览器**总会**对跨站
 *      POST 表单和跨站 fetch 发送 Origin，缺失即视为非浏览器/跨站来源。
 *
 * ── 豁免（CSRF_EXEMPT_PATTERNS）──
 *  非浏览器客户端（支付回调、agent 回传、curl 订阅拉取）没有 Origin，
 *  也不携带会话 cookie —— 它们走自己的凭据（签名 / subscription_key）。
 *  为兼容「恰好带着 cookie 的 curl」，这些路径直接豁免。
 *
 *  Bearer API Key 通道（无 cookie）不受影响：CSRF 利用的是浏览器自动带
 *  cookie 的行为，Authorization 头不会被浏览器自动附加。
 */
import { createMiddleware } from "hono/factory";
import { env } from "../env.ts";
import type { AppVariables } from "./auth.ts";

/**
 * 前端（web/src/lib/api.ts）在写操作上携带的 CSRF 令牌头名。
 * 自定义头：跨站请求不触发 CORS 预检就设不上来。本模块只校验其**存在性**
 * （值无需与任何服务端状态绑定）——「令牌必须与 session 绑定」那套
 * Redis 会话令牌方案已证明过度设计并移除，见 PLAN.md SEC-02 的裁决记录。
 */
export const CSRF_TOKEN_HEADER = "x-csrf-token";
/** 非安全方法集合（这些才可能有副作用）。 */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 豁免路径：非浏览器客户端（支付回调 / agent 观测回传 / 订阅拉取）。
 * 它们不带 Origin、凭据也不在 cookie 里，CSRF 模型不适用。
 */
export const CSRF_EXEMPT_PATTERNS: RegExp[] = [
  /^\/api\/pay\/[^/]+\/callback$/,
  /^\/api\/tunnel\/observer$/,
  /^\/api\/tunnel\/traffic$/,
  /^\/api\/tunnel\/subscription$/,
  // WP7：节点状态上报/快照端点。与上四者同类：非浏览器客户端，不携带会话
  // cookie，凭据走 Authorization: Bearer（不会被浏览器自动附加）。
  /^\/api\/internal\/.*/,
];

export function isCsrfExempt(path: string): boolean {
  return CSRF_EXEMPT_PATTERNS.some((re) => re.test(path));
}

/** 判定结果（纯函数，可离线单测）。 */
export interface CsrfDecision {
  allowed: boolean;
  /** 放行/拒绝原因（用于日志与测试断言）。 */
  reason:
    | "safe-method"
    | "no-cookie"
    | "exempt"
    | "custom-header"
    | "origin-match"
    | "referer-match"
    | "no-origin"
    | "origin-mismatch";
}

/** 从 URL 字符串提取 host（小写、含端口）。非法输入返回 null。 */
function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 纯判定：给定请求方法与头部，决定是否放行。
 *
 * @param input.method  HTTP 方法（大写）
 * @param input.hasSessionCookie  是否携带会话 cookie（任何值都算携带）
 * @param input.path    请求路径（用于豁免判定）
 * @param input.host    请求的 Host 头（小写）
 * @param input.origin  Origin 头（可能缺失）
 * @param input.referer Referer 头（Origin 缺失时的兜底）
 * @param input.xrw     X-Requested-With 头的值
 * @param input.xcsrf   X-TuneX-CSRF 头的值（显式凭证，前端可选）
 * @param input.xcsrfToken X-CSRF-Token 头的值（前端写操作的标准凭证头）
 */
export function checkCsrf(input: {
  method: string;
  hasSessionCookie: boolean;
  path: string;
  host: string;
  origin?: string | null;
  referer?: string | null;
  xrw?: string | null;
  xcsrf?: string | null;
  xcsrfToken?: string | null;
}): CsrfDecision {
  if (!MUTATING_METHODS.has(input.method.toUpperCase())) {
    return { allowed: true, reason: "safe-method" };
  }
  if (!input.hasSessionCookie) return { allowed: true, reason: "no-cookie" };
  if (isCsrfExempt(input.path)) return { allowed: true, reason: "exempt" };

  // 自定义头凭证：跨站来源无法在不触发 CORS 预检的情况下设置它。
  // X-Requested-With / X-TuneX-CSRF / X-CSRF-Token 三者任一非空即可。
  const xrw = (input.xrw ?? "").toLowerCase();
  if (xrw === "xmlhttprequest" || (input.xcsrf ?? "").length > 0 || (input.xcsrfToken ?? "").length > 0) {
    return { allowed: true, reason: "custom-header" };
  }

  const host = input.host.toLowerCase();
  const originHost = hostOf(input.origin);
  if (originHost) {
    return originHost === host
      ? { allowed: true, reason: "origin-match" }
      : { allowed: false, reason: "origin-mismatch" };
  }
  // Origin 缺失 → 看 Referer（部分同站导航/旧浏览器的 POST 不带 Origin）
  const refererHost = hostOf(input.referer);
  if (refererHost && refererHost === host) return { allowed: true, reason: "referer-match" };

  // Origin 与 Referer 都缺失或都不匹配：拒绝。浏览器跨站请求必有其一。
  return { allowed: false, reason: "no-origin" };
}

/**
 * CSRF 防护中间件。挂在 authRequired 之前、IP 提取之后：
 * 它只看 cookie 是否存在，不需要（也不能）等认证结果 —— 在被认证拒绝之前
 * 就先挡住跨站请求，避免「未认证的 CSRF 探测」产生任何副作用。
 */
export function createCsrfMiddleware() {
  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    const cookieHeader = c.req.header("cookie") ?? "";
    const hasSessionCookie = new RegExp(`(?:^|;\\s*)${env.cookieName}=`).test(cookieHeader);
    const decision = checkCsrf({
      method: c.req.method,
      hasSessionCookie,
      path: c.req.path,
      host: c.req.header("host") ?? "",
      origin: c.req.header("origin"),
      referer: c.req.header("referer"),
      xrw: c.req.header("x-requested-with"),
      xcsrf: c.req.header("x-tunex-csrf"),
      xcsrfToken: c.req.header(CSRF_TOKEN_HEADER),
    });
    if (!decision.allowed) {
      return c.json(
        { error: "跨站请求被拒绝", code: "CSRF_REJECTED", reason: decision.reason },
        403,
      );
    }
    return await next();
  });
}
