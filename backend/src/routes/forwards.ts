/**
 * User-facing Forward API.
 *
 * Forward is the product object. Tunnel stays an internal runtime record.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppVariables } from "../middlewares/auth.ts";
import { db } from "../db.ts";
import { canWorkspaceResourceAction, resolveWorkspaceAccess } from "../services/workspace.ts";
import { defaultTopologyDeps, loadForwardTopology } from "../services/forward-topology.ts";
import {
  DDNS_ERROR_CODES,
  DDNS_TTL_SECONDS,
  DNS_MODES,
  DNS_RECORD_TYPES,
  bindForwardDns,
  dnsBindingState,
  unbindForwardDns,
} from "../services/ddns-binding.ts";
import type { DdnsDb, DdnsDeps, DdnsResult, DnsBindingRow } from "../services/ddns-binding.ts";
import {
  INGRESS_MEMBER_ERROR_CODES,
  PREFERRED_INGRESS_ERROR_CODES,
  buildIngressMemberViews,
  readIngressMemberIntent,
  setIngressMembers,
  setPreferredIngressNode,
} from "../services/preferred-ingress.ts";
import type {
  IngressMemberIntentDb,
  IngressMemberIntentRow,
  IngressMemberView,
  IngressMemberWriteDb,
  PreferredIngressDb,
} from "../services/preferred-ingress.ts";
import {
  pickFailoverDestination,
  readFailoverPolicy,
} from "../services/failover-loop.ts";
import { FAILOVER_THRESHOLDS } from "../services/failover-thresholds.ts";
import { defaultDiagnoseDeps, diagnoseForward } from "../services/agent-diagnose.ts";
import {
  createForward,
  deleteForward,
  getForward,
  getForwardSummary,
  getForwardTraffic,
  listForwards,
  listForwardsPage,
  patchForward,
  previewForwardUpdate,
  runForwardAction,
  runForwardBatch,
  type ForwardAction,
  type ForwardServiceResult,
} from "../services/forward-service.ts";
import {
  DEFAULT_BUCKET_RETENTION_DAYS,
  DEFAULT_RAW_RETENTION_HOURS,
  defaultLatencyHistoryDeps,
  readLatencySeries,
} from "../services/latency-history.ts";
import type { LatencyGranularity } from "../services/latency-history.ts";
import { parseForwardBatchRequest } from "../services/forward-batch.ts";
import { BILLING_TIME_ZONE, billingDayKeyStamp, billingDayStart } from "../services/billing-time.ts";
import { dayKeyOf, fillDays } from "../services/traffic.ts";
import { FORWARD_PROTOCOLS } from "../services/forward-contract.ts";
import {
  forwardListShape,
  forwardOrderBy,
  forwardPage,
  parseForwardListQuery,
} from "../services/forward-list-query.ts";

export const forwardsRoutes = new Hono<{ Variables: AppVariables }>();
type Ctx = Context<{ Variables: AppVariables }>;

forwardsRoutes.use("*", async (c, next) => {
  const method = c.req.method.toUpperCase();
  const path = c.req.path;

  let action: "read" | "create" | "update" | "delete" = "read";
  if (method === "DELETE") action = "delete";
  else if (method === "POST" && /\/api\/forwards\/?$/.test(path)) {
    action = "create";
  } else if (method === "POST" && /\/diagnose\/?$/.test(path)) {
    // : the probe is read-only (no desired-state change, no revision
    // bump). Requiring forward:update would tell a read-only role "you may not
    // diagnose the forward you can see", which is not the product rule.
    action = "read";
  } else if (method === "PATCH" || method === "PUT" || method === "POST") {
    action = "update";
  }

  c.set("workspace", await resolveWorkspaceAccess(c, action, "forward"));
  await next();
});

function workspace(c: Ctx): NonNullable<AppVariables["workspace"]> {
  const value = c.get("workspace");
  if (!value) throw new HTTPException(403, { message: "工作空间未授权" });
  return value;
}

function user(c: Ctx): NonNullable<AppVariables["user"]> {
  const value = c.get("user");
  if (!value) throw new HTTPException(401, { message: "Unauthorized" });
  return value;
}

/** Preliminary workspace checks cannot establish creator ownership. Query only the
 * scoped runtime identity; full-access identities keep service-level scope checks. */
async function authorizeForward(c: Ctx, id: number, action: "read" | "update" | "delete") {
  const access = workspace(c);
  if (canWorkspaceResourceAction(access, action, "forward")) return null;
  const row = await db.tunnel.findFirst({
    where: { id, workspace_id: access.id, category: "port_forward" },
    select: { user_id: true },
  });
  if (!row) return c.json({ error: "端口转发不存在", code: "not_found", error_layer: "resource_scope" }, 404);
  if (!canWorkspaceResourceAction(access, action, "forward", row.user_id === user(c).id)) {
    return c.json({ error: "无权操作该端口转发", code: "forbidden", error_layer: "rbac" }, 403);
  }
  return null;
}

function idParam(c: Ctx, name: string): number | null {
  const value = Number(c.req.param(name));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function send<T>(
  c: Ctx,
  result: ForwardServiceResult<T>,
  successStatus: 200 | 201 = 200,
) {
  if (!result.ok) {
    return c.json(
      {
        error: result.message,
        code: result.code,
        apply_error_code: result.apply_error_code,
        error_layer: result.error_layer,
        data: result.data,
      },
      result.status,
    );
  }
  return c.json({ data: result.data }, successStatus);
}

export const ForwardCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    mode: z.enum(["direct", "relay"]),
    protocol: z.enum(FORWARD_PROTOCOLS).optional(),
    // : paths only. Shape is enforced here; existence is the Agent's
    // check (the panel cannot see the node's filesystem), and a missing file is
    // a build-time refusal on the node.
    tls_cert_path: z.string().trim().min(1).max(512).startsWith("/").optional(),
    tls_key_path: z.string().trim().min(1).max(512).startsWith("/").optional(),
    ingress_node_id: z.number().int().positive(),
    egress_node_id: z.number().int().positive().nullable().optional(),
    // V5.4：三跳路由的中间跳（省略 = 单跳）。schema 是 `.strict()` 的 —— 也就是说
    // 少了这一行，body 里的 `middle_node_id` 会被**拒绝**（400）而不是被静默丢掉。
    // 这个 400 是对的（未知字段 fail-closed），它暴露的是"服务层加了、路由层没加"
    // 这一半漏接线 —— 与协议/证书/健康/池内容那几次同类，只是这次发生在入参层。
    middle_node_id: z.number().int().positive().nullable().optional(),
    listen_port: z.number().int().min(1).max(65535).nullable().optional(),
    target_host: z.string().trim().min(1).max(255),
    target_port: z.number().int().min(1).max(65535),
    //：把出口腿委托给一个已信任的 peer panel（缺省 = 出口在本机）。
    // 形状在这里判；"这个 peer 存不存在/信不信任"由 service 层的
    // `validateFederatedEgressDeclaration` 判（唯一的实现，见 forward-hop.ts），
    // 失败返回契约 §6 的错误码而不是 500。
    federated_egress_peer: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/**
 *  §13.3.1 / §13.3.3：可编辑全集（与 create 的字段一致）+ `expected_revision`。
 *
 * `expected_revision` 是可选的乐观并发凭据，不是筛选条件——缺失说明客户端是
 * 首次请求或有意跳过并发检查；存在但不匹配 → 409（见 patchForward 内闸门）。
 */
export const ForwardPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    mode: z.enum(["direct", "relay"]).optional(),
    ingress_node_id: z.number().int().positive().optional(),
    egress_node_id: z.number().int().positive().nullable().optional(),
    /** V5.4：中间跳（`null` = 回到单跳）。与入出口同样是运行态放置事实。 */
    middle_node_id: z.number().int().positive().nullable().optional(),
    listen_port: z.number().int().min(1).max(65535).nullable().optional(),
    target_host: z.string().trim().min(1).max(255).nullable().optional(),
    target_port: z.number().int().min(1).max(65535).nullable().optional(),
    // : the tls front's paths are editable, with the SAME shape rule as
    // create. The protocol itself is deliberately NOT here: turning a tcp Forward
    // into a tls one is a different operation (port lease, target semantics and
    // the RELAY shape all change), and §6.1 did not freeze that semantics — so it
    // is refused by omission rather than guessed at.
    tls_cert_path: z.string().trim().min(1).max(512).startsWith("/").optional(),
    tls_key_path: z.string().trim().min(1).max(512).startsWith("/").optional(),
    /**
     *：`null` = 改回本机出口；省略 = 不变（候选合并的语义）。
     * peer 是否存在/已信任由 service 层判定（唯一实现），这里只判形状。
     */
    federated_egress_peer: z.string().trim().min(1).max(64).nullable().optional(),
    expected_revision: z.number().int().nonnegative().nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      Object.keys(v).some(
        (k) => k !== "expected_revision" && k !== "name",
      ) ||
      v.name !== undefined,
    { message: "至少提供一个有效输入字段" },
  );

const ACTIONS = new Set<ForwardAction>(["retry", "suspend", "resume"]);

/**
 *  §13.6：列表改为**服务端**分页 / 排序。
 *
 * 响应形状 `{ data: { data, total, page, page_size } }`（前端 request() 剥一层
 * 后即 `Paginated<PortForward>`），与 `GET /api/node-groups`、
 * `GET /api/tunnels` 的分页信封完全一致——同一产品里不能有两种分页形状。
 *
 * 兼容口径（重要）：
 *   · 客户端**显式带 page / page_size**才走分页信封；
 *   · 不带分页参数时返回裸数组（保持  及之前 `api.forwards.list()` 的契约，
 *     以及 E2E 脚本 / 仪表盘的 `slice(0,5)` 取用方式）。
 *   这条不是"过渡期双轨"：分页信封与裸数组都是冻结契约，前者是新 UI 的形态，
 *   后者是「取全部」的显式语义（服务端仍施加上限，防止无界查询）。
 *
 * 上限常量 `FORWARD_LIST_MAX_UNPAGED` 定义在 `forward-list-query.ts`——兼容端点
 * `/api/nodes/:ingressId/forwards` 用同一个常量，两处不能各写一个数字。
 */

forwardsRoutes.get("/", async (c) => {
  const ws = workspace(c);
  const q = c.req.query();
  const parsed = parseForwardListQuery(q);

  if (forwardListShape(q) === "all") {
    // 「取全部」的上限在 `listForwards` 服务层（单一落点），这里不再二次截断。
    return c.json({ data: await listForwards(ws.id, parsed.filters) });
  }

  const page = await listForwardsPage(ws.id, parsed.filters, {
    skip: parsed.skip,
    take: parsed.take,
    orderBy: forwardOrderBy(parsed.sort, parsed.order),
  });
  return c.json({
    data: forwardPage(page.data, page.total, parsed.page, parsed.page_size),
  });
});

forwardsRoutes.get("/summary", async (c) => {
  return c.json({ data: await getForwardSummary(workspace(c).id) });
});

forwardsRoutes.post("/", async (c) => {
  const parsed = ForwardCreateSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "端口转发参数不合法", code: "invalid_input" }, 400);
  }

  const ws = workspace(c);
  return send(
    c,
    await createForward(user(c).id, ws.id, parsed.data, {
      canManageNodes: canWorkspaceResourceAction(ws, "manage", "node"),
    }),
    201,
  );
});

forwardsRoutes.get("/:id/traffic", async (c) => {
  const id = idParam(c, "id");
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  const days = Math.max(
    1,
    Math.min(90, Number(c.req.query("days") ?? 14) || 14),
  );
  return send(c, await getForwardTraffic(id, workspace(c).id, days));
});

/** 窗口上限（天）：与 `/:id/traffic` 的钳制口径一致（同一张账本、同一条横轴）。 */
const MAX_THROUGHPUT_WINDOW_DAYS = 90;
/** 归档节拍（分钟）：与 `worker.ts` 里 `cron_save_traffic` 的节拍一致（每 10 分钟）。 */
const THROUGHPUT_ARCHIVE_INTERVAL_MINUTES = 10;

/**
 * `GET /api/forwards/:id/throughput` —— **日均吞吐序列**（只读，零副作用）。
 *
 * 行为参照：ForwardX（AGPL-3.0-only）——流量面「带标签的时间窗 + 分桶 + 单位标注」的产品逻辑；
 * 代码为本项目改写（复用我们自己的 `tunnel_traffic` 归档账本与既有 day-key helper），未复制其实现。
 * 参照溯源：`docs/agent/forwardx-code-reuse.md`。
 *
 * ── 为什么不能直接复用 `/:id/traffic` ──
 * 那个端点为了给详情页柱状图一条连续横轴，会把窗口内**没有归档行的日子补成 0**
 * （`services/forward-service.ts` 的 `fillDays(...).map(key => hit ? … : 0)`）。调用方因此
 * **无法区分**两件完全不同的事：
 *   · 那天有归档行、流量确实是 0（**测到的零**）；
 *   · 那天根本没有归档行（**缺口**：节点没跑 / 归档没到 / 超出保留期）。
 * 吞吐视图的价值恰恰在于"缺口看得见"，所以这里给一条**把缺口保留成 `null`** 的只读投影，
 * 并**不改** `/traffic` 的既有契约（详情页图表与账本累计都在消费它）。
 *
 * ── 口径（全部由服务端给出；前端不自算窗口，也不补零）──
 *   · 粒度 **day**：账本是 `@@unique([tunnel_id, date])` 的日行，归档节拍只把 Redis 缓冲
 *     同步进**当天那一行** ⇒ 不存在日内分辨率（不假装有）；
 *   · 横轴：`fillDays(days, now)` 的稠密日键（Asia/Shanghai 日界），与 `/traffic` 同一套 helper；
 *   · 点值：`bytes: number | null`（`null` = 该日没有归档行）、`rate_bps: number | null`
 *     （日均速率 = 该日字节 ÷ 该日已过秒数；缺口与 `bytes` 同步为 `null`，**不是** 0）；
 *   · `complete`：今天是不完整日 ⇒ `false`（分母只算已过时间，界面不得把它与完整日直接比较）；
 *   · `summary.avg_rate_bps_over_window`：整窗平均（分母 = 整窗秒数），另给
 *     `coverage.{days_with_data,days_missing}`，避免把"缺了一半的日子"读成低吞吐。
 *
 * ── 明确不派生（账本里不存在；需要改 schema，本切片不动）──
 *   · 上行/下行分开：ForwardX 的面板有 `bytesIn`/`bytesOut`，我们的账本只有一列 `traffic`；
 *   · 小时桶 / 峰值：日行没有日内分辨率；
 *   · 连接数：账本没有连接数事实。
 * 这三条写进交付报告的"不可派生"清单，**不做**替代或估算。
 *
 * 权限/作用域与 `/traffic`、`/topology`、`/latency` 同一条（`forward:read`）；跨 Workspace 与
 * "真不存在"返回逐字同形的 404。注册位置同样必须在参数化 catch-all 之前。
 */
forwardsRoutes.get("/:id/throughput", async (c) => {
  const id = idParam(c, "id");
  if (id === null) return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  const denied = await authorizeForward(c, id, "read");
  if (denied) return denied;
  const ws = workspace(c);
  const days = Math.max(
    1,
    Math.min(MAX_THROUGHPUT_WINDOW_DAYS, Number(c.req.query("days") ?? 14) || 14),
  );

  const row = await db.tunnel.findFirst({
    where: { id, workspace_id: ws.id, category: "port_forward" },
    select: { id: true },
  });
  if (!row) {
    return c.json(
      { error: "端口转发不存在", code: "not_found", error_layer: "resource_scope" },
      404,
    );
  }

  const now = new Date();
  const todayKey = dayKeyOf(billingDayKeyStamp(now));
  const since = new Date(billingDayKeyStamp(now).getTime() - (days - 1) * 86_400_000);
  const rows = await db.tunnelTraffic.findMany({
    where: { tunnel_id: id, workspace_id: ws.id, date: { gte: since } },
    orderBy: { date: "asc" },
    select: { date: true, traffic: true },
  });

  // 同一日键可能有多行（历史分片/补录）：与 `/traffic` 一样按日求和，而不是"只取一行"。
  const bytesByDay = new Map<string, number>();
  for (const trafficRow of rows) {
    const key = dayKeyOf(trafficRow.date);
    bytesByDay.set(key, (bytesByDay.get(key) ?? 0) + Number(trafficRow.traffic ?? 0));
  }

  // 今天的分母只算已过时间：拿不完整日与完整日比，会把正常波动读成业务下降。
  //
  // ⚠️ 分母的起点必须是**上海自然日的日首**（`billingDayStart`），**不是**
  // `billingDayKeyStamp`。两者都叫"这一天"，但瞬时点不同：
  //   · `billingDayStart(now)`    = 当日在上海的 00:00:00（= 前一日 16:00Z）；
  //   · `billingDayKeyStamp(now)` = 当日**日标签的归档戳**（当日 00:00:00Z = 上海 08:00），
  //     那是 `tunnel_traffic.date` 的**存储**约定，与自然日界无关（见 billing-time.ts 的说明）。
  // 用归档戳做分母起点，在上海 08:00 之前差值**为负**（被 `Math.max(1, …)` 夹成 1 秒），
  // 08:00 之后也只数到"当天已过的一部分"——于是同一份字节数据在上午被放大成几十倍的假速率。
  // 存储口径（`todayKey` / `since` / 归档日键）保持 `billingDayKeyStamp` 不变：只改分母。
  const elapsedTodaySeconds = Math.max(
    1,
    Math.floor((now.getTime() - billingDayStart(now).getTime()) / 1000),
  );

  const keys = fillDays(days, now);
  const series = keys.map((date) => {
    const hasRow = bytesByDay.has(date);
    const bytes = hasRow ? (bytesByDay.get(date) as number) : null;
    const complete = date !== todayKey;
    const seconds = complete ? 86_400 : elapsedTodaySeconds;
    return {
      date,
      bytes,
      /** 日均速率（bytes/s）；缺口与 `bytes` 同步为 `null`，**不是** 0。 */
      rate_bps: bytes === null ? null : Math.round((bytes / seconds) * 1000) / 1000,
      /** `false` = 不完整日（今天）：速率分母只算已过时间。 */
      complete,
    };
  });

  const daysWithData = series.filter((point) => point.bytes !== null).length;
  const totalBytes = series.reduce((sum, point) => sum + (point.bytes ?? 0), 0);
  const windowSeconds = days * 86_400;

  return c.json({
    data: {
      forward_id: id,
      /** 聚合粒度：账本只有日行分辨率，如实标 `day`。 */
      granularity: "day",
      /** 点值单位：图表与表格共用（日均速率用 bytes_per_second，总量用 bytes）。 */
      unit: "bytes_per_second",
      window: {
        from: keys[0] ?? null,
        to: keys[keys.length - 1] ?? null,
        days,
        time_zone: BILLING_TIME_ZONE,
      },
      series,
      summary: {
        total_bytes: totalBytes,
        /** 整窗平均速率（分母 = 整窗秒数）——与"只按有数据的天算"是两回事，名字里写清。 */
        avg_rate_bps_over_window: Math.round((totalBytes / windowSeconds) * 1000) / 1000,
        coverage: {
          days_with_data: daysWithData,
          days_missing: series.length - daysWithData,
        },
      },
      archive: {
        interval_minutes: THROUGHPUT_ARCHIVE_INTERVAL_MINUTES,
        today_key: todayKey,
        /** 今天永远是不完整日：账本按日累计，且滞后不超过一个归档节拍。 */
        today_incomplete: true,
      },
      limits: { max_days: MAX_THROUGHPUT_WINDOW_DAYS },
    },
  });
});

/**
 *  —— `GET /api/forwards/:id/topology`（**只读**拓扑与逐跳明细）。
 *
 * 位置要求：**必须**注册在任何 `/:id/:参数` catch-all 之前（Hono 同方法按注册顺序匹配）。
 * 这不是注释里的提醒而已 —— `forward-route-order.test.ts` 会机械地检查它，而
 * `forward-route-topology.test.ts` 会在**行为上**证明它真的可达。
 *
 * 权限：`forward:read`（它不改任何东西、不发任何命令：计划与 live facts 都来自既有的
 * route plan 与节点上报）。
 */
forwardsRoutes.get("/:id/topology", async (c) => {
  const id = idParam(c, "id");
  if (id === null) return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  const denied = await authorizeForward(c, id, "read");
  if (denied) return denied;
  const result = await loadForwardTopology(defaultTopologyDeps(), {
    forwardId: id,
    workspaceId: workspace(c).id,
  });
  if (!result.ok) {
    const status = result.code === "not_found" ? 404 : 409;
    return c.json({ error: result.message, code: result.code, error_layer: "resource_scope" }, status);
  }
  return c.json({ data: result.topology });
});

forwardsRoutes.get("/:id", async (c) => {
  const id = idParam(c, "id");
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  const row = await getForward(id, workspace(c).id);
  if (!row) {
    return c.json({ error: "端口转发不存在", code: "not_found" }, 404);
  }
  return c.json({ data: row });
});

forwardsRoutes.patch("/:id", async (c) => {
  //：PATCH 是「编辑」语义而非「改名字」——不再只接受 name 补丁。
  // 单用户/单窗口编辑最快，但两个浏览器标签先后保存必须被 expected_revision
  // 拦下（409），否则后保存者会静默覆盖前者的端口/节点选择。
  const id = idParam(c, "id");
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  const parsed = ForwardPatchSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "端口转发参数不合法";
    return c.json({ error: message, code: "invalid_input" }, 400);
  }
  const denied = await authorizeForward(c, id, "update");
  if (denied) return denied;
  return send(c, await patchForward(id, workspace(c).id, parsed.data, user(c).id));
});

/**
 *  —— `POST /api/forwards/:id/diagnose`
 *
 * 只读诊断：探针目标由服务端从该转发的**已授权期望状态**推导（见
 * services/forward-probe-plan.ts），请求体不携带任何 host/port —— 否则这个
 * 端点会变成"用客户机房里的机器扫内网"的 SSRF 工具。
 *
 * 权限：read 级（forward:read），资源作用域照旧由 resolveWorkspaceAccess +
 * creator guard 保证；它不改 desired、不加 revision、不发业务流量。
 */
forwardsRoutes.post("/:id/diagnose", async (c) => {
  const id = idParam(c, "id");
  if (id === null) return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  const denied = await authorizeForward(c, id, "read");
  if (denied) return denied;
  const result = await diagnoseForward(id, workspace(c).id, defaultDiagnoseDeps());
  if (!result.ok) {
    return c.json({ error: result.message, code: result.code, error_layer: result.error_layer }, result.status);
  }
  return c.json({ data: result.report });
});

/**
 *  §13.3.3 preview：保存前影响面（不写库、不触发 apply）。
 *
 * 路由与 mutation 同源：同一个 zod schema、同一个 candidate resolver。
 * 因此「preview 显示可保存」与「PATCH 实际接受」不可能出现两种结论。
 * 注意：注册在 `/:id/:action` 之前，否则 action 参数会吃掉 "preview"。
 */
forwardsRoutes.post("/:id/preview", async (c) => {
  const id = idParam(c, "id");
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  const parsed = ForwardPatchSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "端口转发参数不合法";
    return c.json({ error: message, code: "invalid_input" }, 400);
  }
  const denied = await authorizeForward(c, id, "update");
  if (denied) return denied;
  const u = c.get("user");
  return send(
    c,
    await previewForwardUpdate(
      id,
      workspace(c).id,
      parsed.data,
      u?.id ?? undefined,
    ),
  );
});

/* ================================================================== */
/*  —— DNS 前门与首选入口（**必须注册在任何 `/:id/:参数` catch-all 之前**） */
/* ================================================================== */
//
// 为什么这段必须在这个位置：Hono 对同一方法**按注册顺序**匹配。文件后段还有一个
// `post("/:id/:action")` 的 catch-all（它把 `action` 当动词分派）；如果本区块注册在它之后，
// `POST /:id/dns` 会被那个 catch-all 先吃掉，返回 400「不支持的端口转发动作」——
// 症状是 **DNS 前门根本绑不上**，而 GET/DELETE 因为同路径没有 catch-all 反而正常。
//
// 这不是猜想： 的 Gate 在真实 API 上实测到过（`POST /api/forwards/70/dns` → 400），
// 而当时 38 条断言全部通过 —— 因为路由级用例是**单独 mount** 这个 router 的，绕过了注册顺序。
// 所以除了位置，还有一条源码级守卫看着它（见 `__tests__/forward-route-order.test.ts`）。

/* ================================================================== */
/*  —— DNS 前门：绑定 / 解绑 / 状态（**零外呼**）               */
/* ================================================================== */

/**
 * 为什么这三个端点挂在 `/api/forwards/:id/dns` 而不是 `/api/ddns/...`：
 * DNS 前门是**某一条转发**的属性，不是独立资源。挂在转发下面，`authorizeForward`
 * 那套"工作空间 + creator guard"的作用域判定就直接复用了 —— 换个前缀就得再写一遍
 * 作用域判定，而每多写一遍就多一个漏判的机会（契约 F6 ③ 的跨租户规则正是靠它兜底）。
 *
 * 权限：读 = `forward:read`，写 = `forward:update`（改的是这条转发的前门）。
 * provider 的增删在 `/api/ddns/providers`，走 `settings:*` —— 凭据属于设置域，不属于某条转发。
 */
const DnsBindSchema = z
  .object({
    domain: z.string().trim().min(1).max(253),
    record_type: z.enum(DNS_RECORD_TYPES),
    mode: z.enum(DNS_MODES),
    provider_id: z.number().int().positive().nullable().optional(),
    auto_resolve: z.boolean().optional(),
    ttl_seconds: z.number().int().min(DDNS_TTL_SECONDS.min).max(DDNS_TTL_SECONDS.max).optional(),
  })
  .strict();

function ddnsDeps(c: Ctx): DdnsDeps {
  return {
    db: db as unknown as DdnsDb,
    // 平台级 provider 与平台共享入口组都看 `super_admin`（与中间件同一判据，
    // 不新造"平台管理员"的第二种定义）。
    isPlatformAdmin: async () => user(c).super_admin === true,
  };
}

function sendDdns<T>(c: Ctx, result: DdnsResult<T>, successStatus: 200 | 201 = 200) {
  if (!result.ok) {
    const status =
      result.code === DDNS_ERROR_CODES.ddns_not_found || result.code === DDNS_ERROR_CODES.dns_provider_not_found
        ? 404
        : result.code === DDNS_ERROR_CODES.dns_provider_forbidden ||
            result.code === DDNS_ERROR_CODES.shared_group_dns_denied
          ? 403
          : 400;
    return c.json({ error: result.error, code: result.code, error_layer: "ddns" }, status);
  }
  return c.json({ data: result.value }, successStatus);
}

/**
 * 读一条转发的 DNS 前门状态（含推导出的期望值集，见 `dnsBindingState`）。
 *
 * **零副作用**：只有这一条 `findFirst`（`authorizeForward` 的 creator 查询只在非全权角色上
 * 发生），不写库、不外呼。
 *
 * select 里三个 V5-WP17.3 读投影列（`dns_auto_resolve` / `dns_attempt_count` /
 * `dns_next_attempt_at`）是给 Web 的**服务端真相**：前门开关与退避进度禁止前端自己算
 * （执行器判的就是这三列，前端重算必然与之漂移）。它们都是非敏感的标量——**凭据**（provider
 * 的 `config` 封存串）与封存材料一律不进这个 select，本路由任何时候都拿不到明文/密文。
 */
forwardsRoutes.get("/:id/dns", async (c) => {
  const id = idParam(c, "id");
  if (id === null) return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  const denied = await authorizeForward(c, id, "read");
  if (denied) return denied;
  const row = (await db.tunnel.findFirst({
    where: { id, workspace_id: workspace(c).id, category: "port_forward" },
    select: {
      dns_domain: true,
      dns_record_type: true,
      dns_mode: true,
      dns_provider_id: true,
      dns_confirmed_values: true,
      dns_synced_at: true,
      dns_verified: true,
      dns_last_error: true,
      dns_auto_resolve: true,
      dns_attempt_count: true,
      dns_next_attempt_at: true,
      ingress_node: { select: { connect_ip: true } },
    },
  })) as
    | (DnsBindingRow & { dns_provider_id?: unknown; ingress_node?: { connect_ip: string | null } | null })
    | null;
  if (!row) return c.json({ error: "端口转发不存在", code: "not_found" }, 404);
  const owner = row.ingress_node?.connect_ip?.trim() ?? "";
  return c.json({ data: dnsBindingState(row, owner === "" ? [] : [owner]) });
});

forwardsRoutes.post("/:id/dns", async (c) => {
  const id = idParam(c, "id");
  if (id === null) return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  const parsed = DnsBindSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "DNS 绑定参数不合法", code: "invalid_input" }, 400);
  }
  const denied = await authorizeForward(c, id, "update");
  if (denied) return denied;
  const result = await bindForwardDns(ddnsDeps(c), {
    workspaceId: workspace(c).id,
    userId: user(c).id,
    tunnelId: id,
    domain: parsed.data.domain,
    recordType: parsed.data.record_type,
    mode: parsed.data.mode,
    providerId: parsed.data.provider_id ?? null,
    autoResolve: parsed.data.auto_resolve ?? false,
    ...(parsed.data.ttl_seconds === undefined ? {} : { ttlSeconds: parsed.data.ttl_seconds }),
  });
  return sendDdns(c, result);
});

forwardsRoutes.delete("/:id/dns", async (c) => {
  const id = idParam(c, "id");
  if (id === null) return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  const denied = await authorizeForward(c, id, "update");
  if (denied) return denied;
  const result = await unbindForwardDns(ddnsDeps(c), {
    workspaceId: workspace(c).id,
    userId: user(c).id,
    tunnelId: id,
  });
  return sendDdns(c, result);
});

/* ================================================================== */
/* （契约 D4）—— 首选入口节点                                  */
/* ================================================================== */

/**
 * 为什么是独立端点而不是 `PATCH` 的一个字段：`PATCH` 是"编辑运行态字段"，它会生成新 revision
 * 并触发 rollout —— 改一个**偏好**不该重启转发，更不该立刻把归属搬到首选节点（那会绕过
 * `FAILBACK_HEALTHY_CHECKS` 与冷却期，而它们正是这条策略的意义）。偏好是调度意图，
 * 由 failover sweep 在后续节拍里按策略决定要不要真的回切。
 *
 * 权限：`forward:update`（它是这条转发的一个属性）。
 */
const PreferredIngressSchema = z.object({ node_id: z.number().int().positive().nullable() }).strict();

forwardsRoutes.put("/:id/preferred-ingress", async (c) => {
  const id = idParam(c, "id");
  if (id === null) return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  const parsed = PreferredIngressSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "node_id 不合法", code: "invalid_input" }, 400);
  }
  const denied = await authorizeForward(c, id, "update");
  if (denied) return denied;
  const result = await setPreferredIngressNode(
    { db: db as unknown as PreferredIngressDb },
    { workspaceId: workspace(c).id, tunnelId: id, nodeId: parsed.data.node_id },
  );
  if (!result.ok) {
    const status = result.code === PREFERRED_INGRESS_ERROR_CODES.preferred_not_found ? 404 : 400;
    return c.json({ error: result.error, code: result.code, error_layer: "failover" }, status);
  }
  return c.json({ data: result.value });
});

/* ================================================================== */
/* task-43 —— 入口成员次序（PUT /:id/ingress-members）                   */
/* ================================================================== */
//
// 行为参照：ForwardX（AGPL-3.0-only）——多入口/转发组的成员表（`priority` + `isEnabled`，
// 顺序即优先级、恢复的高优先级成员要能压过当前活跃的低优先级成员）；**代码为本项目改写，
// 未复制其实现**。
//
// 为什么要有它：成员集合是既有真相（这条转发的入口节点组），但**次序是"按这条转发"的意图**
// —— 同一台节点可以在 A 转发里排第 1、在 B 转发里排第 3。所以次序落在按转发的行上
// （`forward_ingress_member`），而不是节点列（那会让共用该组的其它转发一起变形）。
//
// 语义（与既有 `PUT /:id/preferred-ingress` 同一套纪律）：
//   · **数组顺序 = 优先级**（`priority = 数组下标`）：客户端不传 `priority`，因此不存在
//     "priority 冲突"这件事；重复的 `node_id` 直接拒绝（不静默去重）；
//   · **全量替换**：本次数组就是完整次序；`members: []` = 清除自定义次序（回到平台默认次序）；
//   · **同一条写入路径维护回切目标**：`preferred_ingress_node_id` = 第一台**启用**的成员，
//     与成员表在同一次事务里写 ⇒ 不会出现"表说首选是 A、列说首选是 B"的两份真相；
//   · 不 bump revision、不触发 rollout（次序是调度意图，不是运行态字段）；
//   · 权限：`forward:update` + creator guard（与偏好设置同一道门）。
//
// 顺序纪律：literal 子路由仍必须在参数化 catch-all 之前（与 `/ha`、`/preferred-ingress` 同）。
const IngressMembersSchema = z
  .object({
    members: z
      .array(
        z
          .object({
            node_id: z.number().int().positive(),
            is_enabled: z.boolean().optional(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

forwardsRoutes.put("/:id/ingress-members", async (c) => {
  const id = idParam(c, "id");
  if (id === null) return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  const parsed = IngressMembersSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "members 不合法", code: "invalid_input" }, 400);
  }
  const denied = await authorizeForward(c, id, "update");
  if (denied) return denied;
  const result = await setIngressMembers(
    { db: db as unknown as IngressMemberWriteDb },
    { workspaceId: workspace(c).id, tunnelId: id, members: parsed.data.members },
  );
  if (!result.ok) {
    const status =
      result.code === INGRESS_MEMBER_ERROR_CODES.member_forward_not_found
        ? 404
        : result.code === INGRESS_MEMBER_ERROR_CODES.member_node_not_found
          ? 404
          : result.code === INGRESS_MEMBER_ERROR_CODES.member_unavailable
            ? 503
            : 400;
    return c.json({ error: result.error, code: result.code, error_layer: "failover" }, status);
  }
  return c.json({ data: result.value });
});

/* ================================================================== */
/* task-16 / task-38 —— 高可用只读投影（GET /:id/ha）                    */
/* ================================================================== */
//
// 行为参照：ForwardX（AGPL-3.0-only）——多入口/转发组（成员集合与优先级、"故障窗口后切到
// 下一个可用成员"、"恢复后切回"开关、以及"在线 ≠ 可用"的成员状态口径）；**代码为本项目改写，
// 未复制其实现**。参照的是**行为语义**，落点全部是本项目既有原语（节点组 = 成员集合、
// `pickFailoverDestination` = 顺序与候选、`FAILOVER_POLICY` = 两个开关、
// `failback_healthy_checks` = 回切进度）；**没有**引入它的资源模型，也没有新增任何存储。
//
// 为什么要有这条**只读**端点：`FAILOVER_POLICY`、`tunnel.preferred_ingress_node_id`、
// `pickFailoverDestination` 全都已经在后端存在（策略、存储、执行器、候选判定），而用户域
// **一个字节都读不到**（Web 全仓 grep 命中 0）。于是"平台会不会替我迁移"这件事在产品上
// 完全不可见。这里只做投影：**不新增表/列/迁移，不改 failover 执行语义**。
//
// ── 这份响应里必须分开的四类事实（混在一起就会说错话）──
//
//   ① `preferred_ingress_node_id` = **期望**（调度意图；NULL = 没有偏好）。它**不代表**这台机器
//      在线、能接业务、或者面板指挥得动 —— 写入路径刻意允许把当前离线/维护中的节点设为首选
//      （`preferred-ingress.ts`），真正的门槛由策略在每一拍判；
//   ② `active_ingress_node_id` = **事实**（现在归谁，`tunnel.ingress_node_id`）；
//   ③ `policy` = 平台策略真值（**只读**）。缺省即关：`readFailoverPolicy` 与 failover 循环
//      读的是**同一个函数**，所以"两个开关都 false ⇒ 平台不会自动迁移"是**生效事实**，
//      不是对配置文件的猜测。坏 JSON 会被它当成两个都关（fail-closed），但那是"配置坏了"
//      而不是"运维没开" ⇒ `parse_error` 必须如实带出来，两者下一步动作不同；
//   ④ `failover_candidate` = 与 failover 循环**同一份判定**（`pickFailoverDestination`：非现任
//      + 准入 + 角色 + **此刻在线**）。三态必须可分：`available` / `none`（确实没有合格候选）
//      / `unavailable`（这次读不到）—— 把"读不到"渲染成"没有高可用"是本项目反复吃过亏的形态。
//
// ── 成员视图（`ingress_members`）与它的三个**不同**的态 ──
//
// 成员集合就是这条转发的入口节点组（既有真相，不是新表）；每台成员带
// `connection`（事实）/ `accepts_new_business`（准入结论）/ `can_take_over`（此刻能不能接管）
// / `failover_rank`（平台当前的接管次序）/ `is_failback_target`（是不是回切目标）。
// 契约上必须分得开的三个态：
//   · `status: "unavailable"` —— 这次**读不到**成员列表（不许说成"没有成员"）；
//   · `status: "ok"` + `nodes: []` —— 组里**确实没有成员**；
//   · `nodes` 非空但没有任何 `can_take_over` —— 有成员，但**此刻没有能接管的**（各成员自己的
//     `takeover_rejection` 说明第一个不满足的条件；这与 `failover_candidate: none` 是同一事实的
//     两种粒度，UI 用细粒度的原因码解释"为什么切不过去"）。
//
// 「能不能当首选」（`can_be_preferred`）**只用写入路径自己的规则**（同入口组 +
// `role ∈ {ingress,both}` + 未在成员次序中显式停用，与 `preferred-ingress.ts` 同源）；`can_take_over` 才是 failover
// 的判定（还要求生命周期与在线）。两者不同源、也不同答案：一台维护中的机器
// `can_be_preferred=true` 但 `can_take_over=false`，UI 必须分开说。
//
// ── 顺序（task-38 的诚实边界）──
//
// `member_priority.custom_order_supported = false`：平台此刻的接管次序是既有规则
// （合格候选按 `node_id` 升序，`pickFailoverDestination` 的显式排序），**不是**用户可以随意
// 拖动的列表。按转发自定义成员顺序需要一份"按转发的"存储；节点组是多条转发共享的资源，
// 把顺序塞进节点列会让共用该组的其它转发一起变形 —— 因此本切片不做，交由 Lead 裁决。
//
// 顺序纪律：**literal 子路由一律注册在参数化 catch-all 之前**（本文件 `post("/:id/:action")`
// 在文件末段）。DNS 前门与延迟端点都在这条规则上踩过，所以这里同样前置，并由
// `forwards-ha-route.test.ts` 在行为上证明它没被吃掉。

/** 首选入口备选节点的 select：**不**含任何连接 IP / 凭据明文。 */
const HA_NODE_SELECT = {
  id: true,
  node_id: true,
  role: true,
  status: true,
  last_seen_at: true,
  node_group_id: true,
  lifecycle: true,
  // 只用于派生 `has_credential` 布尔（`projectUserNode` 的入参），**绝不进响应体**。
  node_credential_hash: true,
  credential_revoked: true,
} as const;

interface HaNodeRow {
  id: number;
  node_id: string;
  role: string | null;
  status: string;
  last_seen_at: Date | null;
  node_group_id: number;
  lifecycle?: string | null;
  node_credential_hash?: string | null;
  credential_revoked?: boolean;
}

interface HaTunnelRow {
  id: number;
  in_node_group_id: number;
  ingress_node_id: number | null;
  preferred_ingress_node_id: number | null;
  failback_healthy_checks: number;
}

interface HaFailoverCandidate {
  status: "available" | "none" | "unavailable";
  node_id: number | null;
  /** 仅 `unavailable` 时给出稳定原因码；其余为 null。 */
  reason: string | null;
}

forwardsRoutes.get("/:id/ha", async (c) => {
  const id = idParam(c, "id");
  if (id === null) return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  const denied = await authorizeForward(c, id, "read");
  if (denied) return denied;
  const ws = workspace(c);

  const tunnel = (await db.tunnel.findFirst({
    where: { id, workspace_id: ws.id, category: "port_forward" },
    select: {
      id: true,
      in_node_group_id: true,
      ingress_node_id: true,
      preferred_ingress_node_id: true,
      failback_healthy_checks: true,
    },
  })) as HaTunnelRow | null;
  if (!tunnel) {
    return c.json({ error: "端口转发不存在", code: "not_found", error_layer: "resource_scope" }, 404);
  }

  // ③ 策略：与 failover 循环同一个读者（缺省即关；坏 JSON 也按关处理并报 parse_error）。
  const policy = await readFailoverPolicy();

  // ④ 候选入口：与 failover 循环**同一份判定**。
  let failoverCandidate: HaFailoverCandidate;
  let failbackTargetNodeId: number | null = null;
  try {
    const destinations = await pickFailoverDestination({
      tunnel_id: tunnel.id,
      workspace_id: ws.id,
      owner_node_id: tunnel.ingress_node_id,
      now: new Date(),
    });
    failbackTargetNodeId = destinations.preferred_node_id;
    failoverCandidate =
      destinations.candidate_node_id === null
        ? { status: "none", node_id: null, reason: null }
        : { status: "available", node_id: destinations.candidate_node_id, reason: null };
  } catch {
    // 「读不到」≠「没有候选」。这里刻意**不**把异常消息回显（可能是内部 SQL 细节）。
    failoverCandidate = { status: "unavailable", node_id: null, reason: "candidate_query_failed" };
  }

  // 入口成员视图（有序）：只列**这条转发的入口节点组**内的节点（与用户节点列表同一可见域），
  // 顺序与「此刻能不能接管」都由 `preferred-ingress.ts` 的纯函数按既有判定算出来。
  let ingressMembers: IngressMemberView[] | null = null;
  // task-43：用户保存过的成员次序（意图）。读不到返回 `null` ⇒ 回退到既有规则（`node_id` 升序）。
  let memberIntent: readonly IngressMemberIntentRow[] | null = null;
  let intentReadable = true;
  try {
    memberIntent = await readIngressMemberIntent(db as unknown as IngressMemberIntentDb, tunnel.id);
    intentReadable = memberIntent !== null;
  } catch {
    intentReadable = false;
  }
  try {
    const rows = (await db.node.findMany({
      where: {
        node_group_id: tunnel.in_node_group_id,
        node_group: { workspace_id: ws.id },
      },
      select: HA_NODE_SELECT,
      orderBy: { id: "asc" },
    })) as unknown as HaNodeRow[];
    ingressMembers = buildIngressMemberViews(rows, {
      activeIngressId: tunnel.ingress_node_id,
      preferredId: tunnel.preferred_ingress_node_id,
      now: new Date(),
      intent: memberIntent,
    });
  } catch {
    ingressMembers = null;
  }

  // 回切事实：平台开关（只读）+ 首选节点"连续健康"进度（`failback_healthy_checks` 是跨节拍
  // 的唯一计数，阈值取 `failover-thresholds.ts` 的单一数值来源，不在路由里写字面量）。
  const failback = {
    auto_failback: policy.auto_failback === true,
    /** 偏好 ≠ 现任时，平台此刻会把它当回切目标；否则 null（没有回切可言）。 */
    target_node_id: failbackTargetNodeId,
    preferred_ingress_node_id: tunnel.preferred_ingress_node_id,
    progress: {
      healthy_checks: tunnel.failback_healthy_checks,
      required_checks: FAILOVER_THRESHOLDS.FAILBACK_HEALTHY_CHECKS,
      met: tunnel.failback_healthy_checks >= FAILOVER_THRESHOLDS.FAILBACK_HEALTHY_CHECKS,
    },
  };

  return c.json({
    data: {
      forward_id: tunnel.id,
      // 期望（调度意图）
      preferred_ingress_node_id: tunnel.preferred_ingress_node_id,
      // 事实（现在归谁）
      active_ingress_node_id: tunnel.ingress_node_id,
      policy: {
        auto_failover: policy.auto_failover === true,
        auto_failback: policy.auto_failback === true,
        /** 配置存在但无法解析时的信息（**不是**"运维没开"）；正常为 null。 */
        parse_error: policy.parse_error ?? null,
      },
      failover_candidate: failoverCandidate,
      /**
       * 入口成员的**有序**视图（行为参照 ForwardX 的「成员顺序即优先级」）。
       *
       *  `status: "unavailable"` = 这次读不到成员列表（**不是**"没有成员"）；
       *  `status: "ok"` + `nodes: []` = 这个入口节点组里**确实一台成员都没有**；
       *  `nodes` 非空但 `failover_rank` 全为 `null` = 有成员、但此刻**没有能接管的**
       *  —— 三个态在契约上就是三个不同的形状，Web 必须分开呈现。
       */
      ingress_members: ingressMembers === null
        ? { status: "unavailable" as const, nodes: [] as const }
        : { status: "ok" as const, nodes: ingressMembers },
      /**
       * 成员次序的来源与能力。
       *   · `forward_member_table`   —— 这条转发**存过**自定义次序（表内有行），界面按它排列；
       *   · `platform_rule_node_id_asc` —— 没存过**或**读不到 ⇒ 与迁移前逐位一致
       *     （合格候选按 `node_id` 升序）。两种情况在这里合并成一个来源，但
       *     `order_readable` 会把"读不到"单独说清楚（不许把"读不到"当成"用户没排序"）。
       */
      member_priority: {
        source: (memberIntent !== null && memberIntent.length > 0
          ? "forward_member_table"
          : "platform_rule_node_id_asc") as "forward_member_table" | "platform_rule_node_id_asc",
        custom_order_supported: true,
        order_readable: intentReadable,
      },
      /** 「恢复后切回」的真值与进度（阈值来自 `failover-thresholds.ts`，此处不写字面量）。 */
      failback,
    },
  });
});

/* ================================================================== */
/* D6 —— 延迟历史读端点（**只读**；注册在任何 `/:id/:参数` catch-all 之前）  */
/* ================================================================== */
//
// 为什么必须在这个位置：文件后段有一个 `post("/:id/:action")` catch-all。GET 目前没有
// 同形状的 catch-all（`get("/:id")` 只匹配一段），但"以后加一个 `get("/:id/:action")`
// 就把这条读端点吃掉"是同一类事故（DNS 前门的实测教训见上）。规则统一：**literal
// 子路由一律放在参数化 catch-all 之前**，并由 `forwards-latency-route.test.ts` 在行为上证明。
//
// 数据面：**直接消费** `services/latency-history.ts:readLatencySeries` 的返回。这里
// 不另写查询、不做插值、不把 `null` 补成 0 —— 「没测到」和「0ms」是两个事实。

/** 窗口上界（小时）：与档案的两层保留期**同源**（`latency-history.ts` 的常量），不另抄数字。 */
export const LATENCY_WINDOW_MAX_HOURS: Record<LatencyGranularity, number> = {
  /** 原始样本层：档案只保留 24h，要更久的历史必须读小时桶。 */
  sample: DEFAULT_RAW_RETENTION_HOURS,
  /** 小时桶层：保留 30d。 */
  hour: DEFAULT_BUCKET_RETENTION_DAYS * 24,
};

/**
 * 「有没有数据」的四种形状（稳定字符串，Web **必须**按它分支）。
 *
 *   · `ok`               —— 有真观测点（每个点仍可能 `latency_ms: null` = 那次不可达）；
 *   · `no_samples`       —— 观测维度成立，但这个窗口里**一行都没有**（数据缺口：别渲染成 0）；
 *   · `no_observer`      —— 按构造就不可能有观测（DIRECT / 远端出口 / 无池 / 无目标 / 归属冲突）；
 *   · `ambiguous_target` —— 出口池有多个目标，一次回答一个序列会藏起其余目标的抖动 ⇒ 拒绝猜。
 */
export type ForwardLatencyStatus = "ok" | "no_samples" | "no_observer" | "ambiguous_target";

/** `no_observer` / `ambiguous_target` 的稳定原因码。 */
export type ForwardLatencyReason =
  | "direct_not_observed"
  | "federated_egress"
  | "no_egress_pool"
  | "no_active_target"
  | "dimension_conflict"
  | "multiple_targets";

const HOUR_MS = 3_600_000;

function parseGranularity(value: string | undefined): LatencyGranularity | null {
  // 只认服务层自己的词表（`sample` / `hour`）。加别名就是造第二份词汇表。
  return value === "sample" || value === "hour" ? value : null;
}

interface LatencyWindow {
  from: Date;
  to: Date;
  hours: number;
}

type LatencyWindowParse =
  | { ok: true; window: LatencyWindow }
  | { ok: false; code: string; message: string; data?: Record<string, unknown> };

/**
 * 服务端**自己**钳制时间窗口（客户端不能拉一个无上限的区间）。
 *
 * 三条口径：
 *   1. `hours`（[now-Nh, now)）与 `from`+`to` 互斥——两种都给就自相矛盾，**拒绝**而不是
 *      替客户端选一种（选错就是静默换了横轴）；
 *   2. 窗口长度**超过该粒度的保留期** ⇒ 400 `window_too_long`（**不静默截短**：
 *      客户端要 7 天却拿到 24 小时且不知情，就是一条骗人的横轴）；
 *   3. `to` 在将来 ⇒ 钳制到 `now`（未来不可能有观测，钳制既不多给也不少给）。
 */
function parseLatencyWindow(
  params: { hours?: string; from?: string; to?: string },
  granularity: LatencyGranularity,
  now: Date,
): LatencyWindowParse {
  const max = LATENCY_WINDOW_MAX_HOURS[granularity];
  const tooLong = (): LatencyWindowParse => ({
    ok: false,
    code: "window_too_long",
    message: `${granularity} 粒度最多读 ${max} 小时窗口（服务端硬上限）`,
    data: { max_hours: max, granularity },
  });
  const hasHours = params.hours !== undefined;
  const hasFrom = params.from !== undefined;
  const hasTo = params.to !== undefined;
  if (!hasHours && !hasFrom && !hasTo) {
    return { ok: false, code: "missing_window", message: "缺少时间窗口：给 hours，或同时给 from 与 to" };
  }
  if (hasHours && (hasFrom || hasTo)) {
    return { ok: false, code: "invalid_window", message: "hours 与 from/to 互斥，只能给一种" };
  }
  if (hasHours) {
    const n = Number(params.hours);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, code: "invalid_window", message: "hours 必须是 ≥1 的整数" };
    }
    if (n > max) return tooLong();
    return {
      ok: true,
      window: { from: new Date(now.getTime() - n * HOUR_MS), to: new Date(now.getTime()), hours: n },
    };
  }
  if (!hasFrom || !hasTo) {
    return { ok: false, code: "invalid_window", message: "from 与 to 必须成对给出" };
  }
  const from = new Date(params.from as string);
  const to = new Date(params.to as string);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    return { ok: false, code: "invalid_window", message: "from/to 必须是可解析的时间（ISO 8601）" };
  }
  const clampedTo = to.getTime() > now.getTime() ? new Date(now.getTime()) : to;
  if (from.getTime() >= clampedTo.getTime()) {
    return {
      ok: false,
      code: "invalid_window",
      message: "窗口是半开区间 [from, to)，必须 from < to（窗口不能全落在将来）",
    };
  }
  const spanHours = (clampedTo.getTime() - from.getTime()) / HOUR_MS;
  if (spanHours > max) return tooLong();
  return { ok: true, window: { from, to: clampedTo, hours: Math.round(spanHours * 1000) / 1000 } };
}

/** 本端点用到的 Tunnel 列（只读投影；凭据/内部材料一律不在 select 里）。 */
interface ForwardLatencyRow {
  tunnel_mode: string | null;
  egress_node_id: number | null;
  egress_pool_id: number | null;
  federated_egress_peer: string | null;
}

type DimensionResolution =
  | { ok: true; observer_node_id: number; target_key: string }
  | { ok: false; status: "no_observer"; reason: ForwardLatencyReason }
  | { ok: false; status: "ambiguous_target"; reason: ForwardLatencyReason; candidate_targets: number };

/**
 * 目标身份归一化**只有一份实现**（`node-state.ts:targetKeyOf`，档案的写入方用的就是它）。
 *
 * 为什么这里是**惰性** import 而不是文件顶部的静态 import：`node-state.ts` 的导入图在
 * **模块加载期**就 `new Redis(..., { lazyConnect: false })`（`src/redis.ts:16`），于是任何
 * 只为"多挂一条读端点"而 import 它的进程都会多出一个永不排空的 Redis 连接。这不是理论：
 * 本文件的静态 import 版本让 `workspace-rbac.test.ts` 的 WP10 子进程（只挂
 * forwards/nodes/tunnels/workspaces 四个路由、靠事件循环自然排空退出）从 0.2s 变成
 * bun 的 5s 测试超时。生产进程不受影响（`app.ts` 早就通过 `routes/public.ts` 加载了同一模块，
 * 这里是缓存命中），所以这条惰性化**不新增任何副作用**，只是不给窄进程平白加一个连接。
 */
let canonicalTargetKeyOf: ((host: string, port: number) => string | null) | null = null;
async function targetKeyOfCanonical(host: string, port: number): Promise<string | null> {
  if (canonicalTargetKeyOf === null) {
    canonicalTargetKeyOf = (await import("../services/node-state.ts")).targetKeyOf;
  }
  return canonicalTargetKeyOf(host, port);
}

/**
 * 从**已授权**的 Forward 推导观测维度 `(observer_node_id, target_key)`。
 *
 * ── 维度是服务端事实，不是客户端参数 ──
 * 这两个值**绝不**从 query 取：`target_latency_sample` 只按 (node_id, target_key) 存，
 * 没有 workspace 列。让客户端指定 target_key 就等于让任何 Workspace 的用户读别的租户
 * 的 `host:port` 延迟历史（一个现成的跨租户探针）。所以维度只能从这条已授权的转发推。
 *
 * ── 口径（与写入方对齐，不是猜）──
 *   · 观测方 = **出口节点**：样本由节点的 state report 携带
 *     (`node-state.ts:archiveObservationSamples` ← `syncTargetObservations`)，而 Agent 的
 *     观测器只枚举"本节点服务的**出口池**目标"（`agent/internal/targetobs/observer.go`
 *     + `internal/manager/egress.go:DesiredTargets`）。
 *   · 目标 = 该出口池**active** 目标，按 `order_by`/`id` 升序 —— 与生成 targets 快照的
 *     唯一实现 `forward-revision.ts:927-933` 同一口径。
 *   · 入口节点维度**不存在**：DIRECT 由入口节点自己的 forwarder 直拨目标，但观测器不看
 *     DIRECT 的 `targets`（`orchestrator.dispatchDirect` 下发的是空 targets），所以那半边
 *     从来没有任何样本 —— 如实报 `no_observer`，不拿 0 顶替、不假装"一切正常"。
 */
async function resolveForwardLatencyDimension(row: ForwardLatencyRow): Promise<DimensionResolution> {
  if (row.tunnel_mode !== "relay") {
    return { ok: false, status: "no_observer", reason: "direct_not_observed" };
  }
  if (row.federated_egress_peer !== null) {
    // 出口腿在 peer panel：观测由**那边的**节点上报、落在**那边的**档案里。
    // 本 panel 只能说"我这边没有"，不能说"目标没抖动"。
    return { ok: false, status: "no_observer", reason: "federated_egress" };
  }
  if (row.egress_pool_id === null || row.egress_node_id === null) {
    return { ok: false, status: "no_observer", reason: "no_egress_pool" };
  }
  const pool = await db.egressPool.findUnique({
    where: { id: row.egress_pool_id },
    select: {
      id: true,
      node_id: true,
      targets: {
        where: { status: "active" },
        orderBy: [{ order_by: "asc" }, { id: "asc" }],
        select: { host: true, port: true },
      },
    },
  });
  if (!pool) return { ok: false, status: "no_observer", reason: "no_egress_pool" };
  if (pool.node_id !== row.egress_node_id) {
    // 池的主人 ≠ 这条转发的出口节点：下发事实与归属对不上，**不挑一个信**。
    return { ok: false, status: "no_observer", reason: "dimension_conflict" };
  }
  const keys: string[] = [];
  for (const target of pool.targets) {
    // 身份归一化只有一份实现（`node-state.ts:targetKeyOf`，见上面的惰性加载说明）：
    // 自己拼 `host:port` 会让档案里真实存在的目标在界面上变成"没有证据"。
    const key = await targetKeyOfCanonical(target.host, target.port);
    if (key !== null && !keys.includes(key)) keys.push(key);
  }
  if (keys.length === 0) return { ok: false, status: "no_observer", reason: "no_active_target" };
  if (keys.length > 1) {
    // `readLatencySeries` 一次只回答一个 target_key；挑第一个 = 把其余目标的抖动藏起来。
    // 只报数量（不列 host:port 清单，也不造一个客户端可选 target 的第二入口）。
    return { ok: false, status: "ambiguous_target", reason: "multiple_targets", candidate_targets: keys.length };
  }
  return { ok: true, observer_node_id: row.egress_node_id, target_key: keys[0] as string };
}

/**
 * `GET /api/forwards/:id/latency` —— 延迟历史（**只读**，零副作用）。
 *
 * 权限：`forward:read`（与 topology/diagnose 同一条：它不改 desired、不加 revision、
 * 不发命令、不产生业务流量）。作用域：所有查询都带 `workspace_id`，跨 Workspace 与
 * "真的不存在"返回**逐字同形**的 404（不泄露存在性）。
 *
 * 错误码（稳定）：
 *   · 400 `invalid_input`         —— id 不是正整数；
 *   · 400 `invalid_granularity`   —— granularity 缺失/不是 sample|hour；
 *   · 400 `missing_window`        —— 三种窗口参数一个都没给；
 *   · 400 `invalid_window`        —— 形态非法（hours 非正整数 / from-to 不成对 / 不可解析 / from≥to）；
 *   · 400 `window_too_long`       —— 窗口超过该粒度上限（带 `data.max_hours`）；
 *   · 404 `not_found`             —— 转发不存在或不属于当前 Workspace；
 *   · 409 `raw_window_expired`    —— `granularity=sample` 且窗口下界早于原始样本保留期：
 *     **这是"档案里已经没有那段时间"**，与"那段时间没有观测"（200 `no_samples`）是两件事，
 *     调用方必须能分开（这正是 `readLatencySeries` 拒绝而不是返回空数组的理由）。
 */
forwardsRoutes.get("/:id/latency", async (c) => {
  const id = idParam(c, "id");
  if (id === null) return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  const denied = await authorizeForward(c, id, "read");
  if (denied) return denied;
  const ws = workspace(c);

  // 先定作用域再解析参数：不存在/跨 Workspace 一律 404，且响应体与参数怎么给无关。
  const row = (await db.tunnel.findFirst({
    where: { id, workspace_id: ws.id, category: "port_forward" },
    select: {
      tunnel_mode: true,
      egress_node_id: true,
      egress_pool_id: true,
      federated_egress_peer: true,
    },
  })) as ForwardLatencyRow | null;
  if (!row) {
    return c.json({ error: "端口转发不存在", code: "not_found", error_layer: "resource_scope" }, 404);
  }

  const granularity = parseGranularity(c.req.query("granularity"));
  if (granularity === null) {
    return c.json(
      { error: "granularity 必须是 sample 或 hour", code: "invalid_granularity", error_layer: "input" },
      400,
    );
  }
  const now = new Date();
  const parsed = parseLatencyWindow(
    { hours: c.req.query("hours"), from: c.req.query("from"), to: c.req.query("to") },
    granularity,
    now,
  );
  if (!parsed.ok) {
    return c.json(
      { error: parsed.message, code: parsed.code, error_layer: "input", data: parsed.data },
      400,
    );
  }
  const { window } = parsed;
  const mode = row.tunnel_mode === "relay" ? "relay" : "direct";
  const windowView = { from: window.from.toISOString(), to: window.to.toISOString(), hours: window.hours };

  const dimension = await resolveForwardLatencyDimension(row);
  if (!dimension.ok) {
    // 200 + 明确的 status：**这不是空的序列**，是"没有可观测维度/无法归属"。
    // 用 200 是因为请求本身完全合法；用 `status` 区分则是因为空数组会被读成"当时一切正常"。
    return c.json({
      data: {
        forward_id: id,
        mode,
        granularity,
        window: windowView,
        dimension: null,
        status: dimension.status,
        reason: dimension.reason,
        ...(dimension.status === "ambiguous_target"
          ? { candidate_targets: dimension.candidate_targets }
          : {}),
        series: [],
        truncated: false,
      },
    });
  }

  const series = await readLatencySeries(
    defaultLatencyHistoryDeps(),
    {
      node_id: dimension.observer_node_id,
      target_key: dimension.target_key,
      from: window.from,
      to: window.to,
      granularity,
    },
    now,
  );
  if (!series.ok) {
    // `bad_window` 是防御性的（上面的解析已挡住），仍如实映射，不吞成 200 空序列。
    if (series.reason === "bad_window") {
      return c.json({ error: "时间窗口不合法", code: "invalid_window", error_layer: "input" }, 400);
    }
    return c.json(
      {
        error: "该窗口的原始样本已按保留期清理（原始层只覆盖最近 24 小时）；改用 granularity=hour 或把窗口前移",
        code: "raw_window_expired",
        error_layer: "retention",
      },
      409,
    );
  }

  return c.json({
    data: {
      forward_id: id,
      mode,
      granularity: series.granularity,
      window: windowView,
      // 维度照实回显：调用方必须知道这条线是"哪个节点看哪个目标"，而不是"这条转发"。
      dimension: { observer_node_id: dimension.observer_node_id, target_key: dimension.target_key },
      status: series.points.length === 0 ? "no_samples" : "ok",
      reason: null,
      series: series.points,
      // 命中 `MAX_SERIES_POINTS` 被截断时显式标注——不许把截断过的线当成完整曲线。
      truncated: series.truncated,
    },
  });
});

/**
 *  §13.6：批量 retry / suspend / resume。
 *
 * 为什么是独立路径 `/batch` 而不是给 `POST /api/forwards/:id/:action` 加数组形态：
 * 单条与批量的**错误语义不同**——单条失败整请求失败（4xx/5xx），批量失败是
 * 逐条结果 + 200。把两种语义塞进一个端点会让客户端无法判断该看 `error` 还是
 * `results`。路由注册在 `/:id/:action` **之前**，否则 `:id` 会吃掉 "batch"。
 *
 * 限流：见 rate-limit.ts 的 `forward-batch` 规则（必须在 `api-global` 之前命中）。
 */
forwardsRoutes.post("/batch", async (c) => {
  const parsed = parseForwardBatchRequest(
    await c.req.json().catch(() => null),
  );
  if ("message" in parsed) {
    return c.json({ error: parsed.message, code: "invalid_input" }, 400);
  }
  const payload = await runForwardBatch(
    parsed.ids,
    parsed.action,
    workspace(c).id,
    (row: { user_id: number }) => canWorkspaceResourceAction(
      workspace(c), "update", "forward", row.user_id === user(c).id,
    ),
  );
  return c.json({ data: payload });
});

forwardsRoutes.post("/:id/:action", async (c) => {
  const id = idParam(c, "id");
  const action = c.req.param("action") as ForwardAction;
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  if (!ACTIONS.has(action)) {
    return c.json({ error: "不支持的端口转发动作", code: "invalid_input" }, 400);
  }
  const denied = await authorizeForward(c, id, "update");
  if (denied) return denied;
  return send(c, await runForwardAction(id, action, workspace(c).id));
});

forwardsRoutes.delete("/:id", async (c) => {
  const id = idParam(c, "id");
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  const denied = await authorizeForward(c, id, "delete");
  if (denied) return denied;
  return send(c, await deleteForward(id, workspace(c).id));
});
