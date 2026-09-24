"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Separator } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, ToggleRow } from "@/components/ui/form";
import { ConfirmDeleteDialog } from "@/components/admin/admin-ui";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { formatDateTime } from "@/lib/utils";
import type { User } from "@/lib/types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 密钥展示行：默认打码，可切换明文、可复制、可重新生成 */
function KeyRow({
  label,
  value,
  onRegenerate,
  regenerating,
}: {
  label: string;
  value: string;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const masked = value.length > 8 ? `${value.slice(0, 6)}••••••${value.slice(-4)}` : "••••••";

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("common.copied"));
    } catch {
      toast.error(value);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="field-label">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-[var(--input)] bg-[var(--muted)] px-3 py-2 font-mono text-xs">
          {visible ? value : masked}
        </code>
        <Button variant="ghost" size="icon" onClick={() => setVisible((v) => !v)} aria-label={visible ? t("common.hide") : t("common.show")}>
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" onClick={copy} aria-label={t("common.copy")}>
          <Copy className="size-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={onRegenerate} disabled={regenerating} data-testid={`regen-${label}`}>
          {regenerating ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {t("common.regenerate")}
        </Button>
      </div>
    </div>
  );
}

export function SettingsBody({ user: initialUser }: { user: User }) {
  const { t } = useI18n();
  const [user, setUser] = useState(initialUser);

  // 资料
  const [email, setEmail] = useState(initialUser.email);
  const [note, setNote] = useState(initialUser.note ?? "");
  const [tgId, setTgId] = useState(initialUser.tg_id ?? "");
  const [autoRenew, setAutoRenew] = useState(initialUser.auto_renew);
  const [savingProfile, setSavingProfile] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  // 密钥
  const [regenKey, setRegenKey] = useState<"api" | "sub" | null>(null);
  const [confirmRegen, setConfirmRegen] = useState<"api" | "sub" | null>(null);

  // 密码
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  async function saveProfile() {
    if (!EMAIL_RE.test(email.trim())) {
      setEmailError(t("settings.emailInvalid"));
      return;
    }
    setEmailError(null);
    setSavingProfile(true);
    try {
      const updated = await api.settings.updateProfile({
        email: email.trim(),
        note: note.trim() || null,
        tg_id: tgId.trim() || null,
        auto_renew: autoRenew,
      });
      setUser(updated);
      toast.success(t("settings.profileSaved"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("settings.profileFailed");
      setEmailError(msg);
      toast.error(msg);
    } finally {
      setSavingProfile(false);
    }
  }

  async function regenerate(kind: "api" | "sub") {
    setRegenKey(kind);
    try {
      const res = kind === "api" ? await api.settings.regenerateApiKey() : await api.settings.regenerateSubscriptionKey();
      setUser(res.user);
      toast.success(t("settings.keyRegenerated"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("settings.keyRegenerateFailed"));
    } finally {
      setRegenKey(null);
      setConfirmRegen(null);
    }
  }

  async function changePassword() {
    if (newPassword.length < 6) {
      setPasswordError(t("settings.passwordTooShort"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t("settings.passwordMismatch"));
      return;
    }
    setPasswordError(null);
    setSavingPassword(true);
    try {
      await api.settings.changePassword({ current_password: currentPassword, new_password: newPassword });
      toast.success(t("settings.passwordChanged"));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("settings.passwordFailed");
      setPasswordError(msg);
      toast.error(msg);
    } finally {
      setSavingPassword(false);
    }
  }

  /* ---- TEN-03 邮箱验证条 ---- */
  const [sendingVerify, setSendingVerify] = useState(false);
  const [verifySent, setVerifySent] = useState(false);

  async function resendVerification() {
    setSendingVerify(true);
    try {
      await api.auth.resendVerification();
      setVerifySent(true);
      toast.success(t("auth.resendVerificationSent"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("auth.resendVerificationFailed");
      // 429（已发过 / 间隔不足）提示是预期的节流反馈，不算「失败」
      if (msg.includes("频繁") || msg.includes("Too many")) {
        toast.warning(t("auth.resendVerificationTooSoon"));
      } else {
        toast.error(msg);
      }
    } finally {
      setSendingVerify(false);
    }
  }

  // 订阅地址需要浏览器 origin，放在 effect 里计算，避免 SSR/client 首帧不一致
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  const subscriptionPath = `/api/tunnel/subscription?token=${user.subscription_key}`;
  const subscriptionUrl = origin ? `${origin}${subscriptionPath}` : subscriptionPath;

  return (
    <div className="flex flex-col gap-5" data-testid="settings-body">
      {/* TEN-03：邮箱未验证时的提示条。软约束——不阻断使用，但给「去验证」一个明确入口。 */}
      {user.email_verified_at === null && (
        <div
          className="flex items-center justify-between gap-4 rounded-md border border-[var(--warning,#eab308)]/50 bg-[var(--warning,#eab308)]/10 px-4 py-3"
          data-testid="email-verify-banner"
        >
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-medium">{t("auth.emailUnverified")}</p>
            <p className="text-xs text-[var(--muted-foreground)]">{t("auth.emailUnverifiedHint")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={resendVerification}
            disabled={sendingVerify || verifySent}
            data-testid="resend-verification-btn"
          >
            {sendingVerify && <Loader2 className="size-4 animate-spin" />}
            {verifySent ? t("auth.resendVerificationSent") : t("auth.resendVerification")}
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.profile")}</CardTitle>
          <CardDescription>{t("settings.profileDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("settings.email")} error={emailError ?? undefined}>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="settings-email"
              />
            </Field>
            <Field label={t("settings.uid")}>
              <Input value={user.uid ?? "-"} readOnly className="bg-[var(--muted)]" />
            </Field>
            <Field label={t("settings.tgId")} hint={t("common.optional")}>
              <Input value={tgId} onChange={(e) => setTgId(e.target.value)} placeholder="100200300" />
            </Field>
            <Field label={t("settings.note")} hint={t("common.optional")}>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("common.optional")} />
            </Field>
          </div>
          <ToggleRow
            label={t("settings.autoRenew")}
            description={t("plan.renewable")}
            checked={autoRenew}
            onCheckedChange={setAutoRenew}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="field-hint">
              {t("common.updatedAt")}: {formatDateTime(user.updated_at)}
            </span>
            <Button onClick={saveProfile} disabled={savingProfile} data-testid="save-profile-btn">
              {savingProfile ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              {t("settings.saveProfile")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.keys")}</CardTitle>
          <CardDescription>{t("settings.keysDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <KeyRow
            label={t("settings.apiKey")}
            value={user.api_key}
            regenerating={regenKey === "api"}
            onRegenerate={() => setConfirmRegen("api")}
          />
          <Separator />
          <KeyRow
            label={t("settings.subscriptionKey")}
            value={user.subscription_key}
            regenerating={regenKey === "sub"}
            onRegenerate={() => setConfirmRegen("sub")}
          />
          <p className="field-hint">{t("settings.keyHiddenHint")}</p>
          <Separator />
          <div className="flex flex-col gap-1.5">
            <span className="field-label">{t("settings.subscriptionUrl")}</span>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-[var(--input)] bg-[var(--muted)] px-3 py-2 font-mono text-xs">
                {subscriptionUrl}
              </code>
              <Button
                variant="ghost"
                size="icon"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(subscriptionUrl);
                    toast.success(t("common.copied"));
                  } catch {
                    toast.error(subscriptionUrl);
                  }
                }}
                aria-label={t("common.copy")}
              >
                <Copy className="size-4" />
              </Button>
            </div>
            <p className="field-hint">{t("settings.subscriptionDesc")}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.password")}</CardTitle>
          <CardDescription>{t("settings.passwordDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("settings.currentPassword")}>
              <Input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                data-testid="current-password"
              />
            </Field>
            <Field label={t("settings.newPassword")}>
              <Input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                data-testid="new-password"
              />
            </Field>
            <Field label={t("settings.confirmPassword")} error={passwordError ?? undefined}>
              <Input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                data-testid="confirm-password"
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={changePassword}
              disabled={savingPassword || !currentPassword || !newPassword}
              data-testid="change-password-btn"
            >
              {savingPassword && <Loader2 className="size-4 animate-spin" />}
              {t("settings.changePassword")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{user.super_admin ? t("fields.superAdmin") : t("fields.user")}</Badge>
        <Badge variant={user.status === "active" ? "success" : "muted"}>{user.status}</Badge>
      </div>

      <ConfirmDeleteDialog
        open={!!confirmRegen}
        onOpenChange={(v) => !v && setConfirmRegen(null)}
        title={confirmRegen === "api" ? t("settings.regenerateApiKey") : t("settings.regenerateSubKey")}
        description={t("settings.regenerateConfirm")}
        onConfirm={() => regenerate(confirmRegen ?? "api")}
        pending={regenKey !== null}
      />
    </div>
  );
}
