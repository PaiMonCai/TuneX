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
  BalanceLog,
  Node,
  NodeGroup,
  Payment,
  Plan,
  PlanOrder,
  Ticket,
  TopupOrder,
  Tunnel,
  User,
  UserPlan,
} from "@/lib/types";
import * as seed from "./data";

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
  /** 单例创建时间，便于调试 */
  boot_at: string;
}

const STORE_KEY = "__relayx_mock_store_v1__";

type GlobalWithStore = typeof globalThis & { __relayx_mock_store_v1__?: MockStore };

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

  return {
    user: users[0],
    users,
    passwords: { [users[0].id]: seed.DEMO_CREDENTIALS.password },
    adminRoles: clone([seed.mockAdminRole]),
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
