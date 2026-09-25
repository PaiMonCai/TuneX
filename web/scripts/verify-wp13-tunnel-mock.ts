/**
 * WP13：驱动 mock handler 验证 WP13 Tunnel Web 契约（与 backend WP11 contract 同构）。
 * 运行：bun run scripts/verify-wp13-tunnel-mock.ts
 *
 * 覆盖：
 *   1. 列表 + v3 过滤（apply_status / tunnel_mode / pending_only）
 *   2. 详情（含编排状态 / revision / 出口池字段）
 *   3. 创建 DIRECT（forward_addresses 必填）与 RELAY（out_node_group + egress_pool）
 *   4. 运行操作状态机：retry / suspend / resume 的合法与非法来源状态
 *   5. /egress-pools 用户侧候选
 */
import { handleMock } from "../src/mocks/handler";
import { resetStore } from "../src/mocks/state";

const CK = "tunex_session=u1"; // demo（tunnels 1..5 的 owner）

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Body = any;

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) {
  const [bare, qs] = path.split("?");
  const query: Record<string, string> = {};
  if (qs) for (const [k, v] of new URLSearchParams(qs).entries()) query[k] = v;
  const res = await handleMock(method, bare, {
    body: opts.body,
    query,
    cookie: opts.cookie ?? CK,
  });
  return { status: res.status, body: res.body as Body };
}

async function main() {
  resetStore();
  console.log("[WP13 mock verify] tunnel list / create / runtime actions");

  // ---------- 1. 列表 ----------
  const list = await call("GET", "/tunnels");
  check("列表返回 5 条种子隧道", list.status === 200 && list.body.data.length === 5, list.status);

  const t = list.body.data;
  // NULL 模式 = 未声明，不得被默认成 direct
  check("种子行 1 模式 = direct", t[0].tunnel_mode === "direct");
  check("种子行 2 模式 = relay", t[1].tunnel_mode === "relay");
  check("种子行 3 apply_status = applying", t[2].apply_status === "applying");
  check("种子行 4 apply_status = suspended（desired=inactive）", t[3].apply_status === "suspended");
  check("种子行 5 apply_status = error（保留记录）", t[4].apply_status === "error");
  check("种子行 5 有 apply_error_code", typeof t[4].apply_error_code === "string" && t[4].apply_error_code.length > 0);
  check("种子行 5 有 apply_steps 回放", Array.isArray(t[4].apply_steps) && t[4].apply_steps.length > 0);
  check("seed row 5 pool name preserved (sg-relay-pool)", t[4].egress_pool?.name === "sg-relay-pool");

  // ---------- 2. v3 过滤 ----------
  const byApply = await call("GET", "/tunnels?apply_status=error");
  check("apply_status=error 过滤得 1 条", byApply.body.data.length === 1 && byApply.body.data[0].id === 5, byApply.body.data.length);

  const byMode = await call("GET", "/tunnels?tunnel_mode=relay");
  check("tunnel_mode=relay 过滤得 3 条", byMode.body.data.length === 3, byMode.body.data.length);

  const pendingOnly = await call("GET", "/tunnels?pending_only=true");
  check("pending_only（revision 漂移）得 2 条", pendingOnly.body.data.length === 2, pendingOnly.body.data.map((x: { id: number }) => x.id));

  const unknownFilter = await call("GET", "/tunnels?apply_status=bogus");
  check("未知 filter 值被忽略（不返空集）", unknownFilter.body.data.length === 5);

  // ---------- 3. 详情 ----------
  const detail = await call("GET", "/tunnels/5");
  check("详情返回编排字段", detail.status === 200 && detail.body.apply_status === "error");
  check("详情含 revision 对", detail.body.config_revision === 5 && detail.body.applied_revision === 4);

  // ---------- 4. 运行操作状态机 ----------
  // retry：error → 合法
  const retry = await call("POST", "/tunnels/5/retry", { body: {} });
  check("retry(error) 200", retry.status === 200, retry.body);
  check("retry 后回 active", retry.body.apply_status === "active");
  check("retry 保留 revision（不抬高）", retry.body.config_revision === 5);
  check("retry 幂等标记 reentered", retry.body.reentered === true);

  // retry：active → 非法
  const retryActive = await call("POST", "/tunnels/5/retry", { body: {} });
  check("retry(active) 400", retryActive.status === 400, retryActive.status);
  check("retry(active) 错误码 INVALID_STATE", retryActive.body.code === "INVALID_STATE");

  // suspend：active → 合法（tunnel 2）
  const suspend = await call("POST", "/tunnels/2/suspend", { body: {} });
  check("suspend(active) 200", suspend.status === 200, suspend.body);
  check("suspend 后 apply_status=suspended", suspend.body.apply_status === "suspended");
  check("suspend 后 desired_status=inactive", suspend.body.tunnel.desired_status === "inactive");

  // resume：suspended → 合法（tunnel 2）
  const resume = await call("POST", "/tunnels/2/resume", { body: {} });
  check("resume(suspended) 200", resume.status === 200, resume.body);
  check("resume 后回 active", resume.body.apply_status === "active");
  check("resume revision +1（编排必须前进）", resume.body.config_revision === 8, resume.body.config_revision);

  // suspend：applying（tunnel 3）→ 非法
  const suspendApplying = await call("POST", "/tunnels/3/suspend", { body: {} });
  check("suspend(applying) 400", suspendApplying.status === 400, suspendApplying.status);

  // resume：active（tunnel 1）→ 非法
  const resumeActive = await call("POST", "/tunnels/1/resume", { body: {} });
  check("resume(active) 400", resumeActive.status === 400, resumeActive.status);

  // legacy 行（无 v3 列）不可运行操作：mock 对无编排行一律拒绝
  resetStore();
  const legacyRetry = await call("POST", "/tunnels/1/retry", { body: {} });
  check("legacy(active + 有 v3 列) retry 400（非 error/suspended）", legacyRetry.status === 400);

  // 非法隧道 id
  const missing = await call("GET", "/tunnels/9999");
  check("详情 404（不存在）", missing.status === 404, missing.status);

  // ---------- 5. 创建 ----------
  resetStore();
  const createdDirect = await call("POST", "/tunnels", {
    body: {
      name: "wp13-direct",
      tunnel_type: "tcp",
      category: "port_forward",
      in_node_group_id: 1,
      tunnel_mode: "direct",
      forward_addresses: ["10.0.0.9:8443"],
      listen_port: 20099,
    },
  });
  check("创建 DIRECT 200", createdDirect.status === 200, createdDirect.body);
  check("创建 DIRECT → tunnel_mode=direct", createdDirect.body.tunnel_mode === "direct");
  check("创建 DIRECT → apply_status=pending（期望状态已落库）", createdDirect.body.apply_status === "pending", createdDirect.body.apply_status);

  const createdRelay = await call("POST", "/tunnels", {
    body: {
      name: "wp13-relay",
      tunnel_type: "tcp",
      category: "port_forward",
      in_node_group_id: 1,
      out_node_group_id: 3,
      tunnel_mode: "relay",
      egress_pool_id: 2,
      forward_addresses: [],
    },
  });
  check("创建 RELAY 200", createdRelay.status === 200, createdRelay.body);
  check("创建 RELAY → tunnel_mode=relay", createdRelay.body.tunnel_mode === "relay");
  check("创建 RELAY 回填 egress_pool", createdRelay.body.egress_pool?.name === "sg-relay-pool");
  check("创建 RELAY 反查 egress_node_id", createdRelay.body.egress_node_id === 6, createdRelay.body.egress_node_id);
  check("创建 RELAY → remote_host 为空", createdRelay.body.remote_host == null);

  // RELAY 缺出口组（mock 不强制，但 forward 目标也不该被要求）
  const relayNoGroup = await call("POST", "/tunnels", {
    body: {
      name: "wp13-relay-bad",
      tunnel_type: "tcp",
      category: "port_forward",
      in_node_group_id: 1,
      tunnel_mode: "relay",
      forward_addresses: [],
    },
  });
  check("创建 RELAY 缺出口组 200（后端 WP11 负责校验，mock 不预判）", relayNoGroup.status === 200, relayNoGroup.status);

  // ---------- 6. 用户侧出口池候选 ----------
  const pools = await call("GET", "/egress-pools");
  check("/egress-pools 200", pools.status === 200, pools.status);
  check("/egress-pools 返回 2 个池", pools.body.length === 2, pools.body.length);
  check("/egress-pools 含 targets", pools.body[0].targets.length > 0);
  check("/egress-pools 含 node_label", typeof pools.body[0].node_label === "string" && pools.body[0].node_label.length > 0);

  // 未登录
  const noAuth = await call("GET", "/tunnels", { cookie: "" });
  check("未登录列表 401", noAuth.status === 401, noAuth.status);

  console.log(`\n[WP13] ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main();
