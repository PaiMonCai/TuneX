/**
 * V5-WP18.7 —— DoD6：公告跨租户 + 弹窗唯一约束（**真实 MySQL**，契约 §8 收口）。
 *
 * 单测（`v5-wp18-announcements.test.ts`）用内存替身建模了"唯一索引的语义"；这里跑真的 MySQL，
 * 回答三件只有真库能回答的事：
 *   ① 可见性条件在**真 SQL** 上经得起跨租户夹具（platform ∪ 本 workspace，其它永不返回）；
 *   ② `platform ⟹ workspace_id NULL` 是**类型 + 唯一转换点**保证的（没有 DB CHECK）；
 *      所以这里额外验证它的**兜底方向**：手工插一条 `platform` 却带 `workspace_id` 的坏行，
 *      它对**任何**租户都不可见（坏行的代价被限制在"读不到"，而不是"泄露给某个租户"）。
 *   ③ 弹窗唯一是**真的被 DB 拒绝**的：用 raw SQL 再插一条同 `active_popup_key` 的行会 duplicate key
 *      —— 这是契约 F6.3「用 DB 唯一约束表达」的结构性证据（Forwardx 没约束，并发下留两条）。
 *
 * 需要真实依赖：`TUNEX_DB_TEST=1` + `DATABASE_URL`（无则整份跳过）。
 * 跑法：`TUNEX_DB_TEST=1 DATABASE_URL=... bun test tests/v5-wp18-announcement-tenant-db.test.mjs`
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db.ts";
import {
  createAnnouncement,
  dismissAnnouncement,
  listVisibleAnnouncements,
  revokeAnnouncement,
} from "../src/services/announcement.ts";
import { workspaceNotificationScope } from "../src/services/notification-facts.ts";
import { replaceUserMutes } from "../src/services/announcement-mute.ts";

const ENABLED = process.env.TUNEX_DB_TEST === "1";
const WS_A = workspaceNotificationScope(9901);
const WS_B = workspaceNotificationScope(9902);
const PLATFORM = { kind: "platform", workspace_id: null };
const CREATED_IDS = new Set();
const TEST_WORKSPACES = [9901, 9902];
const TEST_USERS = [19901, 19902];

const announce = async (scope, over = {}) => {
  const result = await createAnnouncement(
    { db },
    { scope, type: "normal", title: "t", body: "b", userId: null, ...over },
  );
  assert.equal(result.ok, true, `建公告失败：${JSON.stringify(result)}`);
  CREATED_IDS.add(result.value.id);
  return result.value;
};

after(async () => {
  await db.announcementDismissal.deleteMany({
    where: { OR: [{ announcement_id: { in: [...CREATED_IDS] } }, { user_id: { in: TEST_USERS } }] },
  });
  await db.announcement.deleteMany({
    where: { OR: [{ id: { in: [...CREATED_IDS] } }, { workspace_id: { in: TEST_WORKSPACES } }] },
  });
  // 坏行/平台行按标题标记清理（它们不在 CREATED_IDS 里）。
  await db.$executeRawUnsafe(`DELETE FROM announcement WHERE title LIKE 'wp18-%'`);
  await db.notificationMute.deleteMany({ where: { user_id: { in: TEST_USERS } } });
  await db.$disconnect();
});

test("DoD6 -- 可见性：platform ∪ 本 workspace；B 的公告对 A 永不返回", { skip: !ENABLED }, async () => {
  const platform = await announce(PLATFORM, { title: "wp18-platform" });
  const forA = await announce(WS_A, { title: "wp18-a" });
  const forB = await announce(WS_B, { title: "wp18-b" });

  const listA = await listVisibleAnnouncements({ db }, { scope: WS_A, userId: TEST_USERS[0] });
  const listB = await listVisibleAnnouncements({ db }, { scope: WS_B, userId: TEST_USERS[0] });
  assert.equal(listA.ok && listB.ok, true);
  const idsA = listA.value.map((a) => a.id);
  const idsB = listB.value.map((a) => a.id);

  assert.ok(idsA.includes(platform.id), "platform 公告对 A 可见");
  assert.ok(idsB.includes(platform.id), "platform 公告对 B 可见");
  assert.ok(idsA.includes(forA.id) && idsB.includes(forB.id));
  assert.equal(idsA.includes(forB.id), false, "A 看不到 B 的公告");
  assert.equal(idsB.includes(forA.id), false, "B 看不到 A 的公告");
  // 作用域列也如实下发（前端据此区分平台/租户来源）。
  assert.equal(listA.value.find((a) => a.id === platform.id).scope_kind, "platform");
  assert.equal(listA.value.find((a) => a.id === platform.id).workspace_id, null);
});

test("DoD6 -- 坏行兜底：手工插入 platform+workspace_id 的行对任何租户都不可见", { skip: !ENABLED }, async () => {
  // 服务层的写路径造不出这种行（判别联合 + 唯一转换点 + 运行期校验）；这里故意绕过它，
  // 验证"万一库里出现坏行"时**读侧**的兜底方向是 fail-closed（谁都看不到），而不是泄给某个租户。
  await db.$executeRawUnsafe(
    `INSERT INTO announcement (scope_kind, workspace_id, type, title, body, active_popup_key, published_at, created_at, updated_at)
     VALUES ('platform', 9902, 'normal', 'wp18-bad-row', 'bad', NULL, NOW(3), NOW(3), NOW(3))`,
  );
  const bad = await db.announcement.findFirst({ where: { title: "wp18-bad-row" } });
  assert.ok(bad, "夹具插入成功");

  for (const scope of [WS_A, WS_B, PLATFORM]) {
    const listed = await listVisibleAnnouncements({ db }, { scope, userId: TEST_USERS[0] });
    if (!listed.ok) continue; // platform 作用域本来就不做用户侧读（返回 invalid_scope）
    assert.equal(listed.value.some((a) => a.id === bad.id), false, "坏行对任何租户都不可见");
  }
  // 直接已读也不行（不可见 = 不存在，避免变成"这个 id 在不在"的探测器）。
  const dismissed = await dismissAnnouncement({ db }, { scope: WS_A, userId: TEST_USERS[0], announcementId: bad.id });
  assert.equal(dismissed.ok, false);
  assert.equal(dismissed.code, "not_found");
});

test("DoD6 -- 弹窗唯一索引由**真 MySQL**拒绝第二条活跃弹窗", { skip: !ENABLED }, async () => {
  const first = await createAnnouncement(
    { db },
    { scope: WS_A, type: "popup", title: "wp18-popup-1", body: "b", userId: null },
  );
  assert.equal(first.ok, true);
  CREATED_IDS.add(first.value.id);

  const second = await createAnnouncement(
    { db },
    { scope: WS_A, type: "popup", title: "wp18-popup-2", body: "b", userId: null },
  );
  assert.equal(second.ok, false);
  assert.equal(second.code, "active_popup_exists", "服务层把 P2002 收敛成业务拒绝");

  // 结构性证据：绕过服务层、用 raw SQL 再插一条同 `active_popup_key` 的行也**插不进去**。
  let rejected = false;
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO announcement (scope_kind, workspace_id, type, title, body, active_popup_key, published_at, created_at, updated_at)
       VALUES ('workspace', 9901, 'popup', 'wp18-popup-raw', 'b', 'popup:9901', NOW(3), NOW(3), NOW(3))`,
    );
  } catch (err) {
    rejected = true;
    assert.ok(
      err.code === "P2002" || /Duplicate entry/i.test(String(err.message)),
      `必须是唯一键冲突：${err.code} ${err.message}`,
    );
  }
  assert.equal(rejected, true, "唯一索引必须真的挡住第二条活跃弹窗");

  // NULL 语义：normal 行（active_popup_key = NULL）之间**不冲突** —— 这正是
  // 「为什么不用 @@unique([scope_kind, workspace_id, type])」的实证（MySQL 里 NULL 互不相等）。
  const n1 = await announce(WS_A, { title: "wp18-normal-1" });
  const n2 = await announce(WS_A, { title: "wp18-normal-2" });
  assert.notEqual(n1.id, n2.id);

  // 撤回释放槽位（清 NULL）⇒ 可以再发一条弹窗。
  const revoked = await revokeAnnouncement({ db }, { scope: WS_A, announcementId: first.value.id });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.value.revoked_at !== null, true);
  const again = await createAnnouncement(
    { db },
    { scope: WS_A, type: "popup", title: "wp18-popup-3", body: "b", userId: null },
  );
  assert.equal(again.ok, true, "撤回后槽位必须被释放");
  CREATED_IDS.add(again.value.id);
});

test("DoD6 -- 已读是每用户一条（真唯一索引）且幂等", { skip: !ENABLED }, async () => {
  const platform = await announce(PLATFORM, { title: "wp18-read" });
  const [u1, u2] = TEST_USERS;

  const first = await dismissAnnouncement({ db }, { scope: WS_A, userId: u1, announcementId: platform.id });
  assert.equal(first.ok && first.value.already, false);
  const second = await dismissAnnouncement({ db }, { scope: WS_A, userId: u1, announcementId: platform.id });
  assert.equal(second.ok && second.value.already, true, "重复已读幂等（唯一索引命中 ⇒ already）");

  const rows = await db.announcementDismissal.findMany({
    where: { announcement_id: platform.id, user_id: { in: [u1, u2] } },
  });
  assert.equal(rows.length, 1, "每用户一条");

  const mine = await listVisibleAnnouncements({ db }, { scope: WS_A, userId: u1 });
  const other = await listVisibleAnnouncements({ db }, { scope: WS_A, userId: u2 });
  assert.equal(mine.value.find((a) => a.id === platform.id).dismissed, true);
  assert.equal(other.value.find((a) => a.id === platform.id).dismissed, false, "已读是按用户的，不是全局标志");
});

test("DoD6 -- 免打扰改不了公告的存在与已读（推送偏好 ≠ 站内内容）", { skip: !ENABLED }, async () => {
  const platform = await announce(PLATFORM, { title: "wp18-mute" });
  const user = TEST_USERS[0];
  const before = await listVisibleAnnouncements({ db }, { scope: WS_A, userId: user });
  assert.equal(before.ok, true);

  // 静音 email × announcement（唯一索引 (user, channel, category)），重复写入幂等。
  const first = await replaceUserMutes(db, user, [{ channel_kind: "email", category: "announcement" }]);
  const second = await replaceUserMutes(db, user, [{ channel_kind: "email", category: "announcement" }]);
  assert.equal(first.ok && second.ok, true);
  const mutes = await db.notificationMute.count({ where: { user_id: user } });
  assert.equal(mutes, 1, "三元映射唯一索引：重复写入不产生第二行");

  const after2 = await listVisibleAnnouncements({ db }, { scope: WS_A, userId: user });
  assert.deepEqual(
    after2.value.map((a) => [a.id, a.dismissed]),
    before.value.map((a) => [a.id, a.dismissed]),
    "静音只影响推送：站内列表与已读一字不变",
  );
  assert.ok(after2.value.some((a) => a.id === platform.id));
});
