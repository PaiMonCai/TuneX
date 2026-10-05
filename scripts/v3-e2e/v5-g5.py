#!/usr/bin/env python3
"""V5-G5 gate —— V5.5 两面板联邦（WP14 / WP15 / WP16）。

契约：`docs/v5-wp14-16-federation-contract.md`（§8 是场景映射）；清单：`DEVELOPMENT.md` §10.3。

真拓扑：**两个真实 Panel + 各自的真实 Agent**（Panel A = home，Panel B = host）。
Panel B 由 `scripts/v3-e2e/bootstrap-federation.py` 建立（独立库 `tunex_b` + 独立 Redis db）。
本门禁**不**用 mock、不写 skip：跑不动的原因会作为 FAIL 逐条打出来。

  G5.1  normal grant/use/revoke      建立租约 → host 侧真实 runtime → 撤销后停服且端口归还
  G5.2  credential rotate            轮转后新密钥可用、旧密钥宽限期内仍可验签、链路不中断
  G5.3  credential revoke            撤销后请求被拒、租约全部 revoke、两侧审计齐全
  G5.4  quota exhaustion             超容量被拒，且不产生任何端口/租约泄漏
  G5.5  lease expiry                 到期 host 主动停服；home 标 expired
  G5.6  Panel B offline              A 侧 fail-closed；不回落本地节点
  G5.7  Panel A offline              host 侧租约到期停服；A 回来后收敛
  G5.8  network partition            两侧各自 fail-closed（停/启真实容器）
  G5.9  duplicate messages           同 message_id 重放返回首次结果、不重复执行
  G5.10 reordered messages           旧 revision/epoch 不得覆盖新状态
  G5.11 partial failure              阶段失败 → 补偿释放端口，两侧无残留
  G5.12 reconnect reconcile          重连后按 (intent_id, revision) 收敛
  G5.13 cross-tenant isolation       另一 peer/workspace 不能消费他人 grant；用量不串租户
  G5.14 audit completeness           每个变更两侧各一条审计，含 peer_panel_id / message_id
  G5.15 usage                        用量去重 / 乱序 / 不补 0 / 无法归因不静默丢弃

跑法（必须在 `tunex-e2e` 容器里：容器间用容器名互通，且本机够不到宿主机发布端口）：

    tar -C /workspace/TuneX --exclude=node_modules --exclude=.git --exclude='Forwardx*' \
        -cf - . | docker exec -i tunex-e2e tar -C /repo -xf -
    docker exec -e API=http://panel:3000 tunex-e2e bash -lc \
        'cd /repo && python3 scripts/v3-e2e/v5-g5.py'

署名：用仓库正式工具 `scripts/v3-e2e/fed-sign.ts`（在**要发请求的那一侧面板容器**里跑），
不另造第二份签名实现。FAIL > 0 意味着 V5.5 未收口。
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import signal
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_harness():
    spec = importlib.util.spec_from_file_location("v5_g1a_harness", HERE / "v5-g1a.py")
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise SystemExit("cannot load scripts/v3-e2e/v5-g1a.py as the harness module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


H = _load_harness()

OUT = HERE / "evidence"
OUT.mkdir(exist_ok=True)
RESULT = OUT / "v5-g5-result.txt"

API_A = H.API
FED_PANEL_B_CANDIDATES = [
    os.environ.get("FED_PANEL_B_API", ""),
    "http://panel-b:3000",
    f"http://127.0.0.1:{os.environ.get('FED_PANEL_B_HOST_PORT', '18181')}",
]
API_B = (os.environ.get("FED_PANEL_B_API") or "http://panel-b:3000").rstrip("/")


def resolve_api_b() -> str:
    """Panel B 的可用地址：显式覆盖 → 容器网络别名 → 发布的宿主端口。

    三种跑法（容器内沙箱 / 容器内但别名不可用 / **宿主机上的 GitHub CI**）各自只有一种能通：
    宿主机解析不了 docker 的容器别名，容器里又够不到宿主机发布的端口。所以按顺序探，
    探不到就返回空 —— 让 setup 明确报"地址不可达"，而不是让后面每条断言各自超时。
    """
    for cand in FED_PANEL_B_CANDIDATES:
        if cand and http("GET", cand, "/healthz", timeout=5)[0] == 200:
            return cand.rstrip("/")
    return ""

PANEL_A = "wp14-panel"
PANEL_B = "wp14-panel-b"
AGENT_B = "wp14-agent-b1"
TARGET_A = "wp14-target-a"
MYSQL = "wp14-mysql"
DB_B = "tunex_b"
SIGNER_TS = "/tmp/fed-sign.ts"
DOC_ADMIN_BASE = "/api/admin/federation"  # 文档与 brief 写的挂载前缀（见 G5.0 的断言）

FIXTURE_PREFIX = f"V5-G5-{int(time.time())}"
# G5.13 的对照租户：一个**从不存在的第三个面板**。用一条只有 id 的 peer 行当"别人的租户"，
# 场景结束后必须删掉，否则它会一直堆在 B 的 federation_peer 里污染后续运行的计数。
FOREIGN_PEER = "11111111-2222-4333-8444-555555555555"
OVERALL_SECONDS = int(os.environ.get("G5_OVERALL_SECONDS", "5400"))
EXPIRE_WAIT = int(os.environ.get("G5_EXPIRE_WAIT", "240"))
START = time.monotonic()

MYSQL_ROOT_PW = H.parse_env(H.ENVF)["MYSQL_ROOT_PASSWORD"]

A_PANEL_ID = ""
B_PANEL_ID = ""
ADMIN_A = ""
ADMIN_B = ""
COOKIE_A = ""
COOKIE_B = ""
B_WS_ID = 0
B_GROUP_ID = 0
B_NODE_DB_ID = 0
B_NODE_STR = ""
B_NODE_IP = ""
CREATED_GRANTS: list[str] = []
CREATED_LEASES: list[str] = []
B_STOPPED = False
A_STOPPED = False


def check(condition, message, detail=""):
    H.record(bool(condition), message if condition or not detail else f"{message} [{detail}]")


def case(name: str, fn, seconds: int):
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        H.record(False, f"{name}: {type(exc).__name__}: {exc}")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


# ---------------------------------------------------------------------------
# HTTP / DB / 容器 helper
# ---------------------------------------------------------------------------

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


def req_b(method: str, path: str, body=None, cookie=None, headers=None, timeout: int = 60):
    return http(method, API_B, path, body, cookie if cookie is not None else COOKIE_B, headers, timeout)


def req_a(method: str, path: str, body=None, headers=None, timeout: int = 60):
    return http(method, API_A, path, body, COOKIE_A, headers, timeout)


def mysql_on(db_name: str, sql: str) -> str:
    return H.docker(["exec", MYSQL, "mysql", "-uroot", f"-p{MYSQL_ROOT_PW}", db_name, "-N", "-B", "-e", sql])


def scalar_b(sql: str) -> str:
    out = mysql_on(DB_B, sql).strip()
    return out.splitlines()[-1].strip() if out else ""


def scalar_a(sql: str) -> str:
    return H.scalar(sql)


def unwrap(value):
    return value.get("data", value) if isinstance(value, dict) else value


def as_list(value):
    value = unwrap(value)
    if isinstance(value, dict) and isinstance(value.get("data"), list):
        return value["data"]
    return value if isinstance(value, list) else []


def code_of(body) -> str:
    return str((body or {}).get("code", "")) if isinstance(body, dict) else ""


def is_federation_error(body) -> bool:
    """契约 §6 的统一错误体。用它判断"请求真的到达了联邦路由"，比看状态码可靠。"""
    return isinstance(body, dict) and isinstance(body.get("code"), str) and "correlation_id" in body


# ---------------------------------------------------------------------------
# 署名请求（仓库正式工具 fed-sign.ts）
# ---------------------------------------------------------------------------

def fed_sign_material(container: str, base: str, method: str, path: str, body=None,
                      message_id: str | None = None, ttl: int = 60, issued_offset: int = 0) -> dict:
    H.docker(["cp", str(HERE / "fed-sign.ts"), f"{container}:{SIGNER_TS}"], timeout=120)
    # 注意：H.docker 会自己补 "docker"，这里只给子命令（早期版本在这里多写了一个 docker，
    # 结果 stdout 恒为空、把 60 条断言读成了产品失败 —— 门禁自己的 bug 最贵）。
    cmd = ["docker", "exec", "-w", "/app", container, "bun", SIGNER_TS,
           "--url", base, "--method", method, "--path", path]
    if body is not None:
        cmd += ["--body", json.dumps(body, separators=(",", ":"))]
    if message_id:
        cmd += ["--message-id", message_id]
    cmd += ["--ttl", str(ttl), "--issued-offset", str(issued_offset)]
    p = subprocess.run(cmd, text=True, capture_output=True, timeout=180)
    out = (p.stdout or "").strip()
    if p.returncode != 0 or not out:
        return {"error": f"fed-sign 失败（container={container}）rc={p.returncode} "
                         f"stdout={out[:200]!r} stderr={(p.stderr or '')[:300]!r}"}
    try:
        return json.loads(out.splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {"error": f"fed-sign 未产出 JSON（container={container}）：{out[:300]}"}


def send_material(material: dict, timeout: int = 30):
    if not isinstance(material, dict) or "error" in material:
        return 0, {"error": material.get("error", "no material") if isinstance(material, dict) else "no material"}, {}
    method = material["method"]
    body = material.get("body", "") or ""
    data = body.encode() if method not in ("GET", "HEAD") and body else None
    req = urllib.request.Request(material["url"], data=data, method=method)
    for k, v in (material.get("headers") or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read().decode()
            return res.status, (json.loads(raw) if raw.strip() else {}), dict(res.headers)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            parsed = json.loads(raw) if raw.strip() else {}
        except Exception:  # noqa: BLE001
            parsed = {"raw": raw}
        return e.code, parsed, dict(e.headers)
    except (urllib.error.URLError, OSError) as e:
        return 0, {"error": str(e)}, {}


def fed_call(signer: str, target: str, method: str, path: str, body=None,
             message_id: str | None = None, ttl: int = 60, issued_offset: int = 0, timeout: int = 30):
    material = fed_sign_material(signer, target, method, path, body, message_id, ttl, issued_offset)
    return send_material(material, timeout)


# ---------------------------------------------------------------------------
# admin 路由发现（文档 / 挂载不一致时仍能跑，但会断言）
# ---------------------------------------------------------------------------

def admin_base(cookie: str, base: str) -> str:
    for candidate in (DOC_ADMIN_BASE, "/api/admin"):
        status, body, _ = http("GET", base, f"{candidate}/status", cookie=cookie)
        if status == 200 and isinstance(body, dict) and "active_leases" in body:
            return candidate
    return ""


def admin_paths(base: str) -> str:
    return ADMIN_A if base == API_A else ADMIN_B


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

def create_grant(peer_panel_id: str, scope: dict, capacity: dict, *,
                 expires_in_seconds: int = 3600, workspace_id=None, quota_reserved: bool = False):
    body = {
        "peer_panel_id": peer_panel_id,
        "scope": scope,
        "capacity": capacity,
        "expires_in_seconds": expires_in_seconds,
        "quota_reserved": quota_reserved,
    }
    if workspace_id is not None:
        body["workspace_id"] = workspace_id
    status, resp, _ = req_b("POST", f"{ADMIN_B}/grants", body)
    grant_ref = str((unwrap(resp) or {}).get("grant_ref") or "")
    if grant_ref:
        CREATED_GRANTS.append(grant_ref)
    return status, unwrap(resp)


def revoke_grant(grant_ref: str, reason: str = "gate_cleanup"):
    return req_b("POST", f"{ADMIN_B}/grants/{grant_ref}/revoke", {"reason": reason})


def intent(intent_id: str, revision: int = 1, hop_role: str = "egress", forward_ref: str | None = None,
           requested=None) -> dict:
    out = {
        "intent_id": intent_id,
        "revision": revision,
        "hop_role": hop_role,
        "forward_ref": forward_ref or f"{FIXTURE_PREFIX}-forward",
    }
    if requested is not None:
        out["requested"] = requested
    return out


def reserve(grant_ref: str, it: dict, *, message_id: str | None = None, signer: str = PANEL_A,
            ttl: int = 60, issued_offset: int = 0):
    return fed_call(signer, API_B, "POST", "/api/federation/v1/leases",
                    {"grant_ref": grant_ref, "intent": it}, message_id=message_id, ttl=ttl,
                    issued_offset=issued_offset)


def lease_row(ref: str) -> dict:
    raw = scalar_b(
        "SELECT CONCAT(state,'|',lease_epoch,'|',IFNULL(node_id,0),'|',IFNULL(listen_port,0),'|',"
        f"IFNULL(applied_revision,-1),'|',requested_revision) FROM federation_lease WHERE lease_ref='{ref}';"
    )
    if "|" not in raw:
        return {}
    state, epoch, node, port, applied, requested = raw.split("|")
    return {"state": state, "lease_epoch": int(epoch), "node_id": int(node), "port": int(port),
            "applied_revision": int(applied), "requested_revision": int(requested), "raw": raw}


def port_lease_status(node_id: int, port: int) -> str:
    return scalar_b(
        f"SELECT CONCAT(status,'|',IFNULL(tunnel_id,0)) FROM node_port_lease WHERE node_id={node_id} AND port={port};"
    )


def leases_for_grant(grant_ref: str) -> int:
    v = scalar_b(
        "SELECT COUNT(*) FROM federation_lease l JOIN federation_grant g ON g.id=l.grant_id "
        f"WHERE g.grant_ref='{grant_ref}';"
    )
    return int(v or 0)


def active_port_leases(node_id: int) -> int:
    return int(scalar_b(f"SELECT COUNT(*) FROM node_port_lease WHERE node_id={node_id} AND status='active';") or 0)


def release_lease(ref: str, it: dict, *, message_id: str | None = None):
    return fed_call(PANEL_A, API_B, "DELETE", f"/api/federation/v1/leases/{ref}",
                    {"intent_id": it["intent_id"], "revision": it["revision"]}, message_id=message_id)


def port_open_from(container: str, ip: str, port: int) -> tuple[bool, str]:
    """从数据网上的容器探测 host 节点监听端口是否真的在服务。"""
    out = H.docker(["exec", container, "sh", "-c",
                    f"nc -w 3 {ip} {port} </dev/null 2>&1 | head -c 64; echo"], allow=True, timeout=60)
    text = out.strip()
    return bool(text) and "refused" not in text.lower(), repr(text[:64])


def federation_audit_count(db_name: str, peer_panel_id: str) -> int:
    sql = ("SELECT COUNT(*) FROM audit_log WHERE action LIKE 'FEDERATION %' "
           f"AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.peer_panel_id'))='{peer_panel_id}';")
    out = mysql_on(db_name, sql).strip()
    return int(out.splitlines()[-1] or 0) if out else 0


def federation_audit_with_message(db_name: str, peer_panel_id: str) -> int:
    sql = ("SELECT COUNT(*) FROM audit_log WHERE action LIKE 'FEDERATION %' "
           f"AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.peer_panel_id'))='{peer_panel_id}' "
           "AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.message_id')) IS NOT NULL;")
    out = mysql_on(db_name, sql).strip()
    return int(out.splitlines()[-1] or 0) if out else 0


# ---------------------------------------------------------------------------
# setup / cleanup
# ---------------------------------------------------------------------------

def setup() -> None:
    global A_PANEL_ID, B_PANEL_ID, ADMIN_A, ADMIN_B, COOKIE_A, COOKIE_B
    global B_WS_ID, B_GROUP_ID, B_NODE_DB_ID, B_NODE_STR, B_NODE_IP

    H.mysql(f"UPDATE user SET super_admin=1 WHERE email='{H.EMAIL}';")
    status, COOKIE_A = H.login()
    check(status == 200 and COOKIE_A.startswith("access="), "G5.setup Panel A 管理员可登录",
          f"status={status}")

    check(bool(H.wait_until(lambda: http("GET", API_A, "/healthz", timeout=5)[0] == 200, timeout=60, interval=2)),
          "G5.setup Panel A 可达")
    # Panel B 的地址在 setup 时**重新解析**（见 resolve_api_b）：容器内跑走 `panel-b`，
    # 宿主机上跑（GitHub CI）只能走发布的宿主端口。硬编码一种就会在另一个世界里全红，
    # 而那种红看起来像产品故障 —— 正是最贵的一类误读。
    global API_B
    API_B = resolve_api_b()
    check(bool(API_B), "G5.setup Panel B 可达（先跑 bootstrap-federation.py）",
          f"试过 {FED_PANEL_B_CANDIDATES}")

    B_EMAIL = os.environ.get("FED_PANEL_B_ADMIN_EMAIL", "wp14-e2e-b@tunex.local")
    st, _body_login, set_cookie = http("POST", API_B, "/api/auth/login",
                                       {"email": B_EMAIL, "password": H.PW})
    COOKIE_B = (set_cookie or "").split(";", 1)[0]
    check(st == 200 and bool(COOKIE_B), "G5.setup Panel B 管理员可登录", f"status={st}")

    # G5.0：文档写的挂载前缀 vs 实际挂载前缀。这不是「风格问题」：按文档调用会 404。
    # 必须用**B 自己的**会话探测 B（A 的 cookie 到了 B 上是未认证，只会得到 401，
    # 那是假阴性 —— 门禁自己的 bug 不该读成产品结论）。
    status_doc, body_doc, _h = http("GET", API_B, f"{DOC_ADMIN_BASE}/status", cookie=COOKIE_B)
    check(status_doc == 200 and isinstance(body_doc, dict) and "active_leases" in body_doc,
          "G5.0 federation admin endpoints live at the documented prefix",
          f"GET {DOC_ADMIN_BASE}/status -> {status_doc} {json.dumps(body_doc)[:120]}")

    ADMIN_A = admin_base(COOKIE_A, API_A)
    ADMIN_B = admin_base(COOKIE_B, API_B)
    check(bool(ADMIN_A) and bool(ADMIN_B), "G5.setup 两个面板的联邦 admin 路由可发现",
          f"A={ADMIN_A} B={ADMIN_B}")
    if not (ADMIN_A and ADMIN_B):
        return

    check(ADMIN_B == DOC_ADMIN_BASE, "G5.0b 联邦 admin 路由挂载在文档写的前缀上",
          f"文档={DOC_ADMIN_BASE} 实际={ADMIN_B}（app.ts 把 admin-federation 挂在 /api/admin）")

    _sa, body_a, _ = http("GET", API_A, f"{ADMIN_A}/status", cookie=COOKIE_A)
    _sb, body_b2, _ = http("GET", API_B, f"{ADMIN_B}/status", cookie=COOKIE_B)
    A_PANEL_ID = str((body_a or {}).get("panel_id") or "")
    B_PANEL_ID = str((body_b2 or {}).get("panel_id") or "")
    check(bool(A_PANEL_ID) and bool(B_PANEL_ID) and A_PANEL_ID != B_PANEL_ID,
          "G5.setup 两个面板有各自稳定且不同的 panel_id",
          f"A={A_PANEL_ID[:8]} B={B_PANEL_ID[:8]}")
    check(bool((body_a or {}).get("enabled")) and bool((body_b2 or {}).get("enabled")),
          "G5.setup 两个面板的联邦开关都已开启",
          f"A.enabled={(body_a or {}).get('enabled')} B.enabled={(body_b2 or {}).get('enabled')}")

    # 双向信任
    _sa, peers_a, _ = http("GET", API_A, f"{ADMIN_A}/peers", cookie=COOKIE_A)
    _sb, peers_b, _ = http("GET", API_B, f"{ADMIN_B}/peers", cookie=COOKIE_B)
    row_a = next((p for p in as_list(unwrap(peers_a)) if p.get("peer_panel_id") == B_PANEL_ID), {})
    row_b = next((p for p in as_list(unwrap(peers_b)) if p.get("peer_panel_id") == A_PANEL_ID), {})
    check(row_a.get("status") == "trusted", "G5.setup A 信任 B", json.dumps(row_a)[:200])
    check(row_b.get("status") == "trusted", "G5.setup B 信任 A", json.dumps(row_b)[:200])
    # 契约 §2.2：握手后两侧都要持有对方的**可拨号地址**，否则反向调用必然 peer_unreachable。
    check(bool(row_a.get("endpoint_url")), "G5.setup A 记录了 B 的 endpoint_url", str(row_a.get("endpoint_url")))
    check(bool(row_b.get("endpoint_url")), "G5.setup B 记录了 A 的 endpoint_url（B 才能回呼 A）",
          f"endpoint_url={row_b.get('endpoint_url')!r} — performHandshake 发 ''，handleHandshake 又原样覆盖")

    # B 侧 fixture
    B_NODE_STR = os.environ.get("FED_PANEL_B_NODE_ID", "WP14-B1-OUT")
    row = scalar_b(f"SELECT CONCAT(id,'|',IFNULL(connect_ip,'')) FROM node WHERE node_id='{B_NODE_STR}';")
    if "|" in row:
        B_NODE_DB_ID, B_NODE_IP = int(row.split("|")[0]), row.split("|")[1]
    B_WS_ID = int(scalar_b("SELECT id FROM workspace WHERE name='WP14-B Primary' ORDER BY id LIMIT 1;") or 0)
    B_GROUP_ID = int(scalar_b("SELECT id FROM node_group WHERE name='WP14-B Egress' ORDER BY id LIMIT 1;") or 0)
    check(B_NODE_DB_ID > 0 and bool(B_NODE_IP), "G5.setup B 的 concrete Node 存在", f"id={B_NODE_DB_ID} ip={B_NODE_IP}")
    check(B_WS_ID > 0 and B_GROUP_ID > 0, "G5.setup B 的 workspace / NodeGroup 存在",
          f"ws={B_WS_ID} group={B_GROUP_ID}")
    check(bool(H.wait_until(lambda: scalar_b(
        "SELECT COUNT(*) FROM node_state_report s JOIN node n ON n.id=s.node_id "
        f"WHERE n.node_id='{B_NODE_STR}' AND s.reported_at > NOW() - INTERVAL 2 MINUTE;") not in ("", "0"),
        timeout=120, interval=4)), "G5.setup B 的真实 Agent 在报状态（节点在线）")

    # 预检：Forward 级场景依赖新迁移的列。缺失时必须在**开跑前**说清楚，
    # 而不是让 A 的 panel 在创建 Forward 时抛 P2022 把整轮读数污染掉。
    for label, dbx in (("A", H.parse_env(H.ENVF).get("MYSQL_DATABASE", "tunex")), ("B", DB_B)):
        col = mysql_on(dbx, "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() "
                            "AND table_name='tunnel' AND column_name='federated_egress_peer';")
        check(col.strip().splitlines()[-1] in ("1",) if col.strip() else False,
              f"G5.setup {label} 侧已 apply 迁移 20261025000000（tunnel.federated_egress_peer 存在）",
              f"got={col.strip() or 'none'} — A 侧需先跑 compose run --rm db-migrate")

    # 署名工具可用性：解封私钥必须成功（AUTH_SECRET 不匹配要 fail-closed 报错，而不是静默重建）
    for container, base, who in ((PANEL_A, API_A, "A"), (PANEL_B, API_B, "B")):
        material = fed_sign_material(container, base, "POST", "/api/federation/v1/whoami", {})
        check("error" not in material, f"G5.setup {who} 面板能用产品自己的签名工具产出署名请求",
              str(material)[:200])

    # 端点存在性（契约 §3.2 / §4.1）。注意 must be a REAL response：status=0 表示
    # 门禁自己发不出请求（例如签名工具坏了），绝不能算成"端点存在"。
    # 端点存在性的判据是**联邦错误体**（code + correlation_id），不是裸 HTTP 状态：
    # 一个不存在的 grant 会得到 404 grant_not_found —— 那恰恰证明路由在。
    # 用**形状非法**的 intent 探路由（不产生任何副作用）。
    # 曾经用"不存在的 grant_ref"来探 —— 结果发现 host 会把显式给错/给不存在的 grant_ref
    # **静默忽略**并回落到"该 peer 唯一一条 active grant"，于是这条探测真地预留了一条租约
    # （留下孤儿端口）。探针不该有副作用；那条回落行为本身另记一条 FINDING（见汇报）。
    st_leases, body_leases, _ = fed_call(PANEL_A, API_B, "POST", "/api/federation/v1/leases",
                                         {"grant_ref": "V5-G5-no-such-grant",
                                          "intent": {"intent_id": "", "revision": -1, "hop_role": "nope",
                                                     "forward_ref": ""}})
    check(is_federation_error(body_leases), "G5.0c POST /api/federation/v1/leases 已挂载且可达",
          f"status={st_leases} body={json.dumps(body_leases)[:200]}")
    material_apply = fed_sign_material(PANEL_A, API_B, "POST", "/api/federation/v1/leases/no-such-lease/apply",
                                       {"intent_id": "probe", "revision": 1,
                                        "link": {"protocol": "tcp", "targets": [{"host": "target-a", "port": 3030}]}})
    st_apply, body_apply, _ = send_material(material_apply)
    check(is_federation_error(body_apply), "G5.0d POST /api/federation/v1/leases/:ref/apply 已挂载且可达（契约 §3.2 阶段 2）",
          f"status={st_apply} body={json.dumps(body_apply)[:160]}")
    material_renew = fed_sign_material(PANEL_A, API_B, "POST", "/api/federation/v1/leases/no-such-lease/renew", {})
    st_renew, body_renew, _ = send_material(material_renew)
    check(is_federation_error(body_renew), "G5.0e POST /api/federation/v1/leases/:ref/renew 已挂载且可达",
          f"status={st_renew} body={json.dumps(body_renew)[:160]}")


def cleanup() -> None:
    try:
        if A_STOPPED:
            H.docker(["start", PANEL_A], allow=True, timeout=180)
        if B_STOPPED:
            H.docker(["start", PANEL_B], allow=True, timeout=180)
    except Exception as exc:  # noqa: BLE001
        H.record(False, f"G5.cleanup 恢复被本门禁停掉的容器失败: {type(exc).__name__}: {exc}")

    # Forward 级 fixture：先删 Forward（走产品自己的释放路径），再清它留下的 placement 行。
    db_a = H.parse_env(H.ENVF).get("MYSQL_DATABASE", "tunex")
    for tid in list(FED_FORWARD_IDS):
        try:
            H.req("DELETE", f"/api/forwards/{tid}", None, timeout=120)
        except Exception:  # noqa: BLE001
            pass
    # placement 行按**创建过的名单**清（含场景自己删掉 Forward 的那些），
    # 不再依赖"此刻还在 FED_FORWARD_IDS 里" —— 那正是上一轮留下 11 行终态残留的原因。
    try:
        if FED_FORWARD_ALL:
            ids = ",".join(str(int(t)) for t in FED_FORWARD_ALL)
            mysql_on(db_a, f"DELETE FROM federation_placement WHERE tunnel_id IN ({ids});")
    except Exception:  # noqa: BLE001
        pass
    # 兜底：按名字清掉本门禁留下的 Forward 行（例如创建成功但响应丢失的情况）
    try:
        mysql_on(db_a, f"DELETE FROM federation_placement WHERE forward_ref IN "
                       f"(SELECT CONCAT('fw-', id) FROM tunnel WHERE name LIKE '{FIXTURE_PREFIX}%');")
        mysql_on(db_a, f"DELETE FROM tunnel WHERE name LIKE '{FIXTURE_PREFIX}%';")
    except Exception:  # noqa: BLE001
        pass
    # 孤儿历史清扫：终态 placement 指向一条**已经不存在的** tunnel，且 forward_ref 是
    # 这个门禁的 `fw-<数字>` 形状 —— 那是历次运行留下的残留，不是任何现存 Forward 的状态。
    # 不扫这一步，"11 行历史 expired"会一直混进证据里（Lead 明确指出要收干净）。
    try:
        mysql_on(db_a,
                 "DELETE p FROM federation_placement p LEFT JOIN tunnel t ON t.id = p.tunnel_id "
                 "WHERE p.state IN ('expired','revoked') AND t.id IS NULL "
                 "AND p.forward_ref REGEXP '^fw-[0-9]+$';")
    except Exception:  # noqa: BLE001
        pass

    # 远端租约：按 fixture 名单扫一遍 B 侧（含创建失败时留下的 reserved 行 —— 那是产品补偿
    # 没走的路径，门禁自己不能因此把端口留在对端）
    for tid in list(FED_FORWARD_ALL):
        try:
            refs = mysql_on(DB_B, f"SELECT lease_ref FROM federation_lease WHERE forward_ref='fw-{tid}' "
                                  "AND state IN ('reserved','active','releasing');")
            for ref in [r.strip() for r in refs.splitlines() if r.strip()]:
                fed_call(PANEL_A, API_B, "DELETE", f"/api/federation/v1/leases/{ref}",
                         {"intent_id": f"fw-{tid}", "revision": 1, "reason": "gate_cleanup"}, timeout=20)
                if ref not in CREATED_LEASES:
                    CREATED_LEASES.append(ref)
        except Exception:  # noqa: BLE001
            pass
    for ref in list(CREATED_LEASES):
        try:
            fed_call(PANEL_A, API_B, "DELETE", f"/api/federation/v1/leases/{ref}", {"reason": "gate_cleanup"},
                     timeout=20)
        except Exception:  # noqa: BLE001
            pass
    for ref in list(CREATED_GRANTS):
        try:
            revoke_grant(ref, "gate_cleanup")
        except Exception:  # noqa: BLE001
            pass

    # 信任被本门禁（G5.3）撤销后，产品目前的路径无法用新 token 重建（见 G5.3 的断言）。
    # 为了让下一次运行仍然从一个可用的拓扑开始，这里做**夹具复位**（只清 peer 行，不碰断言）：
    #   1) 删掉两侧 revoked / pending 的 peer 行（连同其一次性凭据，FK cascade）；
    #   2) 重新跑 bootstrap-federation.py，用真实邀请 + 握手把信任建回来。
    try:
        mysql_on(DB_B, f"DELETE FROM federation_peer WHERE peer_panel_id='{FOREIGN_PEER}';")
        for db_name in (H.parse_env(H.ENVF).get("MYSQL_DATABASE", "tunex"), DB_B):
            mysql_on(db_name, "DELETE FROM federation_peer WHERE status IN ('revoked','pending');")
        H.run(["docker", "exec", "-e", "API=http://panel:3000", "tunex-e2e", "bash", "-lc",
               "cd /repo && FED_SKIP_BUILD=1 python3 scripts/v3-e2e/bootstrap-federation.py"],
              allow=True, timeout=600)
    except Exception as exc:  # noqa: BLE001
        H.record(False, f"G5.cleanup 恢复联邦信任失败: {type(exc).__name__}: {exc}")


# ---------------------------------------------------------------------------
# G5.1 normal grant / use / revoke
# ---------------------------------------------------------------------------

def g5_1_normal_grant_use_revoke():
    global A_PANEL_ID
    if not (A_PANEL_ID and B_NODE_DB_ID):
        H.record(False, "G5.1 前置缺失（panel_id / B 节点未就绪），本条无法执行")
        return
    fwd = f"{FIXTURE_PREFIX}-normal"
    status, grant = create_grant(
        A_PANEL_ID,
        {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 5, "max_bandwidth_mbps": None, "max_connections": None},
        workspace_id=B_WS_ID,
    )
    check(status in (200, 201), "G5.1 host(B) 给 home(A) 签发 grant", f"status={status} body={json.dumps(grant)[:200]}")
    grant_ref = str((grant or {}).get("grant_ref") or "")
    if not grant_ref:
        return

    it = intent(f"{FIXTURE_PREFIX}-normal-1", 1, "egress", fwd)
    ports_before = active_port_leases(B_NODE_DB_ID)
    status, body, _ = reserve(grant_ref, it)
    check(status == 200, "G5.1 A 持 grant 预留远端租约（阶段 1）",
          f"status={status} body={json.dumps(body)[:220]}")
    ref = str((body or {}).get("lease_ref") or "")
    if not ref:
        return
    CREATED_LEASES.append(ref)

    check((body or {}).get("state") == "reserved", "G5.1 阶段 1 落在 reserved", json.dumps(body)[:200])
    check(int((body or {}).get("port") or 0) > 0, "G5.1 返回了具体端口", json.dumps(body)[:200])
    check(str((body or {}).get("node_ref") or "") == str(B_NODE_DB_ID), "G5.1 返回了 host 侧具体 node_ref",
          json.dumps(body)[:200])

    row = lease_row(ref)
    check(row.get("state") == "reserved" and row.get("node_id") == B_NODE_DB_ID,
          "G5.1 host 侧权威行存在且归到自己的节点", json.dumps(row))
    check(port_lease_status(B_NODE_DB_ID, row.get("port", 0)).startswith("active"),
          "G5.1 端口占用走的是 NodePortLease（唯一真相）",
          f"node_port_lease={port_lease_status(B_NODE_DB_ID, row.get('port', 0))}")
    check(active_port_leases(B_NODE_DB_ID) == ports_before + 1,
          "G5.1 恰好多占用一个端口", f"{ports_before} -> {active_port_leases(B_NODE_DB_ID)}")

    # 阶段 2：apply —— 只有它能让 host 侧出现**真实 runtime**。
    # 这里是**契约 §3.2 冻结的形状**（`link` 里面带 targets/protocol）：不复验别名形状，
    # 因为别名只是历史兼容，契约形状才是别的面板会实现的接口。
    targets = [{"host": "target-a", "port": 3030, "weight": 1}]
    status_apply, body_apply, _ = fed_call(
        PANEL_A, API_B, "POST", f"/api/federation/v1/leases/{ref}/apply",
        {"intent_id": it["intent_id"], "revision": it["revision"],
         "link": {"protocol": "tcp", "targets": targets}},
    )
    check(status_apply == 200, "G5.1 阶段 2 接受契约 §3.2 的请求形状（{intent_id, revision, link}）",
          f"status={status_apply} body={json.dumps(body_apply)[:220]}")
    check(status_apply == 200, "G5.1 阶段 2 apply 成功（host 用自己的 orchestrator 下发）",
          f"status={status_apply} body={json.dumps(body_apply)[:200]}")
    if status_apply == 200:
        row_active = lease_row(ref)
        check(row_active.get("state") == "active" and row_active.get("applied_revision") == 1,
              "G5.1 apply 后 host 侧 state=active 且 applied_revision 落库", json.dumps(row_active))
        runtime = f"tunex-fed-{ref}"
        reported = scalar_b(
            "SELECT IFNULL(tunnels,'[]') FROM node_state_report s JOIN node n ON n.id=s.node_id "
            f"WHERE n.node_id='{B_NODE_STR}';"
        )
        check(bool(H.wait_until(lambda: ref in scalar_b(
            "SELECT IFNULL(tunnels,'[]') FROM node_state_report s JOIN node n ON n.id=s.node_id "
            f"WHERE n.node_id='{B_NODE_STR}';"), timeout=120, interval=6)),
            "G5.1 host 侧**真实 runtime** 出现在节点自己的上报里", f"runtime≈{runtime} report={reported[:120]}")
        opened, detail = port_open_from(TARGET_A, B_NODE_IP, row.get("port", 0))
        check(opened, "G5.1 该端口在数据面上真的在服务", detail)

    # 撤销：grant revoke → 级联停服 + 归还端口
    status_rev, body_rev, _ = revoke_grant(grant_ref, "g5_normal_revoke")
    check(status_rev in (200, 201), "G5.1 host 撤销 grant", f"status={status_rev} {json.dumps(body_rev)[:160]}")
    after = lease_row(ref)
    check(after.get("state") == "revoked", "G5.1 撤销后租约立即 revoked（fail-closed）", json.dumps(after))
    if row.get("port"):
        check(port_lease_status(B_NODE_DB_ID, row["port"]).startswith("released"),
              "G5.1 撤销后端口归还（node_port_lease 置 released）",
              f"port={row['port']} {port_lease_status(B_NODE_DB_ID, row['port'])}")
        check(active_port_leases(B_NODE_DB_ID) == ports_before,
              "G5.1 没有端口泄漏", f"{ports_before} -> {active_port_leases(B_NODE_DB_ID)}")
        if status_apply == 200:
            closed, detail = port_open_from(TARGET_A, B_NODE_IP, row["port"])
            check(not closed, "G5.1 撤销后 host 侧监听真的停掉了", detail)


# ---------------------------------------------------------------------------
# G5.2 credential rotate
# ---------------------------------------------------------------------------

def g5_2_credential_rotate():
    if not (A_PANEL_ID and ADMIN_A):
        H.record(False, "G5.2 前置缺失，本条无法执行")
        return
    grant_ref = ""
    status, grant = create_grant(
        A_PANEL_ID, {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 3}, workspace_id=B_WS_ID,
    )
    grant_ref = str((grant or {}).get("grant_ref") or "")
    it = intent(f"{FIXTURE_PREFIX}-rotate-1", 1, "egress", f"{FIXTURE_PREFIX}-rotate")
    status_r, body_r, _ = reserve(grant_ref, it)
    ref = str((body_r or {}).get("lease_ref") or "")
    if ref:
        CREATED_LEASES.append(ref)
    row_before = lease_row(ref) if ref else {}

    # 用**旧密钥**预签一条请求（轮转之后再发出去）——这是"宽限期内旧密钥仍可验签"的唯一真实证据。
    old_message_id = f"{FIXTURE_PREFIX}-oldkey"
    material_old = fed_sign_material(PANEL_A, API_B, "POST", "/api/federation/v1/ping", {},
                                     message_id=old_message_id)
    check("error" not in material_old, "G5.2 轮转前能用旧密钥签出请求", str(material_old)[:160])

    status_key, body_key, _ = req_a("GET", f"{ADMIN_A}/status")
    old_key_id = str((body_key or {}).get("key_id") or "")
    status_rot, body_rot, _ = req_a("POST", f"{ADMIN_A}/key/rotate", {})
    check(status_rot in (200, 201), "G5.2 A 轮转本机密钥（先通知 peer，再切换）",
          f"status={status_rot} {json.dumps(body_rot)[:180]}")
    status_key2, body_key2, _ = req_a("GET", f"{ADMIN_A}/status")
    new_key_id = str((body_key2 or {}).get("key_id") or "")
    check(bool(new_key_id) and new_key_id != old_key_id, "G5.2 key_id 真的换新",
          f"{old_key_id[:12]}… -> {new_key_id[:12]}…")

    _s, peers_b, _ = http("GET", API_B, f"{ADMIN_B}/peers", cookie=COOKIE_B)
    row_peer = next((p for p in as_list(unwrap(peers_b)) if p.get("peer_panel_id") == A_PANEL_ID), {})
    key_ids = row_peer.get("key_ids") or []
    check(new_key_id in key_ids, "G5.2 B 侧接受了 A 的新公钥", json.dumps(key_ids)[:160])
    check(old_key_id in key_ids, "G5.2 B 侧把旧公钥留在集合里（进入 retiring 宽限）", json.dumps(key_ids)[:160])
    states = scalar_b(
        "SELECT IFNULL(public_keys,'[]') FROM federation_peer "
        f"WHERE peer_panel_id='{A_PANEL_ID}';"
    )
    check("retiring" in states and "not_after" in states,
          "G5.2 旧公钥被标为 retiring 且带 not_after（宽限期）", states[:200])

    # 宽限期证据：**用旧密钥签的**请求在轮转之后仍然被接受
    status_old, body_old, _ = send_material(material_old)
    check(status_old == 200, "G5.2 轮转后旧密钥签名的请求在宽限期内仍被接受",
          f"status={status_old} body={json.dumps(body_old)[:160]}")

    # 新密钥可用
    status_new, body_new, _ = fed_call(PANEL_A, API_B, "POST", "/api/federation/v1/ping", {})
    check(status_new == 200, "G5.2 轮转后新密钥可用（链路不中断）",
          f"status={status_new} body={json.dumps(body_new)[:160]}")

    if ref and row_before:
        after = lease_row(ref)
        check(after.get("state") == row_before.get("state") and after.get("lease_epoch") == row_before.get("lease_epoch"),
              "G5.2 轮转不影响既有租约（状态与 epoch 不变）",
              f"{json.dumps(row_before)} -> {json.dumps(after)}")


# ---------------------------------------------------------------------------
# G5.3 credential revoke（信任撤销）
# ---------------------------------------------------------------------------

def g5_3_credential_revoke():
    if not (A_PANEL_ID and ADMIN_A):
        H.record(False, "G5.3 前置缺失，本条无法执行")
        return
    grant_ref = ""
    status, grant = create_grant(
        A_PANEL_ID, {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 3}, workspace_id=B_WS_ID,
    )
    grant_ref = str((grant or {}).get("grant_ref") or "")
    ref = ""
    status_r, body_r = 0, {}
    it = intent(f"{FIXTURE_PREFIX}-revoke-1", 1, "egress", f"{FIXTURE_PREFIX}-revoke")
    if grant_ref:
        status_r, body_r, _ = reserve(grant_ref, it)
        ref = str((body_r or {}).get("lease_ref") or "")
        if ref:
            CREATED_LEASES.append(ref)
    # 让这条链路**真的在服务**，这样"撤销后立即停服"验的是真实 runtime 消失，
    # 而不是"一条从未 apply 过的 reserved 行的状态字段"。
    lease_port = int((body_r or {}).get("port") or 0)
    if ref:
        st_ap, body_ap, _ = fed_call(
            PANEL_A, API_B, "POST", f"/api/federation/v1/leases/{ref}/apply",
            {"intent_id": it["intent_id"], "revision": it["revision"],
             "link": {"protocol": "tcp", "targets": [{"host": "target-a", "port": 3030, "weight": 1}]}},
        )
        check(st_ap == 200 and lease_row(ref).get("state") == "active",
              "G5.3 撤销前先让远端链路真的 active（否则停服断言没有对象）",
              f"apply_status={st_ap} body={json.dumps(body_ap)[:180]} row={json.dumps(lease_row(ref))}")
    check(bool(ref), "G5.3 撤销前先建立一条真实租约（否则级联断言没有对象）",
          f"grant_ref={grant_ref!r} lease_ref={ref!r} reserve_status={status_r} "
          f"reserve_body={json.dumps(body_r)[:200]}")

    # 两侧都可能以 A 或 B 的 panel_id 记账（inbound 用发起方，local 用对端），两个都要数。
    db_a_name = H.parse_env(H.ENVF).get("MYSQL_DATABASE", "tunex")

    def audit_total(db_name: str) -> int:
        return federation_audit_count(db_name, A_PANEL_ID) + federation_audit_count(db_name, B_PANEL_ID)

    audit_a_before = audit_total(db_a_name)
    audit_b_before = audit_total(DB_B)

    _s, peers_a, _ = http("GET", API_A, f"{ADMIN_A}/peers", cookie=COOKIE_A)
    row_a = next((p for p in as_list(unwrap(peers_a)) if p.get("peer_panel_id") == B_PANEL_ID), {})
    peer_id = row_a.get("id")
    check(peer_id is not None, "G5.3 找到 A 侧 B 的 peer 行", json.dumps(row_a)[:160])
    if peer_id is None:
        return

    # 契约 §2.4：撤销**不可逆**、旧 key 不得复活。证据就是"撤销前签好的请求，在重建信任后被拒"。
    # TTL 用 300s（协议上限），让整段 revoke → rotate → 重新握手都落在签名有效期内。
    old_key_material = fed_sign_material(PANEL_A, API_B, "POST", "/api/federation/v1/ping", {},
                                         message_id=f"{FIXTURE_PREFIX}-pre-revoke-key", ttl=300)
    check("error" not in old_key_material,
          "G5.3 撤销前用当时的密钥签出一条请求（待会用它验旧密钥不复活）", str(old_key_material)[:160])

    t_revoke = time.monotonic()
    status_rev, body_rev, _ = req_a("DELETE", f"{ADMIN_A}/peers/{peer_id}")
    check(status_rev in (200, 201), "G5.3 A 撤销对 B 的信任", f"status={status_rev} {json.dumps(body_rev)[:160]}")

    _s, peers_a2, _ = http("GET", API_A, f"{ADMIN_A}/peers", cookie=COOKIE_A)
    row_a2 = next((p for p in as_list(unwrap(peers_a2)) if p.get("peer_panel_id") == B_PANEL_ID), {})
    check(row_a2.get("status") == "revoked", "G5.3 A 侧 peer 置 revoked", json.dumps(row_a2)[:160])

    check(bool(H.wait_until(lambda: next(
        (p for p in as_list(unwrap(http("GET", API_B, f"{ADMIN_B}/peers", cookie=COOKIE_B)[1])) if
         p.get("peer_panel_id") == A_PANEL_ID), {}).get("status") == "revoked", timeout=60, interval=4)),
        "G5.3 撤销**双向**生效（B 侧也被通知并置 revoked）")

    status_after, body_after, _ = fed_call(PANEL_A, API_B, "POST", "/api/federation/v1/ping", {})
    check(status_after in (401, 403) and code_of(body_after) in ("peer_revoked", "peer_unknown"),
          "G5.3 撤销后 A→B 的请求被拒（fail-closed，且错误码可解释）",
          f"status={status_after} code={code_of(body_after)} body={json.dumps(body_after)[:160]}")

    if ref:
        row = lease_row(ref)
        check(row.get("state") == "revoked", "G5.3 撤销信任级联把租约置 revoked", json.dumps(row))
        if row.get("port"):
            # 契约 §2.4 要的是"撤销后**立即**停止相关链路（不等租约到期）"。
            # 第一轮这里曾经只能靠 worker 的下一拍（实测 26s），因此被放宽成"允许传播延迟"的等待；
            # 修复④把 ensureFederationWiring() 也接进了 panel 进程，所以现在要求**秒级**：
            # 5s 内端口必须归还、监听必须消失。达不到就是 FAIL，并把实测延迟写出来。
            port = row["port"]
            released5 = H.wait_until(
                lambda: port_lease_status(B_NODE_DB_ID, port).startswith("released"),
                timeout=5, interval=1)
            elapsed = time.monotonic() - t_revoke
            if not released5:
                # 只为把"最终花了多久"测出来写进证据（不再放宽断言本身）。
                H.wait_until(lambda: port_lease_status(B_NODE_DB_ID, port).startswith("released"),
                             timeout=90, interval=3)
                elapsed = time.monotonic() - t_revoke
            check(released5, "G5.3 撤销后 5s 内端口归还（panel 进程的撤销钩子，不等 worker 下一拍）",
                  f"port={port} state={port_lease_status(B_NODE_DB_ID, port)} 实测延迟≈{elapsed:.2f}s"
                  + ("（>5s：仍靠 worker sweep）" if not released5 else ""))
            if lease_port:
                closed5 = H.wait_until(lambda: not port_open_from(TARGET_A, B_NODE_IP, lease_port)[0],
                                       timeout=5, interval=1)
                check(closed5, "G5.3 撤销后 5s 内 host 侧监听消失（有真实 runtime 时验的是它）",
                      f"port={lease_port} 实测≈{time.monotonic() - t_revoke:.2f}s")

    audit_a_after = audit_total(db_a_name)
    audit_b_after = audit_total(DB_B)
    check(audit_a_after > audit_a_before, "G5.3 撤销在 A 侧留了联邦审计",
          f"{audit_a_before} -> {audit_a_after}")
    check(audit_b_after > audit_b_before, "G5.3 撤销在 B 侧留了联邦审计（inbound 通知）",
          f"{audit_b_before} -> {audit_b_after}")

    # 契约 §2.4：撤销不可逆，但"重新信任必须重新走带外 token" —— 走一次真实路径看它到底行不行。
    if grant_ref:
        revoke_grant(grant_ref, "g5_revoke_cleanup")
    status_inv, invitation, _ = req_b(
        "POST", f"{ADMIN_B}/peers/invite",
        {"display_name": "Panel A (retry)", "endpoint_url": API_A, "ttl_seconds": 900})
    token = str((unwrap(invitation) or {}).get("token") or "")
    check(status_inv in (200, 201) and bool(token), "G5.3 撤销后 B 仍能签发新的带外邀请",
          f"status={status_inv}")
    if token:
        # 撤销后先轮转本机密钥：这样"重建信任后的 peer 公钥"必然与撤销前那把不同，
        # 旧签名的失败原因才只可能是 key_unknown（而不是 message_expired 之类的噪声）。
        st_rot, body_rot, _ = req_a("POST", f"{ADMIN_A}/key/rotate", {})
        check(st_rot in (200, 201), "G5.3 撤销期间本机密钥可以轮转（没有 trusted peer 时不该卡住）",
              f"status={st_rot} body={json.dumps(body_rot)[:160]}")

        status_hs, body_hs, _ = req_a(
            "POST", f"{ADMIN_A}/peers/handshake",
            {"endpoint_url": API_B, "token": token, "display_name": "Panel B (retry)"})
        check(status_hs in (200, 201), "G5.3 撤销后**重新走带外 token 可以重建信任**（契约 §2.4）",
              f"status={status_hs} body={json.dumps(body_hs)[:200]}")

        if status_hs in (200, 201):
            _s, peers_b2, _ = http("GET", API_B, f"{ADMIN_B}/peers", cookie=COOKIE_B)
            row_b2 = next((p for p in as_list(unwrap(peers_b2))
                           if p.get("peer_panel_id") == A_PANEL_ID and p.get("status") == "trusted"), {})
            check(bool(row_b2), "G5.3 重建后 B 侧只有一条 trusted 行持有真实 panel_id",
                  json.dumps(row_b2)[:200])
            status_newkey, body_newkey, _ = fed_call(PANEL_A, API_B, "POST", "/api/federation/v1/ping", {})
            check(status_newkey == 200, "G5.3 重建信任后新密钥立刻可用",
                  f"status={status_newkey} body={json.dumps(body_newkey)[:160]}")
            status_oldkey, body_oldkey, _ = send_material(old_key_material)
            check(status_oldkey in (401, 403) and code_of(body_oldkey) == "key_unknown",
                  "G5.3 撤销前那把旧密钥**不复活**（重建信任只写新公钥）",
                  f"status={status_oldkey} code={code_of(body_oldkey)} body={json.dumps(body_oldkey)[:200]}")


# ---------------------------------------------------------------------------
# G5.4 quota exhaustion
# ---------------------------------------------------------------------------

def g5_4_quota_exhaustion():
    if not (A_PANEL_ID and B_NODE_DB_ID):
        H.record(False, "G5.4 前置缺失，本条无法执行")
        return
    status, grant = create_grant(
        A_PANEL_ID, {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 1}, workspace_id=B_WS_ID,
    )
    grant_ref = str((grant or {}).get("grant_ref") or "")
    if not grant_ref:
        H.record(False, "G5.4 无法签发 max_legs=1 的 grant", f"status={status}")
        return
    it1 = intent(f"{FIXTURE_PREFIX}-quota-1", 1, "egress", f"{FIXTURE_PREFIX}-quota")
    status1, body1, _ = reserve(grant_ref, it1)
    ref1 = str((body1 or {}).get("lease_ref") or "")
    if ref1:
        CREATED_LEASES.append(ref1)
    check(status1 == 200, "G5.4 容量内的第一条租约成功", f"status={status1} {json.dumps(body1)[:160]}")

    leases_before = leases_for_grant(grant_ref)
    ports_before = active_port_leases(B_NODE_DB_ID)

    it2 = intent(f"{FIXTURE_PREFIX}-quota-2", 1, "egress", f"{FIXTURE_PREFIX}-quota")
    status2, body2, _ = reserve(grant_ref, it2)
    check(status2 in (403, 409, 429), "G5.4 超容量被拒",
          f"status={status2} body={json.dumps(body2)[:220]}")
    check(code_of(body2) == "quota_exhausted", "G5.4 拒绝码是 quota_exhausted（不是 500）",
          f"code={code_of(body2)} body={json.dumps(body2)[:200]}")
    check("retryable" in (body2 or {}), "G5.4 错误体带 retryable（错误分层，契约 §6）",
          json.dumps(body2)[:200])

    check(leases_for_grant(grant_ref) == leases_before, "G5.4 超容量请求**没有**留下租约行",
          f"{leases_before} -> {leases_for_grant(grant_ref)}")
    check(active_port_leases(B_NODE_DB_ID) == ports_before, "G5.4 超容量请求**没有**泄漏端口",
          f"{ports_before} -> {active_port_leases(B_NODE_DB_ID)}")

    if ref1:
        status_rel, body_rel, _ = release_lease(ref1, it1)
        check(status_rel in (200, 201), "G5.4 显式释放成功（DELETE /leases/:ref）",
              f"status={status_rel} {json.dumps(body_rel)[:160]}")


# ---------------------------------------------------------------------------
# G5.5 lease expiry
# ---------------------------------------------------------------------------

def g5_5_lease_expiry():
    if not (A_PANEL_ID and B_NODE_DB_ID):
        H.record(False, "G5.5 前置缺失，本条无法执行")
        return
    status, grant = create_grant(
        A_PANEL_ID, {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 2}, workspace_id=B_WS_ID, expires_in_seconds=60,
    )
    grant_ref = str((grant or {}).get("grant_ref") or "")
    if not grant_ref:
        H.record(False, "G5.5 无法签发 60s 到期的 grant", f"status={status}")
        return
    it = intent(f"{FIXTURE_PREFIX}-expiry-1", 1, "egress", f"{FIXTURE_PREFIX}-expiry")
    status_r, body_r, _ = reserve(grant_ref, it)
    ref = str((body_r or {}).get("lease_ref") or "")
    if ref:
        CREATED_LEASES.append(ref)
    check(status_r == 200 and bool(ref), "G5.5 建立一条 60s 到期的租约",
          f"status={status_r} body={json.dumps(body_r)[:200]}")
    if not ref:
        return
    row = lease_row(ref)
    check(row.get("state") == "reserved", "G5.5 初始为 reserved", json.dumps(row))

    ok = H.wait_until(lambda: lease_row(ref).get("state") in ("expired", "released"), timeout=EXPIRE_WAIT, interval=6)
    check(ok, "G5.5 到期后 host 侧主动收口（worker 的联邦 reconcile 把它置 expired）",
          f"state={lease_row(ref).get('state')}（等 {EXPIRE_WAIT}s；host 的 worker 必须真的在跑）")
    if ok:
        check(lease_row(ref).get("state") == "expired", "G5.5 终态是 expired（不是静默留 reserved）",
              json.dumps(lease_row(ref)))
        if row.get("port"):
            check(port_lease_status(B_NODE_DB_ID, row["port"]).startswith("released"),
                  "G5.5 到期后端口归还", f"port={row['port']} {port_lease_status(B_NODE_DB_ID, row['port'])}")
    # home 侧"标 expired"的完整语义在 **Forward 级**（G5.18）断言 —— 只有走本机 rollout 的
    # 远端腿才有 placement 行；直连 M2M 不会写它（契约 §3.4：账本的写入者是 home 自己的 rollout）。
    # 这里钉住的是它的反面：直连 M2M 的这条租约不得在 home 侧留下"还活着"的幽灵账本行。
    m2m_placement = placement_row_a(B_PANEL_ID, it["intent_id"])
    check(not m2m_placement or m2m_placement.get("state") != "active",
          "G5.5 直连 M2M 的远端租约没有在 home 侧留下 active 的幽灵 placement 行",
          json.dumps(m2m_placement))


# ---------------------------------------------------------------------------
# G5.6 / G5.7 / G5.8 分区与失效
# ---------------------------------------------------------------------------

def _no_local_fallback(forward_ref: str) -> tuple[bool, str]:
    """断言 A 没有为了让"远端不可达"看起来好转而偷偷加了本地资源。"""
    tunnels = scalar_a(f"SELECT COUNT(*) FROM tunnel WHERE name LIKE '{forward_ref}%';")
    leases = scalar_a("SELECT COUNT(*) FROM node_port_lease l JOIN node n ON n.id=l.node_id "
                      "WHERE l.status='active' AND l.tunnel_id IS NULL;")
    return tunnels in ("", "0"), f"A.tunnel(name like {forward_ref}%)={tunnels} A.orphan_port_leases={leases}"


def g5_6_panel_b_offline():
    global B_STOPPED
    if not A_PANEL_ID:
        H.record(False, "G5.6 前置缺失，本条无法执行")
        return
    try:
        H.docker(["stop", PANEL_B], allow=True, timeout=180)
        B_STOPPED = True
        status, body, _ = fed_call(PANEL_A, API_B, "POST", "/api/federation/v1/ping", {}, timeout=20)
        check(status == 0 or code_of(body) == "peer_unreachable",
              "G5.6 B 下线后 A→B 调用明确失败（peer_unreachable，不假装成功）",
              f"status={status} body={json.dumps(body)[:160]}")
        ok, detail = _no_local_fallback(f"{FIXTURE_PREFIX}-offline")
        check(ok, "G5.6 A **没有**回落到本地节点/本地端口（fail-closed）", detail)
    finally:
        H.docker(["start", PANEL_B], allow=True, timeout=180)
        B_STOPPED = False
    check(bool(H.wait_until(lambda: http("GET", API_B, "/healthz", timeout=5)[0] == 200, timeout=180, interval=4)),
          "G5.6 B 重新上线")


def g5_7_panel_a_offline():
    """Panel A（home）下线：host(B) 必须自己按租约到期 fail-closed，而不是无限期继续服务。"""
    global A_STOPPED
    if not (A_PANEL_ID and B_NODE_DB_ID):
        H.record(False, "G5.7 前置缺失，本条无法执行")
        return
    status, grant = create_grant(
        A_PANEL_ID, {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 2}, workspace_id=B_WS_ID, expires_in_seconds=60,
    )
    grant_ref = str((grant or {}).get("grant_ref") or "")
    it = intent(f"{FIXTURE_PREFIX}-aoffline-1", 1, "egress", f"{FIXTURE_PREFIX}-aoffline")
    _s, body_r, _ = reserve(grant_ref, it)
    ref = str((body_r or {}).get("lease_ref") or "")
    if ref:
        CREATED_LEASES.append(ref)
    check(bool(ref), "G5.7 在 A 下线前建立一条租约", f"lease_ref={ref}")
    if not ref:
        return

    try:
        H.docker(["stop", PANEL_A], allow=True, timeout=180)
        A_STOPPED = True
        # A 不在，任何 A 侧 API 断言都会失败 —— 这里只观察 B 侧（host）的 fail-closed。
        ok = H.wait_until(lambda: lease_row(ref).get("state") in ("expired", "released"),
                          timeout=EXPIRE_WAIT, interval=6)
        check(ok, "G5.7 A 离线期间 host 侧租约到期即停服（不擅自续期）",
              f"state={lease_row(ref).get('state')}（等 {EXPIRE_WAIT}s）")
        row = lease_row(ref)
        if row.get("port"):
            check(port_lease_status(B_NODE_DB_ID, row["port"]).startswith("released"),
                  "G5.7 到期后端口归还", f"port={row['port']} {port_lease_status(B_NODE_DB_ID, row['port'])}")
        check(scalar_b(f"SELECT COUNT(*) FROM federation_lease WHERE peer_panel_id='{A_PANEL_ID}' "
                       "AND state IN ('reserved','active') AND expires_at < NOW();") in ("", "0"),
              "G5.7 B 侧没有留下「已过期但仍占用」的租约")
    finally:
        H.docker(["start", PANEL_A], allow=True, timeout=180)
        A_STOPPED = False
    back = H.wait_until(lambda: http("GET", API_A, "/healthz", timeout=5)[0] == 200, timeout=240, interval=4)
    check(back, "G5.7 A 回来后 /healthz 恢复")
    if back:
        status, cookie = H.login()
        global COOKIE_A
        if status == 200 and cookie:
            COOKIE_A = cookie
        check(status == 200, "G5.7 A 回来后管理员会话可重建", f"status={status}")
        check(lease_row(ref).get("state") == "expired",
              "G5.7 重连后两侧对同一租约的结论一致（expired）", json.dumps(lease_row(ref)))


def g5_8_network_partition():
    global A_STOPPED, B_STOPPED
    if not (A_PANEL_ID and B_NODE_DB_ID):
        H.record(False, "G5.8 前置缺失，本条无法执行")
        return
    status, grant = create_grant(
        A_PANEL_ID, {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 2}, workspace_id=B_WS_ID, expires_in_seconds=90,
    )
    grant_ref = str((grant or {}).get("grant_ref") or "")
    it = intent(f"{FIXTURE_PREFIX}-partition-1", 1, "egress", f"{FIXTURE_PREFIX}-partition")
    _s, body_r, _ = reserve(grant_ref, it)
    ref = str((body_r or {}).get("lease_ref") or "")
    if ref:
        CREATED_LEASES.append(ref)
    check(bool(ref), "G5.8 分区前建立一条租约", f"lease_ref={ref}")
    if not ref:
        return

    row = lease_row(ref)
    try:
        H.docker(["stop", PANEL_B], allow=True, timeout=180)
        B_STOPPED = True
        H.docker(["stop", PANEL_A], allow=True, timeout=180)
        A_STOPPED = True
        # 两侧都不在：host 的 worker 仍在跑，租约必须按到期离开"在服务"的状态。
        # 注意断言的是**不处于 live 状态**，而不是某一个特定终态：host 的控制面（panel）
        # 同时不在时，停服可能无法当场确认（state=failed + internal_error 是诚实的 fail-closed），
        # 真正的收敛由恢复后的 sweep 完成 —— 下一段就是验这件事。
        ok = H.wait_until(lambda: lease_row(ref).get("state") not in ("reserved", "active", "releasing"),
                          timeout=EXPIRE_WAIT, interval=6)
        check(ok, "G5.8 分区期间 host 侧按租约到期离开 live 状态（不依赖 home 在线）",
              f"state={lease_row(ref).get('state')} {json.dumps(lease_row(ref))}")
        check(lease_row(ref).get("state") != "active", "G5.8 分区期间没有「看起来还活着」的租约",
              json.dumps(lease_row(ref)))
    finally:
        H.docker(["start", PANEL_A], allow=True, timeout=180)
        A_STOPPED = False
        H.docker(["start", PANEL_B], allow=True, timeout=180)
        B_STOPPED = False
    ok_a = H.wait_until(lambda: http("GET", API_A, "/healthz", timeout=5)[0] == 200, timeout=240, interval=4)
    ok_b = H.wait_until(lambda: http("GET", API_B, "/healthz", timeout=5)[0] == 200, timeout=240, interval=4)
    check(ok_a and ok_b, "G5.8 两侧恢复上线", f"A={ok_a} B={ok_b}")
    status, cookie = H.login()
    if status == 200 and cookie:
        global COOKIE_A
        COOKIE_A = cookie
    # 恢复后**收敛**：分区中被卡住的收尾必须被 sweep 补上（终态 expired + 端口归还）。
    if ref:
        converged = H.wait_until(lambda: lease_row(ref).get("state") == "expired", timeout=EXPIRE_WAIT, interval=6)
        check(converged, "G5.8 恢复后租约收敛到 expired（卡住的收尾被补上，不是永远 failed）",
              f"state={lease_row(ref).get('state')} last_error={lease_row(ref).get('last_error_code')}")
        port = row.get("port") or 0
        if port:
            check(port_lease_status(B_NODE_DB_ID, port).startswith("released"),
                  "G5.8 恢复后端口也归还了（不留孤儿端口）",
                  f"port={port} {port_lease_status(B_NODE_DB_ID, port)}")

    # 恢复后对账：同 (intent_id, revision) 重发必须收敛到同一份事实，不产生第二份占用
    if ref:
        before = lease_row(ref)
        status_again, body_again, _ = reserve(grant_ref, it)
        after = lease_row(ref)
        check(status_again == 200, "G5.8 重连后按 (intent_id, revision) 重发被接受（幂等键命中）",
              f"status={status_again} {json.dumps(body_again)[:180]}")
        check(after.get("lease_epoch") == before.get("lease_epoch"),
              "G5.8 重发**没有** bump epoch（旧占用不能被重复计一次）",
              f"epoch {before.get('lease_epoch')} -> {after.get('lease_epoch')}")
        check(leases_for_grant(grant_ref) == 1, "G5.8 重连后**没有**产生第二份租约",
              f"leases_for_grant={leases_for_grant(grant_ref)}")


# ---------------------------------------------------------------------------
# G5.9 duplicate / G5.10 reordered
# ---------------------------------------------------------------------------

def g5_9_duplicate_messages():
    if not (A_PANEL_ID and B_NODE_DB_ID):
        H.record(False, "G5.9 前置缺失，本条无法执行")
        return
    status, grant = create_grant(
        A_PANEL_ID, {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 3}, workspace_id=B_WS_ID,
    )
    grant_ref = str((grant or {}).get("grant_ref") or "")
    it = intent(f"{FIXTURE_PREFIX}-dup-1", 1, "egress", f"{FIXTURE_PREFIX}-dup")
    message_id = f"{FIXTURE_PREFIX}-dup-msg-1"
    ports_before = active_port_leases(B_NODE_DB_ID)

    status1, body1, _ = reserve(grant_ref, it, message_id=message_id)
    ref1 = str((body1 or {}).get("lease_ref") or "")
    if ref1:
        CREATED_LEASES.append(ref1)
    check(status1 == 200, "G5.9 首次投递成功", f"status={status1} {json.dumps(body1)[:180]}")

    status2, body2, _ = reserve(grant_ref, it, message_id=message_id)
    check(status2 == 200, "G5.9 同 message_id 重放返回 200（幂等，而不是报错）",
          f"status={status2} {json.dumps(body2)[:200]}")
    check(str((body2 or {}).get("lease_ref")) == ref1,
          "G5.9 重放返回**首次的**结果（同一个 lease_ref）",
          f"first={ref1} replay={(body2 or {}).get('lease_ref')}")
    check(json.dumps(body1, sort_keys=True) == json.dumps(body2, sort_keys=True),
          "G5.9 重放返回的是首次响应快照（逐字节等价）",
          f"first={json.dumps(body1)[:120]} replay={json.dumps(body2)[:120]}")
    check(leases_for_grant(grant_ref) == 1, "G5.9 重放**没有**重复执行（仍只有一条租约）",
          f"leases_for_grant={leases_for_grant(grant_ref)}")
    check(active_port_leases(B_NODE_DB_ID) == ports_before + 1, "G5.9 重放**没有**多占端口",
          f"{ports_before} -> {active_port_leases(B_NODE_DB_ID)}")

    # 换 message_id 但同一 (intent_id, revision)：协议层去重也必须命中
    status3, body3, _ = reserve(grant_ref, it, message_id=f"{FIXTURE_PREFIX}-dup-msg-2")
    check(str((body3 or {}).get("lease_ref")) == ref1,
          "G5.9 换 message_id 但同 (intent_id, revision) 仍收敛到首次结果",
          f"status={status3} body={json.dumps(body3)[:180]}")
    check(leases_for_grant(grant_ref) == 1, "G5.9 并且没有产生第二份租约",
          f"leases_for_grant={leases_for_grant(grant_ref)}")


def g5_10_reordered_messages():
    if not (A_PANEL_ID and B_NODE_DB_ID):
        H.record(False, "G5.10 前置缺失，本条无法执行")
        return
    status, grant = create_grant(
        A_PANEL_ID, {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 3}, workspace_id=B_WS_ID,
    )
    grant_ref = str((grant or {}).get("grant_ref") or "")
    fwd = f"{FIXTURE_PREFIX}-reorder"

    # 第一代占用
    it1 = intent(f"{FIXTURE_PREFIX}-reorder-1", 1, "egress", fwd)
    msg1 = f"{FIXTURE_PREFIX}-reorder-msg-1"
    status1, body1, _ = reserve(grant_ref, it1, message_id=msg1)
    ref1 = str((body1 or {}).get("lease_ref") or "")
    if ref1:
        CREATED_LEASES.append(ref1)
    epoch1 = lease_row(ref1).get("lease_epoch") if ref1 else 0
    check(status1 == 200 and bool(ref1), "G5.10 第一代租约建立", f"status={status1} {json.dumps(body1)[:160]}")

    msg_rel = f"{FIXTURE_PREFIX}-reorder-rel"
    status_rel, _b, _ = release_lease(ref1, it1, message_id=msg_rel)
    check(status_rel in (200, 201), "G5.10 第一代租约释放", f"status={status_rel}")

    # 第二代占用（同谱系）：epoch 必须单调递增
    it2 = intent(f"{FIXTURE_PREFIX}-reorder-2", 1, "egress", fwd)
    status2, body2, _ = reserve(grant_ref, it2, message_id=f"{FIXTURE_PREFIX}-reorder-msg-2")
    ref2 = str((body2 or {}).get("lease_ref") or "")
    if ref2:
        CREATED_LEASES.append(ref2)
    epoch2 = lease_row(ref2).get("lease_epoch") if ref2 else 0
    check(bool(ref2) and ref2 != ref1, "G5.10 第二代占用是新租约（不复用已释放的行）",
          f"ref1={ref1} ref2={ref2}")
    check(epoch2 > epoch1, "G5.10 lease_epoch 单调递增（fencing 依据）", f"epoch {epoch1} -> {epoch2}")

    # 乱序重放旧消息：旧 epoch 的消息不得覆盖新状态
    status_old, body_old, _ = reserve(grant_ref, it1, message_id=msg1)
    after = lease_row(ref2)
    check(status_old == 200 and str((body_old or {}).get("lease_ref")) == ref1,
          "G5.10 重放第一代的创建消息返回**首次**结果（不回退状态）",
          f"status={status_old} lease_ref={(body_old or {}).get('lease_ref')}")
    check(after.get("state") == "reserved" and after.get("lease_epoch") == epoch2,
          "G5.10 第二代的 state/epoch 没有被旧消息覆盖",
          f"{json.dumps(after)}（期望 epoch={epoch2}）")
    state1_after = lease_row(ref1).get("state")
    check(state1_after == "released", "G5.10 第一代也没有被旧消息「复活」",
          f"state={state1_after} {json.dumps(lease_row(ref1))}")

    status_rel_old, _b2, _ = release_lease(ref2, it2)
    check(status_rel_old in (200, 201), "G5.10 清理第二代占用", f"status={status_rel_old}")


# ---------------------------------------------------------------------------
# G5.11 partial failure
# ---------------------------------------------------------------------------

def g5_11_partial_failure():
    if not (A_PANEL_ID and B_NODE_DB_ID):
        H.record(False, "G5.11 前置缺失，本条无法执行")
        return
    status, grant = create_grant(
        A_PANEL_ID, {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 3}, workspace_id=B_WS_ID,
    )
    grant_ref = str((grant or {}).get("grant_ref") or "")

    # 先占一个端口，再用它当"请求端口已被占用"的失败注入点（阶段 1 的补偿路径）。
    it1 = intent(f"{FIXTURE_PREFIX}-partial-1", 1, "egress", f"{FIXTURE_PREFIX}-partial")
    status1, body1, _ = reserve(grant_ref, it1)
    ref1 = str((body1 or {}).get("lease_ref") or "")
    port1 = int((body1 or {}).get("port") or 0)
    if ref1:
        CREATED_LEASES.append(ref1)
    check(status1 == 200 and port1 > 0, "G5.11 先占用一个真实端口作为失败注入点",
          f"status={status1} port={port1}")

    leases_before = leases_for_grant(grant_ref)
    ports_before = active_port_leases(B_NODE_DB_ID)
    it2 = intent(f"{FIXTURE_PREFIX}-partial-2", 1, "egress", f"{FIXTURE_PREFIX}-partial",
                 requested={"port": port1})
    status2, body2, _ = reserve(grant_ref, it2)
    check(status2 not in (200, 201), "G5.11 端口已被占用时必须失败（而不是静默换端口/双占）",
          f"status={status2} body={json.dumps(body2)[:220]}")
    check(code_of(body2) in ("quota_exhausted", "message_malformed", "grant_scope_violation", "internal_error"),
          "G5.11 失败码落在契约 §6 的闭集里", f"code={code_of(body2)}")
    check(leases_for_grant(grant_ref) == leases_before,
          "G5.11 阶段 1 失败**没有**留下租约行（补偿/无副作用）",
          f"{leases_before} -> {leases_for_grant(grant_ref)}")
    check(active_port_leases(B_NODE_DB_ID) == ports_before,
          "G5.11 阶段 1 失败**没有**多占端口", f"{ports_before} -> {active_port_leases(B_NODE_DB_ID)}")

    # 阶段 2 的失败补偿：apply 收到非法 link 时必须拒绝，且不得把租约留在半状态
    if ref1:
        status_bad, body_bad, _ = fed_call(
            PANEL_A, API_B, "POST", f"/api/federation/v1/leases/{ref1}/apply",
            {"intent_id": it1["intent_id"], "revision": 1},
        )
        check(status_bad == 400 and code_of(body_bad) == "message_malformed",
              "G5.11 阶段 2 的空目标被 fail-closed 拒绝（不把「永远不通的链路」下发上去）",
              f"status={status_bad} code={code_of(body_bad)} body={json.dumps(body_bad)[:180]}")
        row = lease_row(ref1)
        check(row.get("state") in ("reserved", "failed") and row.get("applied_revision") in (-1, 0, None),
              "G5.11 被拒的 apply 没有把租约留成「已激活」", json.dumps(row))
        release_lease(ref1, it1)


# ---------------------------------------------------------------------------
# G5.12 reconnect reconcile
# ---------------------------------------------------------------------------

def g5_12_reconnect_reconcile():
    if not (A_PANEL_ID and B_NODE_DB_ID):
        H.record(False, "G5.12 前置缺失，本条无法执行")
        return
    # home 侧账本的写入者是**本机 rollout**（Forward 级路径），直连 M2M 不写它 —— 这是设计。
    # G5.16 先跑，所以这里断言的对象是真实存在的账本行，而不是"期待外部调用写账本"。
    live_forward = FED_FORWARD_IDS[-1] if FED_FORWARD_IDS else 0
    check(live_forward > 0, "G5.12 home(A) 侧有 Forward 级 placement 账本行（reconnect reconcile 的对象）",
          f"federated forward ids={FED_FORWARD_IDS}")
    if live_forward:
        r0 = forward_row_a(live_forward)
        iid0 = f"fw-{live_forward}-{r0.get('config_revision')}"
        pr0 = placement_row_a(B_PANEL_ID, iid0)
        # 断言的是**对账收敛**（applied 追上 desired），不是"此刻必须活着"：
        # 远端租约的 TTL 只有 300s，一个跑得久的总门禁完全可能在落到这里时它已经到期
        # —— 那时 home 账本仍然必须收敛且可解释。活体链路另有 G5.16 专门验。
        has_row = bool(pr0)
        check(has_row and int(pr0.get("applied_revision") or -1) >= int(pr0.get("desired_revision") or 0)
              and int(pr0.get("desired_revision") or 0) > 0,
              "G5.12 该 placement 的 applied_revision 追上 desired_revision（对账收敛）", json.dumps(pr0))
        check(pr0.get("state") == "active" or bool(pr0.get("last_error_code")),
              "G5.12 不在 active 时必须有可解释原因（不带理由的状态漂移=不可解释）", json.dumps(pr0))
    # 协议层的对账语义仍然可验：B 下线 → 恢复 → 同键重发必须收敛。
    status, grant = create_grant(
        A_PANEL_ID, {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 3}, workspace_id=B_WS_ID,
    )
    grant_ref = str((grant or {}).get("grant_ref") or "")
    it = intent(f"{FIXTURE_PREFIX}-recon-1", 1, "egress", f"{FIXTURE_PREFIX}-recon")
    status1, body1, _ = reserve(grant_ref, it)
    ref1 = str((body1 or {}).get("lease_ref") or "")
    if ref1:
        CREATED_LEASES.append(ref1)
    check(status1 == 200 and bool(ref1), "G5.12 建立租约", f"status={status1}")
    if not ref1:
        return

    H.docker(["stop", PANEL_B], allow=True, timeout=180)
    try:
        status_down, body_down, _ = fed_call(PANEL_A, API_B, "POST", "/api/federation/v1/ping", {}, timeout=20)
        check(status_down == 0 or code_of(body_down) == "peer_unreachable",
              "G5.12 peer 不可达时有可解释的错误（不静默）", f"status={status_down} {json.dumps(body_down)[:120]}")
    finally:
        H.docker(["start", PANEL_B], allow=True, timeout=180)
    check(bool(H.wait_until(lambda: http("GET", API_B, "/healthz", timeout=5)[0] == 200, timeout=180, interval=4)),
          "G5.12 peer 恢复")

    before = lease_row(ref1)
    status2, body2, _ = reserve(grant_ref, it)
    after = lease_row(ref1)
    check(status2 == 200 and str((body2 or {}).get("lease_ref")) == ref1,
          "G5.12 重连后同键重发收敛到同一份事实", f"status={status2} {json.dumps(body2)[:160]}")
    check(after.get("lease_epoch") == before.get("lease_epoch"),
          "G5.12 重发不 bump epoch（不产生第二份占用）",
          f"{before.get('lease_epoch')} -> {after.get('lease_epoch')}")
    check(leases_for_grant(grant_ref) == 1, "G5.12 重连后只有一份租约",
          f"leases_for_grant={leases_for_grant(grant_ref)}")


# ---------------------------------------------------------------------------
# G5.13 cross-tenant isolation
# ---------------------------------------------------------------------------

def g5_13_cross_tenant_isolation():
    if not A_PANEL_ID:
        H.record(False, "G5.13 前置缺失，本条无法执行")
        return
    foreign_peer = FOREIGN_PEER
    mysql_on(DB_B,
             "INSERT INTO federation_peer (peer_panel_id, display_name, endpoint_url, public_keys, status, created_at, updated_at) "
             f"VALUES ('{foreign_peer}', 'Gate foreign tenant', 'http://nowhere:3000', '[]', 'trusted', NOW(3), NOW(3)) "
             "ON DUPLICATE KEY UPDATE status='trusted', public_keys='[]';")
    status, grant = create_grant(
        foreign_peer, {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 2}, workspace_id=B_WS_ID,
    )
    grant_ref = str((grant or {}).get("grant_ref") or "")
    check(bool(grant_ref), "G5.13 为**另一个 peer** 签发 grant（租户隔离的对照面）",
          f"status={status} {json.dumps(grant)[:180]}")
    if not grant_ref:
        return
    leases_before = leases_for_grant(grant_ref)
    it = intent(f"{FIXTURE_PREFIX}-xtenant-1", 1, "egress", f"{FIXTURE_PREFIX}-xtenant")
    status_a, body_a, _ = reserve(grant_ref, it)
    check(status_a in (401, 403, 404), "G5.13 别的 peer 拿 grant_ref 也用不了（引用不是凭据）",
          f"status={status_a} body={json.dumps(body_a)[:220]}")
    check(code_of(body_a) in ("grant_scope_violation", "grant_not_found", "peer_unknown", "peer_revoked"),
          "G5.13 拒绝码可解释", f"code={code_of(body_a)}")
    check(leases_for_grant(grant_ref) == leases_before,
          "G5.13 越权尝试没有留下任何租约行", f"{leases_before} -> {leases_for_grant(grant_ref)}")

    # 用量归因不串租户：无法归因的用量进 unattributed 桶，而不是记到别的 forward 上
    usage_id = f"{FIXTURE_PREFIX}-xtenant-usage"
    report = {
        "usage_id": usage_id,
        "lease_ref": "00000000-0000-4000-8000-000000000000",
        "forward_ref": f"{FIXTURE_PREFIX}-foreign-forward",
        "window_start": "2026-10-04T18:00:00Z",
        "window_end": "2026-10-04T18:05:00Z",
        "bytes_in": 11,
        "bytes_out": 22,
        "connections": 1,
    }
    status_u, body_u, _ = fed_call(PANEL_B, API_A, "POST", "/api/federation/v1/usage", {"report": report})
    check(status_u == 200, "G5.13 无法归因的用量被接受并落库（不静默丢弃）",
          f"status={status_u} body={json.dumps(body_u)[:200]}")
    attribution = scalar_a(f"SELECT attribution FROM federation_usage_record WHERE usage_id='{usage_id}';")
    tunnel_id = scalar_a(f"SELECT IFNULL(tunnel_id,0) FROM federation_usage_record WHERE usage_id='{usage_id}';")
    check(attribution == "unattributed", "G5.13 归因结果是 unattributed（不猜、不串到别的租户）",
          f"attribution={attribution!r}")
    check(tunnel_id in ("0", ""), "G5.13 没有把它归到任何本地 Forward 上", f"tunnel_id={tunnel_id}")

    # 夹具自清理：对照租户的 peer 行与它名下的 grant 都删掉（FK 级联带走 grant）。
    mysql_on(DB_B, f"DELETE FROM federation_peer WHERE peer_panel_id='{foreign_peer}';")
    check(scalar_b(f"SELECT COUNT(*) FROM federation_peer WHERE peer_panel_id='{foreign_peer}';") in ("", "0"),
          "G5.13 对照租户的夹具行已清理（不留测试残留）")


# ---------------------------------------------------------------------------
# G5.16 / G5.17 / G5.18 —— Forward 级：home 侧 placement 端到端
#
# 为什么必须另起三组：直连 M2M 的场景（G5.1…G5.13）**不会**产生 home 侧账本行 ——
# 那是设计如此（home 的账本由本机 rollout 写，不由外部调用写）。契约 §3.4 真正要求的是
# 「Forward 声明远端出口 → 本机 rollout 委托 → 写 placement 镜像 → 不可达时 degraded
# 且不回落 → 恢复后按 (intent_id, revision) 收敛 → 删除/改回本机即释放」。
# 第一轮 G5.5/G5.12 那两条 FAIL 的正解就在这里，所以断言放在这一层，而不是在 M2M 场景
# 里把它放宽。
# ---------------------------------------------------------------------------

# `FED_FORWARD_IDS` = 当前**还活着**的 fixture（G5.12/G5.17 用它挑对象）；
# `FED_FORWARD_ALL` = 本轮**创建过**的全部 id，永不摘除 —— 场景自己删掉 Forward 之后，
# placement 的终态行仍然要有人收（否则下一轮读数里会一直混着"历史 expired"，
# 未来的人分不清那是残留还是真状态）。
FED_FORWARD_IDS: list[int] = []
FED_FORWARD_ALL: list[int] = []
FED_FORWARD_MARKER = "fed_fw_tid"


def node_ip_a(node_id: int) -> str:
    raw = scalar_a(f"SELECT IFNULL(connect_ip,'') FROM node WHERE id={node_id};").strip()
    return raw.split(",")[0].strip() if raw else ""


def ingress_probe(port: int, timeout: float = 6.0) -> tuple[bool, str]:
    """从 ingress 数据网上的 wp14-client 连 A 的入口端口。

    Gate 自己跑在 ctrl 网上（数据网是 internal 的），够不到入口地址，所以借这个拓扑里
    "客户端"角色的容器。回包来自 target-a ⇒ A 入口 → 远端 B 出口腿 → target-a 真的通了。
    """
    ip = node_ip_a(H.ING)
    if not ip or not port:
        return False, f"no ip/port (ip={ip!r} port={port})"
    shell = f"nc -w {int(timeout)} {ip} {port} </dev/null 2>&1 | head -c 64"
    out = H.docker(["exec", "wp14-client", "sh", "-c", shell], allow=True, timeout=60)
    text = out.strip()
    bad = ("refused", "timed out", "unreachable", "No route", "no response")
    ok = bool(text) and not any(b in text for b in bad)
    # 证据形式（Lead 要求）：把"从哪个容器、发什么命令、拿到什么原始输出"一起写进证据，
    # 否则读者无法区分"真的连了"和"断言了一个没测的东西"。
    detail = f"[docker exec wp14-client sh -c {shell!r}] raw={text[:48]!r}"
    return ok, detail


def forward_row_a(tid: int) -> dict:
    raw = scalar_a(
        "SELECT CONCAT(IFNULL(tunnel_mode,''),'|',IFNULL(apply_status,''),'|',IFNULL(listen_port,0),'|',"
        "IFNULL(config_revision,0),'|',IFNULL(applied_revision,0),'|',IFNULL(ingress_node_id,0),'|',"
        "IFNULL(egress_node_id,0),'|',IFNULL(federated_egress_peer,''),'|',IFNULL(forward_protocol,''),'|',"
        "IFNULL(apply_error_code,'')) "
        f"FROM tunnel WHERE id={tid};"
    )
    if "|" not in raw:
        return {}
    mode, status, port, cfg, applied, ing, egr, peer, proto, err = raw.split("|")
    return {"mode": mode, "apply_status": status, "listen_port": int(port), "config_revision": int(cfg),
            "applied_revision": int(applied), "ingress_node_id": int(ing), "egress_node_id": int(egr),
            "federated_egress_peer": peer, "protocol": proto, "apply_error_code": err, "raw": raw}


def placement_row_a(peer_panel_id: str, intent_id: str) -> dict:
    raw = scalar_a(
        "SELECT CONCAT(state,'|',desired_revision,'|',IFNULL(applied_revision,-1),'|',IFNULL(lease_ref,''),'|',"
        "IFNULL(lease_epoch,0),'|',IFNULL(peer_port,0),'|',IFNULL(peer_node_ref,''),'|',IFNULL(last_error_code,''),"
        "'|',IFNULL(tunnel_id,0)) FROM federation_placement "
        f"WHERE peer_panel_id='{peer_panel_id}' AND intent_id='{intent_id}';"
    )
    if "|" not in raw:
        return {}
    state, desired, applied, lease_ref, epoch, port, node_ref, code, tid = raw.split("|")
    return {"state": state, "desired_revision": int(desired), "applied_revision": int(applied),
            "lease_ref": lease_ref, "lease_epoch": int(epoch), "peer_port": int(port),
            "peer_node_ref": node_ref, "last_error_code": code, "tunnel_id": int(tid), "raw": raw}


def remote_lease_for_b(forward_ref: str) -> dict:
    raw = scalar_b(
        "SELECT CONCAT(lease_ref,'|',state,'|',lease_epoch,'|',IFNULL(applied_revision,-1),'|',requested_revision,"
        "'|',IFNULL(node_id,0),'|',IFNULL(listen_port,0),'|',IFNULL(last_error_code,'')) "
        f"FROM federation_lease WHERE forward_ref='{forward_ref}' ORDER BY id DESC LIMIT 1;"
    )
    if "|" not in raw:
        return {}
    ref, state, epoch, applied, requested, node, port, code = raw.split("|")
    return {"lease_ref": ref, "state": state, "lease_epoch": int(epoch), "applied_revision": int(applied),
            "requested_revision": int(requested), "node_id": int(node), "port": int(port),
            "last_error_code": code, "raw": raw}


def create_federated_forward(name: str, peer_panel_id: str) -> tuple[int, dict]:
    body = {
        "name": name,
        "mode": "relay",
        "protocol": "tcp",
        "ingress_node_id": H.ING,
        "federated_egress_peer": peer_panel_id,
        "target_host": "target-a",
        "target_port": 3030,
    }
    status, resp, _ = H.req("POST", "/api/forwards", body, timeout=240)
    data = unwrap(resp)
    data = data if isinstance(data, dict) else {}
    tid = int(data.get("id") or 0)
    if tid:
        if tid not in FED_FORWARD_IDS:
            FED_FORWARD_IDS.append(tid)
        if tid not in FED_FORWARD_ALL:
            FED_FORWARD_ALL.append(tid)
    return status, data


def b_runtime_reported(lease_ref: str) -> bool:
    return f"tunex-fed-{lease_ref}-egress" in scalar_b(
        "SELECT IFNULL(tunnels,'[]') FROM node_state_report s JOIN node n ON n.id=s.node_id "
        f"WHERE n.node_id='{B_NODE_STR}';"
    )


def revoke_all_active_grants() -> int:
    """让 A 在这个 peer 上只可能解析到**一条** active grant（rollout 不带 grant_ref）。"""
    _s, body, _ = req_b("GET", f"{ADMIN_B}/grants")
    n = 0
    for g in as_list(unwrap(body)):
        if g.get("status") in ("active", "suspended"):
            revoke_grant(str(g.get("grant_ref")), "g5_lease_expiry_isolation")
            n += 1
    return n


def g5_16_federated_forward_use():
    global B_STOPPED
    if not (A_PANEL_ID and B_PANEL_ID and B_NODE_DB_ID):
        H.record(False, "G5.16 前置缺失，本条无法执行")
        return
    # rollout **不带** grant_ref（home 侧不该"记得"额度），host 侧解析顺序③要求该 peer 上
    # 只有**一条**覆盖 egress 的 active grant；多于一条会被 fail-closed 拒绝（`grant_scope_violation`）。
    # 所以这里先把额度环境做成确定的：撤掉其它 active grant，再发一条 1h 的。
    revoked = revoke_all_active_grants()
    _sg, grant = create_grant(
        A_PANEL_ID, {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 5}, workspace_id=B_WS_ID, expires_in_seconds=3600,
    )
    _s2, grants_now, _ = req_b("GET", f"{ADMIN_B}/grants")
    active_now = [g for g in as_list(unwrap(grants_now))
                  if g.get("status") in ("active", "suspended")]
    check(len(active_now) == 1,
          "G5.16 该 peer 上此刻**恰好一条**可用 grant（多于一条时 rollout 会被 fail-closed 拒绝）",
          f"revoked_others={revoked} active={[(g.get('grant_ref'), g.get('status')) for g in active_now][:4]}")

    status, data = create_federated_forward(f"{FIXTURE_PREFIX}-fedfw", B_PANEL_ID)
    check(status in (200, 201), "G5.16 A 上创建声明远端出口（federated_egress_peer=B）的 RELAY Forward",
          f"status={status} apply_status={(data or {}).get('apply_status')} "
          f"apply_error_code={(data or {}).get('apply_error_code')} "
          f"apply_error={str((data or {}).get('apply_error'))[:220]}")
    tid = int((data or {}).get("id") or 0)
    if tid <= 0:
        return
    # create 的**响应**与 rollout 的**最终结果**是两件事：实测见过 502 但行还在 `applying`
    # （API 说了失败、而实际还在跑），也见过 502 且行落到 error。所以这里不把响应当结论，
    # 而是等这条 Forward 的 apply_status 稳定下来再断言 —— 这样"API 层不一致"与
    # "远端腿建不起来"会各自留下独立的一条 FAIL，而不是互相掩盖成一串级联。
    settled = H.wait_until(lambda: forward_row_a(tid).get("apply_status") in ("active", "error"),
                           timeout=180, interval=5)
    row = forward_row_a(tid)
    check(settled, "G5.16 创建请求返回后 Forward 的 apply_status 能稳定下来（不长期 pending/applying）",
          json.dumps(row))
    check(row.get("apply_status") == "active", "G5.16 该 Forward 最终收敛到 active",
          f"row={json.dumps(row)} apply_error_code={row.get('apply_error_code')}")
    check(row.get("egress_node_id", 0) == 0 and row.get("federated_egress_peer") == B_PANEL_ID,
          "G5.16 出口腿真的被委托出去：本机没有 egress 节点，只有声明", json.dumps(row))
    check(int(row.get("listen_port") or 0) > 0, "G5.16 本机入口端口已分配", json.dumps(row))

    intent_id = f"fw-{tid}-{row.get('config_revision')}"
    placed = H.wait_until(
        lambda: placement_row_a(B_PANEL_ID, intent_id).get("state") == "active", timeout=150, interval=4)
    prow = placement_row_a(B_PANEL_ID, intent_id)
    check(bool(prow), "G5.16 A 侧 federation_placement 出现该 (peer, intent_id) 行",
          f"intent_id={intent_id} row={json.dumps(prow)}")
    if not prow:
        return
    check(prow.get("desired_revision") == row.get("config_revision"),
          "G5.16 placement.desired_revision 跟随 Forward 的 config_revision",
          f"desired={prow.get('desired_revision')} config={row.get('config_revision')}")
    check(placed, "G5.16 placement 收敛到 active", json.dumps(prow))
    check(prow.get("applied_revision") == prow.get("desired_revision"),
          "G5.16 applied_revision 追上 desired_revision（home 账本可解释）", json.dumps(prow))

    lease_ref = str(prow.get("lease_ref") or "")
    check(bool(lease_ref), "G5.16 placement 记录了 host 决定的 lease_ref（不是 home 猜的）", json.dumps(prow))
    brow = remote_lease_for_b(f"fw-{tid}")
    check(brow.get("state") == "active" and brow.get("applied_revision") == brow.get("requested_revision"),
          "G5.16 B 侧 lease active 且 applied_revision 已落库", json.dumps(brow))
    if lease_ref:
        check(bool(H.wait_until(lambda: b_runtime_reported(lease_ref), timeout=150, interval=6)),
              "G5.16 host 侧**真实 runtime** 出现在节点自己的上报里",
              f"runtime=tunex-fed-{lease_ref}-egress")
    port = int(row.get("listen_port") or 0)
    ok_data = H.wait_until(lambda: ingress_probe(port)[0], timeout=180, interval=5)
    _, detail = ingress_probe(port)
    check(ok_data, "G5.16 数据面：经 A 的入口端口真的到达远端出口腿后面的 target-a（由 wp14-client 发起）",
          detail)

    # ── 稳定性钉子（最直接钉住根因的那条）──
    # host 侧如果**没有把联邦腿发布进自己的权威 desired 快照**，Agent 的"删掉不在 desired
    # 里的 runtime"这条正确逻辑会在 ~20–45s 内把它剪掉（实测：`tunnel applied` 紧跟
    # `reconcile removed runtime absent from authoritative desired state`），而控制面每一行
    # 仍是 active。所以"60 秒后还连得上"比任何分区场景都更短、更稳、更准确地复现它。
    time.sleep(120)
    ok_stable, detail_stable = ingress_probe(port)
    lease_now = str(prow.get("lease_ref") or "")
    b_reported = b_runtime_reported(lease_now)
    check(ok_stable,
          "G5.16 远端腿建立 120s 后**仍在服务**（host 的 desired 快照必须包含这条联邦腿）",
          f"{detail_stable} b_runtime_in_node_report={b_reported} "
          f"tunnel={json.dumps(forward_row_a(tid))}")

    # 同一条根因的**日志级**断言：host 的 Agent 不得把联邦 runtime 当成"不在权威 desired 里"
    # 剪掉。这条与上一条互为独立证据（一个看数据面、一个看 Agent 的判定），
    # 也是 task-12 修复前那条 `reconcile removed runtime absent from authoritative desired state`
    # 的直接对照。
    agent_log = H.docker(["logs", "--since", "20m", AGENT_B], allow=True, timeout=120)
    hits = [ln for ln in agent_log.splitlines()
            if "reconcile removed runtime absent from authoritative desired state" in ln
            and "tunex-fed-" in ln and (lease_now == "" or lease_now in ln)]
    check(not hits,
          "G5.16 host 侧 Agent 不再把联邦腿当成「不在权威 desired 里」而剪掉（task-12 的直接对照）",
          f"matches={len(hits)} last={hits[-1][:220] if hits else ''}")
    _after, _detail_after = ingress_probe(port)
    check(_after, "G5.16 该腿在整个稳定窗口结束时仍可连（不出现「建立后短命」）", _detail_after)

    # ── 停 B：home 账本必须 degraded，且**不回落本地** ──
    try:
        H.docker(["stop", PANEL_B], allow=True, timeout=180)
        B_STOPPED = True
        # 停机窗口必须**短于租约 TTL**（默认 300s）：这里验的是"短分区 → 恢复 → 收敛"，
        # 而不是"租约在停机期间过期"。后者是另一件事，由 G5.19 单独验（它对 Forward 状态
        # 的诚实性有不同断言）。窗口=180s+180s 曾经让租约在场景中途到期，把两条不同的
        # 世界读成一条断言 —— 那是门禁自己的设计错误。
        degraded = H.wait_until(
            lambda: placement_row_a(B_PANEL_ID, intent_id).get("state") == "degraded",
            timeout=90, interval=5)
        drow = placement_row_a(B_PANEL_ID, intent_id)
        check(degraded, "G5.16 停掉 B 后 A 侧 placement → degraded（不静默、不假装 active）",
              json.dumps(drow))
        check(bool(drow.get("last_error_code")), "G5.16 degraded 带可解释错误码",
              json.dumps(drow))
        check(str(drow.get("last_error_code") or "") in
              ("peer_unreachable", "egress_ack_failed", "egress_apply_rejected", "internal_error"),
              "G5.16 错误码在契约 §6 闭集内", f"code={drow.get('last_error_code')}")
        check(int(forward_row_a(tid).get("egress_node_id") or 0) == 0,
              "G5.16 远端不可达时**没有**回落本地出口节点",
              json.dumps(forward_row_a(tid)))
        reports = scalar_a("SELECT IFNULL(GROUP_CONCAT(IFNULL(tunnels,'[]')),'') FROM node_state_report;")
        check(f"tunex-{tid}-egress" not in reports,
              "G5.16 A 侧也没有出现本地出口 runtime（不回落）", reports[:160])
    finally:
        H.docker(["start", PANEL_B], allow=True, timeout=180)
        B_STOPPED = False
    check(bool(H.wait_until(lambda: http("GET", API_B, "/healthz", timeout=5)[0] == 200, timeout=90, interval=3)),
          "G5.16 B 恢复上线")

    # ── 恢复：按 (intent_id, revision) 收敛 ──
    def _converged() -> bool:
        r = placement_row_a(B_PANEL_ID, intent_id)
        return r.get("state") == "active" and r.get("applied_revision") == r.get("desired_revision")

    check(bool(H.wait_until(_converged, timeout=180, interval=5)),
          "G5.16 恢复后按 (intent_id, revision) 收敛（applied 追上 desired）",
          json.dumps(placement_row_a(B_PANEL_ID, intent_id)))
    check(remote_lease_for_b(f"fw-{tid}").get("state") == "active",
          "G5.16 恢复后 B 侧租约仍是同一条 active", json.dumps(remote_lease_for_b(f"fw-{tid}")))
    # 入口腿重建是**异步**的（要等一次 rollout 收敛）：这里等"active 且数据面通"，
    # 而不是"某一瞬间必须 active"。中间态（apply_status=error → resume）是如实的，不是失败。
    ok_back = H.wait_until(lambda: ingress_probe(port)[0], timeout=180, interval=5)
    _, detail_back = ingress_probe(port)
    local_runtimes = scalar_a("SELECT IFNULL(GROUP_CONCAT(IFNULL(tunnels,'[]')),'') FROM node_state_report;")
    check(ok_back, "G5.16 恢复后数据面重新可用（同一条链路）",
          f"{detail_back} tunnel={json.dumps(forward_row_a(tid))} local_runtimes={local_runtimes[:200]}")


def g5_19_no_silent_lie_after_lease_expiry():
    """远端租约在**停机期间**过期（>TTL）之后：Forward 不许继续声称 active。

    与 G5.16 的分工：G5.16 是"短分区（<TTL）→ 恢复 → 收敛 + 数据面回来"；
    这里刻意制造"租约在对面不可达时到期"，因为这两件事在契约里是分开的（§3.2 到期停服 +
    home 标 expired；§5 矩阵）。真正要防的是**静默的假活**：`tunnel.apply_status=active`、
    而远端腿早已 expired、数据面连不上 —— 那是一种用户看得见、系统不承认的故障。

    做法：先只留一条 60s 到期的 grant（租约 expires_at = min(grant, now+300) ≈ 60s），
    然后立刻停掉 B，等到 host 侧租约离开 live；再起 B，观察 home 侧对账后的最终事实。
    """
    global B_STOPPED
    if not (A_PANEL_ID and B_PANEL_ID and B_NODE_DB_ID):
        H.record(False, "G5.19 前置缺失，本条无法执行")
        return
    revoke_all_active_grants()
    _sg, grant = create_grant(
        A_PANEL_ID, {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 3}, workspace_id=B_WS_ID, expires_in_seconds=60,
    )
    check(bool((grant or {}).get("grant_ref")), "G5.19 准备 60s 到期的 grant（让租约在停机窗口内过期）",
          json.dumps(grant)[:160])
    status, data = create_federated_forward(f"{FIXTURE_PREFIX}-fedfw-lie", B_PANEL_ID)
    tid = int((data or {}).get("id") or 0)
    check(status in (200, 201) and tid > 0, "G5.19 建一条声明远端出口的 Forward",
          f"status={status} body={json.dumps(data)[:200]}")
    if tid <= 0:
        return
    row = forward_row_a(tid)
    intent_id = f"fw-{tid}-{row.get('config_revision')}"
    check(bool(H.wait_until(lambda: placement_row_a(B_PANEL_ID, intent_id).get("state") == "active",
                            timeout=120, interval=4)),
          "G5.19 远端腿先真的 active", json.dumps(placement_row_a(B_PANEL_ID, intent_id)))
    port = int(row.get("listen_port") or 0)
    ok_before = H.wait_until(lambda: ingress_probe(port)[0], timeout=90, interval=4)
    check(ok_before, "G5.19 停机前数据面是通的（否则后面的断言没有对照）", ingress_probe(port)[1])

    try:
        H.docker(["stop", PANEL_B], allow=True, timeout=180)
        B_STOPPED = True
        # 让租约在对面不可达时到期（60s grant ⇒ 租约 ≤60s）
        expired_while_down = H.wait_until(
            lambda: remote_lease_for_b(f"fw-{tid}").get("state") not in ("reserved", "active"),
            timeout=200, interval=6)
        check(expired_while_down, "G5.19 租约在 B 停机期间离开 live 状态（host 侧 fail-closed）",
              json.dumps(remote_lease_for_b(f"fw-{tid}")))
    finally:
        H.docker(["start", PANEL_B], allow=True, timeout=180)
        B_STOPPED = False
    check(bool(H.wait_until(lambda: http("GET", API_B, "/healthz", timeout=5)[0] == 200, timeout=120, interval=3)),
          "G5.19 B 恢复上线")

    # 给 home 侧对账留一拍，然后读**最终事实**。
    H.wait_until(lambda: placement_row_a(B_PANEL_ID, intent_id).get("state") in
                 ("expired", "revoked", "failed", "active"), timeout=180, interval=6)

    # 诚实性要求是"**最终**不得继续声称 active"，而不是"某一瞬间必须已经是 error"：
    # 可见状态的收口由 worker 的 30s 一拍驱动（placement 到期 → 健康收口），所以这里等一个
    # 上界（180s ≈ 6 拍），等的是"要么数据面真的通了、要么不再声称 active"。
    # 采样单一时刻会把"还没轮到"读成产品缺陷 —— 那是门禁自己的错，与"永远不纠正"必须区分开。
    def _honest() -> bool:
        return ingress_probe(port)[0] or forward_row_a(tid).get("apply_status") != "active"

    honest = H.wait_until(_honest, timeout=180, interval=6)
    final_tunnel = forward_row_a(tid)
    final_place = placement_row_a(B_PANEL_ID, intent_id)
    _, probe_detail = ingress_probe(port)
    check(honest,
          "G5.19 远端腿已过期且数据面不通时，Forward **不得**继续声称 active（不许静默假活）",
          f"tunnel={json.dumps(final_tunnel)} placement={json.dumps(final_place)} probe={probe_detail}")

    status_del, resp_del, _ = H.req("DELETE", f"/api/forwards/{tid}", None, timeout=240)
    check(status_del == 200, "G5.19 清理这条 Forward fixture",
          f"status={status_del} body={json.dumps(unwrap(resp_del))[:160]}")
    if tid in FED_FORWARD_IDS:
        FED_FORWARD_IDS.remove(tid)


def g5_17_federated_forward_release():
    if not FED_FORWARD_IDS:
        H.record(False, "G5.17 前置缺失（G5.16 没有建成 Forward fixture），本条无法执行")
        return
    tid = FED_FORWARD_IDS[-1]
    fwd_ref = f"fw-{tid}"
    before = remote_lease_for_b(fwd_ref)
    lease_ref = str(before.get("lease_ref") or "")
    port = int(before.get("port") or 0)
    status, resp, _ = H.req("DELETE", f"/api/forwards/{tid}", None, timeout=240)
    check(status == 200, "G5.17 删除声明远端出口的 Forward", f"status={status} body={json.dumps(unwrap(resp))[:200]}")

    rel = H.wait_until(
        lambda: remote_lease_for_b(fwd_ref).get("state") in ("released", "revoked", "expired"),
        timeout=180, interval=5)
    check(rel, "G5.17 删除后远端租约被释放（不是留成 active 的孤儿）",
          json.dumps(remote_lease_for_b(fwd_ref)))
    if port:
        check(bool(H.wait_until(lambda: port_lease_status(B_NODE_DB_ID, port).startswith("released"),
                                timeout=120, interval=4)),
              "G5.17 远端端口归还（node_port_lease 置 released）",
              f"port={port} {port_lease_status(B_NODE_DB_ID, port)}")
    if lease_ref:
        check(bool(H.wait_until(lambda: not b_runtime_reported(lease_ref), timeout=150, interval=6)),
              "G5.17 远端 runtime 从节点上报里消失（无孤儿）",
              f"runtime=tunex-fed-{lease_ref}-egress")
    prow = placement_row_a(B_PANEL_ID, f"fw-{tid}-{before.get('requested_revision')}")
    check(not prow or prow.get("state") in ("expired", "revoked", "failed") or prow.get("applied_revision") < 0,
          "G5.17 home 侧 placement 不再声称这条远端腿还 active", json.dumps(prow))
    check(FED_FORWARD_IDS.count(tid) == 1, "G5.17 fixture 记账一致")
    FED_FORWARD_IDS.remove(tid)


def g5_18_federated_forward_lease_expiry():
    """远端租约到期 → host 停服 + home 账本标 expired。

    这是第一轮 G5.5「home 标 expired」那条 FAIL 的正解：只有在 Forward 级路径上，
    home 侧才有账本行可以标。为了让 rollout 能解析到 grant（它不带 grant_ref），
    本场景先把该 peer 上其它 active grant 全部撤销，只留一条 60s 的。
    """
    if not (A_PANEL_ID and B_PANEL_ID and B_NODE_DB_ID):
        H.record(False, "G5.18 前置缺失，本条无法执行")
        return
    revoked = revoke_all_active_grants()
    status, grant = create_grant(
        A_PANEL_ID, {"node_group_ids": [B_GROUP_ID], "hop_roles": ["egress"], "allow_target_policy": None},
        {"max_legs": 3}, workspace_id=B_WS_ID, expires_in_seconds=60,
    )
    grant_ref = str((grant or {}).get("grant_ref") or "")
    check(bool(grant_ref), "G5.18 只留一条 60s 到期的 egress grant 供 rollout 解析",
          f"revoked_others={revoked} status={status} body={json.dumps(grant)[:160]}")
    if not grant_ref:
        return

    st_fw, data = create_federated_forward(f"{FIXTURE_PREFIX}-fedfw-exp", B_PANEL_ID)
    tid = int((data or {}).get("id") or 0)
    check(st_fw in (200, 201) and tid > 0, "G5.18 建一条声明远端出口的 Forward",
          f"status={st_fw} body={json.dumps(data)[:200]}")
    if tid <= 0:
        return
    row = forward_row_a(tid)
    intent_id = f"fw-{tid}-{row.get('config_revision')}"
    active = H.wait_until(lambda: placement_row_a(B_PANEL_ID, intent_id).get("state") == "active",
                          timeout=150, interval=4)
    prow = placement_row_a(B_PANEL_ID, intent_id)
    check(active, "G5.18 远端腿先真的 active（否则到期断言没有对象）", json.dumps(prow))
    lease_ref = str(prow.get("lease_ref") or "")
    check(bool(lease_ref), "G5.18 拿到 host 的 lease_ref", json.dumps(prow))

    # host 侧到期（grant 60s ⇒ 租约 ≤60s）
    host_expired = H.wait_until(
        lambda: remote_lease_for_b(f"fw-{tid}").get("state") in ("expired", "released"), timeout=240, interval=6)
    check(host_expired, "G5.18 到期后 host 主动停服（租约离开 live 状态）",
          json.dumps(remote_lease_for_b(f"fw-{tid}")))
    if lease_ref:
        check(bool(H.wait_until(lambda: not b_runtime_reported(lease_ref), timeout=150, interval=6)),
              "G5.18 到期后 host 侧 runtime 消失", f"runtime=tunex-fed-{lease_ref}-egress")
    # home 侧账本必须跟上（这是本轮真正要证的）
    home_followed = H.wait_until(
        lambda: placement_row_a(B_PANEL_ID, intent_id).get("state") in ("expired", "revoked", "failed"),
        timeout=240, interval=6)
    hrow = placement_row_a(B_PANEL_ID, intent_id)
    check(home_followed, "G5.18 home 侧 placement 跟到终态（不是永远 active 的幽灵账本）",
          json.dumps(hrow))
    check(str(hrow.get("state") or "") != "active",
          "G5.18 home 侧不再声称这条远端腿还活着", json.dumps(hrow))

    status_del, resp_del, _ = H.req("DELETE", f"/api/forwards/{tid}", None, timeout=240)
    check(status_del == 200, "G5.18 清理这条 Forward fixture",
          f"status={status_del} body={json.dumps(unwrap(resp_del))[:160]}")
    if tid in FED_FORWARD_IDS:
        FED_FORWARD_IDS.remove(tid)


# ---------------------------------------------------------------------------
# G5.14 audit completeness / G5.15 usage
# ---------------------------------------------------------------------------

def g5_14_audit_completeness():
    if not (A_PANEL_ID and B_PANEL_ID):
        H.record(False, "G5.14 前置缺失，本条无法执行")
        return
    db_a = H.parse_env(H.ENVF).get("MYSQL_DATABASE", "tunex")
    a_rows = federation_audit_count(db_a, B_PANEL_ID) + federation_audit_count(db_a, A_PANEL_ID)
    b_rows = federation_audit_count(DB_B, A_PANEL_ID) + federation_audit_count(DB_B, B_PANEL_ID)
    check(a_rows > 0, "G5.14 A 侧有联邦审计行", f"rows={a_rows}")
    check(b_rows > 0, "G5.14 B 侧有联邦审计行", f"rows={b_rows}")
    a_msgs = federation_audit_with_message(db_a, A_PANEL_ID) + federation_audit_with_message(db_a, B_PANEL_ID)
    b_msgs = federation_audit_with_message(DB_B, A_PANEL_ID) + federation_audit_with_message(DB_B, B_PANEL_ID)
    check(a_msgs > 0, "G5.14 A 侧的跨面板变更审计带 message_id（可两侧互查）", f"rows_with_message={a_msgs}")
    check(b_msgs > 0, "G5.14 B 侧的跨面板变更审计带 message_id", f"rows_with_message={b_msgs}")

    # 两侧都要有"每个变更各一条"的证据：按 action 分类统计（不要求数量相等，方向不同）
    actions_b = mysql_on(DB_B, "SELECT GROUP_CONCAT(DISTINCT action) FROM audit_log WHERE action LIKE 'FEDERATION %';")
    actions_a = mysql_on(db_a, "SELECT GROUP_CONCAT(DISTINCT action) FROM audit_log WHERE action LIKE 'FEDERATION %';")
    check("FEDERATION admin.grant" in actions_b or "FEDERATION grant.create" in actions_b,
          "G5.14 B 侧记录了 grant 变更审计", str(actions_b)[:220])
    check("FEDERATION lease" in actions_b, "G5.14 B 侧记录了 lease 变更审计", str(actions_b)[:220])
    check("FEDERATION " in str(actions_a), "G5.14 A 侧记录了联邦动作审计", str(actions_a)[:220])


def g5_15_usage():
    if not A_PANEL_ID:
        H.record(False, "G5.15 前置缺失，本条无法执行")
        return
    base_win = 1_760_000_000  # 固定 epoch 秒，避免依赖当前时间
    lease_ref = f"{FIXTURE_PREFIX}-usage-lease"
    rows_before = int(scalar_a("SELECT COUNT(*) FROM federation_usage_record;") or 0)

    def report(usage_id, start_offset, bi, bo, conn):
        return {
            "usage_id": usage_id,
            "lease_ref": lease_ref,
            "forward_ref": f"{FIXTURE_PREFIX}-usage-forward",
            "window_start": base_win + start_offset,
            "window_end": base_win + start_offset + 300,
            "bytes_in": bi,
            "bytes_out": bo,
            "connections": conn,
        }

    u1 = f"{FIXTURE_PREFIX}-u1"
    status1, body1, _ = fed_call(PANEL_B, API_A, "POST", "/api/federation/v1/usage", {"report": report(u1, 0, 100, 200, 3)})
    check(status1 == 200, "G5.15 host 上报一个窗口的用量", f"status={status1} {json.dumps(body1)[:200]}")
    check(int(scalar_a("SELECT COUNT(*) FROM federation_usage_record WHERE usage_id='%s';" % u1) or 0) == 1,
          "G5.15 该窗口落库一条事实")
    stored_bytes_in = scalar_a("SELECT bytes_in FROM federation_usage_record WHERE usage_id='%s';" % u1)
    check(stored_bytes_in == "100", "G5.15 计数原样落库（不被 home 侧改写/估算）",
          f"bytes_in={stored_bytes_in}")

    # 重复投递：按 usage_id 去重，不重复计数
    status2, body2, _ = fed_call(PANEL_B, API_A, "POST", "/api/federation/v1/usage", {"report": report(u1, 0, 100, 200, 3)})
    check(status2 == 200, "G5.15 重复 usage_id 被幂等吸收", f"status={status2} {json.dumps(body2)[:160]}")
    check(int(scalar_a("SELECT COUNT(*) FROM federation_usage_record WHERE usage_id='%s';" % u1) or 0) == 1,
          "G5.15 重复投递没有落第二行")

    # 乱序：更早的窗口后到 → 两个窗口各自留事实，互不覆盖
    status3, body3, _ = fed_call(PANEL_B, API_A, "POST", "/api/federation/v1/usage",
                                 {"report": report(f"{FIXTURE_PREFIX}-u0", -300, 7, 8, 1)})
    check(status3 == 200, "G5.15 乱序到达的更早窗口被安全吸收", f"status={status3} {json.dumps(body3)[:160]}")
    rows_for_lease = int(scalar_a("SELECT COUNT(*) FROM federation_usage_record WHERE lease_ref='%s';" % lease_ref) or 0)
    check(rows_for_lease == 2, "G5.15 两个窗口都在（乱序不覆盖、不丢）", f"rows={rows_for_lease}")
    rows_now = int(scalar_a("SELECT COUNT(*) FROM federation_usage_record;") or 0)
    check(rows_now == rows_before + 2,
          "G5.15 没有为**没有上报**的窗口补 0（不知道不是零流量）",
          f"{rows_before} -> {rows_now}")

    # 非法 report：未知键/时间窗倒置必须 fail-closed
    bad = report(f"{FIXTURE_PREFIX}-bad", 0, 1, 1, 1)
    bad["unknown_key"] = "x"
    status4, body4, _ = fed_call(PANEL_B, API_A, "POST", "/api/federation/v1/usage", {"report": bad})
    check(status4 == 400 and code_of(body4) == "message_malformed",
          "G5.15 含未知键的用量报告 fail-closed 拒绝（不做宽松解析）",
          f"status={status4} code={code_of(body4)}")


# ---------------------------------------------------------------------------

def code_provenance() -> str:
    """这一轮读数到底是**哪一版代码**跑出来的。

    上一轮的教训：镜像比 checkout 旧，绿灯就变成了"验过的东西"与"相信的东西"不一致。
    所以把 checkout 的 commit + 镜像 ID/构建时间 + 两个面板容器实际用的镜像写进证据头部。
    """
    try:
        commit = H.run(["git", "-C", str(HERE.resolve().parent.parent), "rev-parse", "--short", "HEAD"],
                       allow=True, timeout=60)
    except Exception:  # noqa: BLE001 - 容器里可能没有 git；证据头不能因此崩掉整轮
        commit = "(git 不可用)"
    try:
        image = H.docker(["image", "inspect", "wp14-backend:ci", "--format", "{{.Id}} {{.Created}}"],
                         allow=True, timeout=60)
        panels = {}
        for name in (PANEL_A, PANEL_B):
            panels[name] = H.docker(
                ["inspect", "-f", "{{.Image}} started={{.State.StartedAt}}", name], allow=True, timeout=60)
    except Exception as exc:  # noqa: BLE001
        return f"checkout_commit={commit or 'unknown'}\nimage=unavailable ({exc})"

    # **源码指纹**：容器里实际跑的 `src/` 清单哈希。为什么必须有它：
    # 镜像 digest 只能证明"跑的是某个镜像"，证明不了"那个镜像是这个 checkout 建的"。
    # 实测踩过一次：同步时把 runner 的 /repo 用另一个容器的**旧副本**覆盖了，
    # 于是整轮读数都是旧代码跑出来的，而镜像 digest 看起来完全正常。
    # 把两侧容器里 `src/` 的清单哈希写进证据，读数与代码的对应关系就变成可核对的。
    # 门禁脚本**自己**的指纹：和 panel_src_manifest 同一个道理 —— 读数必须能对上脚本版本。
    # 踩过一次"改了脚本但没同步进 runner，于是跑的是旧脚本"，症状与"产品行为不一致"无法区分。
    try:
        self_md5 = hashlib.md5(Path(__file__).read_bytes()).hexdigest()
    except Exception:  # noqa: BLE001
        self_md5 = "unavailable"

    manifests = {}
    for name in (PANEL_A, PANEL_B):
        manifests[name] = H.docker(
            ["exec", name, "sh", "-c", "cd /app && find src -type f | sort | xargs md5sum | md5sum"],
            allow=True, timeout=120).strip()
    return (
        f"checkout_commit={commit or 'unknown'}\n"
        f"image={image}\n"
        f"containers={json.dumps(panels, ensure_ascii=False)}\n"
        f"panel_src_manifest={json.dumps(manifests, ensure_ascii=False)}\n"
        f"gate_script_md5={self_md5}"
    )


def main():
    signal.signal(signal.SIGALRM, H.alarm)
    ready = False
    try:
        signal.setitimer(signal.ITIMER_REAL, min(300, OVERALL_SECONDS))
        H.acquire_lock()
        setup()
        ready = True
        signal.setitimer(signal.ITIMER_REAL, 0)
        for name, fn, budget in [
            ("G5.1 normal grant/use/revoke", g5_1_normal_grant_use_revoke, 480),
            ("G5.2 credential rotate", g5_2_credential_rotate, 300),
            ("G5.4 quota exhaustion", g5_4_quota_exhaustion, 300),
            ("G5.9 duplicate messages", g5_9_duplicate_messages, 300),
            ("G5.10 reordered messages", g5_10_reordered_messages, 300),
            ("G5.11 partial failure", g5_11_partial_failure, 300),
            # Forward 级（home 侧 placement 的正解）先跑：G5.12 要拿它建的账本行做对账断言
            ("G5.16 federated Forward use/degrade/recover", g5_16_federated_forward_use, 900),
            ("G5.12 reconnect reconcile", g5_12_reconnect_reconcile, 420),
            ("G5.13 cross-tenant isolation", g5_13_cross_tenant_isolation, 300),
            ("G5.15 usage", g5_15_usage, 300),
            ("G5.6 Panel B offline", g5_6_panel_b_offline, 420),
            ("G5.5 lease expiry", g5_5_lease_expiry, 480),
            ("G5.7 Panel A offline", g5_7_panel_a_offline, 600),
            ("G5.8 network partition", g5_8_network_partition, 720),
            ("G5.18 federated Forward lease expiry", g5_18_federated_forward_lease_expiry, 900),
            ("G5.19 no silent lie after lease expiry", g5_19_no_silent_lie_after_lease_expiry, 900),
            ("G5.17 federated Forward release", g5_17_federated_forward_release, 600),
            ("G5.14 audit completeness", g5_14_audit_completeness, 240),
            ("G5.3 credential revoke", g5_3_credential_revoke, 600),
        ]:
            case(name, fn, budget)
    except Exception as exc:  # noqa: BLE001
        H.record(False, f"G5 prerequisite/setup: {type(exc).__name__}: {exc}; remaining tests NOT EXECUTED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.setitimer(signal.ITIMER_REAL, 300)
        try:
            cleanup()
        except Exception as exc:  # noqa: BLE001
            H.record(False, f"G5.cleanup: {type(exc).__name__}: {exc}")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        RESULT.write_text(
            "# V5-G5 two-panel federation gate (WP14/WP15/WP16)\n"
            f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
            f"topology: A={API_A} (home) B={API_B} (host, container wp14-panel-b, db {DB_B})\n"
            f"fixture: {FIXTURE_PREFIX}; setup={'executed' if ready else 'incomplete'}\n"
            + code_provenance() + "\n"
            f"elapsed_seconds: {int(time.monotonic() - START)}\n"
            + "\n".join(H.RESULTS)
            + f"\nV5-G5 TOTAL PASS={H.PASS} FAIL={H.FAIL}\n",
            encoding="utf-8",
        )
        H.release_lock()
        print(f"V5-G5 TOTAL PASS={H.PASS} FAIL={H.FAIL} evidence={RESULT}", flush=True)
    return 1 if H.FAIL or not ready else 0


if __name__ == "__main__":
    raise SystemExit(main())
