/**
 * V5-WP18.5 —— 公告 / 已读 / 弹窗唯一 / `NOTICE` 只读迁移（`services/announcement.ts`）。
 *
 * 覆盖的行为（除最后一段的静态断言外全部离线：注入内存 db 替身，不连 DB / Redis）：
 *   A. **作用域结构**（F6.2 / DoD6）：`platform` 配不上 `workspace_id` —— 类型 + 运行期两道；
 *      漏填、坏 id、越权 workspace 一律拒绝。
 *   B. **可见性**（DoD6）：platform ∪ 本 workspace；B 租户的行对 A 永不可见；
 *      `scope_kind="platform"` 却带 `workspace_id` 的坏行对**任何人**都不可见（fail-closed）。
 *   C. **已读**（F6.5）：每用户一条；重复已读幂等；别人的 workspace 的公告 → 404 且不落行；
 *      已读**不**让公告从列表消失。
 *   D. **弹窗唯一**（F6.3）：同 scope 第二条活跃弹窗被拒（DB 唯一索引的语义模型）；
 *      撤回释放槽位；撤回幂等；跨作用域撤回 → 404。
 *   E. **纯文本**（F6.6 / DoD7）：CRLF/控制字符规范化、超长**拒绝而非截断**、
 *      不做标签剥离（没有第二套自研净化器）、全仓零 `dangerouslySetInnerHTML`。
 *   F. **不抛错**（F4.6 同取向）：db 抛错收敛成 `storage_error`。
 *   G. **迁移静态断言**（DoD8 的离线半边）：只读 `config`、幂等闸门、三张表/索引/外键齐全、
 *      三个 NOTICE 枚举值一个没删且已标 deprecated。**真实 apply（空库 + 存量库）需要 MySQL，
 *      本沙箱没有** ⇒ 归 WP18.7 / 有 DB 的环境，见交付记录。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp18-announcements.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  isNotificationScope,
  platformNotificationScope,
  workspaceNotificationScope,
} from "../notification-facts.ts";
import {
  ANNOUNCEMENT_LIMITS,
  activePopupKey,
  announcementScopeColumns,
  createAnnouncement,
  dismissAnnouncement,
  isAnnouncementScope,
  isAnnouncementType,
  isAnnouncementVisible,
  listAnnouncementsForManagement,
  listVisibleAnnouncements,
  normalizeAnnouncementBody,
  normalizeAnnouncementTitle,
  renderAnnouncementText,
  revokeAnnouncement,
  toAnnouncementView,
  visibleAnnouncementWhere,
  type AnnouncementDb,
  type AnnouncementRow,
} from "../announcement.ts";

/* ================================================================== */
/* 内存 db 替身：**把 DB 的两条唯一索引建成语义模型**                    */
/*   · announcement.active_popup_key 唯一（MySQL 视 NULL 互不相等）      */
/*   · announcement_dismissal(announcement_id, user_id) 唯一            */
/*   · 其余查询按本模块真正发出的 where 形状求值                        */
/* ================================================================== */

const uniqueViolation = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

function makeRow(over: Partial<AnnouncementRow> = {}): AnnouncementRow {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: 1,
    scope_kind: "platform",
    workspace_id: null,
    type: "normal",
    title: "标题",
    body: "正文",
    active_popup_key: null,
    published_at: now,
    revoked_at: null,
    created_by_id: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

interface DismissalRow {
  announcement_id: number;
  user_id: number;
  dismissed_at: Date;
}

function memoryDb(options: { fail?: "create" | "findMany" | "findUnique" | "dismissCreate" | "update" | "all" } = {}) {
  const rows: AnnouncementRow[] = [];
  const dismissals: DismissalRow[] = [];
  let nextId = 1;
  let nextDismissalId = 1;
  const boom = (kind: string) => {
    if (options.fail === "all" || options.fail === kind) throw new Error("db down");
  };

  /** 只实现本模块真正发出的 where 形状；形状不认识就抛错（防止测试替身悄悄放过条件）。 */
  function matches(row: AnnouncementRow, where: Record<string, unknown>): boolean {
    if ("id" in where && where.id !== row.id) return false;
    if ("revoked_at" in where && where.revoked_at === null && row.revoked_at !== null) return false;
    if ("scope_kind" in where && where.scope_kind !== row.scope_kind) return false;
    if ("workspace_id" in where && where.workspace_id !== row.workspace_id) return false;
    if (Array.isArray(where.OR)) {
      const any = (where.OR as Array<Record<string, unknown>>).some((clause) => matches(row, clause));
      if (!any) return false;
    }
    return true;
  }

  const db: AnnouncementDb = {
    announcement: {
      async findMany(args) {
        boom("findMany");
        return rows.filter((row) => matches(row, args.where as Record<string, unknown>));
      },
      async findUnique(args) {
        boom("findUnique");
        const id = (args.where as { id: number }).id;
        return rows.find((row) => row.id === id) ?? null;
      },
      async create(args) {
        boom("create");
        const data = args.data as Partial<AnnouncementRow>;
        // 唯一索引语义：只有**非 NULL** 的 active_popup_key 参与冲突（MySQL 同款）。
        if (
          data.active_popup_key !== null &&
          data.active_popup_key !== undefined &&
          rows.some((row) => row.active_popup_key === data.active_popup_key)
        ) {
          throw uniqueViolation();
        }
        const now = new Date();
        const row = makeRow({
          id: nextId++,
          created_at: now,
          updated_at: now,
          ...data,
        } as Partial<AnnouncementRow>);
        rows.push(row);
        return { ...row };
      },
      async update(args) {
        boom("update");
        const id = (args.where as { id: number }).id;
        const row = rows.find((r) => r.id === id);
        if (!row) throw new Error("row missing");
        Object.assign(row, args.data as Partial<AnnouncementRow>, { updated_at: new Date() });
        return { ...row };
      },
    },
    announcementDismissal: {
      async findMany(args) {
        boom("findMany");
        const where = args.where as { user_id: number; announcement_id: { in: number[] } };
        return dismissals
          .filter((d) => d.user_id === where.user_id && where.announcement_id.in.includes(d.announcement_id))
          .map((d) => ({ announcement_id: d.announcement_id, dismissed_at: d.dismissed_at }));
      },
      async create(args) {
        boom("dismissCreate");
        const data = args.data as { announcement_id: number; user_id: number; dismissed_at: Date };
        if (dismissals.some((d) => d.announcement_id === data.announcement_id && d.user_id === data.user_id)) {
          throw uniqueViolation();
        }
        dismissals.push({ ...data, dismissed_at: data.dismissed_at });
        void nextDismissalId++;
        return { id: nextDismissalId };
      },
    },
  };

  return { db, rows, dismissals };
}

const WS7 = workspaceNotificationScope(7);
const WS9 = workspaceNotificationScope(9);
const PLATFORM = platformNotificationScope();

/* ------------------------------------------------------------------ */
/* A. 作用域结构                                                       */
/* ------------------------------------------------------------------ */

describe("A. 公告作用域：platform 配不上 workspace_id（F6.2 / DoD6）", () => {
  test("作用域类型与 WP18.1 的 `NotificationScope` 是**同一个**判定函数（不是副本）", () => {
    expect(isAnnouncementScope).toBe(isNotificationScope);
  });

  test("唯一转换点：platform 恒配 workspace_id = NULL", () => {
    expect(announcementScopeColumns(PLATFORM)).toEqual({ scope_kind: "platform", workspace_id: null });
    expect(announcementScopeColumns(WS7)).toEqual({ scope_kind: "workspace", workspace_id: 7 });
  });

  test("坏作用域一律拒绝，不落库", async () => {
    const { db, rows } = memoryDb();
    // 类型层面写不出来的形状，从 JSON 边界进来时必须被运行期挡住。
    const forged = { kind: "platform", workspace_id: 7 } as unknown as typeof PLATFORM;
    const result = await createAnnouncement(
      { db, onWarn: () => {} },
      { scope: forged, type: "normal", title: "t", body: "b", userId: 1 },
    );
    expect(result).toEqual({ ok: false, code: "invalid_scope", error: expect.any(String) });
    expect(rows.length).toBe(0);
  });

  test("枚举与类型闭集：`upgrade_popup` 不在其中（O3 不移植）", () => {
    expect(isAnnouncementType("normal")).toBe(true);
    expect(isAnnouncementType("popup")).toBe(true);
    expect(isAnnouncementType("upgrade_popup")).toBe(false);
    const { db, rows } = memoryDb();
    return createAnnouncement(
      { db, onWarn: () => {} },
      { scope: WS7, type: "upgrade_popup", title: "t", body: "b", userId: 1 },
    ).then((result) => {
      expect(result.ok).toBe(false);
      expect(rows.length).toBe(0);
    });
  });
});

/* ------------------------------------------------------------------ */
/* B. 可见性                                                           */
/* ------------------------------------------------------------------ */

describe("B. 可见性：platform ∪ 本 workspace，其它租户永不返回（DoD6）", () => {
  const rows: AnnouncementRow[] = [
    makeRow({ id: 1, scope_kind: "platform", workspace_id: null }),
    makeRow({ id: 2, scope_kind: "workspace", workspace_id: 7 }),
    makeRow({ id: 3, scope_kind: "workspace", workspace_id: 9 }),
    makeRow({ id: 4, scope_kind: "platform", workspace_id: null, revoked_at: new Date() }),
    // 坏行：platform 却带 workspace_id。既不该对所有人可见，也不该落进 9 号租户。
    makeRow({ id: 5, scope_kind: "platform", workspace_id: 9 }),
  ];

  test("查询条件与行级判定都排除越界数据", () => {
    expect(visibleAnnouncementWhere(7)).toEqual({
      revoked_at: null,
      OR: [
        { scope_kind: "platform", workspace_id: null },
        { scope_kind: "workspace", workspace_id: 7 },
      ],
    });
    expect(rows.filter((row) => isAnnouncementVisible(row, 7)).map((r) => r.id)).toEqual([1, 2]);
    expect(rows.filter((row) => isAnnouncementVisible(row, 9)).map((r) => r.id)).toEqual([1, 3]);
    // 坏行 id=5 对任何租户都不可见。
    expect(rows.filter((row) => isAnnouncementVisible(row, 9)).some((r) => r.id === 5)).toBe(false);
  });

  test("A 的列表里没有 B 的公告；platform 公告对两者都可见", async () => {
    const { db } = memoryDb();
    db.announcement.findMany = async (args) =>
      rows.filter((row) => {
        const where = args.where as { revoked_at: null; OR: Array<Record<string, unknown>> };
        if (where.revoked_at === null && row.revoked_at !== null) return false;
        return where.OR.some((clause) =>
          Object.entries(clause).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value),
        );
      });

    const forSeven = await listVisibleAnnouncements({ db, onWarn: () => {} }, { scope: WS7, userId: 42 });
    const forNine = await listVisibleAnnouncements({ db, onWarn: () => {} }, { scope: WS9, userId: 42 });
    expect(forSeven.ok && forSeven.value.map((a) => a.id)).toEqual([1, 2]);
    expect(forNine.ok && forNine.value.map((a) => a.id)).toEqual([1, 3]);
    // 7 号租户永远看不到 9 号那两条（id=3 与坏行 id=5）。
    expect(forSeven.ok && forSeven.value.map((a) => a.id)).not.toContain(3);
    expect(forSeven.ok && forSeven.value.map((a) => a.id)).not.toContain(5);
  });

  test("platform 作用域不能当租户读入参（读路径要求 workspace）", async () => {
    const { db } = memoryDb();
    const result = await listVisibleAnnouncements({ db, onWarn: () => {} }, { scope: PLATFORM, userId: 1 });
    expect(result.ok).toBe(false);
  });

  test("管理列表按**恰好**本作用域取，不混 platform（可见 ⊋ 可管理）", async () => {
    const { db, rows: stored } = memoryDb();
    await stored.push(makeRow({ id: 11, scope_kind: "workspace", workspace_id: 7 }));
    await stored.push(makeRow({ id: 12, scope_kind: "platform", workspace_id: null }));
    const managed = await listAnnouncementsForManagement({ db, onWarn: () => {} }, WS7);
    expect(managed.ok && managed.value.map((a) => a.id)).toEqual([11]);
    const platform = await listAnnouncementsForManagement({ db, onWarn: () => {} }, PLATFORM);
    expect(platform.ok && platform.value.map((a) => a.id)).toEqual([12]);
  });
});

/* ------------------------------------------------------------------ */
/* C. 已读                                                             */
/* ------------------------------------------------------------------ */

describe("C. 已读：每用户一条、幂等、不跨租户（F6.5）", () => {
  test("标记已读 → 列表带 dismissed；重复已读 = already:true 且不新增行", async () => {
    const { db, rows, dismissals } = memoryDb();
    rows.push(makeRow({ id: 1, scope_kind: "platform", workspace_id: null }));

    const first = await dismissAnnouncement({ db, onWarn: () => {} }, { scope: WS7, userId: 42, announcementId: 1 });
    expect(first.ok && first.value.already).toBe(false);
    expect(dismissals.length).toBe(1);

    const second = await dismissAnnouncement({ db, onWarn: () => {} }, { scope: WS7, userId: 42, announcementId: 1 });
    expect(second.ok && second.value.already).toBe(true);
    expect(dismissals.length).toBe(1);

    const mine = await listVisibleAnnouncements({ db, onWarn: () => {} }, { scope: WS7, userId: 42 });
    expect(mine.ok && mine.value[0]!.dismissed).toBe(true);
    // 已读 ≠ 删除：公告仍在列表里（"你错过了什么"与"什么还存在"是两个问题）。
    expect(mine.ok && mine.value.length).toBe(1);
  });

  test("另一个用户不受影响（已读是每用户一条，不是全局标志）", async () => {
    const { db, rows } = memoryDb();
    rows.push(makeRow({ id: 1, scope_kind: "platform", workspace_id: null }));
    await dismissAnnouncement({ db, onWarn: () => {} }, { scope: WS7, userId: 42, announcementId: 1 });
    const other = await listVisibleAnnouncements({ db, onWarn: () => {} }, { scope: WS7, userId: 43 });
    expect(other.ok && other.value[0]!.dismissed).toBe(false);
  });

  test("不可见的公告 = 404，且**不写**已读行（不泄露别的租户有没有这条）", async () => {
    const { db, rows, dismissals } = memoryDb();
    rows.push(makeRow({ id: 3, scope_kind: "workspace", workspace_id: 9 }));
    const result = await dismissAnnouncement({ db, onWarn: () => {} }, { scope: WS7, userId: 42, announcementId: 3 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("not_found");
    expect(dismissals.length).toBe(0);
    // 不存在的 id 得到**同一个**错误码（不可区分）。
    const missing = await dismissAnnouncement({ db, onWarn: () => {} }, { scope: WS7, userId: 42, announcementId: 999 });
    expect(!missing.ok && missing.code).toBe("not_found");
  });

  test("撤回后的公告不能补标记已读（撤回即对用户不存在）", async () => {
    const { db, rows } = memoryDb();
    rows.push(makeRow({ id: 1, scope_kind: "platform", workspace_id: null, revoked_at: new Date() }));
    const result = await dismissAnnouncement({ db, onWarn: () => {} }, { scope: WS7, userId: 42, announcementId: 1 });
    expect(!result.ok && result.code).toBe("not_found");
  });
});

/* ------------------------------------------------------------------ */
/* D. 弹窗唯一                                                         */
/* ------------------------------------------------------------------ */

describe("D. 弹窗：同 scope 只允许一条活跃（F6.3，DB 唯一索引兜底）", () => {
  test("活跃弹窗键是结构化标量，platform 与 workspace 各占一格", () => {
    expect(activePopupKey(PLATFORM)).toBe("popup:global");
    expect(activePopupKey(WS7)).toBe("popup:7");
    expect(activePopupKey(WS7)).not.toBe(activePopupKey(WS9));
  });

  test("第二条活跃弹窗被拒（唯一索引），normal 公告不受影响", async () => {
    const { db, rows } = memoryDb();
    const first = await createAnnouncement(
      { db, onWarn: () => {} },
      { scope: WS7, type: "popup", title: "维护", body: "今晚", userId: 1 },
    );
    expect(first.ok).toBe(true);
    expect(first.ok && first.value.revoked_at).toBeNull();

    const second = await createAnnouncement(
      { db, onWarn: () => {} },
      { scope: WS7, type: "popup", title: "再来一条", body: "并发", userId: 1 },
    );
    expect(!second.ok && second.code).toBe("active_popup_exists");

    // 多租户互不干扰：9 号租户的弹窗不受 7 号影响。
    const other = await createAnnouncement(
      { db, onWarn: () => {} },
      { scope: WS9, type: "popup", title: "9 号", body: "b", userId: 1 },
    );
    expect(other.ok).toBe(true);

    // normal 公告不带活跃键 ⇒ 可以有很多条（NULL 互不冲突）。
    const normal1 = await createAnnouncement(
      { db, onWarn: () => {} },
      { scope: WS7, type: "normal", title: "n1", body: "b", userId: 1 },
    );
    const normal2 = await createAnnouncement(
      { db, onWarn: () => {} },
      { scope: WS7, type: "normal", title: "n2", body: "b", userId: 1 },
    );
    expect(normal1.ok && normal1.value.id).toBeDefined();
    expect(normal2.ok).toBe(true);
    expect(rows.filter((r) => r.active_popup_key === null).length).toBe(2);
  });

  test("撤回释放槽位：撤回后可以再发一条弹窗", async () => {
    const { db } = memoryDb();
    const first = await createAnnouncement(
      { db, onWarn: () => {} },
      { scope: WS7, type: "popup", title: "A", body: "b", userId: 1 },
    );
    expect(first.ok).toBe(true);
    const id = first.ok ? first.value.id : 0;
    const revoked = await revokeAnnouncement({ db, onWarn: () => {} }, { scope: WS7, announcementId: id });
    expect(revoked.ok && revoked.value.revoked_at).not.toBeNull();
    const again = await createAnnouncement(
      { db, onWarn: () => {} },
      { scope: WS7, type: "popup", title: "B", body: "b", userId: 1 },
    );
    expect(again.ok).toBe(true);
  });

  test("撤回幂等：重复撤回不改首次撤回时刻", async () => {
    const { db } = memoryDb();
    const created = await createAnnouncement(
      { db, onWarn: () => {} },
      { scope: WS7, type: "normal", title: "A", body: "b", userId: 1 },
    );
    const id = created.ok ? created.value.id : 0;
    const at = new Date("2026-02-02T00:00:00.000Z");
    const first = await revokeAnnouncement({ db, onWarn: () => {} }, { scope: WS7, announcementId: id, now: at });
    const second = await revokeAnnouncement(
      { db, onWarn: () => {} },
      { scope: WS7, announcementId: id, now: new Date("2026-03-03T00:00:00.000Z") },
    );
    expect(first.ok && first.value.revoked_at).toBe(at.toISOString());
    expect(second.ok && second.value.revoked_at).toBe(at.toISOString());
  });

  test("撤回要求作用域**恰好相等**：租户撤不掉平台公告，平台撤不掉租户公告", async () => {
    const { db, rows } = memoryDb();
    rows.push(makeRow({ id: 21, scope_kind: "platform", workspace_id: null }));
    rows.push(makeRow({ id: 22, scope_kind: "workspace", workspace_id: 7 }));
    const tenantTriesPlatform = await revokeAnnouncement({ db, onWarn: () => {} }, { scope: WS7, announcementId: 21 });
    expect(!tenantTriesPlatform.ok && tenantTriesPlatform.code).toBe("not_found");
    const platformTriesTenant = await revokeAnnouncement({ db, onWarn: () => {} }, { scope: PLATFORM, announcementId: 22 });
    expect(!platformTriesTenant.ok && platformTriesTenant.code).toBe("not_found");
    // 两条都还在（撤回是"未发生"，不是"改错了"）。
    expect(rows.every((row) => row.revoked_at === null)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* E. 纯文本（F6.6 / DoD7）                                            */
/* ------------------------------------------------------------------ */

describe("E. 正文是纯文本：规范化 + 拒绝超长 + 不做标签剥离（F6.6 / DoD7）", () => {
  test("CRLF → LF、控制字符剥除、行尾空白清理", () => {
    expect(normalizeAnnouncementBody("第一行\r\n第二行\t \r\n\r\n\u0007尾")).toBe("第一行\n第二行\n\n尾");
  });

  test("标题是单行；超长**拒绝**而不是静默截断", () => {
    expect(normalizeAnnouncementTitle("  多行\n标题  ")).toBe("多行 标题");
    expect(normalizeAnnouncementTitle("x".repeat(ANNOUNCEMENT_LIMITS.TITLE_MAX))).not.toBeNull();
    expect(normalizeAnnouncementTitle("x".repeat(ANNOUNCEMENT_LIMITS.TITLE_MAX + 1))).toBeNull();
    expect(normalizeAnnouncementTitle("")).toBeNull();
    expect(normalizeAnnouncementTitle(undefined)).toBeNull();
    expect(normalizeAnnouncementBody("x".repeat(ANNOUNCEMENT_LIMITS.BODY_MAX + 1))).toBeNull();
  });

  test("**没有**自研净化器：HTML 原样保留为文本（渲染面才是防线）", async () => {
    const { db } = memoryDb();
    const raw = '<script>alert(1)</script>\n<img src=x onerror=alert(2)>';
    const result = await createAnnouncement(
      { db, onWarn: () => {} },
      { scope: WS7, type: "normal", title: "标题", body: raw, userId: 1 },
    );
    // 原样保存：正文是给人读的文本，服务端不做"看起来安全"的裁剪（§2.2 已论证正则净化器的失效面）。
    expect(result.ok && result.value.body).toBe(raw);
    // 下发出去的内容也不含任何 HTML 包装（纯文本渲染的前提）。
    const rendered = renderAnnouncementText({
      title: "标题",
      body: raw,
      type: "normal",
      published_at: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(rendered.subject).toBe("[TuneX][公告] 标题");
    expect(rendered.text).toContain(raw);
    expect(rendered.text.startsWith("标题\n")).toBe(true);
  });

  /* ---------------------------------------------------------------- */
  /* DoD7：web/src 零 HTML 注入面                                     */
  /*                                                                  */
  /* 口径是「**去注释后**零命中」，不是「文件里零出现」——             */
  /* 理由见下方 `stripTsComments` 的注释（Lead 2026-10-05 的可执行反馈）*/
  /* ---------------------------------------------------------------- */

  const INJECTION_ATTRIBUTE = /dangerouslySetInnerHTML/;

  /**
   * 去掉 TS/TSX 的注释：行注释、块注释、JSX 注释（`{/* … *\/}` 也是块注释形态）。
   *
   * ── 为什么必须去注释（而不是让注释别写这几个字）──
   * 这条断言的本意是「没有 XSS 注入面」。第一版直接 `src.includes(...)`，命中的**全是**
   * 解释「我们没有用它、为什么不用」的注释 —— 一个把好行为（写清为什么不用）逼走的断言，
   * 错的是断言。所以口径改成：**注释里的字不算命中，代码里的算**。
   *
   * ── 为什么不是"一行正则删注释"──
   * 朴素做法（逐行 `/\/\/.*$/`）会把字符串里的 `//` 之后的内容一起删掉，
   * 于是 `title="https://x" dangerouslySetInnerHTML=…` 这种**真命中**会被漏掉
   * （`URL` 字符串在 web 代码里很常见，这条不是假想）。所以这里走一个最小的状态机：
   * 认出 `'` / `"` / `` ` `` 三种字符串与转义，只在**代码态**下识别注释。
   * 已知不做：正则字面量（`/.../`）里的 `//` 会被当成行注释（会少算一点），
   * 模板串 `${}` 不做嵌套解析。方向都是**更保守地找命中**，因此下一条自检必须钉住
   * 「真代码里的必须算命中」。
   */
  function stripTsComments(source: string): string {
    let out = "";
    let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i]!;
      const next = source[i + 1];
      if (mode === "code") {
        if (ch === "/" && next === "/") {
          mode = "line";
          i += 1;
          continue;
        }
        if (ch === "/" && next === "*") {
          mode = "block";
          i += 1;
          continue;
        }
        out += ch;
        if (ch === "'") mode = "single";
        else if (ch === '"') mode = "double";
        else if (ch === "`") mode = "template";
        continue;
      }
      if (mode === "line") {
        if (ch === "\n") {
          mode = "code";
          out += ch;
        }
        continue;
      }
      if (mode === "block") {
        if (ch === "*" && next === "/") {
          mode = "code";
          i += 1;
        }
        continue;
      }
      // 字符串态：内容留在 out 里（它是代码），但转义与收尾要认出来。
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
        continue;
      }
      if ((mode === "single" && ch === "'") || (mode === "double" && ch === '"') || (mode === "template" && ch === "`")) {
        mode = "code";
      }
    }
    return out;
  }

  /**
   * 递归扫描 `web/src`：返回**代码中**使用 HTML 注入属性的文件，以及扫了多少个文件
   * （后者用来防"路径写错 ⇒ 一个文件都没扫 ⇒ 零命中 ⇒ 假通过"）。
   */
  function scanWebForUnsafeHtml(): { hits: string[]; scanned: number } {
    const webSrc = fileURLToPath(new URL("../../../../web/src/", import.meta.url));
    const hits: string[] = [];
    let scanned = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) {
          scanned += 1;
          if (INJECTION_ATTRIBUTE.test(stripTsComments(readFileSync(full, "utf8")))) hits.push(full);
        }
      }
    };
    walk(webSrc);
    return { hits, scanned };
  }

  test("DoD7 口径自检（守卫不空转）：注释里的字不算命中，代码里的算", () => {
    // ① 只在注释里出现 → 必须**不**命中（否则下一个人为了变绿会去删掉解释性注释）。
    const commentOnly = [
      "// 我们不用 dangerouslySetInnerHTML，因为它引入 XSS 面",
      "/* 同理：dangerouslySetInnerHTML 全仓零命中 */",
      "/** 文档注释里也说一次：dangerouslySetInnerHTML 是禁用项 */",
      "{/* JSX 注释里提到 dangerouslySetInnerHTML 也不算 */}",
      "} // 行尾注释再说一次 dangerouslySetInnerHTML",
    ].join("\n");
    expect(stripTsComments(commentOnly)).not.toMatch(INJECTION_ATTRIBUTE);

    // ② 真代码里出现 → 必须命中（否则这条守卫会静默失效）。
    const realUsage = '<div dangerouslySetInnerHTML={{ __html: body }} />';
    expect(stripTsComments(realUsage)).toMatch(INJECTION_ATTRIBUTE);

    // ③ 最容易漏的一种：同一行前面有含 `//` 的字符串（URL），朴素的行注释正则会把真命中一起删掉。
    const afterUrlString =
      '<a title="https://example.com" dangerouslySetInnerHTML={{ __html: body }} />';
    expect(stripTsComments(afterUrlString)).toMatch(INJECTION_ATTRIBUTE);

    // ④ 反过来：字符串里的字（不是属性位置）会被保留，属于"宁可多报"的方向 —— 记录下来，
    //    免得下一个人以为这是漏报而去把状态机改宽。
    expect(stripTsComments('const label = "dangerouslySetInnerHTML";')).toMatch(INJECTION_ATTRIBUTE);
  });

  test("DoD7：`web/src` 里零 HTML 注入属性（去注释后；保持今天的状态）", () => {
    const { hits, scanned } = scanWebForUnsafeHtml();
    // 非空转的另一半：扫描确实读到了文件（路径写错会让它"零命中"地假通过）。
    expect(scanned, "扫到的 web/src 文件数为 0 ⇒ 扫描路径失效，这条断言等于没跑").toBeGreaterThan(50);
    expect(
      hits,
      "这些文件在代码里把字符串当 HTML 插入：web/src 必须保持零命中（DoD7）",
    ).toEqual([]);
  });

  test("视图不下发 `created_by_id`（少一个可枚举字段）", () => {
    const view = toAnnouncementView(makeRow({ created_by_id: 5 }), null);
    expect(Object.keys(view).sort()).toEqual([
      "body",
      "dismissed",
      "dismissed_at",
      "id",
      "published_at",
      "revoked_at",
      "scope_kind",
      "title",
      "type",
      "workspace_id",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* F. 失败可见但不拖挂主业务                                            */
/* ------------------------------------------------------------------ */

describe("F. db 不可用 → storage_error（永不抛出）", () => {
  test("列表 / 发布 / 已读三条路径都收敛成结果", async () => {
    const warnings: string[] = [];
    const deps = { db: memoryDb({ fail: "all" }).db, onWarn: (m: string) => warnings.push(m) };
    const listed = await listVisibleAnnouncements(deps, { scope: WS7, userId: 1 });
    expect(!listed.ok && listed.code).toBe("storage_error");
    const created = await createAnnouncement(deps, { scope: WS7, type: "normal", title: "t", body: "b", userId: 1 });
    expect(!created.ok && created.code).toBe("storage_error");
    const dismissed = await dismissAnnouncement(deps, { scope: WS7, userId: 1, announcementId: 1 });
    expect(!dismissed.ok && dismissed.code).toBe("storage_error");
    expect(warnings.length).toBe(3);
  });

  test("唯一索引冲突被识别为业务拒绝（复用 WP18.2 的 `isUniqueViolation`）", async () => {
    const { db } = memoryDb();
    await createAnnouncement(depsOf(db), { scope: PLATFORM, type: "popup", title: "a", body: "b", userId: 1 });
    const clash = await createAnnouncement(depsOf(db), { scope: PLATFORM, type: "popup", title: "b", body: "b", userId: 1 });
    expect(!clash.ok && clash.code).toBe("active_popup_exists");
  });
});

function depsOf(db: AnnouncementDb) {
  return { db, onWarn: () => {} };
}

/* ------------------------------------------------------------------ */
/* G. 迁移静态断言（DoD8 的离线半边）                                   */
/* ------------------------------------------------------------------ */

const MIGRATION_PATH = new URL(
  "../../../prisma/migrations/20261033000000_v5_wp18_announcements/migration.sql",
  import.meta.url,
);
const SCHEMA_PATH = new URL("../../../prisma/schema.prisma", import.meta.url);

describe("G. `NOTICE` 只读迁移 + 建表（DoD8）", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  test("建三张表 + 两条唯一索引 + 一条外键（外键只指向本 WP 自己的表）", () => {
    for (const table of ["announcement", "announcement_dismissal", "notification_mute"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE \`${table}\``));
    }
    expect(sql).toMatch(/UNIQUE INDEX `announcement_active_popup_key`\(`active_popup_key`\)/);
    expect(sql).toMatch(/UNIQUE INDEX `announcement_dismissal_unique`\(`announcement_id`, `user_id`\)/);
    expect(sql).toMatch(/UNIQUE INDEX `notification_mute_unique`\(`user_id`, `channel_kind`, `category`\)/);
    expect(sql).toMatch(/FOREIGN KEY \(`announcement_id`\) REFERENCES `announcement`\(`id`\) ON DELETE CASCADE/);
    // 一个 DB ENUM 列都不新增（F5/§9.8 的口径：ENUM 增删值会让旧二进制崩）。
    expect(sql).not.toMatch(/^\s+`[a-z_]+`\s+ENUM\(/im);
  });

  test("**只读** `config`：没有任何一条语句写它", () => {
    for (const forbidden of [
      /UPDATE\s+`config`/i,
      /INSERT\s+INTO\s+`config`/i,
      /DELETE\s+FROM\s+`config`/i,
      /ALTER\s+TABLE\s+`config`/i,
      /DROP\s+TABLE\s+`config`/i,
      /TRUNCATE/i,
    ]) {
      expect(sql).not.toMatch(forbidden);
    }
    // 它确实读了 `config`（否则"只读迁移"就成了空话）。
    expect(sql).toMatch(/FROM `config` c/);
    expect(sql).toMatch(/c\.`name` = 'NOTICE'/);
  });

  test("非空 NOTICE → 一条 platform normal 公告；空白值不迁", () => {
    expect(sql).toMatch(/TRIM\(c\.`value`\) <> ''/);
    expect(sql).toMatch(/'platform', NULL, 'normal', '站点公告'/);
    // 发布时间来自来源表（不是 CURRENT_TIMESTAMP 顶替）。
    expect(sql).toMatch(/COALESCE\(c\.`updated_at`, c\.`created_at`, CURRENT_TIMESTAMP\(3\)\)/);
    // 作者留 NULL（旧键没有作者，不猜）。
    expect(sql).toMatch(/b\.`published_at`, NULL, NULL, CURRENT_TIMESTAMP\(3\)/);
  });

  test("幂等闸门：判据挂在临时表上（MySQL 禁止 INSERT 的目标表出现在自己的子查询里）", () => {
    expect(sql).toMatch(/CREATE TEMPORARY TABLE `_wp18_notice_backfill`/);
    expect(sql).toMatch(/DROP TEMPORARY TABLE `_wp18_notice_backfill`/);
    expect(sql).toMatch(/AND NOT EXISTS \(\s*SELECT 1\s*FROM `announcement` a/);
    // 回填语句的目标表不能同时出现在自己的子查询里（手册 13.2.5.1 的限制）。
    const backfill = sql.slice(sql.indexOf("INSERT INTO `announcement`"));
    expect(backfill).not.toMatch(/NOT EXISTS/);
  });

  test("列集合与 schema.prisma 的模型对齐（漂移的最小提醒）", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    const modelOf = (name: string): string => {
      const start = schema.indexOf(`model ${name} {`);
      expect(start).toBeGreaterThan(-1);
      return schema.slice(start, schema.indexOf("\n}", start));
    };
    const columnsOf = (table: string): string[] => {
      const start = sql.indexOf(`CREATE TABLE \`${table}\``);
      const block = sql.slice(start, sql.indexOf("PRIMARY KEY", start));
      return [...block.matchAll(/^\s+`([a-z_]+)`\s+(?:INTEGER|VARCHAR|TEXT|DATETIME|BOOLEAN)/gm)].map((m) => m[1]!);
    };
    for (const [model, table] of [
      ["Announcement", "announcement"],
      ["AnnouncementDismissal", "announcement_dismissal"],
      ["NotificationMute", "notification_mute"],
    ] as const) {
      const modelSrc = modelOf(model);
      for (const column of columnsOf(table)) {
        // schema 里的字段名与列名一一对应（本 WP 三张表都不需要 @map 改名）。
        expect(modelSrc).toMatch(new RegExp(`\\b${column}\\b`));
      }
      expect(modelSrc).toMatch(new RegExp(`@@map\\("${table}"\\)`));
    }
  });

  test("三个 NOTICE 枚举值一个都没删，且都标了 deprecated（§9.8 / F6.7）", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    const enumStart = schema.indexOf("enum SystemConfigName {");
    const enumBody = schema.slice(enumStart, schema.indexOf("\n}", enumStart));
    for (const key of ["NOTICE", "NOTICE_POPUP", "NOTICE_POPUP_INTERVAL_HOURS"]) {
      expect(enumBody).toMatch(new RegExp(`^\\s+${key}$`, "m"));
      // 紧邻上方必须有 @deprecated（"标 deprecated"是可断言的，不是口头承诺）。
      expect(enumBody).toMatch(new RegExp(`@deprecated[^\\n]*\\n(?:\\s+\\/\\/\\/[^\\n]*\\n)*\\s+${key}$`, "m"));
    }
  });

  test("公开下发面不再把 `NOTICE*` 当公告来源（R3：不留两份公告真相）", () => {
    const publicRoutes = readFileSync(new URL("../../routes/public.ts", import.meta.url), "utf8");
    const whitelistStart = publicRoutes.indexOf('publicRoutes.get("/system/config/site"');
    const handler = publicRoutes.slice(whitelistStart, publicRoutes.indexOf("return c.json({ data });", whitelistStart));
    expect(handler).not.toMatch(/"NOTICE/);
    expect(handler).toMatch(/"SITE_NAME"/);
  });
});
