"use client";

/**
 * V5-WP18.5 —— 公告的最小展示（契约 §F6.6 / §9.5）。
 *
 * ── 为什么只做"最小展示" ──
 * 契约明令本期**不做通知中心前端**（渠道偏好矩阵 UI / 投递日志租户页，§9.5），
 * 前端只负责把平台/租户的公告**读给人看**：标题、正文、发布时间、一个「知道了」。
 * 弹窗（`type="popup"`）本期也只是"排在最前面 + 一个标记"，不做模态弹窗 ——
 * 定时发布（O7）没拍板，做成模态就会预先假设它。
 *
 * ── 纯文本渲染（DoD7）──
 * 正文用 `{item.body}` 作为 **React 文本节点**渲染（React 自动转义），**没有**
 * `dangerouslySetInnerHTML`：后端也不存 HTML（`services/announcement.ts` 的注释写了
 * 为什么不引入净化器）。DoD7 的可执行形式是"`web/src` 里零 HTML 注入面"，由后端契约测试
 * `v5-wp18-announcements.test.ts` 扫描 —— 它**先去注释再匹配**，所以本注释里写出这个名字
 * 是安全的，也正是应该写的地方：把"为什么不用它"留在代码旁边，比让人从 diff 里猜好得多。
 *
 * ── 三态，缺一不可（与 attention-panel 同一纪律）──
 *   · 有内容 → 列出未已读的公告；
 *   · 没有   → **什么都不渲染**（不占位、不说"暂无公告"）；
 *   · 取不到 → 一句"暂时取不到"。这一态最容易漏：把 `[]` 当成"平台没有话说"，
 *     于是一次 DB/网络抖动会被用户读成"没有公告"。所以 `null` 与 `[]` 必须区分。
 *
 * 数据由服务端组件取（`DashboardBody`，workspace 从 `tunex_workspace` cookie 解析），
 * 本组件只负责「显示」与「标记已读」。已读后 `router.refresh()` 让服务端重取，
 * 不在前端维护第二份"我读过什么"的账本（那正是 C2 禁止的第二份真相）。
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { isPopup, normalizeAnnouncements, pendingAnnouncements, type Announcement } from "@/lib/announcements";

export function AnnouncementBanner({ announcements }: { announcements: Announcement[] | null }) {
  const { t } = useI18n();
  const router = useRouter();
  const [hidden, setHidden] = useState<number[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  // 「取不到」≠「没有公告」：前者要说出来，后者不占版面。
  if (announcements === null) {
    return (
      <p className="text-xs text-[var(--muted-foreground)]" data-testid="announcement-degraded">
        {t("announcements.unavailable")}
      </p>
    );
  }

  // 形状在这里**再校验一次**（服务端已经 `normalizeAnnouncements` 过）：渲染期抛错会把整个
  // Dashboard 拖进 error boundary，一行坏数据不该有这种权力。`normalizeAnnouncements` 是幂等的。
  const pending = pendingAnnouncements(normalizeAnnouncements(announcements)).filter(
    (item) => !hidden.includes(item.id),
  );
  if (pending.length === 0) return null;

  const dismiss = async (id: number) => {
    setBusy(id);
    try {
      await api.announcements.dismiss(id);
      // 乐观隐藏 + 让服务端重取（已读的真相在后端那张表里，这里只是不再显示）。
      setHidden((prev) => [...prev, id]);
      router.refresh();
    } catch {
      // 标记已读失败不阻断阅读：公告留在屏幕上，下次进入页面会再试一次。
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="announcement-banner">
      {pending.map((item) => (
        <Card key={item.id} className={isPopup(item) ? "border-[var(--primary)]" : undefined}>
          <CardContent className="flex flex-col gap-2 pt-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {isPopup(item) && <Badge variant="secondary">{t("announcements.popupBadge")}</Badge>}
                <span className="font-medium">{item.title}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy === item.id}
                onClick={() => void dismiss(item.id)}
                data-testid={`announcement-dismiss-${item.id}`}
              >
                {t("announcements.dismiss")}
              </Button>
            </div>
            {/* 纯文本：正文里的 HTML 在这里只是字符，不会被解析。 */}
            <p className="whitespace-pre-wrap break-words text-sm text-[var(--muted-foreground)]">{item.body}</p>
            <p className="text-xs text-[var(--muted-foreground)]">
              {t("announcements.publishedAt")} {formatDateTime(item.published_at)}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
