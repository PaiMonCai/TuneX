/**
 * 平台管理视角（persona）——**只决定「入口是否可见」与「错误面怎么解释」，不承担授权**。
 *
 * 为什么需要它：顶栏的「管理后台」入口曾经对所有登录用户无条件渲染，普通用户点进去
 * 会让 `/api/admin/*` 返回 403 —— 那是**后端 RBAC 的正确行为**，问题出在前端把
 * 「这个账号大概有没有后台权限」当成一件不需要知道的事。
 *
 * 判据只有一个来源，且是后端**真实**权限视图（`GET /api/auth/permissions`，
 * `backend/src/routes/auth.ts`：`{ super_admin, roles: [{ id, name, permissions }] }`）：
 *
 * - `super_admin === true` → `super_admin`；
 * - 否则**只要持有任意后台角色** → `delegated`（平台管理员不只是超管：后端
 *   `adminRequired` 的准入条件就是 `super_admin || admin_roles.length > 0`，只看一个
 *   布尔字段会把合法委派管理员藏起来）；
 * - 两者都不是 → `member`；
 * - **读数取不到 / 形状不认识 → `unknown`**：宁可多给一个入口（点进去有受控错误面），
 *   也不凭一次失败把可能是管理员的账号挡在门外。unknown 不是「成员」。
 *
 * 纪律：这里**没有**第二套权限判定 —— 每个资源的 `read`/`write` 真相始终在后端
 * `adminPermissionGuard`；本模块不做「他能看哪些 segment」这种推断，只回答
 * 「这个账号是否可能是后台用户」。`member` 之外一律 fail-open 展示入口。
 */

/** `GET /api/auth/permissions` 的真实响应体（`data` 已由 api 层解包）。 */
export interface AdminPermissionsView {
  super_admin: boolean;
  roles: { id: number; name: string; permissions?: unknown }[];
}

export type AdminPersona = "super_admin" | "delegated" | "member";
/** 读数缺失/不认识：既不是管理员，也**不是**成员 —— 不许折叠成 member。 */
export const ADMIN_PERSONA_UNKNOWN = "unknown";
export type AdminPersonaReading = AdminPersona | typeof ADMIN_PERSONA_UNKNOWN;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * 解析 `/auth/permissions` 的载荷；形状不认识返回 `null`（调用方据此判 unknown）。
 *
 * 刻意**不**在缺字段时猜默认值：`super_admin` 缺失时把它当 `false` 会凭空造出
 * 「这个人不是管理员」的结论 —— 而那正是本模块要修的那类谎。
 */
export function parseAdminPermissions(value: unknown): AdminPermissionsView | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.super_admin !== "boolean") return null;
  const roles: AdminPermissionsView["roles"] = [];
  if (Array.isArray(record.roles)) {
    for (const entry of record.roles) {
      const role = asRecord(entry);
      if (!role) continue;
      const id = typeof role.id === "number" && Number.isInteger(role.id) ? role.id : null;
      const name = typeof role.name === "string" && role.name.trim() !== "" ? role.name : null;
      if (id === null && name === null) continue;
      roles.push({ id: id ?? 0, name: name ?? `role:${id}`, permissions: role.permissions });
    }
  }
  return { super_admin: record.super_admin, roles };
}

/** 载荷 → 视角读数。形状不认识（含 `null`）= `unknown`，不是 `member`。 */
export function adminPersonaOf(payload: unknown): AdminPersonaReading {
  const view = parseAdminPermissions(payload);
  if (!view) return ADMIN_PERSONA_UNKNOWN;
  if (view.super_admin) return "super_admin";
  return view.roles.length > 0 ? "delegated" : "member";
}

/**
 * 入口可见性：只有**确认为成员**（读数成功且既非超管也无任何后台角色）才隐藏。
 * `unknown` 一律展示 —— 隐藏合法管理员入口的代价比多一个受控错误页大得多。
 */
export function canEnterAdminConsole(reading: AdminPersonaReading): boolean {
  return reading !== "member";
}

/** 视角的稳定标识（`data-*` 属性 / 测试用；不参与任何授权判断）。 */
export function adminPersonaLabel(reading: AdminPersonaReading): string {
  return reading === ADMIN_PERSONA_UNKNOWN ? "unknown" : reading;
}
