import { cookies } from "next/headers";
import { api } from "@/lib/api";
import { AdminResourceUnavailable, loadAdminResource, type AdminLoadFailure } from "@/components/admin/admin-resource-state";
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

/**
 * 管理端资源分发：有写操作（CRUD）的 segment 交给专门的 manager 客户端组件，
 * 初始数据在这里服务端预取并下发，客户端只负责交互（表单、toast、刷新）。
 *
 * **取数失败不再被折叠成空列表**（R2-C / D5）：以前这里的 `safe()` / `safeValue()`
 * 把 403、503、网络失败统一 `catch` 成一个「空的分页结果」，license 取不到还会回落成
 * 「未授权(none)」的默认值。于是「你的后台角色没有这个资源键」与「这个列表真的是空的」
 * 在界面上**完全一样**。现在任何一次读取失败都会渲染
 * `AdminResourceUnavailable`（说清是哪一次读取、后端为什么拒绝、找谁、去哪里重试），
 * 只有真的读到了空数组，才会走到 manager 自己的空态。
 *
 * 辅助读取（节点组、权限资源元数据）同样按失败处理：把空数组喂给一个有写操作的
 * manager，会让「取不到组列表」在下拉框里显示成「没有组」——又是一条假事实。
 */
export async function AdminResourceList({ segment }: { segment: AdminSegment }) {
  const cookie = (await cookies()).toString();
  const q = { page: 1, page_size: 20 };
  const unavailable = (failure: AdminLoadFailure) => (
    <AdminResourceUnavailable segment={segment} failure={failure} />
  );

  if (segment === "plans") {
    const load = await loadAdminResource<Paginated<Plan>>("套餐列表", api.admin.plans(q, cookie));
    return load.ok ? <AdminPlansManager initialData={load.data} /> : unavailable(load.failure);
  }

  if (segment === "node-groups") {
    const load = await loadAdminResource<Paginated<NodeGroup>>("节点组列表", api.admin.nodeGroups(q, cookie));
    return load.ok ? <AdminNodeGroupsManager initialData={load.data} /> : unavailable(load.failure);
  }

  if (segment === "nodes") {
    const [nodes, groups] = await Promise.all([
      loadAdminResource<Paginated<Node>>("节点列表", api.admin.nodes(q, cookie)),
      loadAdminResource<Paginated<NodeGroup>>("节点组列表（节点归属选择用）", api.admin.nodeGroups({ page: 1, page_size: 100 }, cookie)),
    ]);
    if (!nodes.ok) return unavailable(nodes.failure);
    if (!groups.ok) return unavailable(groups.failure);
    return <AdminNodesManager initialData={nodes.data} nodeGroups={groups.data.data} />;
  }

  if (segment === "users") {
    const load = await loadAdminResource<Paginated<User>>("用户列表", api.admin.users(q, cookie));
    return load.ok ? <AdminUsersManager initialData={load.data} /> : unavailable(load.failure);
  }

  if (segment === "roles") {
    const [roles, meta] = await Promise.all([
      loadAdminResource<AdminRole[]>("后台角色列表", api.admin.roles(cookie)),
      loadAdminResource<{ resources: AdminResourceMeta[] }>("权限资源元数据", api.admin.metaResources(cookie)),
    ]);
    if (!roles.ok) return unavailable(roles.failure);
    if (!meta.ok) return unavailable(meta.failure);
    return <AdminRolesManager initialData={roles.data} resources={meta.data.resources} />;
  }

  if (segment === "settings") {
    const load = await loadAdminResource<SystemConfigItem[]>("系统配置", api.admin.systemConfig(cookie));
    return load.ok ? <AdminSettingsManager initialData={load.data} /> : unavailable(load.failure);
  }

  if (segment === "audit-logs") {
    const load = await loadAdminResource<Paginated<AuditLog>>("审计日志", api.admin.auditLogs({ page: 1, page_size: 30 }, cookie));
    return load.ok ? <AdminAuditManager initialData={load.data} /> : unavailable(load.failure);
  }

  if (segment === "license") {
    const load = await loadAdminResource<LicenseInfo>("License 信息", api.admin.license(cookie));
    // 取不到**不是**「未授权（type: none）」—— 那是另一条结论，必须让用户看见差别。
    return load.ok ? <AdminLicensePanel license={load.data} /> : unavailable(load.failure);
  }

  return null;
}
