/**
 * 通知偏好 mock（切片 N1：EXPOSE `GET/PUT /api/announcements/preferences`）。
 *
 * ── 唯一真相 ──
 * `backend/src/routes/announcements.ts:151-180` + `services/announcement-mute.ts`。
 * 这里逐条镜像真实契约（本文件的形状是用真实后端实测过的，见 task-12 报告的真机输出）：
 *
 *   1. **GET 连同闭集一起下发**：`{ mutes, channels, categories }`。前端据此渲染矩阵，
 *      mock 不得只回 `mutes`（那会逼前端自己硬编码一份会漂移的副本）。
 *   2. **PUT 是全量替换**，响应回显**已落库**的清单；未知渠道 / 未知类别 / 非数组
 *      ⇒ **整个请求 400**（`unknown_channel_kind` / `unknown_category` / `not_an_array`），
 *      不做"丢掉不认识的项"的降级 —— mock 要是宽容，本地看着能用、线上直接 400。
 *   3. 存储不可用 ⇒ `503 storage_error`（真实后端由 `loadUserMutes`/`replaceUserMutes` 的
 *      `storage_error` 分支给出）。可用查询参数 `?mock_error=storage_error` 在本地演示该分支，
 *      这是**唯一**的假故障注入点，且它明确属于"存储不可用"这一类（不冒充权限/校验失败）。
 *   4. 免打扰是 **user 级**：mock 也按 `user.id` 分片，不看 `x-workspace-id`/`scopeId`
 *      （真实路由只做 `requireUser`）。这一点必须与真机一致，否则 UI 会把偏好当成空间设置。
 *
 * 状态挂在 `WeakMap<MockStore, …>` 上（与 `handlers/ddns.ts` 同款）：`resetStore()` 换掉 store
 * 对象后 mock 状态自动归零，不需要也不允许去改 `mocks/state.ts` 的 `MockStore` 形状。
 */
import * as rt from "../runtime";
import type { MockResponse, Store } from "../runtime";

const { failFlat, isLoggedIn, notFound, reqStr } = rt;

/** 闭集 = 服务端的词表（与真机实测输出逐字一致）。 */
export const MOCK_NOTIFICATION_CHANNELS = ["email", "webhook", "telegram"] as const;
export const MOCK_NOTIFICATION_CATEGORIES = [
  "node",
  "forward",
  "reconcile_finding",
  "workspace_event",
  "federation_event",
  "announcement",
] as const;

interface MuteRow {
  channel_kind: string;
  category: string;
}

interface MockNotificationState {
  /** 按 user_id 分片：这是用户级偏好，不是工作空间级。 */
  mutesByUser: Map<number, MuteRow[]>;
}

const STORES = new WeakMap<Store, MockNotificationState>();

function stateOf(store: Store): MockNotificationState {
  let state = STORES.get(store);
  if (!state) {
    state = { mutesByUser: new Map() };
    STORES.set(store, state);
  }
  return state;
}

function bodyOf(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** 与真实后端同形：`{ error, code, error_layer }`（`failFlat` 保证 extras/字段在顶层）。 */
function announcementError(status: number, message: string, code: string): MockResponse {
  return failFlat(status, message, code, { error_layer: "announcement" });
}

function mutesOf(state: MockNotificationState, userId: number): MuteRow[] {
  return state.mutesByUser.get(userId) ?? [];
}

/**
 * 解析请求体 —— **fail-closed**，与 `services/announcement-mute.ts` 的 `parseNotificationMutes` 同序：
 * 非数组 → `not_an_array`；未知渠道 → `unknown_channel_kind`；未知类别 → `unknown_category`；
 * 重复项折成一条（同一个意图，不是错误）。
 */
function parseMutes(
  input: unknown,
): { ok: true; mutes: MuteRow[] } | { ok: false; code: "not_an_array" | "unknown_channel_kind" | "unknown_category" } {
  if (!Array.isArray(input)) return { ok: false, code: "not_an_array" };
  const seen = new Set<string>();
  const mutes: MuteRow[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return { ok: false, code: "unknown_channel_kind" };
    const channel = (raw as { channel_kind?: unknown }).channel_kind;
    const category = (raw as { category?: unknown }).category;
    if (typeof channel !== "string" || !(MOCK_NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
      return { ok: false, code: "unknown_channel_kind" };
    }
    if (typeof category !== "string" || !(MOCK_NOTIFICATION_CATEGORIES as readonly string[]).includes(category)) {
      return { ok: false, code: "unknown_category" };
    }
    const key = `${channel}\u0000${category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mutes.push({ channel_kind: channel, category });
  }
  return { ok: true, mutes };
}

export async function handleNotificationsMock(ctx: rt.MockAuthedRouteContext): Promise<MockResponse | null> {
  const { method, seg, db, user, q, req } = ctx;
  if (seg[0] !== "announcements" || seg[1] !== "preferences") return null;

  // 真实路由用 `requireUser`：未登录是 401，不是"空偏好"。
  if (!isLoggedIn(req.cookie)) return failFlat(401, "Unauthorized", "UNAUTHORIZED");

  const state = stateOf(db);

  // 唯一的假故障注入点：存储不可用（503）。别的一律不伪造。
  if (q?.mock_error === "storage_error") {
    return announcementError(503, "免打扰存储暂时不可用", "storage_error");
  }

  if (method === "GET") {
    return {
      status: 200,
      body: {
        data: {
          mutes: mutesOf(state, user.id),
          channels: [...MOCK_NOTIFICATION_CHANNELS],
          categories: [...MOCK_NOTIFICATION_CATEGORIES],
        },
      },
    };
  }

  if (method === "PUT") {
    const body = bodyOf(req.body);
    if (!body) return announcementError(400, "免打扰清单不合法", "not_an_array");
    if (!("mutes" in body)) return announcementError(400, "免打扰清单不合法", "not_an_array");
    const parsed = parseMutes(body.mutes);
    if (!parsed.ok) return announcementError(400, "免打扰清单不合法", parsed.code);
    state.mutesByUser.set(user.id, parsed.mutes);
    return { status: 200, body: { data: { mutes: parsed.mutes } } };
  }

  return notFound(`Mock route not found: ${method} /${seg.join("/")}`);
}

/** 供测试断言：mock 与真实后端一样把偏好按用户分片（换用户互不影响）。 */
export function mockMutesFor(db: Store, userId: number, cookie: string): MuteRow[] {
  const state = STORES.get(db);
  if (!state) return [];
  void cookie;
  void reqStr;
  return mutesOf(state, userId);
}
