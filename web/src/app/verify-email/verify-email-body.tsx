"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { AuthActionCard } from "@/components/auth-action";

type State =
  | { kind: "loading" }
  | { kind: "verified"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "missing" };

/**
 * TEN-03 邮箱验证结果页。
 * 邮件里的链接（`/verify-email?token=...`）直接打开本页，客户端带 token 调
 * `GET /api/auth/verify-email`，按后端返回的 status 渲染成功/失败。
 * 不依赖登录态：用户可能在别的浏览器/设备上点链接。
 */
export function VerifyEmailBody() {
  const { t } = useI18n();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      setState({ kind: "missing" });
      return;
    }
    // noRedirect=true：验证失败绝不应把用户弹去登录页
    api.auth
      .verifyEmail(token)
      .then((res) => setState({ kind: res.status, message: res.message }))
      .catch((err: unknown) =>
        setState({
          kind: "invalid",
          message: err instanceof Error && err.message ? err.message : t("auth.verifyInvalid"),
        }),
      );
  }, [t]);

  if (state.kind === "loading") {
    return (
      <AuthActionCard title={t("auth.verifyTitle")} description={t("common.loading")}>
        <p className="text-sm text-[var(--muted-foreground)]" data-testid="verify-status">
          {t("common.loading")}
        </p>
      </AuthActionCard>
    );
  }

  if (state.kind === "verified") {
    return (
      <AuthActionCard title={t("auth.verifyTitle")} description={state.message || t("auth.verified")}>
        <div className="flex flex-col items-center gap-3 py-2" data-testid="verify-status" data-state="verified">
          <CheckCircle2 className="size-10 text-emerald-500" />
          <p className="text-sm text-[var(--muted-foreground)]">{t("auth.verifiedHint")}</p>
          <Button asChild className="w-full">
            <Link href="/dashboard">{t("auth.goDashboard")}</Link>
          </Button>
        </div>
      </AuthActionCard>
    );
  }

  return (
    <AuthActionCard
      title={t("auth.verifyTitle")}
      description={state.kind === "missing" ? t("auth.verifyMissing") : t("auth.verifyInvalid")}
    >
      <div className="flex flex-col items-center gap-3 py-2" data-testid="verify-status" data-state="invalid">
        <XCircle className="size-10 text-[var(--destructive)]" />
        <p className="text-xs text-[var(--muted-foreground)]">{t("auth.verifyRetryHint")}</p>
        <Button asChild variant="outline" className="w-full">
          <Link href="/login">{t("auth.goLogin")}</Link>
        </Button>
      </div>
    </AuthActionCard>
  );
}
