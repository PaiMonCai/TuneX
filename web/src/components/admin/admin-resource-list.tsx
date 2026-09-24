import { cookies } from "next/headers";
import { api } from "@/lib/api";
import { AdminPlansManager } from "@/components/admin/plans-manager";
import { AdminNodeGroupsManager } from "@/components/admin/node-groups-manager";
import { AdminNodesManager } from "@/components/admin/nodes-manager";
import { AdminUsersManager } from "@/components/admin/users-manager";
import { AdminRolesManager } from "@/components/admin/roles-manager";
import { AdminSettingsManager } from "@/components/admin/settings-manager";
import { AdminLicensePanel } from "@/components/admin/license-panel";
import { AdminAuditManager } from "@/components/admin/admin-audit-manager";
import type {
  AdminResourceMeta,
  AdminRole,
  AuditLog,
  LicenseInfo,
  Node,
  NodeGroup,
  Paginated,
  Plan,
  SystemConfigItem,
  User,
} from "@/lib/types";

export const ADMIN_SEGMENTS = [
  "nodes",
  "node-groups",
  "plans",
  "tunnels",
  "users",
  "roles",
  "orders",
  "tickets",
  "settings",
  "audit-logs",
  "license",
] as const;
export type AdminSegment = (typeof ADMIN_SEGMENTS)[number];

const EMPTY = { data: [], total: 0, page: 1, page_size: 20 };

function safe<T>(p: Promise<Paginated<T>>): Promise<Paginated<T>> {
  return p.catch(() => ({ ...EMPTY, data: [] as T[] }));
}

/** 非分页资源的安全取数（失败回落默认值） */
async function safeValue<T>(p: Promise<T>, fallback: T): Promise<T> {
  return p.catch(() => fallback);
}

/**
 * 管理端资源分发：有写操作（CRUD）的 segment 交给专门的 manager 客户端组件，
 * 初始数据在这里服务端预取并下发，客户端只负责交互（表单、toast、刷新）。
 */
export async function AdminResourceList({ segment }: { segment: AdminSegment }) {
  const cookie = (await cookies()).toString();

  if (segment === "plans") {
    const initialData = await safe<Plan>(api.admin.plans({ page: 1, page_size: 20 }, cookie));
    return <AdminPlansManager initialData={initialData} />;
  }

  if (segment === "node-groups") {
    const initialData = await safe<NodeGroup>(api.admin.nodeGroups({ page: 1, page_size: 20 }, cookie));
    return <AdminNodeGroupsManager initialData={initialData} />;
  }

  if (segment === "nodes") {
    const [initialData, groups] = await Promise.all([
      safe<Node>(api.admin.nodes({ page: 1, page_size: 20 }, cookie)),
      safe<NodeGroup>(api.admin.nodeGroups({ page: 1, page_size: 100 }, cookie)),
    ]);
    return <AdminNodesManager initialData={initialData} nodeGroups={groups.data} />;
  }

  if (segment === "users") {
    const initialData = await safe<User>(api.admin.users({ page: 1, page_size: 20 }, cookie));
    return <AdminUsersManager initialData={initialData} />;
  }

  if (segment === "roles") {
    const [roles, meta] = await Promise.all([
      safeValue<AdminRole[]>(api.admin.roles(cookie), []),
      safeValue<{ resources: AdminResourceMeta[] }>(api.admin.metaResources(cookie), { resources: [] }),
    ]);
    return <AdminRolesManager initialData={roles} resources={meta.resources} />;
  }

  if (segment === "settings") {
    const config = await safeValue<SystemConfigItem[]>(api.admin.systemConfig(cookie), []);
    return <AdminSettingsManager initialData={config} />;
  }

  if (segment === "audit-logs") {
    const initialData = await safe<AuditLog>(api.admin.auditLogs({ page: 1, page_size: 30 }, cookie));
    return <AdminAuditManager initialData={initialData} />;
  }

  if (segment === "license") {
    const license = await safeValue<LicenseInfo>(api.admin.license(cookie), { type: "none" });
    return <AdminLicensePanel license={license} />;
  }

  return null;
}
