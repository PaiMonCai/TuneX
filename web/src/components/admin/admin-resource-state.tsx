import Link from "next/link";
import { cookies } from "next/headers";
import { Ban, KeyRound, RefreshCw, ServerCrash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "@/lib/api/core";
import { currentLocale } from "@/components/console/session";

/**
 * 管理端**取数失败与「真的没有数据」必须可分**（R2-C / D5）。
 *
 * 修复前的写法是把任何异常 `catch` 成空列表（`{ data: [], total: 0 }`）或
 * `{ type: "none" }`：
 *
 * - 403「你的后台角色没有这个资源键」→ 页面显示「暂无数据」；
 * - 503/取不到 → 同样显示「暂无数据」；
 * - license 取不到 → 显示「未授权（none）」—— 那是**另一条**结论，不只是缺数据。
 *
 * 现在失败不再被折叠：`loadAdminResource` 保留失败原因，页面渲染一个**受控提示卡**
 * （说明是哪一次读取失败、后端为什么拒绝、找谁解决、去哪里重试），而不是让表格空着
 * 冒充「这里本来就没有东西」。只有读取成功且真的为空时，才会走到 manager 自己的空态。
 *
 * 纪律：本模块不判断「这个账号能不能访问」—— 结论来自后端 URL/状态码；它也不吞错误
 * （`message`/状态原样展示，`console.error` 交给调用方）。
 */

export type AdminLoadFailureKind = "denied" | "unauthenticated" | "error";

export interface AdminLoadFailure {
  kind: AdminLoadFailureKind;
  /** 真实 HTTP 状态；网络层失败时是 `null`（不填 500）。 */
  status: number | null;
  /** 后端下发的消息（能拿到才展示）。 */
  message: string | null;
  /** 失败的是哪一次读取（人话，例如「节点组列表」），避免把原因归错对象。 */
  what: string;
}

export type AdminResourceLoad<T> = { ok: true; data: T } | { ok: false; failure: AdminLoadFailure };

/** 异常 → 失败事实。401/403 保留其真实含义，其余一律「取不到」。 */
export function classifyAdminLoadError(error: unknown, what: string): AdminLoadFailure {
  if (error instanceof ApiError) {
    const message = typeof error.message === "string" && error.message.trim() !== "" ? error.message : null;
    if (error.status === 403) return { kind: "denied", status: 403, message, what };
    if (error.status === 401) return { kind: "unauthenticated", status: 401, message, what };
    return { kind: "error", status: Number.isInteger(error.status) ? error.status : null, message, what };
  }
  const message = error instanceof Error && error.message.trim() !== "" ? error.message : null;
  return { kind: "error", status: null, message, what };
}

/** 解析取数结果：成功给数据，失败给可解释的失败事实。 */
export async function loadAdminResource<T>(what: string, promise: Promise<T>): Promise<AdminResourceLoad<T>> {
  try {
    return { ok: true, data: await promise };
  } catch (error) {
    console.error(`[tunex] admin resource load failed: ${what}`, error);
    return { ok: false, failure: classifyAdminLoadError(error, what) };
  }
}

const COPY = {
  zh: {
    deniedTitle: "后端拒绝了这次读取：你的后台角色没有这个资源的权限",
    deniedReason:
      "平台后台按资源键授权（只读与可写也是两种权限），所以「有后台角色」不等于每一个列表都能看。这一次不是「暂无数据」，而是这个账号没有读权限。",
    unauthenticatedTitle: "登录状态已失效",
    unauthenticatedReason: "服务端认为这次请求没有有效会话（401），因此没有返回任何数据。",
    errorTitle: "这次读取没有成功（这不等于「没有数据」）",
    errorReason:
      "请求没有拿到可用结果。页面不会用空列表来代替，否则「取不到」会被当成「本来就没有」。",
    what: (what: string) => `失败的读取：${what}`,
    status: (status: number) => `服务端状态：${status}`,
    message: (message: string) => `服务端消息：${message}`,
    deniedHint: "请联系平台超级管理员，请其确认你的后台角色是否包含这个资源键的读权限。",
    unauthenticatedHint: "重新登录后回到这个地址即可。",
    errorHint: "可以点「重新加载」再试一次；若持续失败，请把上面的事实（资源名与状态码）提供给管理员。",
    retry: "重新加载",
    back: "返回前台",
  },
  en: {
    deniedTitle: "The backend refused this read: your admin role lacks this resource",
    deniedReason:
      "Admin console permissions are granted per resource key (read and write are different levels), so holding an admin role does not mean every list opens. This is **not** \u201cno data\u201d \u2014 this account has no read permission.",
    unauthenticatedTitle: "Your session has expired",
    unauthenticatedReason: "The server saw no valid session for this request (401), so no data was returned.",
    errorTitle: "This read did not succeed (which is not \u201cthere is no data\u201d)",
    errorReason:
      "The request produced no usable result. The page will not substitute an empty list, because \u201ccould not read\u201d would then be read as \u201cthere is nothing\u201d.",
    what: (what: string) => `Failed read: ${what}`,
    status: (status: number) => `Server status: ${status}`,
    message: (message: string) => `Server message: ${message}`,
    deniedHint: "Ask the platform super admin to confirm your admin roles include read access for this resource key.",
    unauthenticatedHint: "Sign in and return to this address.",
    errorHint: "Use \u201cReload\u201d to try again; if it keeps failing, give an administrator the facts above (resource and status).",
    retry: "Reload",
    back: "Back to site",
  },
} as const;

/** 管理端取数失败的受控提示卡（**同步**展示件：locale 由调用方注入，便于受控测试）。 */
export function AdminResourceUnavailableCard({
  segment,
  failure,
  locale = "zh",
}: {
  segment: string;
  failure: AdminLoadFailure;
  locale?: "zh" | "en";
}) {
  const copy = COPY[locale];
  const title =
    failure.kind === "denied"
      ? copy.deniedTitle
      : failure.kind === "unauthenticated"
        ? copy.unauthenticatedTitle
        : copy.errorTitle;
  const reason =
    failure.kind === "denied"
      ? copy.deniedReason
      : failure.kind === "unauthenticated"
        ? copy.unauthenticatedReason
        : copy.errorReason;
  const hint =
    failure.kind === "denied"
      ? copy.deniedHint
      : failure.kind === "unauthenticated"
        ? copy.unauthenticatedHint
        : copy.errorHint;
  const Icon = failure.kind === "denied" ? Ban : failure.kind === "unauthenticated" ? KeyRound : ServerCrash;

  return (
    <Card data-testid="admin-resource-unavailable" data-admin-load-failure={failure.kind}>
      <CardHeader className="flex-row items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
        <div className="min-w-0">
          <CardTitle data-testid="admin-resource-unavailable-title">{title}</CardTitle>
          <CardDescription className="mt-2">{reason}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul
          className="flex flex-col gap-1 rounded-md border border-[var(--border)] bg-[var(--muted)]/40 p-3 text-xs text-[var(--muted-foreground)]"
          data-testid="admin-resource-unavailable-details"
        >
          <li>{copy.what(failure.what)}</li>
          {failure.status === null ? null : <li>{copy.status(failure.status)}</li>}
          {failure.message === null ? null : <li>{copy.message(failure.message)}</li>}
        </ul>
        <p className="text-sm text-[var(--muted-foreground)]">{hint}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" asChild>
            <Link href={`/admin/${segment}`} data-testid="admin-resource-retry">
              <RefreshCw className="size-4" />
              {copy.retry}
            </Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link href="/dashboard" data-testid="admin-resource-back">
              {copy.back}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 服务端入口：读语言并渲染提示卡。
 *
 * 读语言失败（无请求上下文等）回落 zh 并**照常渲染** —— 一个「读取失败」的提示
 * 不该因为读不到 locale 自己再炸一次。
 */
export async function AdminResourceUnavailable({
  segment,
  failure,
}: {
  segment: string;
  failure: AdminLoadFailure;
}) {
  let locale: "zh" | "en" = "zh";
  try {
    locale = await currentLocale();
  } catch {
    locale = "zh";
  }
  return <AdminResourceUnavailableCard segment={segment} failure={failure} locale={locale} />;
}
