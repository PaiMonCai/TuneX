/**
 * mock 运行时状态：进程内单例。
 *
 * 为什么不用模块级 `let`：Next.js 会把同一份源码打进多个 bundle（服务端组件 / 客户端组件 /
 * HMR 重载），模块被重新求值时模块级变量会被重置，于是「上一条请求新建的隧道」在下一条请求里消失。
 * 这里把可变状态挂到 globalThis 上，任何模块实例拿到的都是同一个对象，
 * 因此 create/update/delete 的结果在同一次 dev/build 运行期间持续有效。
 *
 * data.ts 只作为「种子数据」，状态层深拷贝一份后独立演化，种子数组永不被打脏。
 */
import type {
  AdminRole,
  AuditLog,
  BalanceLog,
  LicenseInfo,
  Node,
  NodeGroup,
  Payment,
  Plan,
  PlanOrder,
  SystemConfigItem,
  Ticket,
  TopupOrder,
  Tunnel,
  User,
  UserPlan,
  WorkspaceRole,
} from "@/lib/types";
import * as seed from "./data";

/** build() 内复用种子数据集的时间基准（seed.now），保证演示数据时间一致 */
const iso = (d: Date) => d.toISOString();
const daysAgo = (n: number, h = 0) => new Date(seed.now.getTime() - n * 86400000 - h * 3600000);

export interface MockStore {
  /** 当前登录演示用户（与 users[0] 同一引用，余额改动即时反映到管理端列表） */
  user: User;
  users: User[];
  /** 内部：用户 id → 登录密码（仅 mock 用，不对应任何接口字段） */
  passwords: Record<number, string>;
  adminRoles: AdminRole[];
  userPlans: UserPlan[];
  nodeGroups: NodeGroup[];
  nodes: Node[];
  tunnels: Tunnel[];
  plans: Plan[];
  payments: Payment[];
  topupOrders: TopupOrder[];
  planOrders: PlanOrder[];
  tickets: Ticket[];
  balanceLogs: BalanceLog[];
  /** 系统配置（config 表） */
  systemConfig: SystemConfigItem[];
  /** 授权信息 */
  license: LicenseInfo;
  /** 审计日志（只读） */
  auditLogs: AuditLog[];
  /** TEN-03：邮箱验证 / 密码重置一次性令牌（仅 mock 内存态，语义对齐后端 email_verification） */
  emailTokens: MockEmailToken[];
  /**
   * TEN-01：工作空间（个人 + 团队）、成员关系与邀请。
   * ids 与真实库一样自增；members/invites 用扁平数组存储，查询时按字段过滤。
   */
  workspaces: MockWorkspace[];
  workspaceMembers: MockWorkspaceMember[];
  workspaceInvites: MockWorkspaceInvite[];
  /** 单例创建时间，便于调试 */
  boot_at: string;
}

/** TEN-01 mock 工作空间（对齐 backend/prisma/schema.prisma 的 Workspace 子集） */
export interface MockWorkspace {
  id: number;
  slug: string;
  name: string;
  kind: "personal" | "team";
  personal_user_id: number | null;
  created_by_id: number;
  created_at: string;
}

export interface MockWorkspaceMember {
  id: number;
  workspace_id: number;
  user_id: number;
  role: WorkspaceRole;
  active: boolean;
  created_at: string;
}

export interface MockWorkspaceInvite {
  id: number;
  workspace_id: number;
  email: string;
  role: WorkspaceRole;
  /** mock 直接存明文 token（真实后端只存 sha256，token 仅返回一次） */
  token: string;
  invited_by_id: number;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

/**
 * TEN-03 mock 令牌：与后端 `email_verification` 行同构。
 * 单次使用（used_at）/ 过期（expires_at）/ 用途隔离（purpose）三条不变量在 mock 里同样成立，
 * 这样前端页面在 mock 模式下跑的是真实契约，而不是「任何 token 都成功」的假实现。
 */
export interface MockEmailToken {
  token: string;
  email: string;
  purpose: "email_verify" | "password_reset";
  expires_at: number;
  used_at: number | null;
  created_at: number;
}

const STORE_KEY = "__tunex_mock_store_v1__";

type GlobalWithStore = typeof globalThis & { __tunex_mock_store_v1__?: MockStore };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function build(): MockStore {
  const users = clone(seed.mockUsers);
  const userPlans = clone([seed.mockUserPlan]);
  // 演示用户的订阅计划指向可变状态里的同一条记录
  users[0].user_plan = userPlans[0];

  const nodeGroups = clone(seed.mockNodeGroups);
  const nodes = clone(seed.mockNodes);
  // 节点/节点组内嵌引用重建，保证与可变数组同一份数据
  for (const n of nodes) {
    const g = nodeGroups.find((x) => x.id === n.node_group_id);
    n.node_group = g ? { id: g.id, name: g.name, node_type: g.node_type } : undefined;
  }
  const tunnels = clone(seed.mockTunnels);
  for (const t of tunnels) {
    const g = nodeGroups.find((x) => x.id === t.in_node_group_id);
    t.in_node_group = g ? { id: g.id, name: g.name, node_type: g.node_type } : undefined;
    const og = t.out_node_group_id ? nodeGroups.find((x) => x.id === t.out_node_group_id) : undefined;
    t.out_node_group = og ? { id: og.id, name: og.name, node_type: og.node_type } : null;
  }

  // TEN-01：每个用户一个 personal 空间（owner），demo 用户额外带一个演示团队空间。
  // 与后端 createPersonalWorkspace / ensurePersonalWorkspace 的初始化语义一致。
  const wsAt = iso(daysAgo(150));
  const workspaces: MockWorkspace[] = [];
  const workspaceMembers: MockWorkspaceMember[] = [];
  let wsId = 0;
  let memberId = 0;
  const addWorkspace = (
    w: Omit<MockWorkspace, "id" | "created_at">,
    rosters: { user_id: number; role: WorkspaceRole }[],
  ) => {
    const ws: MockWorkspace = { ...w, id: ++wsId, created_at: wsAt };
    workspaces.push(ws);
    for (const m of rosters) {
      workspaceMembers.push({
        id: ++memberId,
        workspace_id: ws.id,
        user_id: m.user_id,
        role: m.role,
        active: true,
        created_at: wsAt,
      });
    }
    return ws;
  };
  for (const u of users) {
    addWorkspace(
      {
        slug: `personal-${u.id}`,
        name: `Personal ${u.id}`,
        kind: "personal",
        personal_user_id: u.id,
        created_by_id: u.id,
      },
      [{ user_id: u.id, role: "owner" }],
    );
  }
  // 演示团队：demo 是 owner，alice(2) 是 admin，bob(3) 是普通成员
  const teamRoster: { user_id: number; role: WorkspaceRole }[] = [
    { user_id: users[0].id, role: "owner" },
    { user_id: users[1]?.id ?? 0, role: "admin" },
    { user_id: users[2]?.id ?? 0, role: "member" },
  ];
  addWorkspace(
    { slug: "team-demo-ops", name: "演示团队", kind: "team", personal_user_id: null, created_by_id: users[0].id },
    teamRoster.filter((m) => m.user_id > 0),
  );

  return {
    user: users[0],
    users,
    passwords: { [users[0].id]: seed.DEMO_CREDENTIALS.password },
    adminRoles: clone(seed.mockAdminRoles),
    userPlans,
    nodeGroups,
    nodes,
    tunnels,
    plans: clone(seed.mockPlans),
    payments: clone(seed.mockPayments),
    topupOrders: clone(seed.mockTopupOrders),
    planOrders: clone(seed.mockPlanOrders),
    tickets: clone(seed.mockTickets),
    balanceLogs: clone(seed.mockBalanceLogs),
    systemConfig: clone(seed.mockSystemConfig),
    license: clone(seed.mockLicense),
    auditLogs: clone(seed.mockAuditLogs),
    emailTokens: [],
    workspaces,
    workspaceMembers,
    workspaceInvites: [],
    boot_at: new Date().toISOString(),
  };
}

/** 取进程内单例状态（首次调用时构建） */
export function getStore(): MockStore {
  const g = globalThis as GlobalWithStore;
  if (!g[STORE_KEY]) g[STORE_KEY] = build();
  return g[STORE_KEY];
}

/** 重置为种子数据（测试/演示用） */
export function resetStore(): MockStore {
  const g = globalThis as GlobalWithStore;
  g[STORE_KEY] = build();
  return g[STORE_KEY];
}

/** 便捷引用（与 getStore() 同一对象） */
export const store: MockStore = getStore();
