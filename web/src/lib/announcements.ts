/**
 * V5-WP18.5 —— 公告的前端类型与**展示用**纯函数（契约 F6.6）。
 *
 * 为什么类型不放 `lib/types.ts`：那个文件是**与 prisma schema 对齐的全局类型表**，
 * 由多条线并行编辑。本 WP 的公告类型只被公告组件用到，放在这里可以让两边的改动互不干扰
 * （同一条纪律：一个文件一个所有者）。
 *
 * ── 只做展示，不做判定 ──
 * 「谁看得见」「有没有已读」「哪条是活跃弹窗」全部由后端决定（`GET /api/announcements`
 * 已经把 platform ∪ 本 workspace、未撤回、本用户已读都算好了）。这里只做两件事：
 *   ① 形状校验（拿到的载荷不合法就当作"没有可展示的内容"，**绝不猜**）；
 *   ② 展示排序（弹窗在前，其余按发布时间倒序）。
 *
 * ── 纯文本纪律（DoD7）──
 * 正文一律作为**文本**渲染（`{body}`，React 自动转义），本目录不得出现
 * `dangerouslySetInnerHTML`；后端也不存 HTML（`announcement` 的注释写明了理由）。
 * 那条 DoD7 扫描**先去注释再匹配**（`backend/src/services/__tests__/v5-wp18-announcements.test.ts`），
 * 所以这里写出名字不会让断言变红 —— 有意如此：断言不该惩罚"写清为什么不用它"。
 */
export type AnnouncementType = "normal" | "popup";

export interface Announcement {
  id: number;
  scope_kind: "platform" | "workspace";
  workspace_id: number | null;
  type: string;
  title: string;
  body: string;
  published_at: string;
  revoked_at: string | null;
  dismissed: boolean;
  dismissed_at: string | null;
}

/*
 * 免打扰（`GET/PUT /api/announcements/preferences`）在这里**故意没有类型**：
 * 契约 §9.5 本期不做通知中心前端（偏好矩阵 UI），没有消费者的类型就是死代码。
 * 后端那条线的形状见 `backend/src/services/announcement-mute.ts`。
 */

export function isPopup(announcement: Announcement): boolean {
  return announcement.type === "popup";
}

/**
 * 载荷 → 公告列表。**任何形状不符的行都丢弃**（返回空数组），并保持列表非空校验：
 * 后端返回 `{ error }` / 半截数据时，界面应当"什么都不显示"，而不是渲染 `undefined`。
 */
export function normalizeAnnouncements(payload: unknown): Announcement[] {
  const rows = Array.isArray(payload) ? payload : [];
  const result: Announcement[] = [];
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "number" || typeof row.title !== "string" || typeof row.body !== "string") continue;
    result.push({
      id: row.id,
      scope_kind: row.scope_kind === "platform" ? "platform" : "workspace",
      workspace_id: typeof row.workspace_id === "number" ? row.workspace_id : null,
      type: typeof row.type === "string" ? row.type : "normal",
      title: row.title,
      body: row.body,
      published_at: typeof row.published_at === "string" ? row.published_at : "",
      revoked_at: typeof row.revoked_at === "string" ? row.revoked_at : null,
      dismissed: row.dismissed === true,
      dismissed_at: typeof row.dismissed_at === "string" ? row.dismissed_at : null,
    });
  }
  return result;
}

/**
 * 待展示的公告：**未已读**的（已读的留在这里不显示，但后端仍然返回它们 ——
 * 「你错过了什么」与「什么还存在」是两个问题，回收站式的隐藏不是已读的语义）。
 * 排序：弹窗优先（它是需要立刻看到的），其余按发布时间倒序。
 */
export function pendingAnnouncements(list: readonly Announcement[]): Announcement[] {
  return list
    .filter((item) => !item.dismissed && item.revoked_at === null)
    .slice()
    .sort((a, b) => {
      if (isPopup(a) !== isPopup(b)) return isPopup(a) ? -1 : 1;
      return b.published_at.localeCompare(a.published_at);
    });
}
