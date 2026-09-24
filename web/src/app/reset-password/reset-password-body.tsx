"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { AuthActionCard, BackToLogin, FormError, PasswordField, SubmitButton } from "@/components/auth-action";

/**
 * TEN-03 重置密码页。
 * 从 `/reset-password?token=...` 邮件链接进入；提交 `POST /api/auth/reset-password`。
 * token 由后端单次校验：过期/伪造/已用都返回同一句「链接无效或已过期」，
 * 缺少 token 时直接判定无效（不发起请求）。
 */
export function ResetPasswordBody() {
  const { t } = useI18n();
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("token"));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError(t("auth.passwordMismatch"));
      return;
    }
    if (!token) {
      setError(t("auth.resetInvalid"));
      return;
    }
    setPending(true);
    try {
      await api.auth.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("auth.resetInvalid"));
      setPending(false);
    }
  }

  if (done) {
    return (
      <AuthActionCard title={t("auth.resetTitle")} description={t("auth.resetDone")}>
        <div className="flex flex-col items-center gap-3 py-2" data-testid="reset-status" data-state="done">
          <CheckCircle2 className="size-10 text-emerald-500" />
          <p className="text-center text-xs text-[var(--muted-foreground)]">{t("auth.resetDoneHint")}</p>
          <Button asChild className="w-full">
            <Link href="/login">{t("auth.goLogin")}</Link>
          </Button>
        </div>
      </AuthActionCard>
    );
  }

  return (
    <AuthActionCard title={t("auth.resetTitle")} description={t("auth.resetSubtitle")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" data-testid="reset-password-form">
        {!token && (
          <p className="rounded-md border border-[var(--destructive)] px-3 py-2 text-xs text-[var(--destructive)]">
            {t("auth.resetMissing")}
          </p>
        )}
        <PasswordField
          id="password"
          value={password}
          onChange={setPassword}
          disabled={pending}
          minLength={8}
          autoComplete="new-password"
          placeholder={t("auth.passwordPlaceholder")}
          label={t("auth.password")}
        />
        <PasswordField
          id="confirm"
          value={confirm}
          onChange={setConfirm}
          disabled={pending}
          minLength={8}
          autoComplete="new-password"
          placeholder={t("auth.confirmPassword")}
          label={t("auth.confirmPassword")}
        />
        <FormError message={error} />
        <SubmitButton pending={pending} label={t("auth.resetButton")} testId="reset-submit" />
        <BackToLogin label={t("auth.backToLogin")} linkLabel={t("auth.goLogin")} />
      </form>
    </AuthActionCard>
  );
}
