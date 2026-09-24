"use client";

import { useState } from "react";
import Link from "next/link";
import { MailCheck } from "lucide-react";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { AuthActionCard, BackToLogin, EmailField, SubmitButton } from "@/components/auth-action";

/**
 * TEN-03 忘记密码页。
 * 提交后**永远**显示「已发送」——后端对存在/不存在的邮箱返回同一响应
 * （防邮箱枚举），前端因此不做「该邮箱未注册」的失败分支。
 */
export function ForgotPasswordBody() {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await api.auth.forgotPassword(email);
    } catch {
      // 即使请求失败也走「已发送」文案：不给探测方任何区分信息
    } finally {
      setSent(true);
      setPending(false);
    }
  }

  if (sent) {
    return (
      <AuthActionCard title={t("auth.forgotTitle")} description={t("auth.forgotSent")}>
        <div className="flex flex-col items-center gap-3 py-2" data-testid="forgot-status" data-state="sent">
          <MailCheck className="size-10 text-emerald-500" />
          <p className="text-center text-xs text-[var(--muted-foreground)]">{t("auth.forgotSentHint")}</p>
          <BackToLogin label={t("auth.backToLogin")} linkLabel={t("auth.goLogin")} />
        </div>
      </AuthActionCard>
    );
  }

  return (
    <AuthActionCard title={t("auth.forgotTitle")} description={t("auth.forgotSubtitle")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" data-testid="forgot-password-form">
        <EmailField
          value={email}
          onChange={setEmail}
          disabled={pending}
          placeholder={t("auth.emailPlaceholder")}
          label={t("common.email")}
        />
        <SubmitButton pending={pending} label={t("auth.forgotButton")} testId="forgot-submit" />
        <BackToLogin label={t("auth.backToLogin")} linkLabel={t("auth.goLogin")} />
      </form>
    </AuthActionCard>
  );
}
