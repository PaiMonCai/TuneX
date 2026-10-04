#!/usr/bin/env python3
"""V5.5 Federation —— Panel B 引导（Gate V5-G5 的前置）。

契约：`docs/v5-wp14-16-federation-contract.md` §2 / §3；门禁清单 `DEVELOPMENT.md` §10.3。

这个脚本把**第二个真实面板**立起来，作为 Panel A 的联邦对端（host 侧）：

  1. 复用 A 的 MySQL / Redis 容器，但用**独立数据库** `tunex_b` 与**独立 Redis db**
     `redis://redis:6379/2`（不能和 A 共享一份库：那会让"两个面板"变成一份真相）；
  2. 起 `wp14-panel-b`（image `wp14-backend:ci`，`--network wp14_ctrl`，容器名固定）；
  3. 跑 `prisma migrate deploy`（幂等），必要时跑 `prisma/seed.ts`；
  4. 通过**真实 HTTP API** 建管理员 / workspace / NodeGroup / Node，并起一个**真实
     Agent 容器** `wp14-agent-b1`（image `wp14-agent:ci`，指向 `http://panel-b:3000`），
     等它完成 credential-authenticated state report；
  5. 通过带外 token + `POST /api/federation/v1/handshake` 建立**双向联邦信任**。

幂等：第二次执行不会产生第二份 Node / Agent / peer / grant：

  · 面板容器存在就复用（停止则 start）；
  · `migrate deploy` 与 seed 各自幂等（seed 只在 capability_policy 为空时跑）；
  · Node 行已存在就**不**再调用 provision（该 API 对已存在节点带 targets 会
    返回 runtimeEdit 冲突，这是产品明确的保护），改为按需补发 enrollment；
  · Agent 容器存在就复用（credential / agent_id 直接从容器 Cmd 读回）；
  · 已互相信任就跳过握手（重新握手会多建一条 pending peer 行）。

硬约束（契约 §7）：**不碰** `wp14-panel` / `wp14-mysql` / `wp14-redis` / 四个既有
Agent / `wp14-target-*` / `wp14-client`，**不碰** `tunex` 数据库。

运行（必须在 `tunex-e2e` 容器里，因为它有 docker CLI + socket，且和面板同网）：

    docker exec -e API=http://panel:3000 tunex-e2e bash -lc \
      'cd /repo && python3 scripts/v3-e2e/bootstrap-federation.py'

环境变量：`API`（Panel A，默认 http://panel:3000）、`FED_PANEL_B_API`
（默认 http://panel-b:3000）。改动脚本后必须先用 tar 同步仓库到 `/repo`。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE = HERE / "state.json"
ENVF = HERE / ".env.wp14"
PASSF = HERE / ".passwords.env"

API_A = os.environ.get("API", "http://panel:3000").rstrip("/")
API_B = os.environ.get("FED_PANEL_B_API", "http://panel-b:3000").rstrip("/")

PANEL_A = "wp14-panel"
MYSQL = "wp14-mysql"
REDIS = "wp14-redis"
PANEL_B = "wp14-panel-b"
MIGRATE_B = "wp14-migrate-b"
AGENT_B = "wp14-agent-b1"
NET = "wp14_ctrl"
DATA_NET = "wp14_egress_data"
DB_B = "tunex_b"
REDIS_B = "redis://redis:6379/2"

# Panel A 的既有资产：本脚本**只读**它们，绝不 start/stop/rm/写库。
PROTECTED_CONTAINERS = (
    PANEL_A, MYSQL, REDIS, "wp14-worker",
    "wp14-ingress-agent", "wp14-egress-agent",
    "wp14-ingress-agent-b", "wp14-egress-agent-b",
    "wp14-target-a", "wp14-target-b", "wp14-client",
)

B_ADMIN_EMAIL = os.environ.get("FED_PANEL_B_ADMIN_EMAIL", "wp14-e2e-b@tunex.local")
B_WORKSPACE_NAME = "WP14-B Primary"
B_GROUP_NAME = "WP14-B Egress"
B_NODE_STR = "WP14-B1-OUT"
B_NODE_LISTEN_IP = os.environ.get("FED_PANEL_B_NODE_IP", "172.31.20.41")
B_EGRESS_RANGE = "22000-22099"

START = time.monotonic()


def say(msg: str) -> None:
    print(f"\n== {msg}", flush=True)


def step(msg: str) -> None:
    print(f"[federation-b] {msg}", flush=True)


def die(msg: str) -> "NoReturn":  # type: ignore[name-defined]  # noqa: F821
    print(f"[federation-b] FATAL: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def parse_env(path: Path) -> dict:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v
    return out


def run(args, allow: bool = False, timeout: int = 600) -> str:
    p = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if p.returncode and not allow:
        raise RuntimeError(f"{' '.join(args)} failed ({p.returncode}): {p.stderr.strip() or p.stdout.strip()}")
    return (p.stdout or "").strip()


def docker(args, allow: bool = False, timeout: int = 600) -> str:
    return run(["docker", *args], allow=allow, timeout=timeout)


def inspect(fmt: str, container: str) -> str:
    return docker(["inspect", "-f", fmt, container], allow=True)


def container_running(name: str) -> bool:
    return inspect("{{.State.Running}}", name) == "true"


def container_exists(name: str) -> bool:
    return docker(["inspect", "-f", "{{.Id}}", name], allow=True) != ""


def mysql_b(sql: str) -> str:
    """只对 `tunex_b` 执行 SQL。A 的库（tunex）在本脚本里是不可达的：DB 名是常量。"""
    e = parse_env(ENVF)
    return run([
        "docker", "exec", MYSQL, "mysql", "-uroot", f"-p{e['MYSQL_ROOT_PASSWORD']}",
        DB_B, "-N", "-B", "-e", sql,
    ])


def mysql_b_scalar(sql: str) -> str:
    out = mysql_b(sql).strip()
    return out.splitlines()[-1].strip() if out else ""


def http(method: str, base: str, path: str, body=None, cookie=None, headers=None, timeout: int = 60):
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json", "x-requested-with": "XMLHttpRequest", "origin": base}
    if cookie:
        h["cookie"] = cookie
    if headers:
        h.update(headers)
    req = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read().decode()
            return res.status, (json.loads(raw) if raw.strip() else {}), res.headers.get("set-cookie")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            parsed = json.loads(raw) if raw.strip() else {}
        except Exception:  # noqa: BLE001
            parsed = {"raw": raw}
        return e.code, parsed, e.headers.get("set-cookie")
    except (urllib.error.URLError, OSError) as e:
        return 0, {"error": str(e)}, None


def unwrap(value):
    return value.get("data", value) if isinstance(value, dict) else value


def as_list(value):
    value = unwrap(value)
    if isinstance(value, dict) and isinstance(value.get("data"), list):
        return value["data"]
    return value if isinstance(value, list) else []


def login(base: str, email: str, password: str):
    status, body, set_cookie = http("POST", base, "/api/auth/login", {"email": email, "password": password})
    cookie = (set_cookie or "").split(";", 1)[0]
    return status, cookie, body


def wait_until(fn, timeout: int = 120, interval: int = 3) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn():
                return True
        except Exception:  # noqa: BLE001 - 瞬时探测失败就是重试
            pass
        time.sleep(interval)
    return False


# ---------------------------------------------------------------------------
# 0. 前置检查
# ---------------------------------------------------------------------------

def preflight() -> dict:
    if not (STATE.exists() and ENVF.exists() and PASSF.exists()):
        die("缺少 A 的 e2e 状态（state.json / .env.wp14 / .passwords.env）：先跑 scripts/v3-e2e/setup.sh")
    state = json.loads(STATE.read_text())
    env = parse_env(ENVF)
    pw = parse_env(PASSF).get("WP14_USER_PASSWORD", "")
    if not pw:
        die(".passwords.env 缺少 WP14_USER_PASSWORD")

    for name in (PANEL_A, MYSQL, REDIS):
        if not container_running(name):
            die(f"Panel A 依赖的 {name} 不在运行：先跑 scripts/v3-e2e/setup.sh")
    status = http("GET", API_A, "/healthz")[0]
    if status != 200:
        die(f"Panel A /healthz 不可达（{API_A}）：{status}")
    step(f"Panel A 就绪：{API_A}，e2e 用户={state['user']['email']}")

    # 幂等的复位：A 侧用户必须是 super_admin，否则 /api/admin/federation/* 会 403。
    mysql_a_update_super_admin(state["user"]["email"])
    return {"state": state, "env": env, "password": pw}


def mysql_a(sql: str) -> str:
    """**唯一**允许碰 A 的库的地方：把 e2e 用户提为 super_admin（与 v5-g1a/v5-g4 的 setup 同口径）。

    这里刻意只有一个固定语句，且不写任何联邦业务表。
    """
    e = parse_env(ENVF)
    return run([
        "docker", "exec", MYSQL, "mysql", "-uroot", f"-p{e['MYSQL_ROOT_PASSWORD']}",
        e.get("MYSQL_DATABASE", "tunex"), "-N", "-B", "-e", sql,
    ])


def mysql_a_update_super_admin(email: str) -> None:
    mysql_a(f"UPDATE user SET super_admin=1 WHERE email='{email}';")


# ---------------------------------------------------------------------------
# 1. 数据库与面板
# ---------------------------------------------------------------------------

def ensure_database() -> None:
    e = parse_env(ENVF)
    run([
        "docker", "exec", MYSQL, "mysql", "-uroot", f"-p{e['MYSQL_ROOT_PASSWORD']}",
        "-e", f"CREATE DATABASE IF NOT EXISTS {DB_B} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;",
    ])
    step(f"数据库 {DB_B} 就绪")


def panel_b_env(env: dict) -> list[str]:
    """Panel B 的容器环境：沿用 A 的服务密钥，但数据库与 Redis db index 必须独立。"""
    base: dict[str, str] = {}
    for item in inspect("{{json .Config.Env}}", PANEL_A).strip().splitlines():
        try:
            for pair in json.loads(item):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    base[k] = v
        except Exception:  # noqa: BLE001
            continue
    if not base:
        die("读不到 Panel A 的容器环境（inspect 失败）")

    root_pw = env["MYSQL_ROOT_PASSWORD"]
    base.update({
        "PORT": "3000",
        "NODE_ENV": "production",
        "DATABASE_URL": f"mysql://root:{root_pw}@mysql:3306/{DB_B}",
        "REDIS_URL": REDIS_B,
        "JWT_ISSUER": "wp14b",  # 两个面板的会话 token 不能互相认
        "COOKIE_SECURE": "false",
        "ALLOW_REGISTER_FALLBACK": "true",
        "SITE_URL": "http://127.0.0.1:18181",
        # 自报地址（契约 §2.2）：握手时 A 会把这个值发给 B，作为"B 回呼 A"的地址。
        # 继承 A 的值会把 B 的 peer(A) 指到 panel:3000 之外 —— 必须显式覆盖。
        "FEDERATION_PUBLIC_URL": "http://panel-b:3000",
    })
    # 保险丝：Panel B 绝不允许指向 A 的库。
    if not base["DATABASE_URL"].endswith(f"/{DB_B}"):
        die(f"Panel B 的 DATABASE_URL 不是 {DB_B}: {base['DATABASE_URL']}")
    return [f"{k}={v}" for k, v in base.items()]


def backend_image() -> str:
    """Panel B 用的镜像 = A 正在跑的那个（或显式覆盖）。"""
    image = os.environ.get("FED_PANEL_B_IMAGE") or inspect("{{.Config.Image}}", PANEL_A).strip()
    if not image:
        die("找不到 backend 镜像（Panel A 不在运行？）")
    return image


def ensure_backend_image() -> str:
    """默认从**当前 checkout** 重建 backend 镜像，再起 Panel B。

    理由（实测教训）：`wp14-backend:ci` 可能是几十分钟前的快照，而 backend 正在被改。
    一个"用旧代码跑出来的绿灯"比一个红灯更危险 —— 它会让人相信一条没被验证的链路。
    `FED_SKIP_BUILD=1` 才跳过（例如本地反复调试时）。
    """
    if os.environ.get("FED_SKIP_BUILD") == "1":
        return backend_image()
    repo_root = HERE.resolve().parent.parent
    context = repo_root / "backend"
    if not (context / "Dockerfile").exists():
        die(f"找不到 backend 构建上下文：{context}")
    step(f"从当前 checkout 构建 wp14-backend:ci（FED_SKIP_BUILD=1 可跳过）：{context}")
    docker(["build", "-t", "wp14-backend:ci", str(context)], timeout=1800)
    return "wp14-backend:ci"


def image_id(ref: str) -> str:
    return docker(["image", "inspect", "-f", "{{.Id}}", ref], allow=True).strip()


def container_uses_image(name: str, ref: str) -> bool:
    """容器是否已经跑在目标镜像上。不一致就必须重建，否则 B 会跑旧代码。"""
    current = inspect("{{.Image}}", name).strip()
    want = image_id(ref)
    return bool(current) and bool(want) and current == want


def drop_container(name: str) -> None:
    docker(["rm", "-f", name], allow=True, timeout=120)
    step(f"已移除旧容器 {name}（镜像已变更）")


def ensure_panel_b(image: str, env_pairs: list[str]) -> None:
    if container_exists(PANEL_B) and not container_uses_image(PANEL_B, image):
        drop_container(PANEL_B)
    if container_exists(PANEL_B):
        step(f"复用既有 {PANEL_B}（image={image}）")
        if not container_running(PANEL_B):
            docker(["start", PANEL_B])
        return

    cmd = ["run", "-d", "--name", PANEL_B, "--restart", "unless-stopped",
           "--network", NET, "--network-alias", "panel-b"]
    for pair in env_pairs:
        cmd += ["-e", pair]
    cmd.append(image)
    docker(cmd)
    step(f"已启动 {PANEL_B}（image={image}，network={NET}）")


def ensure_migrated(image: str, env_pairs: list[str]) -> None:
    """**每次都跑** `prisma migrate deploy`（幂等）。

    早期版本用"panel-b 的 /healthz 已经 200 就跳过迁移"当优化 —— 那是个真 bug：
    panel-b 可能还跑着**上一个镜像**（健康检查照样 200），于是新迁移永远不会 apply，
    而新代码一旦读新列就会炸在一个与联邦无关的地方（实测：B 侧 `tunnel.federated_egress_peer`
    缺列，Gate 的预检把它抓成了 FAIL）。迁移是幂等的，省这几秒不值得。
    """
    cmd = ["run", "--rm", "--name", MIGRATE_B, "--network", NET]
    for pair in env_pairs:
        cmd += ["-e", pair]
    cmd += [image, "sh", "-c", "bunx prisma migrate deploy"]
    step("执行 prisma migrate deploy（tunex_b，幂等）")
    docker(cmd, timeout=900)

    if mysql_b_scalar("SELECT COUNT(*) FROM capability_policy;") in ("", "0"):
        cmd = ["run", "--rm", "--name", f"{MIGRATE_B}-seed", "--network", NET]
        for pair in env_pairs:
            cmd += ["-e", pair]
        cmd += [image, "sh", "-c", "bun prisma/seed.ts"]
        step("执行 prisma/seed.ts（首次，capability_policy 为空）")
        docker(cmd, timeout=900)
    else:
        step("跳过 seed（capability_policy 已存在）")


def ensure_panel_b_healthy() -> None:
    ok = wait_until(lambda: http("GET", API_B, "/healthz", timeout=10)[0] == 200, timeout=180, interval=3)
    if not ok:
        logs = docker(["logs", "--tail", "60", PANEL_B], allow=True, timeout=120)
        die(f"Panel B /healthz 不可达（{API_B}）；容器日志：\n{logs}")
    step(f"Panel B healthy：{API_B}")


# ---------------------------------------------------------------------------
# 2. B 侧管理员 / workspace / NodeGroup / Node
# ---------------------------------------------------------------------------

def ensure_admin(password: str) -> str:
    status, body, _ = http("POST", API_B, "/api/auth/register", {"email": B_ADMIN_EMAIL, "password": password})
    if status not in (200, 201, 409):
        die(f"B 注册管理员失败：status={status} body={json.dumps(body)[:200]}")
    mysql_b(f"UPDATE user SET super_admin=1 WHERE email='{B_ADMIN_EMAIL}';")
    status, cookie, body = login(API_B, B_ADMIN_EMAIL, password)
    if status != 200 or not cookie:
        die(f"B 管理员登录失败：status={status} body={json.dumps(body)[:200]}")
    step(f"B 管理员就绪：{B_ADMIN_EMAIL}")
    return cookie


def ensure_workspace(cookie: str) -> dict:
    status, body, _ = http("GET", API_B, "/api/workspaces", cookie=cookie)
    if status != 200:
        die(f"B 列 workspace 失败：{status} {json.dumps(body)[:200]}")
    for item in as_list(body):
        if item.get("name") == B_WORKSPACE_NAME:
            return item
    status, body, _ = http("POST", API_B, "/api/workspaces", {"name": B_WORKSPACE_NAME}, cookie)
    if status not in (200, 201):
        die(f"B 建 workspace 失败：{status} {json.dumps(body)[:200]}")
    ws = unwrap(body)
    step(f"B workspace 新建：id={ws['id']} name={ws['name']}")
    return ws


def ensure_group(cookie: str, ws_id: int) -> dict:
    headers = {"x-workspace-id": str(ws_id)}
    status, body, _ = http("GET", API_B, "/api/node-groups?page=1&page_size=200", cookie=cookie, headers=headers)
    if status != 200:
        die(f"B 列 node group 失败：{status} {json.dumps(body)[:200]}")
    for item in as_list(body):
        if item.get("name") == B_GROUP_NAME:
            return item
    status, body, _ = http(
        "POST", API_B, "/api/node-groups",
        {"name": B_GROUP_NAME, "node_type": "out", "port_range": B_EGRESS_RANGE},
        cookie, headers,
    )
    if status not in (200, 201):
        die(f"B 建 node group 失败：{status} {json.dumps(body)[:200]}")
    group = unwrap(body)
    step(f"B node group 新建：id={group['id']} name={group['name']}")
    return group


def enroll(token: str) -> dict:
    body = b""
    req = urllib.request.Request(
        API_B + "/api/internal/node/enroll", data=body, method="POST",
        headers={"authorization": f"Enrollment {token}", "accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read().decode()
            status = res.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        status = e.code
    if status != 200:
        die(f"B 节点 enrollment 失败：{status} {raw[:200]}")
    return unwrap(json.loads(raw)) if raw else {}


def ensure_quota() -> None:
    """E2E 专用配额 fixture（与 setup.sh 的口径一致，只作用在 tunex_b）。"""
    mysql_b("UPDATE capability_policy SET max_nodes=4, revision=revision+1 WHERE max_nodes IS NOT NULL;")
    mysql_b("UPDATE capability_policy SET max_tunnels=200, revision=revision+1 WHERE max_tunnels IS NOT NULL;")
    quota = mysql_b_scalar("SELECT IFNULL(MAX(max_nodes),0) FROM capability_policy;")
    if quota not in ("4",):
        die(f"B 的 max_nodes fixture 未生效（got={quota}）")
    step("B 配额 fixture 就绪：max_nodes=4")


def ensure_node(cookie: str, ws_id: int, group: dict, password: str) -> dict:
    """建/复用 concrete Node，并返回 {node_db_id, agent_id, credential}。

    复用优先：已存在就不调用 provision（该 API 对已存在节点带 targets 会
    返回 runtimeEdit 冲突，这是产品有意的保护）。
    """
    row = mysql_b_scalar(
        f"SELECT CONCAT(id,'|',IFNULL(agent_id,''),'|',IFNULL(connect_ip,'')) FROM node WHERE node_id='{B_NODE_STR}';"
    )
    headers = {"x-workspace-id": str(ws_id)}

    if row:
        db_id, agent_id, _ip = (row.split("|") + ["", ""])[:3]
        step(f"复用既有 Node {B_NODE_STR}（db_id={db_id}）")
    else:
        status, body, _ = http(
            "POST", API_B, f"/api/node-groups/{group['id']}/nodes",
            {
                "node_id": B_NODE_STR,
                "connect_ip": B_NODE_LISTEN_IP,
                "role": "egress",
                "targets": [{"host": "target-a", "port": 3030, "weight": 1}],
            },
            cookie, headers, timeout=90,
        )
        if status not in (200, 201):
            die(f"B provision node 失败：{status} {json.dumps(body)[:240]}")
        provisioned = unwrap(body)
        node = provisioned.get("node") or {}
        db_id = str(node.get("id") or "")
        agent_id = str(node.get("agent_id") or "")
        enrolled = enroll(provisioned["enrollment"]["token"])
        if enrolled.get("agent_id") != agent_id:
            die(f"B enrollment 的 agent_id 与 node 行不一致：{enrolled.get('agent_id')} != {agent_id}")
        step(f"B Node 新建：db_id={db_id} agent_id={agent_id[:12]}…")
        return {"node_db_id": int(db_id), "agent_id": agent_id, "credential": enrolled["credential"],
                "connect_ip": B_NODE_LISTEN_IP, "reused": False, "enrollment": status}

    # 复用路径：credential 从 Agent 容器自己的 Cmd 里读回（它就是唯一的那一份）。
    if container_exists(AGENT_B):
        cmd = inspect("{{json .Config.Cmd}}", AGENT_B).strip()
        try:
            parts = json.loads(cmd)
        except Exception:  # noqa: BLE001
            parts = []
        cred = parts[parts.index("--node-credential") + 1] if "--node-credential" in parts else ""
        agent_id = parts[parts.index("--agent-id") + 1] if "--agent-id" in parts else agent_id
        if cred:
            step(f"复用既有 Agent {AGENT_B}（agent_id={agent_id[:12]}…）")
            return {"node_db_id": int(db_id), "agent_id": agent_id, "credential": cred,
                    "connect_ip": B_NODE_LISTEN_IP, "reused": True}

    # Node 行在、Agent 不在：用 admin 端点补发一次性 enrollment（身份/凭据，不是 runtime 编辑）。
    status, body, _ = http("POST", API_B, f"/api/admin/node/{db_id}/enrollment", {}, cookie, headers, timeout=60)
    if status not in (200, 201):
        die(f"B 补发 enrollment 失败：{status} {json.dumps(body)[:200]}")
    enrollment = unwrap(body)
    token = enrollment.get("token") if isinstance(enrollment, dict) else None
    if not token:
        die(f"B 补发 enrollment 没有 token：{json.dumps(body)[:200]}")
    enrolled = enroll(token)
    step(f"B Node {B_NODE_STR} 重新签发凭据（agent_id={str(enrolled.get('agent_id'))[:12]}…）")
    return {"node_db_id": int(db_id), "agent_id": enrolled.get("agent_id") or agent_id,
            "credential": enrolled["credential"], "connect_ip": B_NODE_LISTEN_IP, "reused": True}


def ensure_agent_b(node: dict) -> None:
    image = os.environ.get("FED_PANEL_B_AGENT_IMAGE") or "wp14-agent:ci"
    if container_exists(AGENT_B):
        if not container_running(AGENT_B):
            docker(["start", AGENT_B])
        step(f"复用既有 Agent 容器 {AGENT_B}")
        return

    args = [
        "--panel-http-url", "http://panel-b:3000",
        "--node-id", B_NODE_STR,
        "--listen-ip", B_NODE_LISTEN_IP,
        "--role", "EGRESS",
        "--agent-admin-port", "0",
        "--agent-id", node["agent_id"],
        "--node-credential", node["credential"],
        "--egress-range", B_EGRESS_RANGE,
        "--state-dir", "/var/lib/tunex-agent",
        "--debug",
    ]
    # 先 create（不启动）→ 接上数据网 → 再 start：Agent 在启动时就会 bind 数据面监听，
    # 数据网接口必须先存在，否则"第一次 bind 失败"会被读成产品问题。
    docker(["create", "--name", AGENT_B, "--restart", "unless-stopped",
            "--network", NET, "--network-alias", "agent-b1", image, *args])
    docker(["network", "connect", "--ip", B_NODE_LISTEN_IP, DATA_NET, AGENT_B])
    docker(["start", AGENT_B])
    step(f"已启动 {AGENT_B}（ctrl + {DATA_NET} {B_NODE_LISTEN_IP}）")


def wait_state_report(agent_id: str) -> None:
    ok = wait_until(
        lambda: mysql_b_scalar(
            "SELECT COUNT(*) FROM node_state_report s JOIN node n ON n.id=s.node_id "
            f"WHERE n.node_id='{B_NODE_STR}' AND s.reported_at > NOW() - INTERVAL 2 MINUTE;"
        ) not in ("", "0"),
        timeout=180, interval=3,
    )
    if not ok:
        logs = docker(["logs", "--tail", "60", AGENT_B], allow=True, timeout=120)
        die(f"Agent {AGENT_B} 未完成 state report（agent_id={agent_id}）；日志：\n{logs}")
    step(f"Agent {AGENT_B} 已完成 credential-authenticated state report")


def ensure_worker_b(image: str, env_pairs: list[str]) -> None:
    """Panel B 自己的 worker。

    没有它，"host 侧主动停服"（租约到期 / 撤销后的 sweep）就**不会发生**：
    `runFederationReconcile` 挂在 worker 的 `cron_reconcile_v3`（everyMs=30s）上。
    一个只有 API 没有 worker 的面板不是"第二个面板"，而是半个面板 —— 把它补上，
    Gate 才能验到真实到期路径而不是"数据库里翻了个状态"。
    """
    name = "wp14-worker-b"
    if container_exists(name) and not container_uses_image(name, image):
        drop_container(name)
    if container_exists(name):
        if not container_running(name):
            docker(["start", name])
        step(f"复用既有 {name}")
        return
    cmd = ["run", "-d", "--name", name, "--restart", "unless-stopped", "--network", NET]
    for pair in env_pairs:
        if pair.startswith(("PORT=", "SITE_URL=", "COOKIE_SECURE=")):
            continue
        cmd += ["-e", pair]
    cmd += ["-e", "DISABLE_WORKER=false", image, "bun", "src/worker.ts"]
    docker(cmd)
    ok = wait_until(lambda: "federation wiring ready" in docker(["logs", name], allow=True, timeout=60), timeout=120, interval=5)
    if not ok:
        logs = docker(["logs", "--tail", "40", name], allow=True, timeout=60)
        die(f"{name} 未完成 federation wiring；日志：\n{logs}")
    step(f"已启动 {name}（federation wiring ready）")


# ---------------------------------------------------------------------------
# 3. 联邦信任（带外 token + 握手）
# ---------------------------------------------------------------------------

def admin_base(cookie: str, base: str) -> str:
    """联邦 Admin Console 路由实际所在的挂载前缀。

    **刻意做两件事**：先用文档写的前缀 `/api/admin/federation`，再用实际能用的
    `/api/admin`。当前 checkout 里 `admin-federation.ts` 的注释与
    `DEVELOPMENT.md`/brief 都写 `/api/admin/federation`，但 `app.ts` 把它挂在
    `/api/admin`（与其它 Admin 路由同前缀）——这是**产品/文档不一致**，由 Gate 记录，
    本脚本只负责找到真正可用的那个前缀。
    """
    for candidate in os.environ.get("FED_ADMIN_BASE", "").split(",") + ["/api/admin/federation", "/api/admin"]:
        candidate = candidate.strip()
        if not candidate:
            continue
        status, body, _ = http("GET", base, f"{candidate}/status", cookie=cookie)
        if status == 200 and isinstance(body, dict) and "active_leases" in body:
            if candidate != "/api/admin/federation":
                step(f"注意：{base} 的联邦 admin 路由在 {candidate}（文档写的是 /api/admin/federation）")
            return candidate
    die(f"{base} 找不到联邦 admin 路由（试过 /api/admin/federation 与 /api/admin）")


def panel_id(cookie: str, base: str) -> tuple[str, str]:
    ab = admin_base(cookie, base)
    status, body, _ = http("POST", base, f"{ab}/enable", {}, cookie)
    if status != 200:
        die(f"{base} {ab}/enable 失败：{status} {json.dumps(body)[:200]}")
    data = unwrap(body)
    if not isinstance(data, dict) or not data.get("panel_id"):
        die(f"{base} enable 未返回 panel_id：{json.dumps(body)[:200]}")
    return str(data["panel_id"]), ab


def peer_rows(base: str, cookie: str, ab: str) -> list[dict]:
    status, body, _ = http("GET", base, f"{ab}/peers", cookie=cookie)
    if status != 200:
        return []
    return as_list(unwrap(body))


def ensure_trust(cookie_a: str, cookie_b: str) -> dict:
    pid_a, ab_a = panel_id(cookie_a, API_A)
    pid_b, ab_b = panel_id(cookie_b, API_B)
    if pid_a == pid_b:
        die(f"两个面板的 panel_id 相同（{pid_a}）——它们其实共用了一身份/一数据库")

    peers_a = {p.get("peer_panel_id"): p for p in peer_rows(API_A, cookie_a, ab_a)}
    peers_b = {p.get("peer_panel_id"): p for p in peer_rows(API_B, cookie_b, ab_b)}
    a_trusts_b = peers_a.get(pid_b, {}).get("status") == "trusted"
    b_trusts_a = peers_b.get(pid_a, {}).get("status") == "trusted"
    if a_trusts_b and b_trusts_a:
        step(f"信任已建立，跳过握手（A panel_id={pid_a[:8]}… B panel_id={pid_b[:8]}…）")
        return {"panel_id_a": pid_a, "panel_id_b": pid_b, "handshake": "skipped",
                "admin_base_a": ab_a, "admin_base_b": ab_b,
                "endpoint_url_a_on_b": peers_b.get(pid_a, {}).get("endpoint_url")}

    if not b_trusts_a:
        # B 出邀请（带外 token），A 拿 token 发起握手 —— 契约 §2.2 的真实路径。
        status, body, _ = http(
            "POST", API_B, f"{ab_b}/peers/invite",
            {"display_name": "Panel A (home)", "endpoint_url": API_A, "ttl_seconds": 900},
            cookie_b,
        )
        if status not in (200, 201):
            die(f"B 生成信任邀请失败：{status} {json.dumps(body)[:200]}")
        invitation = unwrap(body)
        token = (invitation or {}).get("token")
        if not token:
            die(f"B 邀请没有 token：{json.dumps(body)[:200]}")
        step(f"B 已生成一次性邀请（peer_id={invitation.get('peer_id')}），经带外交给 A")

        status, body, _ = http(
            "POST", API_A, f"{ab_a}/peers/handshake",
            {"endpoint_url": API_B, "token": token, "display_name": "Panel B (host)"},
            cookie_a, timeout=90,
        )
        if status not in (200, 201):
            die(f"A 握手失败：{status} {json.dumps(body)[:240]}")
        step(f"A → B 握手成功：{json.dumps(unwrap(body))[:160]}")

    peers_a = {p.get("peer_panel_id"): p for p in peer_rows(API_A, cookie_a, ab_a)}
    peers_b = {p.get("peer_panel_id"): p for p in peer_rows(API_B, cookie_b, ab_b)}
    if peers_a.get(pid_b, {}).get("status") != "trusted":
        die(f"A 侧没有把 B 记为 trusted：{json.dumps(peers_a.get(pid_b))[:200]}")
    if peers_b.get(pid_a, {}).get("status") != "trusted":
        die(f"B 侧没有把 A 记为 trusted：{json.dumps(peers_b.get(pid_a))[:200]}")
    step("双向信任已建立（A↔B 均 trusted）")
    return {"panel_id_a": pid_a, "panel_id_b": pid_b, "handshake": "performed",
            "admin_base_a": ab_a, "admin_base_b": ab_b,
            "endpoint_url_a_on_b": peers_b.get(pid_a, {}).get("endpoint_url")}


# ---------------------------------------------------------------------------

def main() -> int:
    say("V5.5 Federation Panel B bootstrap")
    ctx = preflight()
    env_pairs = panel_b_env(ctx["env"])

    say("1/5 独立数据库 + 第二个面板")
    image = ensure_backend_image()
    ensure_database()
    ensure_migrated(image, env_pairs)
    ensure_panel_b(image, env_pairs)
    ensure_panel_b_healthy()

    say("2/5 B 管理员 / workspace / NodeGroup / Node")
    cookie_b = ensure_admin(ctx["password"])
    ensure_quota()
    ws = ensure_workspace(cookie_b)
    group = ensure_group(cookie_b, ws["id"])
    node = ensure_node(cookie_b, ws["id"], group, ctx["password"])

    say("3/5 B 的真实 Agent + worker")
    ensure_agent_b(node)
    wait_state_report(node["agent_id"])
    ensure_worker_b(image, env_pairs)

    say("4/5 双向联邦信任")
    status_a, cookie_a, body_a = login(API_A, ctx["state"]["user"]["email"], ctx["password"])
    if status_a != 200 or not cookie_a:
        die(f"Panel A 管理员登录失败：{status_a} {json.dumps(body_a)[:200]}")
    trust = ensure_trust(cookie_a, cookie_b)

    say("5/5 完成")
    summary = {
        "api_a": API_A,
        "api_b": API_B,
        "db_b": DB_B,
        "redis_b": REDIS_B,
        "panel_b_container": PANEL_B,
        "worker_b_container": "wp14-worker-b",
        "agent_b_container": AGENT_B,
        "panel_b_admin": B_ADMIN_EMAIL,
        "workspace": {"id": ws["id"], "name": ws["name"]},
        "node_group": {"id": group["id"], "name": group["name"], "node_type": group.get("node_type")},
        "node": {"node_id": B_NODE_STR, "db_id": node["node_db_id"], "agent_id": node["agent_id"],
                 "connect_ip": node["connect_ip"], "reused": node["reused"]},
        **trust,
        "elapsed_seconds": int(time.monotonic() - START),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    print(f"[federation-b] OK（idempotent: node_reused={node['reused']} handshake={trust['handshake']}）", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
