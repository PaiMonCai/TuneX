import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/input";

/**
 * TEN-03 认证卡片外壳：verify-email / forgot-password / reset-password 三个页面共用。
 * 独立于 app-shell（这些页面在登录态之外也要能打开），复用登录页的卡片视觉。
 */
export function AuthActionCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md" data-testid="auth-action-card">
        <CardHeader>
          <CardTitle data-testid="auth-action-title">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {children}
          {footer}
        </CardContent>
      </Card>
    </div>
  );
}

/** 提交按钮（带 pending 态），三个页面共用。 */
export function SubmitButton({
  pending,
  label,
  testId = "auth-action-submit",
}: {
  pending: boolean;
  label: string;
  testId?: string;
}) {
  return (
    <Button type="submit" disabled={pending} data-testid={testId}>
      {pending && <Loader2 className="size-4 animate-spin" />}
      {label}
    </Button>
  );
}

/** 错误提示条（与 auth-form.tsx 同款边框/配色）。 */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      className="rounded-md border border-[var(--destructive)] px-3 py-2 text-xs text-[var(--destructive)]"
      role="alert"
      data-testid="auth-action-error"
    >
      {message}
    </p>
  );
}

/** 邮箱输入框（三个页面里有两个需要，抽出来避免重复）。 */
export function EmailField({
  value,
  onChange,
  disabled,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="email">{label}</Label>
      <Input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        data-testid="email-input"
      />
    </div>
  );
}

/** 密码输入框。 */
export function PasswordField({
  id,
  value,
  onChange,
  disabled,
  placeholder,
  label,
  minLength,
  autoComplete = "new-password",
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder: string;
  label: string;
  minLength?: number;
  autoComplete?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        type="password"
        autoComplete={autoComplete}
        required
        disabled={disabled}
        minLength={minLength}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`${id}-input`}
      />
    </div>
  );
}

/** 返回登录链接。 */
export function BackToLogin({ label, linkLabel }: { label: string; linkLabel: string }) {
  return (
    <p className="text-center text-xs text-[var(--muted-foreground)]">
      {label}{" "}
      <Link href="/login" className="text-[var(--primary)] hover:underline">
        {linkLabel}
      </Link>
    </p>
  );
}
