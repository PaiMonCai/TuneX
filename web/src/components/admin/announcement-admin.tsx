"use client";

/**
 * V5-WP18.5 —— 平台公告的**发布 / 撤回**（Admin Console）。
 *
 * ── 为什么表单这么朴素 ──
 * 契约 F6.6 明确**不做富文本编辑器**、不引入 HTML 净化器：正文是**纯文本**，前端只做
 * 纯文本渲染（`whitespace-pre-wrap`）。多行靠 textarea，不需要所见即所得。
 *
 * ── 权限：失败就把原因显示出来 ──
 * `/admin/announcements` 的 RBAC 资源键由 WP18.6 登记；在那之前 `adminPermissionGuard`
 * 对未登记前缀 fail-closed，只有超管可用。因此本组件**不**做乐观隐藏/禁用：拿不到就渲染
 * 后端给的原因（`Error.message`），不把 403 说成"暂无公告"。
 *
 * ── 弹窗冲突（409）是可预期的正常结果 ──
 * 同 scope 只允许一条活跃弹窗（DB 唯一索引），第二条会被拒绝并给出 `active_popup_exists`；
 * 这里如实展示"先撤回它在发"，而不是自动撤回别人正在用的弹窗（§12.3-D5）。
 */
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Megaphone } from "lucide-react";
import { useI18n } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import type { Locale } from "@/lib/i18n";
import { isPopup, normalizeAnnouncements, type Announcement } from "@/lib/announcements";

/**
 * 正文长度上限与服务端同源（`ANNOUNCEMENT_LIMITS.BODY_MAX`）：前端**只做提示**，
 * 真正的拒绝在后端（前端截断会让用户以为发出去的是一整篇）。
 */
const TITLE_MAX = 200;
const BODY_MAX = 10_000;

export function AnnouncementAdmin({ initial, locale }: { initial: Announcement[]; locale: Locale }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<Announcement[]>(() => normalizeAnnouncements(initial));
  const [type, setType] = useState<"normal" | "popup">("normal");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [revokingId, setRevokingId] = useState<number | null>(null);

  const publish = async () => {
    setPublishing(true);
    try {
      const created = await api.admin.announcements.create({ type, title, body });
      setRows((prev) => [created, ...prev]);
      setTitle("");
      setBody("");
      setType("normal");
      toast.success(t("announcements.admin.published"));
    } catch (e) {
      // 失败原因来自后端（403 / 400 / 409 active_popup_exists）；原样显示，不猜。
      toast.error(e instanceof Error ? e.message : t("announcements.admin.failed"));
    } finally {
      setPublishing(false);
    }
  };

  const revoke = async (id: number) => {
    setRevokingId(id);
    try {
      const updated = await api.admin.announcements.revoke(id);
      setRows((prev) => prev.map((row) => (row.id === id ? updated : row)));
      toast.success(t("announcements.admin.revoked"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("announcements.admin.failed"));
    } finally {
      setRevokingId(null);
    }
  };

  const titleOk = title.trim().length > 0 && title.trim().length <= TITLE_MAX;
  const bodyOk = body.trim().length > 0 && body.trim().length <= BODY_MAX;

  return (
    <div className="flex flex-col gap-5" data-testid="announcement-admin">
      <Card>
        <CardHeader>
          <CardTitle>{t("announcements.admin.formTitle")}</CardTitle>
          <CardDescription>{t("announcements.admin.formHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="announcement-type">{t("announcements.admin.type")}</Label>
            <div id="announcement-type">
              <OptionSelect<"normal" | "popup">
                value={type}
                onValueChange={setType}
                locale={locale}
                testId="announcement-type"
                options={[
                  { value: "normal", zh: t("announcements.admin.typeNormal"), en: t("announcements.admin.typeNormal") },
                  { value: "popup", zh: t("announcements.admin.typePopup"), en: t("announcements.admin.typePopup") },
                ]}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="announcement-title">{t("announcements.admin.title")}</Label>
            <Input
              id="announcement-title"
              data-testid="announcement-title"
              value={title}
              maxLength={TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("announcements.admin.titlePlaceholder")}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="announcement-body">{t("announcements.admin.body")}</Label>
            {/* 纯文本正文：多行靠 textarea，不做富文本（F6.6）。 */}
            <Textarea
              id="announcement-body"
              data-testid="announcement-body"
              value={body}
              maxLength={BODY_MAX}
              rows={6}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("announcements.admin.bodyPlaceholder")}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={() => void publish()}
              disabled={publishing || !titleOk || !bodyOk}
              data-testid="announcement-publish"
            >
              {publishing ? <Loader2 className="animate-spin" /> : <Megaphone />}
              {t("announcements.admin.publish")}
            </Button>
            <span className="text-xs text-[var(--muted-foreground)]">
              {t("announcements.admin.plainTextHint")}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("announcements.admin.listTitle")}</CardTitle>
          <CardDescription>{t("announcements.admin.listHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {rows.length === 0 && (
            <p className="text-sm text-[var(--muted-foreground)]" data-testid="announcement-admin-empty">
              {t("announcements.admin.empty")}
            </p>
          )}
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex flex-col gap-2 rounded-md border border-[var(--border)] p-4"
              data-testid={`announcement-row-${row.id}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{row.title}</span>
                {isPopup(row) && <Badge variant="secondary">{t("announcements.admin.typePopupShort")}</Badge>}
                {row.revoked_at !== null && (
                  <Badge variant="muted" data-testid={`announcement-revoked-${row.id}`}>
                    {t("announcements.admin.revokedBadge")}
                  </Badge>
                )}
                <span className="text-xs text-[var(--muted-foreground)]">
                  {formatDateTime(row.published_at)}
                </span>
                <div className="ml-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={row.revoked_at !== null || revokingId === row.id}
                    onClick={() => void revoke(row.id)}
                    data-testid={`announcement-revoke-${row.id}`}
                  >
                    {revokingId === row.id ? <Loader2 className="animate-spin" /> : null}
                    {t("announcements.admin.revoke")}
                  </Button>
                </div>
              </div>
              {/* 与用户侧同一条纪律：正文作为文本渲染（自动转义），不是 HTML。 */}
              <p className="whitespace-pre-wrap break-words text-sm text-[var(--muted-foreground)]">{row.body}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
