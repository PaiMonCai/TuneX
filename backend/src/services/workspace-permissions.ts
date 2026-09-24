/**
 * TEAM-01 自定义角色 · 细粒度权限。
 *
 * ── 为什么单独一个模块 ──
 * 固定四角色（owner/admin/member/viewer）的判定在 `services/workspace.ts` 里，
 * 但自定义角色引入了两个新问题：权限集合本身（哪 11 个键合法）与「自定义角色
 * 与固定角色并存时谁说了算」。二者都是**纯逻辑**，放这里可以离线单测；
 * DB 编排（取成员 + 角色行）留在 workspace.ts，避免循环依赖。
 *
 * ── 权限模型 ──
 * 11 个细粒度权限键，`resource:action` 形式：
 *   tunnel:read   tunnel:create   tunnel:update   tunnel:delete
 *   node:read     node:manage
 *   member:read   member:manage
 *   settings:read settings:manage
 *   audit:read
 *
 * 与后台 `permissions.ts` 的区别（有意为之）：后台是 read/write 两级 + 资源键表，
 * 这里是布尔白名单——因为团队侧的动作集合是**离散且可枚举**的（创建 vs 删除是两件
 * 事，不是读写两级），且每个键的语义由路由层固定，不需要「write 隐含 read」的推导。
 *
 * ── fail-closed 取向 ──
 * 判定侧对一切「无法证明有权」的输入都返回拒绝：
 *   · 角色不存在 / member 无角色引用 → 拒绝
 *   · permissions 不是对象、是数组、是 null → 拒绝
 *   · 权限键不在白名单 → 拒绝（不静默忽略）
 *   · 权限键存在但值不是布尔 → 拒绝
 *   · 传入的 action 不在集合内 → 拒绝
 * 唯一放行路径是「键存在且值为 true」。
 */

/** 全部细粒度权限键（11 个）。单一真相源：API 校验、UI 勾选、测试都从这里取。 */
export const WORKSPACE_PERMISSIONS = [
  "tunnel:read",
  "tunnel:create",
  "tunnel:update",
  "tunnel:delete",
  "node:read",
  "node:manage",
  "member:read",
  "member:manage",
  "settings:read",
  "settings:manage",
  "audit:read",
] as const;

export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(WORKSPACE_PERMISSIONS);

/** 权限键 → 中文说明（用于 API 错误提示与前端标签的来源）。 */
export const WORKSPACE_PERMISSION_LABELS: Record<WorkspacePermission, string> = {
  "tunnel:read": "查看隧道",
  "tunnel:create": "创建隧道",
  "tunnel:update": "修改隧道",
  "tunnel:delete": "删除隧道",
  "node:read": "查看节点与节点组",
  "node:manage": "管理节点与节点组",
  "member:read": "查看成员",
  "member:manage": "管理成员",
  "settings:read": "查看工作空间设置",
  "settings:manage": "修改工作空间设置",
  "audit:read": "查看审计日志",
};

/** 分组（前端权限编辑器按组渲染）。 */
export const WORKSPACE_PERMISSION_GROUPS: { group: string; permissions: WorkspacePermission[] }[] = [
  { group: "隧道", permissions: ["tunnel:read", "tunnel:create", "tunnel:update", "tunnel:delete"] },
  { group: "节点", permissions: ["node:read", "node:manage"] },
  { group: "成员", permissions: ["member:read", "member:manage"] },
  { group: "设置", permissions: ["settings:read", "settings:manage"] },
  { group: "审计", permissions: ["audit:read"] },
];

export type WorkspacePermissionMap = Partial<Record<WorkspacePermission, boolean>>;

/** 是否是已知权限键。 */
export function isWorkspacePermission(key: string): key is WorkspacePermission {
  return PERMISSION_SET.has(key);
}

/**
 * 入库前的白名单过滤。与 `permissions.ts#sanitizePermissions` 同取向：
 * 只保留白名单内的布尔键，其余（未知键、非布尔值、原型链键）一律丢弃。
 * 返回的映射**不含**被丢弃的键，因此判定侧「缺键」即可判定为无权。
 */
export function sanitizeCustomPermissions(input: unknown): WorkspacePermissionMap {
  const result: WorkspacePermissionMap = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!PERMISSION_SET.has(key)) continue; // 未知键丢弃，不写入
    if (typeof value !== "boolean") continue; // "true"/1 等一律丢弃
    if (!value) continue; // false 不入库（缺键即无权，省掉冗余 false）
    result[key as WorkspacePermission] = true;
  }
  return result;
}

/**
 * 从数据库 JSON 里安全地取出权限集。**只认布尔 true**：
 * `{ "tunnel:read": "true" }`、`{ "tunnel:read": 1 }` 都视为无权——
 * 宁可漏放也不要把字符串当成授权（JSON 列可被任何写路径污染）。
 */
export function parseCustomPermissions(input: unknown): WorkspacePermissionMap {
  const result: WorkspacePermissionMap = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!PERMISSION_SET.has(key)) continue;
    if (value !== true) continue;
    result[key as WorkspacePermission] = true;
  }
  return result;
}

/** 转换为稳定的数组形式（响应给前端 / 测试断言用）。 */
export function permissionList(input: unknown): WorkspacePermission[] {
  const parsed = parseCustomPermissions(input);
  return WORKSPACE_PERMISSIONS.filter((k) => parsed[k] === true);
}

/** 自定义角色是否授予了某个权限（未知键 → false）。 */
export function customRoleGrants(permissions: unknown, permission: string): boolean {
  if (!isWorkspacePermission(permission)) return false; // 未知权限一律拒绝（fail-closed）
  return parseCustomPermissions(permissions)[permission] === true;
}

/** 自定义角色是否「空权限」——空角色没有任何用处，创建/更新时应拒绝。 */
export function isEmptyCustomPermissions(input: unknown): boolean {
  return permissionList(input).length === 0;
}
