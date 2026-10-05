#!/usr/bin/env python3
"""V5-G7 gate —— Billing Runtime（WP20；契约 `docs/v5-wp20-subscription-billing-runtime-contract.md` §7.1）。

**这是自带环境的一次性门禁**：它自己起一个**临时 MySQL 容器**、自己 `migrate deploy`、
自己跑 DoD 场景、自己收证据，跑完删容器。它**不**依赖、也**不触碰** `scripts/v3-e2e`
里那套正在被别的门禁用着的真拓扑（`b2x-*`）—— 同一拓扑上不该有两个动作。

断言（编号按 Lead 2026-10-05 的裁决：`v5-g7.py` + `G7.x`；契约原表中的 `G6.x`/`v5-g6.py`
是命名冲突前的编号，`v5-g6.py` 已被 WP17.5 的 DDNS 门禁占用且不可改名）：

  G7.1  计费时钟进程时区无关：同一组断言在 TZ=UTC 与 TZ=Asia/Shanghai 下逐字相等（§3.1、F13）
  G7.2  购买 → **存在 `purchase` 来源的发放**，且订阅/订单/legacy 投影同事务落库（§3.2.2、§3.5.2、F5）
  G7.3  **连跑两遍结算 tick**：第二轮 `settled`/`skipped` 为 0，`plan_order`/`balance_log`/余额逐行不变；
        且真正扣款的续期路径**恰好一次**（幂等锚点 = 账本行的 `order_id`）（§3.1.4、DoD 4）
  G7.4  预置一条超时的 `pending` 行 → 下一轮**恰好一次**推入 `settled`（§3.1.4、DoD 5）
  G7.5  到期语义：`purchase` 发放过期 → `grace_policies` 非空 + `deny_reason="policy_expired"`；
        且**存量 Forward 不受影响**（tick 不碰 `tunnel`）（§3.2.2、F2/F3）
  G7.6  越过宽限期：仍有 `system_default` ⇒ 额度**降级**而非 `deny_scope`；连它也撤掉 ⇒ `deny_scope=true`（§3.2.2）
  G7.9  流量口径一致：窗口求和与用量报告在跨月边界前后同源（归档戳 = 当日标签的 UTC 午夜）（§3.3、F12–F14）
  G7.10 联邦远端腿用量**不计入**额度，但作为 `traffic_used_unattributed_federated` **可观测**（§3.3.5、F17、O5）
  G7.11 计费侧不做额度判定：`grep checkTunnelCreation|max_tunnels` 在 payment/ + subscription-billing.ts 为 0（DoD 1）
  G7.12 `purchase` 发放写入点恰好两个（`assignDefaultPolicy` + `grantPolicyFromPurchase`）（DoD 2）

**本门禁不覆盖（附理由，不假装覆盖）**：
  · G7.7「额度拒绝时不产生 NodePortLease」/ G7.8「端口占位失败时 tunnel 行保留」—— 这两条断言的是
    **建 Forward 的编排顺序**（判定 → 占位 → 编排），需要真面板 + 真 Agent 的端口编排路径；
    本门禁没有面板（自带环境只有 DB），硬编一个 DB 级近似只会给出"看起来通过"的错觉。
    它们同时是 **V4 冻结基线**的行为（`forward-service` 的行锁占位 + `portPool` 的唯一键），
    已由 `verify.sh` 与既有 v5 门禁在真拓扑上覆盖；WP20 的改动不触及该路径（有静态守卫：
    `services/subscription-billing.ts` 里不出现额度判定字段）。

跑法（宿主即可，与真拓扑无关）：

    python3 scripts/v3-e2e/v5-g7.py            # 跑完自动删临时容器
    python3 scripts/v3-e2e/v5-g7.py --keep     # 保留容器与库，便于复现（会打印连接串）

证据：`docs/evidence/v5-g7-result-<YYYYMMDD>.txt`（契约 §7.2.3 指定的路径）。
失败语义沿用既有纪律：**缺少前提 / 超时 / 任何异常一律 FAIL，不得 skip**。
"""
from __future__ import annotations

import argparse
import os
import random
import re
import secrets
import shutil
import string
import subprocess
import sys
import tempfile
import time
from datetime import date, datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent  # scripts/v3-e2e
REPO = HERE.parent.parent  # repo root
BACKEND = REPO / "backend"
SCHEMA = BACKEND / "prisma" / "schema.prisma"
MIGRATIONS = BACKEND / "prisma" / "migrations"
EVIDENCE_DIR = REPO / "docs" / "evidence"
MYSQL_IMAGE = os.environ.get("TUNEX_G7_MYSQL_IMAGE", "mysql:8.4.11")
# 场景要在**容器里**跑：这门禁所在的环境里，宿主够不到容器发布端口（`scripts/v3-e2e/README.md`
# 记的同一件事），而且 bind mount 不可见。所以用「后端镜像 + docker cp 新源码 + docker 网络」
# 这套自带环境，完全不碰正在跑的真拓扑。
BACKEND_IMAGE = os.environ.get("TUNEX_G7_BACKEND_IMAGE", "b2x-backend:ci")
DB_NAME = "tunex_g7"

# 与 tests/preload-env.ts 同口径的占位值：`bun run` 不加载 bunfig 的 preload，
# 而被测模块的传递依赖里有 `env.ts` 的 requireSecret（import 期即读）。
PLACEHOLDER_ENV = {
    "REDIS_URL": "redis://127.0.0.1:6379/15",
    "AUTH_SECRET": "tunex-g7-gate-auth-secret-not-a-real-secret",
    "LICENSE_SECRET": "tunex-g7-gate-license-secret-not-a-real-secret",
    "PAYMENTS_ENABLED": "false",
}

PASS = 0
FAIL = 0
LOG: list[str] = []


def log(line: str) -> None:
    print(line, flush=True)
    LOG.append(line)


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        log(f"{name} OK{' ' + detail if detail else ''}")
    else:
        FAIL += 1
        log(f"{name} FAIL {detail}".rstrip())


def run(cmd: list[str], *, env: dict[str, str] | None = None, cwd: Path | None = None, timeout: int = 300):
    merged = {**os.environ, **(env or {})}
    return subprocess.run(cmd, env=merged, cwd=str(cwd or REPO), capture_output=True, text=True, timeout=timeout)


def docker(*args: str, timeout: int = 300):
    docker_env = {**os.environ}
    if "DOCKER_CONFIG" not in docker_env:
        docker_env["DOCKER_CONFIG"] = "/tmp/docker-config"
    return subprocess.run(
        ["docker", *args], env=docker_env, capture_output=True, text=True, timeout=timeout
    )


# ───────────────────────────── 前提（FAIL 而非 skip） ─────────────────────────────

def preflight() -> list[str]:
    problems: list[str] = []
    if shutil.which("docker") is None:
        problems.append("找不到 docker CLI（本门禁自带环境需要它）")
    else:
        images = set(docker("images", "--format", "{{.Repository}}:{{.Tag}}").stdout.split())
        if MYSQL_IMAGE not in images:
            problems.append(f"本地没有 MySQL 镜像 {MYSQL_IMAGE}（离线环境无法 pull）")
        if BACKEND_IMAGE not in images:
            problems.append(f"本地没有后端镜像 {BACKEND_IMAGE}（场景要在容器里跑；可用 TUNEX_G7_BACKEND_IMAGE 覆盖）")
    if shutil.which("bun") is None:
        problems.append("找不到 bun（G7.1 的纯函数探针在宿主上跑）")
    if not (BACKEND / "node_modules").is_dir():
        problems.append(f"{BACKEND}/node_modules 不存在（先安装依赖）")
    if not SCHEMA.is_file():
        problems.append(f"schema 不存在：{SCHEMA}")
    if not MIGRATIONS.is_dir() or not any(MIGRATIONS.glob("*/migration.sql")):
        problems.append(f"迁移目录为空：{MIGRATIONS}")
    return problems


# ───────────────────────────── 一次性环境（网络 + MySQL + 后端容器） ─────────────────────────────

class G7Environment:
    """自带环境：一条一次性 docker 网络 + 一个 MySQL 容器 + 一个后端镜像容器。

    为什么不是「起 MySQL 再把端口映射到宿主」：`scripts/v3-e2e/README.md` 已经记过 ——
    在这套环境里**宿主够不到容器的发布端口**，而且宿主路径的 bind mount 对 daemon 不可见。
    因此：迁移用 `docker exec -i ... mysql < migration.sql` 灌（读宿主文件走 stdin，不靠挂载），
    场景在**同网络**的后端容器里跑（源码用 `docker cp` 送进去）。整个过程与正在跑的真拓扑零交集。
    """

    def __init__(self) -> None:
        tag = secrets.token_hex(3)
        self.network = f"tunex-g7-net-{tag}"
        self.mysql_name = f"tunex-g7-db-{tag}"
        self.app_name = f"tunex-g7-app-{tag}"
        self.password = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(24))
        self.up = False

    def start(self) -> None:
        out = docker("network", "create", self.network)
        if out.returncode != 0:
            raise RuntimeError(f"docker network create 失败：{out.stderr.strip()}")
        out = docker(
            "run", "-d", "--rm", "--network", self.network, "--name", self.mysql_name,
            "-e", f"MYSQL_ROOT_PASSWORD={self.password}", "-e", f"MYSQL_DATABASE={DB_NAME}",
            MYSQL_IMAGE,
        )
        if out.returncode != 0:
            raise RuntimeError(f"MySQL 容器启动失败：{out.stderr.strip() or out.stdout.strip()}")
        self.up = True
        self._wait_mysql()
        out = docker(
            "run", "-d", "--rm", "--network", self.network, "--name", self.app_name,
            "--entrypoint", "sh", BACKEND_IMAGE, "-c", "sleep 3600",
        )
        if out.returncode != 0:
            raise RuntimeError(f"后端容器启动失败：{out.stderr.strip() or out.stdout.strip()}")

    def _mysql(self, sql: str) -> subprocess.CompletedProcess:
        return docker(
            "exec", self.mysql_name, "sh", "-c",
            f'mysql -uroot -p"{self.password}" {DB_NAME} -e "{sql}"',
            timeout=60,
        )

    def _wait_mysql(self, timeout_s: int = 180) -> None:
        deadline = time.time() + timeout_s
        last = ""
        while time.time() < deadline:
            probe = self._mysql("SELECT 1")
            if probe.returncode == 0:
                return
            last = (probe.stderr or probe.stdout).strip()
            time.sleep(3)
        raise RuntimeError(f"MySQL 在 {timeout_s}s 内没有就绪：{last}")

    def database_url(self) -> str:
        """容器间用**容器名**互通（同一 docker 网络）。"""
        return f"mysql://root:{self.password}@{self.mysql_name}:3306/{DB_NAME}"

    def apply_migrations(self) -> tuple[int, str]:
        """按目录名排序灌入全部 migration.sql（不需要 prisma CLI 的 shadow db）。"""
        files = sorted(MIGRATIONS.glob("*/migration.sql"))
        for f in files:
            with f.open("rb") as stdin:
                proc = subprocess.run(
                    ["docker", "exec", "-i", self.mysql_name, "sh", "-c",
                     f'mysql -uroot -p"{self.password}" {DB_NAME}'],
                    stdin=stdin, capture_output=True, text=True,
                    env={**os.environ, "DOCKER_CONFIG": os.environ.get("DOCKER_CONFIG", "/tmp/docker-config")},
                    timeout=300,
                )
            if proc.returncode != 0:
                return len(files), f"{f.parent.name}: {(proc.stderr or proc.stdout).strip()[-300:]}"
        return len(files), ""

    def push_sources(self) -> None:
        """把**当前工作树**的源码送进容器（镜像里的可能是旧版本）。"""
        for src, dst in ((BACKEND / "src", "/app/src"), (BACKEND / "prisma", "/app/prisma")):
            out = docker("cp", f"{src}/.", f"{self.app_name}:{dst}/", timeout=300)
            if out.returncode != 0:
                raise RuntimeError(f"docker cp {src} 失败：{out.stderr.strip()}")

    def generate_client(self) -> subprocess.CompletedProcess:
        """按**新 schema** 生成 Prisma client（镜像里的可能是旧 schema）。"""
        return docker(
            "exec", "-e", f"DATABASE_URL={self.database_url()}", self.app_name,
            "sh", "-lc", "cd /app && bunx prisma generate --schema prisma/schema.prisma",
            timeout=300,
        )

    def run_scenario(self, remote_path: str) -> subprocess.CompletedProcess:
        env_args: list[str] = []
        for key, value in PLACEHOLDER_ENV.items():
            env_args += ["-e", f"{key}={value}"]
        return docker(
            "exec", "-e", f"DATABASE_URL={self.database_url()}", *env_args,
            self.app_name, "sh", "-lc", f"cd /app && bun {remote_path}",
            timeout=600,
        )

    def stop(self) -> None:
        if self.up:
            docker("rm", "-f", self.app_name, timeout=120)
            docker("rm", "-f", self.mysql_name, timeout=120)
        docker("network", "rm", self.network, timeout=60)


# ───────────────────────────── 场景脚本（内嵌，单文件交付） ─────────────────────────────

SCENARIO = r'''
/** V5-G7 场景：真 MySQL 上的 DoD 断言（由 v5-g7.py 写入临时文件后执行）。 */
import { db } from "./db.ts";
import { billingPeriodKey, billingDayKeyStamp } from "./services/billing-time.ts";
import { getEffectivePolicy, invalidatePolicyCache, sumWorkspaceTraffic, sumFederatedUnattributedTraffic, getWorkspaceUsageReport } from "./services/policy-service.ts";
import { defaultSettlementDeps, settleDuePeriods } from "./services/subscription-billing.ts";
import { applyPlanPurchase } from "./services/subscription-purchase.ts";

const NOW = new Date("2026-10-05T05:30:00.000Z");   // 上海 2026-10-05 13:30
const PERIOD_KEY = billingPeriodKey(NOW, "month");  // 2026-10
const DAY = 86_400_000;

let pass = 0;
let fail = 0;
function assert(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`${name} OK${detail ? " " + detail : ""}`); }
  else { fail++; console.log(`${name} FAIL ${detail}`); }
}

// ── 种子：A=团队（default + purchase，验证降级/宽限/用量）；B=个人（purchase，验证续期扣款）──
const user = await db.user.create({ data: { email: `g7-${Date.now()}@tunex.local`, balance: 1000 } });
// A = **团队** workspace（有 default + purchase 发放；没有钱包主体 —— 续期不会在团队上发生）
// B = **个人** workspace（只有 purchase 发放；有钱包主体，用来验证续期的扣款路径）
const wsA = await db.workspace.create({ data: { slug: `g7-a-${Date.now()}`, name: "G7 A", kind: "team", created_by_id: user.id } });
const wsB = await db.workspace.create({ data: { slug: `g7-b-${Date.now()}`, name: "G7 B", kind: "personal", personal_user_id: user.id, created_by_id: user.id } });
const nodeGroup = await db.nodeGroup.create({ data: { name: "g7-in", node_type: "in", user_id: user.id, workspace_id: wsA.id } });
const tunnel = await db.tunnel.create({
  data: { name: "g7-tunnel", forward_addresses: [], load_balance_type: "round", in_node_group_id: nodeGroup.id, user_id: user.id, workspace_id: wsA.id, apply_status: "active" },
});
const policyDefault = await db.capabilityPolicy.create({
  data: { key: `g7_free_${Date.now()}`, name: "G7 Free", source: "system_default", is_default: true, tunnel_types: ["tcp"], max_tunnels: 1, traffic_limit: 1000, traffic_period: "month" },
});
const policyPro = await db.capabilityPolicy.create({
  data: { key: `g7_pro_${Date.now()}`, name: "G7 Pro", source: "purchase", tunnel_types: ["tcp", "udp"], max_tunnels: 10, traffic_limit: 100000, traffic_period: "month" },
});
const plan = await db.plan.create({
  data: {
    name: "G7 Pro Plan", price: 20, policy_id: policyPro.id, billing_cycle: "month",
    allow_custom_in_node_group: true, allow_custom_out_node_group: true, all_in_node_groups: true, all_out_node_groups: true,
  },
});
// 注意：`effective_at` 必须**显式**给（Prisma 默认的 now() 是真实墙钟，而本场景的 `NOW` 是合成时间；
// 用默认值会让这条发放被判成"尚未生效"，于是断言会指向完全不同的分支 —— 夹具陷阱，不是引擎行为）。
await db.workspacePolicyAssignment.create({
  data: { workspace_id: wsA.id, policy_id: policyDefault.id, source: "system_default", effective_at: new Date(NOW.getTime() - 30 * DAY) },
});

// ── G7.2 购买 → purchase 发放（真实 applyPlanPurchase，不接受 mock）──
{
  const order = await db.planOrder.create({ data: { user_id: user.id, workspace_id: wsB.id, plan_id: plan.id, price: 20, balance: 980 } });
  const result = await db.$transaction((tx) => applyPlanPurchase(tx, {
    now: NOW,
    workspace_id: wsB.id,
    payer_user_id: user.id,
    plan: { id: plan.id, name: plan.name, billing_cycle: "month", price: 20, policy_id: policyPro.id, traffic_bytes: 100000, max_tunnels: 10 },
    order_id: order.id,
  }));
  const assignment = await db.workspacePolicyAssignment.findFirst({ where: { workspace_id: wsB.id, policy_id: policyPro.id } });
  const subscription = await db.planSubscription.findUnique({ where: { workspace_id: wsB.id } });
  const legacy = await db.userPlan.findUnique({ where: { user_id: user.id } });
  assert("G7.2", Boolean(assignment && assignment.source === "purchase"), `source=${assignment?.source}`);
  assert("G7.2b", result.grant.granted === true && Boolean(subscription), `sub=${subscription?.id} granted=${result.grant.granted}`);
  assert("G7.2c", legacy !== null && legacy.plan_id === plan.id, `legacy_plan=${legacy?.plan_id}`);
}
// 给 wsA 也发一条 purchase（同样的购买路径），用于 G7.3/G7.5 的"有 default 兜底"场景
{
  const order = await db.planOrder.create({ data: { user_id: user.id, workspace_id: wsA.id, plan_id: plan.id, price: 20, balance: 960 } });
  await db.$transaction((tx) => applyPlanPurchase(tx, {
    now: NOW, workspace_id: wsA.id, payer_user_id: user.id,
    plan: { id: plan.id, name: plan.name, billing_cycle: "month", price: 20, policy_id: policyPro.id, traffic_bytes: 100000, max_tunnels: 10 },
    order_id: order.id,
  }));
}

// ── G7.3 结算幂等：auto_renew=false 只记账；连跑两遍零变化 ──
{
  const deps = defaultSettlementDeps();
  const ordersBefore = await db.planOrder.count();
  const logsBefore = await db.balanceLog.count();
  const balanceBefore = (await db.user.findUniqueOrThrow({ where: { id: user.id } })).balance;

  const first = await settleDuePeriods(deps, NOW);
  const second = await settleDuePeriods(deps, NOW);

  const ordersAfter = await db.planOrder.count();
  const logsAfter = await db.balanceLog.count();
  const balanceAfter = (await db.user.findUniqueOrThrow({ where: { id: user.id } })).balance;

  assert("G7.3a", first.settled >= 2 && first.due >= 2, `due=${first.due} settled=${first.settled}`);
  assert("G7.3b", second.settled === 0 && second.skipped === 0 && second.due === 0, `settled=${second.settled} skipped=${second.skipped} due=${second.due}`);
  assert("G7.3c", ordersAfter === ordersBefore && logsAfter === logsBefore && balanceAfter === balanceBefore,
    `orders ${ordersBefore}->${ordersAfter} logs ${logsBefore}->${logsAfter} balance ${balanceBefore}->${balanceAfter}`);
  const settledRows = await db.subscriptionPeriodSettlement.count({ where: { period_key: PERIOD_KEY, state: "settled" } });
  assert("G7.3d", settledRows >= 2, `settled_rows=${settledRows}`);
}

// ── G7.3e 续期路径（auto_renew=true + 已绑策略）：恰好扣一次款 ──
{
  await db.planSubscription.update({ where: { workspace_id: wsB.id }, data: { auto_renew: true } });
  const balanceBefore = (await db.user.findUniqueOrThrow({ where: { id: user.id } })).balance;
  const ordersBefore = await db.planOrder.count();
  // 换到下一个周期，让 B 的订阅重新"到期该结算"
  const NEXT = new Date(NOW.getTime() + 32 * DAY);
  const deps = defaultSettlementDeps();
  const round1 = await settleDuePeriods(deps, NEXT);
  const balanceAfter1 = (await db.user.findUniqueOrThrow({ where: { id: user.id } })).balance;
  const ordersAfter1 = await db.planOrder.count();
  const anchor = await db.subscriptionPeriodSettlement.findFirst({
    where: { plan_subscription: { workspace_id: wsB.id }, period_key: billingPeriodKey(NEXT, "month") },
  });
  const round2 = await settleDuePeriods(deps, NEXT);
  const balanceAfter2 = (await db.user.findUniqueOrThrow({ where: { id: user.id } })).balance;
  const ordersAfter2 = await db.planOrder.count();

  assert("G7.3e", round1.settled >= 1 && balanceAfter1 === balanceBefore - 20 && ordersAfter1 === ordersBefore + 1,
    `settled=${round1.settled} balance ${balanceBefore}->${balanceAfter1} orders ${ordersBefore}->${ordersAfter1}`);
  assert("G7.3f", anchor?.order_id !== null && anchor?.state === "settled", `anchor_order=${anchor?.order_id} state=${anchor?.state}`);
  assert("G7.3g", round2.skipped === 0 && balanceAfter2 === balanceAfter1 && ordersAfter2 === ordersAfter1,
    `round2 skipped=${round2.skipped} balance ${balanceAfter1}->${balanceAfter2} orders ${ordersAfter1}->${ordersAfter2}`);
  await db.planSubscription.update({ where: { workspace_id: wsB.id }, data: { auto_renew: false } });
}

// ── G7.4 崩溃接管：超时 pending → 恰好一次 settled ──
{
  const subscription = await db.planSubscription.findUniqueOrThrow({ where: { workspace_id: wsB.id } });
  // 刻意挑一个**没有任何 tick 会碰**的旧周期：接管是按账本行续跑的（period-agnostic by design），
  // 用"当前周期"或"下一周期"都会与 G7.3e 已建的行撞唯一键 —— 那是夹具的错，不是引擎的错。
  const staleKey = "2026-09";
  await db.subscriptionPeriodSettlement.create({
    data: { plan_subscription_id: subscription.id, period_key: staleKey, state: "pending", started_at: new Date(NOW.getTime() - 11 * 60_000), order_id: null },
  });
  const deps = defaultSettlementDeps();
  const round1 = await settleDuePeriods(deps, NOW);
  const row1 = await db.subscriptionPeriodSettlement.findFirstOrThrow({ where: { plan_subscription_id: subscription.id, period_key: staleKey } });
  const round2 = await settleDuePeriods(deps, NOW);
  const row2 = await db.subscriptionPeriodSettlement.findFirstOrThrow({ where: { plan_subscription_id: subscription.id, period_key: staleKey } });
  assert("G7.4a", round1.taken_over >= 1 && row1.state === "settled", `taken_over=${round1.taken_over} state=${row1.state}`);
  assert("G7.4b", round2.taken_over === 0 && row2.state === "settled" && row2.attempts === row1.attempts, `taken_over=${round2.taken_over} attempts ${row1.attempts}->${row2.attempts}`);
}

// ── G7.5 到期：宽限内仍放行 + 存量 Forward 不受影响 ──
{
  const expired = new Date(NOW.getTime() - 60 * 60_000); // 1 小时前过期
  await db.workspacePolicyAssignment.updateMany({ where: { workspace_id: wsB.id, policy_id: policyPro.id }, data: { expires_at: expired } });
  const policy = await getEffectivePolicy(wsB.id, { now: NOW, noCache: true });
  assert("G7.5a", policy.grace_policies.length > 0 && policy.deny_reason === "policy_expired" && policy.deny_scope === false,
    `grace=${JSON.stringify(policy.grace_policies)} reason=${policy.deny_reason} deny=${policy.deny_scope}`);
  assert("G7.5b", policy.limits.max_tunnels === 10, `max_tunnels=${policy.limits.max_tunnels}`); // 宽限内不缩水

  const tunnelBefore = await db.tunnel.findUniqueOrThrow({ where: { id: tunnel.id } });
  await settleDuePeriods(defaultSettlementDeps(), NOW);
  const tunnelAfter = await db.tunnel.findUniqueOrThrow({ where: { id: tunnel.id } });
  assert("G7.5c", tunnelBefore.apply_status === "active" && tunnelAfter.apply_status === "active",
    `apply_status ${tunnelBefore.apply_status}->${tunnelAfter.apply_status}（到期不得停掉存量 Forward）`);
}

// ── G7.6 降级 vs fail-closed ──
{
  // A：purchase 过期、system_default 仍在 ⇒ 降级（额度 = default 的 1 条）而不是 deny_scope
  await db.workspacePolicyAssignment.updateMany({ where: { workspace_id: wsA.id, policy_id: policyPro.id }, data: { expires_at: new Date(NOW.getTime() - 60 * 60_000) } });
  const a = await getEffectivePolicy(wsA.id, { now: NOW, noCache: true });
  assert("G7.6a", a.deny_scope === false && a.limits.max_tunnels === 1 && a.entitlements.tunnel_types.join(",") === "tcp",
    `deny=${a.deny_scope} max_tunnels=${a.limits.max_tunnels} types=${a.entitlements.tunnel_types.join("|")}`);

  // A 的第二态：把 system_default 也撤掉，并越过 purchase 的宽限期 ⇒ fail-closed。
  // （刻意用同一条 workspace 验证两态：先"降级"、再"一条都不剩"，这样断言的是状态转移，不是两个孤例。）
  const beyond = new Date(NOW.getTime() + 10 * DAY);
  const revoked = await db.workspacePolicyAssignment.updateMany({
    where: { workspace_id: wsA.id, policy_id: policyDefault.id },
    data: { revoked_at: new Date(NOW.getTime() - 60 * 60_000) },
  });
  const b = await getEffectivePolicy(wsA.id, { now: beyond, noCache: true });
  assert("G7.6b", revoked.count === 1 && b.deny_scope === true,
    `revoked=${revoked.count} deny=${b.deny_scope} reason=${b.deny_reason} grace=${b.grace_policies.length}`);
}

// ── G7.9 流量口径：跨月边界 + 归档戳口径 ──
{
  const sept = await db.tunnelTraffic.create({ data: { tunnel_id: tunnel.id, traffic: 111, traffic_cost: 111, date: new Date("2026-09-30T00:00:00.000Z") } });
  const oct = await db.tunnelTraffic.create({ data: { tunnel_id: tunnel.id, traffic: 222, traffic_cost: 222, date: new Date("2026-10-01T00:00:00.000Z") } });
  const monthSum = await sumWorkspaceTraffic(wsA.id, "month", NOW);
  const daySum = await sumWorkspaceTraffic(wsA.id, "day", NOW);
  assert("G7.9a", monthSum === 222, `month=${monthSum}（只应含 10 月的 ${oct.traffic}）`);
  assert("G7.9b", daySum === 0, `day=${daySum}（10-05 当天没有行）`);

  // 归档戳与"当日标签"同源：写入端 trafficDate 与读入口径逐字相等
  const stampFromLabel = new Date(`${billingPeriodKey(new Date("2026-10-01T00:00:00.000Z"), "day")}T00:00:00.000Z`);
  assert("G7.9c", billingDayKeyStamp(new Date("2026-09-30T18:00:00.000Z")).toISOString() === stampFromLabel.toISOString(),
    `stamp=${billingDayKeyStamp(new Date("2026-09-30T18:00:00.000Z")).toISOString()}`);

  // ── 为什么这里要显式失效策略缓存 ──
  // `getEffectivePolicy` 的缓存**与调用方传入的 `now` 无关**：条目按 workspace 存，
  // 有效性判定用的是「调用方的 now − 计算时的 now < TTL」，而且 `noCache: true` **只跳过读、
  // 仍然会写**（`if (!opts.client) cache.set(...)`）。本门禁在 G7.6b 用**未来时间**（NOW+10d）
  // 调过一次 wsA（那一次是在验证 fail-closed），于是缓存里被放进了"未来那一刻"的策略
  // （deny_scope ⇒ limits = UNLIMITED_LIMITS ⇒ traffic_period = "total"），
  // 后面的展示路径读到的就是它 —— 这正是"合成时间 + 与时间无关的缓存"这族陷阱。
  // 生产里 `now ≈ Date.now()`，所以症状轻得多；但**这个坑本身是真实存在的**，已单独报给 Lead。
  invalidatePolicyCache(wsA.id);

  // 两条读路径同源：用量报告的 traffic_used == 按**它自己给出的周期**做的窗口求和。
  const report = await getWorkspaceUsageReport(wsA.id, { now: NOW });
  const sameSource = await sumWorkspaceTraffic(wsA.id, report.limits.traffic_period, NOW);
  assert("G7.9d", report.traffic_used === sameSource, `report=${report.traffic_used} same_source_sum=${sameSource} period=${report.limits.traffic_period}`);

  // ── 生效周期语义（Lead 2026-10-05 裁决）──
  // **生效周期 = 适用策略中声明的「最长」周期；只有当某条策略真的声明 total 时才是 total。**
  // 这条曾经是缺陷：union 的累加初值 UNLIMITED_LIMITS（total）是"恒胜元"，
  // 于是单条 month 策略也会被算成 total ⇒ 月额度按全量累计判定、永不复位。
  const policyMonth = await db.capabilityPolicy.create({
    data: { key: `g7_m_${Date.now()}`, name: "G7 Month", source: "admin_grant", tunnel_types: ["tcp"], traffic_limit: 5000, traffic_period: "month" },
  });
  // ① 单条 month ⇒ month。先给 A 补一条**长期有效**的 month 授予：否则 A 在 NOW 之后会因
  //    "宽限也过了"而 deny_scope，而 deny_scope 的 limits 是 UNLIMITED_LIMITS（period=total），
  //    断言就会走到另一个分支（又是"夹具让断言指向别处"那族）。
  await db.workspacePolicyAssignment.create({
    data: { workspace_id: wsA.id, policy_id: policyMonth.id, source: "admin_grant", effective_at: new Date(NOW.getTime() - 30 * DAY) },
  });
  invalidatePolicyCache(wsA.id);
  const octReport = await getWorkspaceUsageReport(wsA.id, { now: NOW });
  assert("G7.9e", octReport.limits.traffic_period === "month", `period=${octReport.limits.traffic_period}`);

  // ② month + total 并存 ⇒ total（更宽松者是声明者之一）
  const policyTotal = await db.capabilityPolicy.create({
    data: { key: `g7_t_${Date.now()}`, name: "G7 Total", source: "admin_grant", tunnel_types: ["tcp"], traffic_limit: 5000, traffic_period: "total" },
  });
  for (const policy of [policyMonth, policyTotal]) {
    await db.workspacePolicyAssignment.create({
      data: { workspace_id: wsB.id, policy_id: policy.id, source: "admin_grant", effective_at: new Date(NOW.getTime() - 30 * DAY) },
    });
  }
  invalidatePolicyCache(wsB.id);
  const both = await getEffectivePolicy(wsB.id, { now: NOW, noCache: true });
  assert("G7.9f", both.limits.traffic_period === "total", `period=${both.limits.traffic_period}（month+total 并存）`);

  // ③ 跨月复位（可执行证明）：11 月的行不计入"10 月的已用流量"。
  //    顺序要紧：**先**取 10 月的读数，**再**插 11 月的行 —— 窗口是 `date >= 窗口起点`（上界开放），
  //    先插后读会把"未来那一行"算进 10 月（生产里不存在未来行，但夹具必须尊重这条口径）。
  const octUsed = octReport.traffic_used;
  await db.tunnelTraffic.create({ data: { tunnel_id: tunnel.id, traffic: 777, traffic_cost: 777, date: new Date("2026-11-01T00:00:00.000Z") } });
  const NOV = new Date("2026-11-15T05:30:00.000Z");
  invalidatePolicyCache(wsA.id);
  const novUsed = (await getWorkspaceUsageReport(wsA.id, { now: NOV })).traffic_used;
  assert("G7.9g", octUsed === 222 && novUsed === 777,
    `oct=${octUsed} nov=${novUsed}（月额度复位：11 月不含 10 月的 222，10 月不含 11 月的 777）`);
}

// ── G7.10 联邦缺口可观测且不并账 ──
{
  const before = (await getWorkspaceUsageReport(wsA.id, { now: NOW })).traffic_used;
  await db.federationUsageRecord.create({
    data: {
      usage_id: `g7-${Date.now()}`, peer_panel_id: "peer-g7", lease_ref: "lease-g7", forward_ref: "fw-g7",
      tunnel_id: tunnel.id, window_start: new Date(NOW.getTime() - 3600_000), window_end: NOW,
      bytes_in: 3000n, bytes_out: 2000n, attribution: "attributed",
    },
  });
  const federated = await sumFederatedUnattributedTraffic(wsA.id);
  const report = await getWorkspaceUsageReport(wsA.id, { now: NOW });
  const after = await sumWorkspaceTraffic(wsA.id, report.limits.traffic_period, NOW);
  assert("G7.10a", federated === 5000 && report.traffic_used_unattributed_federated === 5000, `federated=${federated} report=${report.traffic_used_unattributed_federated}`);
  assert("G7.10b", after === before && report.traffic_used === before, `before=${before} after=${after} report=${report.traffic_used}（联邦用量不得并入额度账本）`);
}

console.log(`SCENARIO PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
'''


# ───────────────────────────── G7.1（进程时区无关，纯函数） ─────────────────────────────

TZ_PROBE = r'''
import { billingPeriodKey, billingMonthStart, billingDayStart, billingMonthlyBoundary } from "./services/billing-time.ts";
import { trafficWindowStart } from "./services/capability-policy.ts";
const instants = ["2026-01-31T15:59:59.999Z","2026-01-31T16:00:00.000Z","2026-10-05T18:30:00.000Z","2028-02-29T02:30:00.000Z"];
const rows = instants.map((iso) => {
  const at = new Date(iso);
  return [iso, billingPeriodKey(at, "day"), billingPeriodKey(at, "month"), billingMonthStart(at).toISOString(),
    billingDayStart(at).toISOString(), billingMonthlyBoundary(at, 31).toISOString(),
    trafficWindowStart("day", at)?.toISOString() ?? "null", trafficWindowStart("month", at)?.toISOString() ?? "null"].join("|");
});
process.stdout.write(JSON.stringify(rows));
'''


def gate_tz_independence() -> None:
    # 探针要在 backend/src 下（相对导入才成立）；纯函数，不需要 DB。
    probe = BACKEND / "src" / "__g7_tz_probe.ts"
    probe.write_text(TZ_PROBE, encoding="utf-8")
    outputs = {}
    try:
        for tz in ("UTC", "Asia/Shanghai"):
            result = run(["bun", "src/__g7_tz_probe.ts"], cwd=BACKEND, env={**PLACEHOLDER_ENV, "TZ": tz}, timeout=120)
            if result.returncode != 0:
                check("G7.1", False, f"TZ={tz} 探针失败：{(result.stderr or result.stdout).strip()[:200]}")
                return
            outputs[tz] = result.stdout.strip()
    finally:
        probe.unlink(missing_ok=True)
    same = len(set(outputs.values())) == 1
    check("G7.1", same, "两个进程时区输出逐字相等" if same else f"UTC 与 Asia/Shanghai 输出不同：{outputs['UTC'][:120]} vs {outputs['Asia/Shanghai'][:120]}")


# ───────────────────────────── G7.11 / G7.12（DoD 1 / 2 的 grep） ─────────────────────────────

def gate_greps() -> None:
    grep = shutil.which("grep")
    if grep is None:
        check("G7.11", False, "找不到 grep")
        return
    dod1 = run([grep, "-rnE", "checkTunnelCreation|max_tunnels", str(BACKEND / "src" / "services" / "payment"), str(BACKEND / "src" / "services" / "subscription-billing.ts")])
    hits1 = [line for line in dod1.stdout.splitlines() if line.strip()]
    check("G7.11", not hits1, f"计费侧出现额度判定：{hits1[:2]}" if hits1 else "0 命中")

    dod2 = run([grep, "-rnE", "workspacePolicyAssignment\\.(create|upsert)", str(BACKEND / "src")])
    hits2 = [line for line in dod2.stdout.splitlines() if "__tests__" not in line and line.strip()]
    functions = []
    for hit in hits2:
        path, lineno, _rest = hit.split(":", 2)
        before = "\n".join(Path(path).read_text(encoding="utf-8").splitlines()[: int(lineno)])
        found = re.findall(r"export async function (\w+)", before)
        functions.append(found[-1] if found else "(顶层)")
    check("G7.12", functions == ["assignDefaultPolicy", "grantPolicyFromPurchase"], f"写入点={functions}")


# ───────────────────────────── 主流程 ─────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="V5-G7 Billing Runtime gate（自带一次性 MySQL）")
    parser.add_argument("--keep", action="store_true", help="保留临时容器（默认跑完删除）")
    args = parser.parse_args()

    started = datetime.now(timezone.utc)
    log(f"# V5-G7 Billing Runtime gate @ {started.isoformat()}")
    problems = preflight()
    check("G7.0", not problems, "前提齐备" if not problems else "；".join(problems))

    env = G7Environment()
    tmp = Path(tempfile.mkdtemp(prefix="v5-g7-"))
    try:
        if problems:
            log("前提不满足 ⇒ 不再继续（其余断言不做，避免制造'没跑=通过'的错觉）")
        else:
            env.start()
            log(f"# 一次性环境：网络={env.network} MySQL={env.mysql_name} 应用容器={env.app_name} 库={DB_NAME}")

            count, err = env.apply_migrations()
            check("G7.migrate", not err, f"{count} 条迁移全部应用" if not err else f"{count} 条中失败：{err}")

            generated = env.generate_client()
            check("G7.client", generated.returncode == 0,
                  "Prisma client 按新 schema 生成" if generated.returncode == 0 else (generated.stderr or generated.stdout)[-300:])

            gate_tz_independence()

            env.push_sources()
            scenario_src = BACKEND / "src" / "__g7_scenario.ts"
            scenario_src.write_text(SCENARIO, encoding="utf-8")
            try:
                copied = docker("cp", str(scenario_src), f"{env.app_name}:/app/src/__g7_scenario.ts", timeout=120)
                if copied.returncode != 0:
                    raise RuntimeError(f"场景脚本送入容器失败：{copied.stderr.strip()}")
                result = env.run_scenario("src/__g7_scenario.ts")
                output = result.stdout + result.stderr
                for line in output.splitlines():
                    # FINDING 是「已知缺陷的可观测结论」：必须进证据，但**不计分**
                    # （它不属于本门禁声称覆盖的断言集合；隐瞒它才是更坏的做法）。
                    if line.startswith("G7.FINDING"):
                        log(line)
                        continue
                    if re.match(r"^G7\.\d", line):
                        log(line)
                        if " OK" in line:
                            globals()["PASS"] += 1
                        elif " FAIL" in line:
                            globals()["FAIL"] += 1
                produced = {re.match(r"^(G7\.\d\w*)", line).group(1) for line in output.splitlines() if re.match(r"^G7\.\d", line)}
                expected = {
                    "G7.2", "G7.2b", "G7.2c",
                    "G7.3a", "G7.3b", "G7.3c", "G7.3d", "G7.3e", "G7.3f", "G7.3g",
                    "G7.4a", "G7.4b",
                    "G7.5a", "G7.5b", "G7.5c",
                    "G7.6a", "G7.6b",
                    "G7.9a", "G7.9b", "G7.9c", "G7.9d", "G7.9e", "G7.9f", "G7.9g",
                    "G7.10a", "G7.10b",
                }
                missing = sorted(expected - produced)
                check("G7.scenario", result.returncode == 0 and not missing,
                      "场景全部产出结论" if not missing else f"未产出结论（不得当作通过）：{missing}")
                if result.returncode != 0:
                    log("--- 场景输出（失败时的原文）---")
                    for line in output.splitlines()[-25:]:
                        log(f"  {line}")
            finally:
                scenario_src.unlink(missing_ok=True)

            gate_greps()
    except Exception as exc:  # noqa: BLE001 - 任何异常都是 FAIL，不是 skip
        check("G7.exception", False, f"{type(exc).__name__}: {exc}")
    finally:
        if args.keep:
            log(f"# --keep：环境保留（网络={env.network} MySQL={env.mysql_name} 应用={env.app_name}；"
                f"docker exec -it {env.app_name} sh）")
        else:
            env.stop()
        shutil.rmtree(tmp, ignore_errors=True)

    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    evidence = EVIDENCE_DIR / f"v5-g7-result-{started.strftime('%Y%m%d')}.txt"
    header = [
        f"V5-G7 Billing Runtime gate —— {started.isoformat()}",
        f"repo={REPO}",
        f"mysql_image={MYSQL_IMAGE}（一次性容器，跑完删除）",
        "不覆盖：G7.7/G7.8（建 Forward 的占位顺序需要真面板 + 真 Agent 编排；见脚本 docstring 的理由）",
        "",
    ]
    evidence.write_text("\n".join(header + LOG) + f"\nV5-G7 TOTAL PASS={PASS} FAIL={FAIL}\n", encoding="utf-8")
    log("")
    log(f"V5-G7 TOTAL PASS={PASS} FAIL={FAIL} evidence={evidence}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
