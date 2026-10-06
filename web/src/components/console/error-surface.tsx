"use client";

/**
 * 受控错误面 —— 全站 `error.tsx` / 后台 `(admin)/error.tsx` 共用的展示件。
 *
 * 为什么要有它：Next 的默认错误页会把**任何**未捕获的服务端错误渲染成同一个
 * 开发/生产错误屏。对「普通账号点进 /admin → 后端 403」这件事，那既没有说清原因，
 * 也没有回去/重试的路径 —— 用户看到的是一个和「网站挂了」无法区分的界面。
 *
 * 本组件的纪律：
 *
 * 1. **不谎报状态**：只有真的拿到 `status` 才说 403/401/404；拿不到就直说
 *    「没有拿到可用的原因」，绝不用「500 / 服务器错误」去概括一切。
 * 2. **不白屏**：始终渲染带标题、原因、摘要编号与两个动作的卡片。
 * 3. **不吞错误**：`console.error` 原样打给开发者；`retry()` 是 Next 16.3 稳定版
 *    的错误边界重试入口（`error.js` 的 `retry` prop，见已安装版本指南）。
 * 4. **不是权限判定**：后台错误面会额外读一次 `GET /api/auth/permissions`，只为把
 *    「这个账号不是后台用户」这句话说清楚；它不决定任何资源能不能访问
 *    （真相始终在后端 RBAC），也**不隐藏**任何入口。
 *
 * 文案自带 zh/en 两份（沿用专项里 `node-lifecycle-i18n` / `forward-latency` 的
 * 切片自带文案约定），因为错误面必须能在任何 Provider 缺失时渲染：`useI18nOptional()`
 * 在没有 `<I18nProvider>` 时返回 `null`（例如错误就发生在 Provider 内部），
 * 此时回落到站点默认语言 zh，而不是抛错。
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, ShieldAlert, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18nOptional } from "@/components/providers";
import { get } from "@/lib/api/core";
import {
  adminPersonaOf,
  type AdminPersonaReading,
} from "@/components/console/admin-persona";

export type ErrorScope = "app" | "admin";

export interface ErrorSurfaceFacts {
  scope: ErrorScope;
  /** 真实 HTTP 状态；未知传 `null`（**不**填 500）。 */
  status: number | null;
  /** 后台错误面读到的账号视角；未读/取不到 = `unknown`。 */
  persona: AdminPersonaReading;
  /** 服务端错误摘要编号（`error.digest`），仅用于对日志。 */
  digest: string | null;
  /** 服务端下发的错误消息（能拿到才展示，拿不到就不编）。 */
  serverMessage: string | null;
}

export type ErrorTone = "denied" | "unauthenticated" | "missing" | "unknown";

/** 事实 → 基调。只有真实状态码才升级基调，绝不把「未知」说成严重故障。 */
export function errorToneOf(facts: Pick<ErrorSurfaceFacts, "scope" | "status" | "persona">): ErrorTone {
  if (facts.status === 403) return "denied";
  if (facts.status === 401) return "unauthenticated";
  if (facts.status === 404) return "missing";
  // 后台页面 + 读数明确说「这个账号没有后台角色」：页面加载不出来的原因是可解释的，
  // 不是未知故障。这条**不**依赖 status（服务端错误的状态码到不了浏览器）。
  if (facts.scope === "admin" && facts.persona === "member") return "denied";
  return "unknown";
}

export function errorStatusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

export function errorDigestOf(error: unknown): string | null {
  const digest = (error as { digest?: unknown } | null | undefined)?.digest;
  return typeof digest === "string" && digest.trim() !== "" ? digest : null;
}

export function errorServerMessageOf(error: unknown): string | null {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  return trimmed === "" ? null : trimmed;
}

interface Copy {
  title: Record<ErrorTone, string>;
  reason: Record<ErrorTone, string>;
  hint: Record<ErrorTone, string>;
  detailStatus: (status: number) => string;
  detailPersona: Record<"member" | "delegated" | "super_admin" | "unknown", string>;
  detailDigest: (digest: string) => string;
  detailMessage: (message: string) => string;
  retry: string;
  backApp: string;
  backAdmin: string;
  signIn: string;
}

const COPY: Record<"zh" | "en", Copy> = {
  zh: {
    title: {
      denied: "这个页面需要的权限，当前账号没有",
      unauthenticated: "登录状态已失效",
      missing: "这个资源不存在或已被删除",
      unknown: "这个页面没能加载出来",
    },
    reason: {
      denied:
        "后端 RBAC 拒绝了这次访问。平台后台的权限按资源键分级（例如「节点配置」与「系统设置」是两种权限），所以有后台角色也不等于能打开每一个页面。",
      unauthenticated: "服务端认为这次请求没有有效会话（401）。重新登录后再试即可。",
      missing: "服务端明确回答这个地址没有对应资源（404）。如果它是你刚删除的内容，这是预期行为。",
      unknown:
        "没有拿到可用的原因：服务端错误详情不会下发到浏览器，浏览器只拿到一个摘要编号。它可能是权限不足，也可能是临时故障 —— 这里不会用一个状态码去概括它。",
    },
    hint: {
      denied:
        "如果你应当有后台权限，请联系平台超级管理员，请其确认你的后台角色是否包含这个页面所需的资源权限（普通账号请从「返回控制台」继续使用用户功能）。",
      unauthenticated: "登录后回到这个地址即可继续。",
      missing: "回到控制台，或从侧边栏重新进入目标页面。",
      unknown:
        "可以先点「重试」重新取一次；若一直失败，请把下面的摘要编号提供给管理员，便于在服务端日志里定位这一次错误。",
    },
    detailStatus: (status) => `服务端状态：${status}`,
    detailPersona: {
      member: "权限读数（GET /api/auth/permissions）：super_admin=false，且没有任何后台角色。",
      delegated: "权限读数：持有后台角色（委派管理员）。具体能访问哪些页面由后端按资源键裁决。",
      super_admin: "权限读数：super_admin=true。",
      unknown: "权限读数：本次没有取到（取不到不等于没有权限）。",
    },
    detailDigest: (digest) => `摘要编号：${digest}`,
    detailMessage: (message) => `服务端消息：${message}`,
    retry: "重试",
    backApp: "返回首页",
    backAdmin: "返回控制台",
    signIn: "去登录",
  },
  en: {
    title: {
      denied: "This page requires a permission your account does not have",
      unauthenticated: "Your session has expired",
      missing: "This resource does not exist or was removed",
      unknown: "This page failed to load",
    },
    reason: {
      denied:
        "Backend RBAC rejected this request. Admin console permissions are graded per resource key (for example \u201cnode config\u201d and \u201csystem settings\u201d are different permissions), so holding an admin role does not mean every page opens.",
      unauthenticated: "The server saw no valid session for this request (401). Sign in again and retry.",
      missing: "The server answered that this address has no such resource (404). If you just deleted it, this is expected.",
      unknown:
        "No usable cause was received: details of a failed render are not forwarded to the browser, only a digest. It may be a missing permission or a transient failure \u2014 this page will not summarize it with a status code.",
    },
    hint: {
      denied:
        "If you should have admin access, ask the platform super admin to confirm your admin roles cover the resource key this page needs (regular accounts can keep using the console via \u201cBack to console\u201d).",
      unauthenticated: "Sign in and return to this address to continue.",
      missing: "Go back to the console, or pick the page again from the sidebar.",
      unknown:
        "Try \u201cRetry\u201d once. If it keeps failing, pass the digest below to an administrator so the exact error can be found in the server logs.",
    },
    detailStatus: (status) => `Server status: ${status}`,
    detailPersona: {
      member: "Permission reading (GET /api/auth/permissions): super_admin=false and no admin roles.",
      delegated: "Permission reading: holds admin role(s) (delegated admin). Which pages open is decided per resource key by the backend.",
      super_admin: "Permission reading: super_admin=true.",
      unknown: "Permission reading: not available this time (not available does not mean not permitted).",
    },
    detailDigest: (digest) => `Digest: ${digest}`,
    detailMessage: (message) => `Server message: ${message}`,
    retry: "Retry",
    backApp: "Back to home",
    backAdmin: "Back to console",
    signIn: "Sign in",
  },
};

/** 事实 → 具体文案（纯函数，可单测）。 */
export function errorSurfaceView(facts: ErrorSurfaceFacts, locale: "zh" | "en" = "zh") {
  const copy = COPY[locale];
  const tone = errorToneOf(facts);
  const backHref = facts.scope === "admin" ? "/dashboard" : "/";
  return {
    tone,
    title: copy.title[tone],
    reason: copy.reason[tone],
    hint: copy.hint[tone],
    retryLabel: copy.retry,
    backLabel: facts.scope === "admin" ? copy.backAdmin : copy.backApp,
    backHref,
    /** 只在真的拿到事实时才出现的补充行（顺序稳定，便于断言）。 */
    details: [
      facts.status === null ? null : copy.detailStatus(facts.status),
      facts.scope === "admin" ? copy.detailPersona[facts.persona] : null,
      facts.serverMessage === null ? null : copy.detailMessage(facts.serverMessage),
      facts.digest === null ? null : copy.detailDigest(facts.digest),
    ].filter((line): line is string => line !== null),
  };
}

/**
 * 后台错误面专用的权限读数。只读一次、失败即静默（保持 `unknown`），
 * 且不改变任何访问决定 —— 它只影响这段文案怎么解释。
 */
function useAdminPersona(scope: ErrorScope): AdminPersonaReading {
  const [persona, setPersona] = useState<AdminPersonaReading>("unknown");
  useEffect(() => {
    if (scope !== "admin") return;
    let alive = true;
    void (async () => {
      try {
        const payload = await get<unknown>("/auth/permissions", undefined, undefined);
        if (alive) setPersona(adminPersonaOf(payload));
      } catch {
        // 取不到就保持 unknown：错误面不因为一次读数失败改变口径。
      }
    })();
    return () => {
      alive = false;
    };
  }, [scope]);
  return persona;
}

export function ConsoleErrorSurface({
  scope,
  error,
  retry,
}: {
  scope: ErrorScope;
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const i18n = useI18nOptional();
  const locale = i18n?.locale ?? "zh";
  const persona = useAdminPersona(scope);

  useEffect(() => {
    // 不吞错误：开发者在控制台/日志里照旧看到原始错误。
    console.error(`[tunex] ${scope} error boundary`, error);
  }, [scope, error]);

  const facts: ErrorSurfaceFacts = {
    scope,
    status: errorStatusOf(error),
    persona,
    digest: errorDigestOf(error) ?? null,
    serverMessage: errorServerMessageOf(error),
  };
  const view = errorSurfaceView(facts, locale);
  const denied = view.tone === "denied" || view.tone === "unauthenticated";
  const Icon = denied ? ShieldAlert : AlertTriangle;

  return (
    <div
      className="flex min-h-[60vh] items-center justify-center p-4"
      data-testid="console-error-surface"
      data-error-scope={scope}
      data-error-tone={view.tone}
    >
      <Card className="w-full max-w-xl">
        <CardHeader className="flex-row items-start gap-3">
          <Icon className="mt-0.5 size-5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
          <div className="min-w-0">
            <CardTitle data-testid="console-error-title">{view.title}</CardTitle>
            <CardDescription className="mt-2 whitespace-pre-line">{view.reason}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="whitespace-pre-line text-sm text-[var(--muted-foreground)]" data-testid="console-error-hint">
            {view.hint}
          </p>
          {view.details.length > 0 && (
            <ul
              className="flex flex-col gap-1 rounded-md border border-[var(--border)] bg-[var(--muted)]/40 p-3 text-xs text-[var(--muted-foreground)]"
              data-testid="console-error-details"
            >
              {view.details.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => retry()} data-testid="console-error-retry">
              <RefreshCw className="size-4" />
              {view.retryLabel}
            </Button>
            {view.tone === "unauthenticated" ? (
              <Button size="sm" variant="outline" asChild>
                <Link href="/login" data-testid="console-error-signin">
                  {COPY[locale].signIn}
                </Link>
              </Button>
            ) : null}
            <Button size="sm" variant="outline" asChild>
              <Link href={view.backHref} data-testid="console-error-back">
                <Undo2 className="size-4" />
                {view.backLabel}
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
