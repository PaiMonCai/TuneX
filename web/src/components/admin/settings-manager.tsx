"use client";

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Save, Search } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { cn } from "@/lib/utils";
import type { SystemConfigItem } from "@/lib/types";

/** 配置项分组（按 name 前缀归类，未知项落到「其他」） */
function groupOf(name: string): string {
  if (name.startsWith("SITE_") || name === "LOGO_URL" || name.startsWith("HIDE_")) return "站点";
  // V5-WP18.5：`NOTICE*` 三个键已废弃 —— 公告的真相迁到了 `announcement` 表，
  // 免认证下发面也不再读它们（契约 F6.7）。这里**仍然显示**（旧值要能看见/清理），
  // 但组名写明废弃，避免有人继续往"能写、但没人读"的键里填内容。
  if (name.startsWith("NOTICE")) return "公告（已废弃）";
  if (name.startsWith("SMTP_") || name.startsWith("EMAIL_") || name.startsWith("RESEND_")) return "邮件";
  if (name.startsWith("REFERRAL_")) return "推广";
  if (name.startsWith("WITHDRAW_") || name === "MIN_WITHDRAW_AMOUNT") return "提现";
  if (name.startsWith("CHATWOOT_")) return "客服";
  if (name === "MIN_TOPUP_AMOUNT" || name === "ENABLE_SUBSCRIPTION" || name === "LIMIT_SCOPE") return "运营";
  if (name.startsWith("TUNNEL_") || name === "OBSERVER_PERIOD" || name === "AUTO_UPDATE_AGENT") return "隧道";
  return "其他";
}

/** 布尔型配置：渲染成 true/false 下拉 */
function isBoolValue(v: string): boolean {
  return v === "true" || v === "false";
}

/** 长文本配置：渲染成 textarea */
const TEXTAREA_KEYS = ["NOTICE", "WITHDRAW_METHODS"];

const GROUP_ORDER = ["站点", "公告（已废弃）", "邮件", "推广", "提现", "客服", "运营", "隧道", "其他"];

/**
 * N-F1：SMTP **不在这个页面**配置（后端 `config` 表里的 `SMTP_*` 行没有任何读者，
 * `services/mail.ts` 只读 `env.ts` 的 `mail` 段）。静默移除会让运维找不到地方配，所以这里
 * 明确写清"为什么不在这里"、给出**具体变量名**、指向部署文档，并说明历史行会被忽略。
 */
const SMTP_ENV_NAMES = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_SECURE"] as const;

const SMTP_NOTICE: Record<"zh" | "en", { title: string; body: string; history: string }> = {
  zh: {
    title: "SMTP（邮件）属于部署级配置",
    body:
      "邮件发送读取的是部署环境的变量，因此管理端**不提供** SMTP 写入项（写进这里也不会生效）。请在部署环境设置：" +
      SMTP_ENV_NAMES.join(" / ") +
      "，详见 docs/production-deploy.md 的邮件配置段。",
    history: "若数据库里还留着历史的 SMTP_* 行：本页与后端都会**忽略**它们（不改写、也不删除）。",
  },
  en: {
    title: "SMTP (email) is deployment-level configuration",
    body:
      "Email delivery reads deployment environment variables, so this console does not offer SMTP fields (values written here would not take effect). Set them in the deployment environment: " +
      SMTP_ENV_NAMES.join(" / ") +
      ", see the mail section of docs/production-deploy.md.",
    history: "If legacy SMTP_* rows still exist in the database, both this page and the backend ignore them (they are not rewritten or deleted).",
  },
};

export function AdminSettingsManager({ initialData }: { initialData: SystemConfigItem[] }) {
  const { t, locale } = useI18n();
  const notice = SMTP_NOTICE[locale === "en" ? "en" : "zh"];
  const [rows, setRows] = useState(initialData);
  const [draft, setDraft] = useState<Record<string, string>>(
    () => Object.fromEntries(initialData.map((c) => [c.name, c.value])),
  );
  const [saving, setSaving] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  // 凭据类键**非受控**：值只存在于输入框里，不进 React state、不在成功后被保留。
  const secretRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // 非受控输入需要一次状态变化才会重绘（"有改动"徽章/保存按钮的可用态）：这里只计数，不存值。
  const [, bumpSecretDraft] = useState(0);

  const grouped = useMemo(() => {
    const kw = keyword.trim().toUpperCase();
    const map = new Map<string, SystemConfigItem[]>();
    for (const c of rows) {
      if (kw && !c.name.includes(kw)) continue;
      const g = groupOf(c.name);
      const arr = map.get(g) ?? [];
      arr.push(c);
      map.set(g, arr);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [rows, keyword]);

  const dirty = (row: SystemConfigItem) =>
    isSecret(row)
      ? (secretRefs.current[row.name]?.value ?? "") !== ""
      : (draft[row.name] ?? "") !== row.value;

  /** 凭据类键（后端回 `secret_configured`）：值只写不读，界面只显示"配没配"。 */
  const isSecret = (row: SystemConfigItem) => row.secret_configured !== undefined;
  const pendingValue = (row: SystemConfigItem): string =>
    isSecret(row) ? (secretRefs.current[row.name]?.value ?? "") : (draft[row.name] ?? "");

  async function save(name: string) {
    const secret = isSecret(rows.find((r) => r.name === name) ?? ({ name } as SystemConfigItem));
    const value = secret ? (secretRefs.current[name]?.value ?? "") : (draft[name] ?? "");
    setSaving(name);
    try {
      await api.admin.setSystemConfig(name, value);
      if (secret) {
        // 只写不读：保存成功后立刻从输入框抹掉，并只把"已配置"这个事实记进状态。
        if (secretRefs.current[name]) secretRefs.current[name]!.value = "";
        setRows((prev) =>
          prev.map((r) => (r.name === name ? { ...r, value: "", secret_configured: value.length > 0, updated_at: new Date().toISOString() } : r)),
        );
      } else {
        setRows((prev) => prev.map((r) => (r.name === name ? { ...r, value, updated_at: new Date().toISOString() } : r)));
      }
      toast.success(t("admin.configSaveSuccess"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.saveFailed"));
    } finally {
      setSaving(null);
    }
  }

  function setValue(name: string, value: string) {
    setDraft((prev) => ({ ...prev, [name]: value }));
  }

  return (
    <div className="flex flex-col gap-5" data-testid="admin-settings">
      <Card data-testid="smtp-deployment-note">
        <CardHeader className="pb-2">
          <CardTitle>{notice.title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          <p className="field-hint">{notice.body}</p>
          <p className="field-hint" data-testid="smtp-deployment-history">
            {notice.history}
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t("common.search")}
            className="w-56 sm:w-72"
            data-testid="settings-search"
          />
          <Search className="size-4 text-[var(--muted-foreground)]" />
        </div>
        <p className="field-hint max-w-md">{t("admin.configHint")}</p>
      </div>

      {grouped.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-[var(--muted-foreground)]">
            {t("common.noData")}
          </CardContent>
        </Card>
      ) : (
        grouped.map(([group, items]) => (
          <Card key={group}>
            <CardHeader className="pb-2">
              <CardTitle>{group}</CardTitle>
              <CardDescription>{t("admin.configEditable")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {items.map((c) => {
                const value = draft[c.name] ?? "";
                const changed = dirty(c);
                const secret = isSecret(c);
                return (
                  <div key={c.name} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <label className="font-mono text-xs font-medium text-[var(--muted-foreground)]">{c.name}</label>
                      <span className="flex items-center gap-2">
                        {secret && (
                          <Badge
                            variant={c.secret_configured ? "success" : "muted"}
                            data-testid={`config-secret-state-${c.name}`}
                          >
                            {c.secret_configured
                              ? locale === "en"
                                ? "Configured"
                                : "已配置"
                              : locale === "en"
                                ? "Not configured"
                                : "未配置"}
                          </Badge>
                        )}
                        {changed && <Badge variant="default">{t("common.save")}</Badge>}
                      </span>
                    </div>
                    <div className="flex items-start gap-2">
                      {secret ? (
                        // 只写不读：输入框是非受控的（值不进 state），成功保存后立刻清空。
                        <Input
                          ref={(el) => {
                            secretRefs.current[c.name] = el;
                          }}
                          type="password"
                          autoComplete="off"
                          placeholder={locale === "en" ? "Write a new value (never echoed)" : "写入新值（不回显）"}
                          onChange={() => bumpSecretDraft((n) => n + 1)}
                          data-testid={`config-${c.name}`}
                        />
                      ) : isBoolValue(c.value) ? (
                        <select
                          value={value}
                          onChange={(e) => setValue(c.name, e.target.value)}
                          className="flex h-9 w-40 rounded-md border border-[var(--input)] bg-[var(--card)] px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                          data-testid={`config-${c.name}`}
                        >
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : TEXTAREA_KEYS.includes(c.name) ? (
                        <Textarea
                          rows={3}
                          value={value}
                          onChange={(e) => setValue(c.name, e.target.value)}
                          data-testid={`config-${c.name}`}
                        />
                      ) : (
                        <Input
                          value={value}
                          onChange={(e) => setValue(c.name, e.target.value)}
                          data-testid={`config-${c.name}`}
                        />
                      )}
                      <Button
                        size="sm"
                        variant={changed ? "default" : "outline"}
                        disabled={!changed || saving === c.name}
                        onClick={() => save(c.name)}
                        className={cn("shrink-0", !changed && "opacity-60")}
                        data-testid={`config-save-${c.name}`}
                      >
                        {saving === c.name ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                        {t("common.save")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
