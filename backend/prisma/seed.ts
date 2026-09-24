/**
 * Prisma seed —— 基础设施初始化 + 演示种子数据（幂等，可重复执行）
 *
 * 职责：
 *  ① 初始化 config 表（33 项枚举默认值，仅插入缺失项，并迁移旧品牌默认文案）
 *  ② 超管用户（admin@tunex.local）+ 密码凭证（user_credential）
 *     - 邮箱/密码可通过 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD 覆盖
 *     - 未设置 SEED_ADMIN_PASSWORD 时随机生成强口令并写入凭证文件
 *  ③ 3 个套餐（体验 / 标准 / 专业）
 *  ④ 2 个节点组（HK-IN: type=in；HK-OUT: type=out）
 *  ⑤ 2 个节点（HK-Node-1 -> HK-IN；HK-Node-2 -> HK-OUT）
 *  ⑥ 套餐-节点组关联（plan_node_group）
 *
 * 单位约定（与原版一致）：
 *  - plan.traffic          : GB（10 / 100 / 500）
 *  - plan.bandwidth_limit  : Mbps（10 / 100 / 500）
 *  - plan.max_tunnels      : 条
 *
 * 依据: db_schema_report.md §3.1（config 枚举）、
 *       auth-rbac-source-verification-report.md、
 *       reports/reference-schema.sql（plan / node_group / node / plan_node_group）
 */
import { db } from "../src/db.ts";
import { createPersonalWorkspace, ensurePersonalWorkspace } from "../src/services/workspace.ts";
import { hashPassword, generatePassword, newApiKey, verifyPassword } from "../src/auth.ts";
import { hashKey } from "../src/services/user-keys.ts";
import { writeFileSync, chmodSync } from "node:fs";
import {
  NodeType,
  LoadBalanceType,
  BillingCycle,
  Status,
  type SystemConfigName,
} from "@prisma/client";

/**
 * config 表默认值（覆盖 schema 中 SystemConfigName 枚举全量 33 项）。
 * 说明：原版 config 表初始为空、由后台设置页首次写入；此处给出可用的
 * 本地栈默认值，使前端/接口在未配置时仍有确定行为。
 * 仅插入缺失项；旧品牌默认值会更新，运营者自定义值不变。
 */
const DEFAULT_CONFIG: Record<SystemConfigName, string> = {
  MIN_TOPUP_AMOUNT: "1",
  NOTICE: "",
  NOTICE_POPUP: "",
  NOTICE_POPUP_INTERVAL_HOURS: "24",
  SITE_NAME: "TuneX",
  SITE_DESCRIPTION: "TuneX 隧道转发服务",
  ALLOW_REGISTER: "true",
  LOGO_URL: "",
  HIDE_NODE_STATUS: "false",
  AUTO_UPDATE_AGENT: "false",
  CHATWOOT_BASE_URL: "",
  CHATWOOT_TOKEN: "",
  TUNNEL_TRAFFIC_RETENTION_DAYS: "30",
  HIDE_FOOTER: "false",
  HIDE_DOCS: "false",
  LANDING_PAGE_URL: "",
  REFERRAL_COMMISSION_RATE: "0",
  REFERRAL_FIRST_ONLY: "false",
  REFERRAL_MODE: "balance",
  OBSERVER_PERIOD: "10",
  EMAIL_PROVIDER: "smtp",
  SMTP_HOST: "",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_USER: "",
  SMTP_PASS: "",
  SMTP_FROM: "",
  RESEND_API_KEY: "",
  RESEND_FROM: "",
  MIN_WITHDRAW_AMOUNT: "10",
  WITHDRAW_METHODS: "[]",
  LIMIT_SCOPE: "global",
  ENABLE_SUBSCRIPTION: "true",
};

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@tunex.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? generatePassword(24);
const CREDENTIALS_PATH =
  process.env.ADMIN_CREDENTIALS_PATH ?? "/host/.admin-credentials";

/** 节点默认连接 IP 占位（真实部署时由 Agent 上报 / 后台修改）。 */
const NODE_CONNECT_IP = process.env.SEED_NODE_CONNECT_IP ?? "127.0.0.1";

/** 套餐定义（价格单位为 ¥，traffic=GB，bandwidth_limit=Mbps）。 */
interface PlanSeed {
  name: string;
  description: string;
  price: number;
  traffic: number;
  maxTunnels: number;
  bandwidthLimit: number;
}

const PLANS: PlanSeed[] = [
  {
    name: "体验套餐",
    description: "入门体验：10GB 流量 / 2 条隧道 / 10Mbps",
    price: 9.9,
    traffic: 10,
    maxTunnels: 2,
    bandwidthLimit: 10,
  },
  {
    name: "标准套餐",
    description: "日常使用：100GB 流量 / 10 条隧道 / 100Mbps",
    price: 29.9,
    traffic: 100,
    maxTunnels: 10,
    bandwidthLimit: 100,
  },
  {
    name: "专业套餐",
    description: "高强度使用：500GB 流量 / 50 条隧道 / 500Mbps",
    price: 99.9,
    traffic: 500,
    maxTunnels: 50,
    bandwidthLimit: 500,
  },
];

/** 节点组定义（token 固定，保证幂等 upsert）。 */
interface NodeGroupSeed {
  token: string;
  name: string;
  nodeType: NodeType;
  loadBalanceType: LoadBalanceType;
}

const NODE_GROUPS: NodeGroupSeed[] = [
  {
    token: "a0000001-0000-4000-8000-000000000001",
    name: "HK-IN",
    nodeType: NodeType.in,
    loadBalanceType: LoadBalanceType.round,
  },
  {
    token: "a0000002-0000-4000-8000-000000000002",
    name: "HK-OUT",
    nodeType: NodeType.out,
    loadBalanceType: LoadBalanceType.round,
  },
];

/** 节点定义（node_id 唯一，保证幂等 upsert）。 */
interface NodeSeed {
  nodeId: string;
  nodeGroupName: string;
}

const NODES: NodeSeed[] = [
  { nodeId: "HK-Node-1", nodeGroupName: "HK-IN" },
  { nodeId: "HK-Node-2", nodeGroupName: "HK-OUT" },
];

async function seedConfig(): Promise<{ inserted: number; total: number }> {
  const names = Object.keys(DEFAULT_CONFIG) as SystemConfigName[];
  const existing = await db.systemConfig.findMany({ select: { name: true } });
  const have = new Set(existing.map((r) => r.name as string));

  const toInsert = names.filter((n) => !have.has(n));
  if (toInsert.length > 0) {
    await db.systemConfig.createMany({
      data: toInsert.map((name) => ({ name, value: DEFAULT_CONFIG[name] })),
    });
  }
  // 仅迁移旧版（RelayX）品牌默认值；管理员自定义的站点名称和描述保持不变。
  await db.systemConfig.updateMany({
    where: { name: "SITE_NAME", value: "RelayX" },
    data: { value: DEFAULT_CONFIG.SITE_NAME },
  });
  await db.systemConfig.updateMany({
    where: { name: "SITE_DESCRIPTION", value: "RelayX 隧道转发服务" },
    data: { value: DEFAULT_CONFIG.SITE_DESCRIPTION },
  });
  const total = await db.systemConfig.count();
  return { inserted: toInsert.length, total };
}

async function seedSuperAdmin(): Promise<{
  id: number;
  email: string;
  created: boolean;
  passwordSet: boolean;
}> {
  const existing = await db.user.findUnique({
    where: { email: ADMIN_EMAIL },
    include: { credential: true },
  });

  // —— 用户已存在：保留用户本身，仅确保凭证可用 ——
  if (existing) {
    await ensurePersonalWorkspace(existing);
    if (!existing.credential) {
      await db.userCredential.create({
        data: { user_id: existing.id, password: await hashPassword(ADMIN_PASSWORD) },
      });
      writeCredentials(existing.email, ADMIN_PASSWORD);
      return { id: existing.id, email: existing.email, created: false, passwordSet: true };
    }
    // 已存在凭证：不重置，避免种子任务覆盖管理员已修改的口令。
    return { id: existing.id, email: existing.email, created: false, passwordSet: false };
  }

  // —— 用户不存在：创建（首个用户自动 super_admin） ——
  const anySuperAdmin = await db.user.findFirst({ where: { super_admin: true } });

  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: ADMIN_EMAIL,
        super_admin: true,
        // SEC-02：种子账号同样只落 api_key 的 sha256 哈希（不落明文）。
        // 明文只会出现在 seed 写出的凭据文件里，DB 无明文。
        api_key: null,
        api_key_hash: hashKey(newApiKey()),
      },
    });
    await tx.userCredential.create({
      data: { user_id: created.id, password: await hashPassword(ADMIN_PASSWORD) },
    });
    await createPersonalWorkspace(tx, created);
    return created;
  });

  writeCredentials(user.email, ADMIN_PASSWORD);
  if (anySuperAdmin) {
    console.warn(
      `[seed] 注意：库中已存在其他 super_admin，本次新建账号 ${user.email} 也是 super_admin`,
    );
  }
  return { id: user.id, email: user.email, created: true, passwordSet: true };
}

function writeCredentials(email: string, password: string): void {
  const body = `${email}:${password}\n`;
  try {
    writeFileSync(CREDENTIALS_PATH, body, { mode: 0o600 });
    chmodSync(CREDENTIALS_PATH, 0o600);
  } catch (e) {
    // 路径不可写（如本地 bun 直接跑 seed）时退回 stderr 打印，不阻断种子流程
    console.warn(
      `[seed] 无法写入 ${CREDENTIALS_PATH}: ${(e as Error).message}；凭证如下（仅本次输出）`,
    );
    console.log(`[seed] ADMIN_CREDENTIALS ${body.trim()}`);
  }
}

/** 套餐：按 name 幂等 upsert（Plan.name 非唯一，故 findFirst + create/update）。 */
async function seedPlans(): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const p of PLANS) {
    const data = {
      name: p.name,
      description: p.description,
      price: p.price,
      traffic: p.traffic,
      max_tunnels: p.maxTunnels,
      bandwidth_limit: p.bandwidthLimit,
      billing_cycle: BillingCycle.month,
      status: Status.active,
      renewable: true,
      // 允许在购买时自定义节点组，并在全部节点组间可选
      allow_custom_in_node_group: true,
      allow_custom_out_node_group: true,
      all_in_node_groups: false,
      all_out_node_groups: false,
    };
    const existing = await db.plan.findFirst({ where: { name: p.name } });
    if (existing) {
      await db.plan.update({ where: { id: existing.id }, data });
      ids.set(p.name, existing.id);
    } else {
      const created = await db.plan.create({ data });
      ids.set(p.name, created.id);
    }
  }
  return ids;
}

/** 节点组：按 token 幂等 upsert，归属超管用户。 */
async function seedNodeGroups(adminUserId: number): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  const workspace = await db.workspace.findUniqueOrThrow({ where: { personal_user_id: adminUserId } });
  for (const g of NODE_GROUPS) {
    const shared = {
      name: g.name,
      node_type: g.nodeType,
      load_balance_type: g.loadBalanceType,
      user_id: adminUserId,
      workspace_id: workspace.id,
      connect_ip: NODE_CONNECT_IP,
    };
    const ng = await db.nodeGroup.upsert({
      where: { token: g.token },
      update: shared,
      create: { token: g.token, ...shared },
    });
    ids.set(g.name, ng.id);
  }
  return ids;
}

/** 节点：按 node_id 幂等 upsert。 */
async function seedNodes(nodeGroupIds: Map<string, number>): Promise<number> {
  let count = 0;
  for (const n of NODES) {
    const groupId = nodeGroupIds.get(n.nodeGroupName);
    if (groupId === undefined) {
      throw new Error(`[seed] 节点 ${n.nodeId} 引用了不存在的节点组 ${n.nodeGroupName}`);
    }
    await db.node.upsert({
      where: { node_id: n.nodeId },
      update: { node_group_id: groupId, connect_ip: NODE_CONNECT_IP, status: Status.active },
      create: {
        node_id: n.nodeId,
        node_group_id: groupId,
        connect_ip: NODE_CONNECT_IP,
        status: Status.active,
        version: "unknown",
      },
    });
    count++;
  }
  return count;
}

/** 套餐-节点组关联：无联合唯一约束，故先查后插保证幂等。 */
async function seedPlanNodeGroups(
  planIds: Map<string, number>,
  nodeGroupIds: Map<string, number>,
): Promise<number> {
  const allGroupIds = [...nodeGroupIds.values()];
  let created = 0;
  for (const planId of planIds.values()) {
    for (const nodeGroupId of allGroupIds) {
      const link = await db.planNodeGroup.findFirst({
        where: { plan_id: planId, node_group_id: nodeGroupId },
        select: { id: true },
      });
      if (!link) {
        await db.planNodeGroup.create({ data: { plan_id: planId, node_group_id: nodeGroupId } });
        created++;
      }
    }
  }
  return created;
}

async function main() {
  console.log("[seed] start");

  const cfg = await seedConfig();
  console.log(`[seed] config: inserted=${cfg.inserted} total=${cfg.total}`);

  const admin = await seedSuperAdmin();
  console.log(
    `[seed] super_admin: email=${admin.email} created=${admin.created} password_set=${admin.passwordSet}`,
  );

  const planIds = await seedPlans();
  console.log(`[seed] plans: ${[...planIds.keys()].join(", ")}`);

  const nodeGroupIds = await seedNodeGroups(admin.id);
  console.log(`[seed] node_groups: ${[...nodeGroupIds.keys()].join(", ")}`);

  const nodeCount = await seedNodes(nodeGroupIds);
  console.log(`[seed] nodes: ${nodeCount}`);

  const linkCount = await seedPlanNodeGroups(planIds, nodeGroupIds);
  console.log(`[seed] plan_node_group links created: ${linkCount}`);

  const counts = {
    user: await db.user.count(),
    credential: await db.userCredential.count(),
    adminRole: await db.adminRole.count(),
    nodeGroup: await db.nodeGroup.count(),
    node: await db.node.count(),
    plan: await db.plan.count(),
    planNodeGroup: await db.planNodeGroup.count(),
  };
  console.log(`[seed] counts: ${JSON.stringify(counts)}`);
  console.log("[seed] done");
}

main()
  .then(async () => {
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("[seed] FAILED:", e);
    await db.$disconnect();
    process.exit(1);
  });
