"use client";

import { useMemo, useState } from "react";
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
  if (name.startsWith("NOTICE")) return "公告";
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

const GROUP_ORDER = ["站点", "公告", "邮件", "推广", "提现", "客服", "运营", "隧道", "其他"];

export function AdminSettingsManager({ initialData }: { initialData: SystemConfigItem[] }) {
  const { t } = useI18n();
  const [rows, setRows] = useState(initialData);
  const [draft, setDraft] = useState<Record<string, string>>(
    () => Object.fromEntries(initialData.map((c) => [c.name, c.value])),
  );
  const [saving, setSaving] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");

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

  const dirty = (name: string) => draft[name] !== rows.find((r) => r.name === name)?.value;

  async function save(name: string) {
    const value = draft[name] ?? "";
    setSaving(name);
    try {
      await api.admin.setSystemConfig(name, value);
      setRows((prev) => prev.map((r) => (r.name === name ? { ...r, value, updated_at: new Date().toISOString() } : r)));
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
                const changed = dirty(c.name);
                return (
                  <div key={c.name} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <label className="font-mono text-xs font-medium text-[var(--muted-foreground)]">{c.name}</label>
                      {changed && <Badge variant="default">{t("common.save")}</Badge>}
                    </div>
                    <div className="flex items-start gap-2">
                      {isBoolValue(c.value) ? (
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
