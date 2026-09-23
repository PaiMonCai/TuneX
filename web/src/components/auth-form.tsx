"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const { t } = useI18n();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isLogin = mode === "login";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isLogin && password !== confirm) {
      setError(t("auth.passwordMismatch"));
      return;
    }
    setPending(true);
    try {
      if (isLogin) {
        await api.auth.login(email, password);
        toast.success(t("auth.loginSuccess"));
      } else {
        await api.auth.register(email, password);
        toast.success(t("auth.registerSuccess"));
      }
      const next = params.get("next");
      const target = next && next.startsWith("/") ? next : "/dashboard";
      // 必须整页跳转：会话 cookie 是刚写入的，且 /dashboard 可能在登录前
      // 就被预取过（未登录 → 重定向到 /login），走 router.push 会命中旧结果被弹回。
      window.location.assign(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("auth.loginFailed");
      setError(msg);
      toast.error(msg);
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle data-testid="auth-title">{isLogin ? t("auth.loginTitle") : t("auth.registerTitle")}</CardTitle>
        <CardDescription>{isLogin ? t("auth.loginSubtitle") : t("auth.registerSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" data-testid={`${mode}-form`}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">{t("common.email")}</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              placeholder={t("auth.emailPlaceholder")}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="email-input"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">{t("auth.password")}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={isLogin ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              placeholder={t("auth.passwordPlaceholder")}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="password-input"
            />
          </div>
          {!isLogin && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirm">{t("auth.confirmPassword")}</Label>
              <Input
                id="confirm"
                name="confirm"
                type="password"
                required
                minLength={6}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          )}

          {error && (
            <p className="rounded-md border border-[var(--destructive)] px-3 py-2 text-xs text-[var(--destructive)]" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" disabled={pending} data-testid="auth-submit">
            {pending && <Loader2 className="size-4 animate-spin" />}
            {isLogin ? t("auth.loginButton") : t("auth.registerButton")}
          </Button>

          <p className="text-center text-xs text-[var(--muted-foreground)]">
            {isLogin ? t("auth.noAccount") : t("auth.hasAccount")}{" "}
            <Link href={isLogin ? "/register" : "/login"} className="text-[var(--primary)] hover:underline">
              {isLogin ? t("auth.goRegister") : t("auth.goLogin")}
            </Link>
          </p>
          {isLogin && (
            <p className="rounded-md bg-[var(--muted)] px-3 py-2 text-center text-xs text-[var(--muted-foreground)]">
              {t("auth.demoHint")}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
