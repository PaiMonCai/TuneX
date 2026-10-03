/**
 * Workspace custom-role permission kernel (WP10).
 * Product keys are canonical forward:*; tunnel:* remains a read-compatible alias.
 * Explicit canonical false wins over a legacy true. Non-boolean/unknown keys or
 * malformed maps invalidate the entire authorization map rather than widening it.
 */
export const WORKSPACE_PERMISSIONS = [
  "forward:read",
  "forward:create",
  "forward:update",
  "forward:delete",
  "node:read",
  "node:manage",
  "member:read",
  "member:manage",
  "settings:read",
  "settings:manage",
  "audit:read",
] as const;

export type CanonicalWorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number];
export type LegacyWorkspacePermission = `tunnel:${"read" | "create" | "update" | "delete"}`;
/** Legacy keys remain accepted as input, but all normalized output is canonical. */
export type WorkspacePermission = CanonicalWorkspacePermission | LegacyWorkspacePermission;
export type WorkspacePermissionMap = Partial<Record<WorkspacePermission, boolean>>;

const PERMISSION_SET: ReadonlySet<string> = new Set([
  ...WORKSPACE_PERMISSIONS,
  "tunnel:read", "tunnel:create", "tunnel:update", "tunnel:delete",
]);

export const WORKSPACE_PERMISSION_LABELS: Record<CanonicalWorkspacePermission, string> = {
  "forward:read": "查看端口转发",
  "forward:create": "创建端口转发",
  "forward:update": "修改端口转发",
  "forward:delete": "删除端口转发",
  "node:read": "查看节点与节点组",
  "node:manage": "管理节点与节点组",
  "member:read": "查看成员",
  "member:manage": "管理成员",
  "settings:read": "查看工作空间设置",
  "settings:manage": "修改工作空间设置",
  "audit:read": "查看审计日志",
};

export const WORKSPACE_PERMISSION_GROUPS: { group: string; permissions: CanonicalWorkspacePermission[] }[] = [
  { group: "端口转发", permissions: ["forward:read", "forward:create", "forward:update", "forward:delete"] },
  { group: "节点", permissions: ["node:read", "node:manage"] },
  { group: "成员", permissions: ["member:read", "member:manage"] },
  { group: "设置", permissions: ["settings:read", "settings:manage"] },
  { group: "审计", permissions: ["audit:read"] },
];

export function isWorkspacePermission(key: string): key is WorkspacePermission {
  return PERMISSION_SET.has(key);
}

/** Only plain JSON-style objects with known own boolean properties are valid. */
export function isValidCustomPermissions(input: unknown): input is WorkspacePermissionMap {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(input).every((key) => {
    if (typeof key !== "string" || !isWorkspacePermission(key)) return false;
    const property = Object.getOwnPropertyDescriptor(input, key);
    return !!property && "value" in property && typeof property.value === "boolean";
  });
}

/** Preserve false during canonicalization; dropping it can resurrect legacy grants. */
export function parseCustomPermissions(input: unknown): WorkspacePermissionMap {
  const result: WorkspacePermissionMap = {};
  if (!isValidCustomPermissions(input)) return result;
  for (const key of WORKSPACE_PERMISSIONS) {
    if (Object.hasOwn(input, key)) {
      result[key] = input[key];
    } else if (key.startsWith("forward:")) {
      const legacy = key.replace("forward:", "tunnel:") as LegacyWorkspacePermission;
      if (Object.hasOwn(input, legacy)) result[key] = input[legacy];
    }
  }
  return result;
}

/** Write canonical keys only, rejecting malformed maps rather than salvaging grants. */
export function sanitizeCustomPermissions(input: unknown): WorkspacePermissionMap {
  return parseCustomPermissions(input);
}

export function permissionList(input: unknown): CanonicalWorkspacePermission[] {
  const parsed = parseCustomPermissions(input);
  return WORKSPACE_PERMISSIONS.filter((key) => parsed[key] === true);
}

export function customRoleGrants(permissions: unknown, permission: string): boolean {
  if (!isWorkspacePermission(permission)) return false;
  const canonical = permission.replace(/^tunnel:/, "forward:") as CanonicalWorkspacePermission;
  return parseCustomPermissions(permissions)[canonical] === true;
}

export function isEmptyCustomPermissions(input: unknown): boolean {
  return permissionList(input).length === 0;
}
