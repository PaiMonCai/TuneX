#!/usr/bin/env python3
"""V5-G6 gate — DDNS 前门（契约 `docs/v5-wp17-entry-exit-group-ddns-contract.md` §5 WP17.5）。

断言的七条性质（契约 §6 DoD + 「F4 更正」的 Lead 裁决口径）：

  G6.1  未开 `auto_resolve` ⇒ **零外呼**，绑定状态仍是 `pending`
  G6.2  开启后 ⇒ **恰好写一次**，值 = owner 的 `connect_ip`，读回一致 ⇒ `synced`
  G6.3  **安全断言**：值集里**不含任何非 owner 的节点地址**
        （把不服务这条转发的机器写进 A 记录 = 把大约一半客户端送进黑洞；
         `multi_entry` 今天与 `single_active` 算出同一值集 —— 见契约 F4 更正第 2/3 条）
  G6.4  非 owner 的入口节点**上下线** ⇒ **零 DNS 写**（值集未变）
  G6.5  **归属迁移**（`ingress_node_id` 改变）⇒ 值集跟随新 owner，且在
        `DDNS_SYNC_DEADLINE_MS`（120s）内落定
  G6.6  **禁止假成功**：读回与期望不一致 ⇒ 状态是 `synced_unverified`，**不是** `synced`
  G6.7  **就绪闸门**：DNS 路径不可用 + `auto_failover` 打开 ⇒ 扫描**不迁移**、
        epoch 不变、原因可见（`dns_path_unready`）

触发器是 worker **既有**的 reconcile 节拍（`cron_reconcile_v3`，约 30s 一拍）：本门禁
**不新增定时器**，也不把 DNS 下发给 Agent。因此每条断言都是"等一拍"或"等
`DDNS_SYNC_DEADLINE_MS`"，而不是 sleep 一个猜出来的秒数。

## 为什么需要一个 stub provider（而不是打公共 DNS）

契约 §7 冻结：provider 用 **endpoint 覆盖** 指向 Gate 自带的 stub，**不新增
`DNSProviderType` 枚举值**、不访问公共 DNS。stub 跑在本门禁进程里（runner），
面板经控制网访问它的 `GET /records` / `POST /records` —— 于是"写了没有、写了什么、
读回是什么"三个事实都在测试进程里可直接观测，而且**零出网**。

## 做不到的断言（明写，不硬编）

契约「F4 更正」把 DoD 1 的"两个地址 + 客户端用另一个连通"明确移出本 WP：今天
`Tunnel.ingress_node_id` 是**单一 owner**，全仓没有"一条转发由多个入口同时服务"的机制，
所以值集只可能有一个元素。本门禁**不**为它写一条会假通过的断言（例如"往组里凑节点"），
只断言"值集 = 真在服务的地址、且不含任何非 owner 的机器"。同一条记录的完整理由见契约
「F4 更正」与 WP17.5 交付记录。

## 运行前提

* 自动解析的执行挂在 **failover 扫描**的逐条循环里，而扫描在
  `FAILOVER_POLICY` 两个开关都为 false 时**提前返回** ⇒ 策略关闭时 `auto_resolve`
  不产生任何同步。本门禁在 setup 里显式打开 `auto_failover`（并在 cleanup 还原），
  这是"让 DNS 同步真的发生"的前置条件，G6.0 把它当成**事实**断言出来。
* Gate 通过 `docker cp` 进入 runner；**不要** bind mount 宿主路径（runner 通过挂载的
  socket 调 docker，daemon 只看得到宿主路径）。

FAIL > 0 表示 WP17.5 未闭合。拓扑缺失、超时、前置条件失败、清理失败都算 FAIL，绝不 skip。
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import signal
import socket
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_g1a():
    """复用 V5-G1A 的 harness（登录 / API / mysql / docker / 等待 / 夹具清理）。

    与 G1B 同一条理由：两份 helper 就是两份会漂移的真相。本门禁关心的是 DDNS 语义，
    不是"怎么登录"。
    """
    spec = importlib.util.spec_from_file_location("v5_g1a_harness", HERE / "v5-g1a.py")
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise SystemExit("cannot load scripts/v3-e2e/v5-g1a.py as the harness module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


H = _load_g1a()

OUT = HERE / "evidence"
OUT.mkdir(exist_ok=True)
RESULT = OUT / "v5-g6-result.txt"
TRACE = OUT / "v5-g6-http.json"

# 门禁自己跑在哪个容器里 / 要停哪个 Agent：单一说法，避免"换了个名字就静默取到空值"。
WORKER_CONTAINER = os.environ.get("G6_WORKER", "b2x-worker")
PANEL_CONTAINER = H.PANEL_CONTAINER
# 非 owner 的入口节点（state.json 的 `ingress_secondary`）由它承载。
INGRESS_B_CONTAINER = os.environ.get("G6_INGRESS_B", "b2x-ingress-agent-b")

FIXTURE_PREFIX = f"V5-G6-{int(time.time())}"
OVERALL_SECONDS = int(os.environ.get("G6_OVERALL_SECONDS", "1800"))
START = time.monotonic()

# 契约 §6：一次同步的期限（与退避阶梯不是一回事）。
DDNS_SYNC_DEADLINE_MS = 120_000
DDNS_DEADLINE_S = DDNS_SYNC_DEADLINE_MS // 1000 + 10
# 一拍 = `cron_reconcile_v3`（30s）。等两拍足以覆盖"失败一拍、下一拍再来"的形状。
TICK_SECONDS = 30
DEADLINE_TICKS = 2
WAIT_TICKS_S = TICK_SECONDS * DEADLINE_TICKS + 45

# 非 owner 节点的地址（用于 G6.3 的安全断言）。运行期从库里取，这里只留接口。
NON_OWNER_DECOY = "203.0.113.9"  # 读回不一致模式下的诱饵值（RFC 5737 文档地址）

# 观察（不是断言）：进证据头，不进 PASS/FAIL 计数 —— 把"发现的形状"与"冻结的要求"分开，
# 才不会有一天把观察静悄悄升格成要求。
OBSERVATIONS: dict[str, object] = {}


def record(passed: bool, message: str) -> None:
    H.record(passed, message)


def check(condition, message, detail=""):
    record(bool(condition), message if condition or not detail else f"{message} [{detail}]")


def case(name: str, fn, seconds: int):
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        fn()
    except Exception as exc:  # noqa: BLE001 - a case failure is a gate failure
        record(False, f"{name}: {type(exc).__name__}: {exc}")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


# ---------------------------------------------------------------------------
# stub provider —— 唯一的"第三方 DNS"，跑在门禁进程里
# ---------------------------------------------------------------------------

class DdnsStub:
    """一个最小的权威 DNS 记录集 API，形状就是契约 §5 WP17.3 冻结的那两条：

        GET  /records?domain=&type=   → {"values": [...]}
        POST /records                 → 记账 + 应用

    它**只实现这一个窄契约**，不模仿任何厂商的真实 API：契约 F6 明确不新增 provider
    类型，而"值集规划 / 读回 / 退避"这些与厂商无关的部分才是本 WP 要证明的东西。

    三个测试专用的开关，都是**测试进程内的属性**（不需要另外开 HTTP 端点 ——
    多一个控制面就多一个能被误用的表面）：
      · `writes`   写日志：用来断言"零写"（G6.1 / G6.4 / G6.7）
      · `records`  当前记录集：用来断言"值集是什么"（G6.2 / G6.3 / G6.5）
      · `mismatch` 读回不一致模式：写入照常应用，但 GET 返回一个诱饵
                   —— 这正是"provider 接受了写入"与"记录真的对了"之间的那道缝
                   （契约 D2/F7 的禁止假成功）。

    **HTTP/1.0（无 keep-alive）**保证 `stop()` 后新请求真实不可达；`dead` 对已建立连接
    返回 503。两层共同保证 provider-down 场景不是连接池假象。
    """

    def __init__(self) -> None:
        self.records: dict[tuple[str, str], list[str]] = {}
        self.writes: list[dict] = []
        self.reads = 0
        self.mismatch = False
        self.dead = False
        self._lock = threading.Lock()
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.port = 0

    # ── 生命周期 ──────────────────────────────────────────────────────────
    def start(self) -> None:
        self.dead = False
        httpd = ThreadingHTTPServer(("0.0.0.0", self.port), _stub_handler)
        httpd.daemon_threads = True
        self.port = httpd.server_address[1]
        self._httpd = httpd
        self._thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        # 先立起 `dead`（对已经建立的连接回 503 + 关连接），再关监听套接字。
        self.dead = True
        httpd, self._httpd = self._httpd, None
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    @property
    def running(self) -> bool:
        return self._httpd is not None

    # ── 记录集（测试视角） ────────────────────────────────────────────────
    def values(self, domain: str, record_type: str = "A") -> list[str]:
        with self._lock:
            return list(self.records.get((domain.lower(), record_type.upper()), []))

    def write_count(self, domain: str | None = None, record_type: str | None = None) -> int:
        with self._lock:
            rows = list(self.writes)
        if domain is None:
            return len(rows)
        return sum(
            1
            for w in rows
            if w["domain"] == domain.lower() and (record_type is None or w["type"] == record_type.upper())
        )

    def written_values(self, domain: str | None = None) -> list[str]:
        """所有写请求里出现过的地址（去重、排序）—— G6.3 的安全断言用它。"""
        with self._lock:
            rows = list(self.writes)
        out: set[str] = set()
        for w in rows:
            if domain is not None and w["domain"] != domain.lower():
                continue
            out.update(w["values"])
        return sorted(out)

    # ── HTTP 面（面板/worker 视角） ───────────────────────────────────────
    def _handle_get(self, query: dict) -> tuple[int, dict]:
        domain = (query.get("domain") or "").strip().lower()
        record_type = (query.get("type") or "A").strip().upper()
        with self._lock:
            self.reads += 1
            if self.mismatch:
                # 写入照常应用（records 是真的），但读回撒谎：provider 说"当前是别的值"。
                return 200, {"values": [NON_OWNER_DECOY]}
            return 200, {"values": list(self.records.get((domain, record_type), []))}

    def _handle_post(self, body: dict) -> tuple[int, dict]:
        domain = str(body.get("domain") or "").strip().lower()
        record_type = str(body.get("type") or "A").strip().upper()
        values = [str(v).strip() for v in (body.get("values") or []) if str(v).strip()]
        if not domain or not record_type:
            return 400, {"error": "domain/type required"}
        with self._lock:
            self.writes.append(
                {
                    "domain": domain,
                    "type": record_type,
                    "values": values,
                    "ttl": body.get("ttl"),
                    "zone": body.get("zone"),
                    "at": time.time(),
                }
            )
            self.records[(domain, record_type)] = list(values)
        return 200, {"ok": True, "values": values}


def _stub_handler_factory():
    class Handler(BaseHTTPRequestHandler):
        # 无 keep-alive：`stop()` 之后必须"真的连不上"（见 DdnsStub 的注释）。
        protocol_version = "HTTP/1.0"

        def log_message(self, *args):  # 测试替身不该往门禁输出里灌访问日志
            return

        def _respond(self, status: int, payload: dict) -> None:
            raw = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.send_header("connection", "close")
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler 的接口名
            if STUB.dead:
                self._respond(503, {"error": "stub stopped"})
                return
            path, _, raw_query = self.path.partition("?")
            if path != "/records":
                self._respond(404, {"error": "not found"})
                return
            query: dict[str, str] = {}
            for pair in raw_query.split("&"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    query[_unquote(k)] = _unquote(v)
            status, payload = STUB._handle_get(query)
            self._respond(status, payload)

        def do_POST(self):  # noqa: N802
            if STUB.dead:
                self._respond(503, {"error": "stub stopped"})
                return
            path = self.path.split("?", 1)[0]
            if path != "/records":
                self._respond(404, {"error": "not found"})
                return
            length = int(self.headers.get("content-length") or 0)
            try:
                body = json.loads(self.rfile.read(length).decode() or "{}")
            except Exception:  # noqa: BLE001
                self._respond(400, {"error": "bad json"})
                return
            status, payload = STUB._handle_post(body)
            self._respond(status, payload)

    return Handler


def _unquote(value: str) -> str:
    from urllib.parse import unquote_plus

    return unquote_plus(value)


STUB = DdnsStub()
_stub_handler = _stub_handler_factory()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def runner_ctrl_ip() -> str:
    """runner 在**控制网**上的地址。

    面板只能从控制网访问 stub（它不接数据网），所以这不是"随便取一个本机地址"：
    取错地址的表现是 provider 永远写不通，而那看起来像产品问题。
    """
    out = subprocess.run(["hostname", "-i"], capture_output=True, text=True, timeout=30).stdout
    prefix = os.environ.get("G6_CTRL_PREFIX", "172.41.0.")
    for candidate in out.split():
        if candidate.startswith(prefix):
            return candidate
    return ""


def worker_logs(since_epoch: float | None = None) -> str:
    """Read worker logs since a timestamp, including stdout and stderr.

    Use RFC3339 UTC and a two-second cushion so second-level truncation cannot drop
    the first line in the assertion window.
    """
    args = ["docker", "logs"]
    if since_epoch is not None:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(max(0.0, since_epoch - 2.0)))
        args += ["--since", stamp]
    args.append(WORKER_CONTAINER)
    proc = subprocess.run(args, text=True, capture_output=True, timeout=180)
    return (proc.stdout or "") + (proc.stderr or "")


def ticks_since(since_epoch: float) -> int:
    """自 `since_epoch` 起 worker 完成的 reconcile 拍数。

    用 worker 自己的节拍计数（`cron_reconcile_v3 ok`）而不是 sleep 一个猜出来的秒数：
    "等一拍"这件事只有节点进程自己说了算。
    """
    return worker_logs(since_epoch).count("cron_reconcile_v3 ok")


def wait_ticks(n: int, timeout: float = WAIT_TICKS_S * 2) -> int:
    t0 = time.time()
    end = t0 + timeout
    seen = 0
    while time.time() < end:
        seen = ticks_since(t0)
        if seen >= n:
            return seen
        time.sleep(5)
    return seen


def gated_lines(since_epoch: float, tunnel_id: int) -> list[str]:
    """worker 日志里"因 DNS 路径不可用而没迁移"的行（按 tunnel 过滤）。

    过滤用**词边界**而不是子串：`"tunnel_id":9` 是 `"tunnel_id":93` 的前缀，用 `in`
    会把别的转发的闸门算成这一条 —— 而这类错误只会让断言**更容易通过**，是最坏的一种。
    （第一版就是这个前缀 bug，是拿一段合成日志跑出来的。）
    """
    pattern = re.compile(r'"tunnel_id"\s*:\s*%d(?!\d)' % tunnel_id)
    return [
        line
        for line in worker_logs(since_epoch).splitlines()
        if "dns_path_unready" in line and pattern.search(line)
    ]


def tunnel_field(fid: int, column: str) -> str:
    return H.scalar(f"SELECT IFNULL(`{column}`,'') FROM tunnel WHERE id={fid};")


def owner_ip(fid: int) -> str:
    return H.scalar(
        "SELECT IFNULL(n.connect_ip,'') FROM tunnel t JOIN node n ON n.id=t.ingress_node_id "
        f"WHERE t.id={fid};"
    )


def lease_epoch(fid: int) -> str:
    return H.scalar(f"SELECT IFNULL(epoch,'') FROM placement_lease WHERE tunnel_id={fid};")


def node_ip(node_id: int) -> str:
    return H.scalar(f"SELECT IFNULL(connect_ip,'') FROM node WHERE id={node_id};")


def all_node_ips() -> dict[int, str]:
    raw = H.mysql("SELECT CONCAT(id,'|',IFNULL(connect_ip,'')) FROM node;")
    out: dict[int, str] = {}
    for line in raw.splitlines():
        if "|" in line:
            nid, ip = line.split("|", 1)
            out[int(nid)] = ip.strip()
    return out


def dns_state(fid: int) -> dict:
    status, body, _ = H.req("GET", f"/api/forwards/{fid}/dns")
    data = H.unwrap(body) if status == 200 else {}
    return data if isinstance(data, dict) else {}


def wait_dns(fid: int, predicate, timeout: float = DDNS_DEADLINE_S) -> tuple[bool, dict]:
    last: dict = {}
    end = time.time() + timeout
    while time.time() < end:
        last = dns_state(fid)
        try:
            if predicate(last):
                return True, last
        except Exception:  # noqa: BLE001 - 视图还在变（key 未出现）= 还没到
            pass
        time.sleep(4)
    return False, last


def bind_dns(fid: int, domain: str, *, auto: bool, mode: str = "single_active",
             record_type: str = "A", provider_id: int | None) -> tuple[bool, dict, str]:
    """绑定 DNS 前门 —— **只走真实 HTTP 写入口**。返回 `(是否 200, 状态投影, 备注)`。

    这里刻意**没有**"写入口不可达就自动改走 SQL"的回退：这条门禁抓到的第一个真缺陷
    正是"写入口不可达"（`POST /:id/dns` 曾被注册更早的 `POST /:id/:action` 吃掉，
    已由 `b171460` 修复，并加了类级守卫
    `backend/src/routes/__tests__/forward-route-order.test.ts`）。自动回退会把"最该红
    的那一次失败"变成一条安静的绿色 —— 那正是本仓库反复禁止的假通过。
    `plant_binding_via_sql` 因此只作**排障辅助**存在（见它的注释），任何断言都不许走它。
    """
    body = {
        "domain": domain,
        "record_type": record_type,
        "mode": mode,
        "provider_id": provider_id,
        "auto_resolve": auto,
    }
    status, resp, _ = H.req("POST", f"/api/forwards/{fid}/dns", body)
    data = H.unwrap(resp) if status == 200 else {}
    return status == 200, (data if isinstance(data, dict) else {}), f"http {status}"


def plant_binding_via_sql(fid: int, domain: str, *, auto: bool, mode: str, record_type: str,
                          provider_id: int | None) -> None:
    """**排障辅助，不是断言路径**：把绑定列直接写进库。

    与 `bindForwardDns` 的 `tunnel.update` 逐列同形（多写/少写一列，就会让"值集没变 ⇒
    零外呼"的判据因夹具与产品写法不同而给出不同答案，那种红看起来像产品缺陷）。

    它只在一种场景下有用：写入口本身不可达时，要把"DNS 运行时行为"与"HTTP 写入口"两件
    事分开排查（2026-10-05 就是这么定位到路由抢占的）。门禁**不**调用它 —— 如果哪天
    有人想让门禁"绕过"一个坏掉的写入口，请先回答契约 §8.3 的那个问题：一个没人能打开的
    写入口，算不算交付。
    """
    provider = "NULL" if provider_id is None else str(int(provider_id))
    H.mysql(
        "UPDATE tunnel SET "
        f"dns_domain='{domain}', dns_record_type='{record_type}', dns_mode='{mode}', "
        f"dns_provider_id={provider}, dns_auto_resolve={1 if auto else 0}, "
        "dns_synced_at=NULL, dns_confirmed_values=NULL, dns_verified=0, dns_last_error=NULL "
        f"WHERE id={fid};"
    )


def g6_pre_bind_route():
    """G6.PRE —— ensure the DDNS binding route is reachable and not shadowed by `POST /:id/:action`."""
    optin = FIXTURES["gate_tunnel_optin"]
    ok, data, note = bind_dns(optin["id"], optin["domain"], auto=False, provider_id=FIXTURES["provider_id"])
    check(ok, "G6.PRE `POST /api/forwards/:id/dns` reaches the DDNS binding route "
              "(it must not be shadowed by POST /:id/:action)",
          f"{note} body={json.dumps(data, ensure_ascii=False)[:200]}")
    check(data.get("state") == "pending",
          "G6.PRE a valid binding lands as `pending` (never self-declared `synced`)",
          json.dumps(data, ensure_ascii=False)[:200])
    check((data.get("expected_values") or []) == [owner_ip(optin["id"])],
          "G6.PRE the binding's suggested value set is the owner's connect_ip",
          f"view={json.dumps(data, ensure_ascii=False)[:200]}")


def create_fixture(name: str, protocol: str = "tcp", mode: str = "direct") -> tuple[int | None, int]:
    status, fid, port, resp = H.create_forward(name, protocol, mode)
    return (int(fid) if fid is not None else None), int(port or 0)


def patch_ingress(fid: int, node_id: int) -> tuple[int, dict]:
    status, resp, _ = H.req("PATCH", f"/api/forwards/{fid}", {"ingress_node_id": node_id})
    data = H.unwrap(resp) if status == 200 else {}
    return status, data if isinstance(data, dict) else {}


def set_failover_policy(value: str) -> None:
    H.mysql(f"UPDATE config SET value='{value}' WHERE name='FAILOVER_POLICY';")


def read_failover_policy() -> str:
    return H.scalar("SELECT IFNULL(value,'') FROM config WHERE name='FAILOVER_POLICY';")


# ---------------------------------------------------------------------------
# fixtures / 前置状态
# ---------------------------------------------------------------------------

FIXTURES: dict[str, dict] = {}


def setup():
    # 平台管理员：provider 的 `settings:manage` 与平台级作用域判定都看它（G1A/G1B 同一取向）。
    H.mysql(f"UPDATE user SET super_admin=1 WHERE email='{H.EMAIL}';")

    # ① 面板镜像里真的有 DDNS 代码。没有它，后面每一条断言都会"通过"得毫无意义。
    status, body, _ = H.req("GET", "/api/ddns/providers")
    check(status == 200, "G6.setup the panel serves the DDNS provider API (image rebuilt)",
          f"status={status} body={json.dumps(body, ensure_ascii=False)[:160]}")

    # ② provider 执行器的两列退避状态必须在（WP17.3 的 additive 迁移）。
    columns = H.mysql("SHOW COLUMNS FROM tunnel;")
    for column in ("dns_attempt_count", "dns_next_attempt_at", "dns_auto_resolve", "dns_confirmed_values"):
        check(column in columns, f"G6.setup tunnel.{column} exists (WP17.2/17.3 migration applied)")

    # ③ stub 起在 runner 上，并**从面板容器**里验证可达 —— "面板连不上 stub"是一类
    #    看起来像产品 bug 的环境问题，必须在写断言之前就变成一句明确的话。
    STUB.start()
    ctrl_ip = runner_ctrl_ip()
    check(bool(ctrl_ip), "G6.setup the gate knows its own address on the control network", f"ip={ctrl_ip!r}")
    if not ctrl_ip:
        raise RuntimeError("runner 没有控制网地址：stub 不可达，后续断言全部无意义")
    probe = H.docker([
        "exec", PANEL_CONTAINER, "curl", "-s", "-m", "5",
        f"http://{ctrl_ip}:{STUB.port}/records?domain=probe.tunex.test&type=A",
    ], allow=True, timeout=60)
    check('"values"' in probe, "G6.setup the panel can reach the gate's stub provider over the control network",
          f"endpoint=http://{ctrl_ip}:{STUB.port} reply={probe[:120]!r}")

    # ④ provider：endpoint 覆盖指向 stub（契约 F6：不新增 provider 类型）。
    status, resp, _ = H.req("POST", "/api/ddns/providers", {
        "name": f"{FIXTURE_PREFIX}-stub",
        "type": "cloudflare",
        "credential": {"token": "g6-gate-token", "endpoint": f"http://{ctrl_ip}:{STUB.port}"},
    })
    provider = H.unwrap(resp) if status == 201 else {}
    provider_id = int((provider or {}).get("id") or 0)
    check(status == 201 and provider_id > 0, "G6.setup a DDNS provider is created with the stub endpoint",
          f"status={status} body={json.dumps(resp, ensure_ascii=False)[:200]}")
    check(bool((provider or {}).get("has_credential")) and "config" not in json.dumps(provider or {}),
          "G6.setup the provider's credential is sealed and never echoed back",
          json.dumps(provider or {}, ensure_ascii=False)[:200])
    if not provider_id:
        raise RuntimeError("provider 创建失败：后续断言全部依赖它")

    # ⑤ 夹具 Forward：两条 DIRECT（入口 = 主入口节点），一条用于主路径，一条用于就绪闸门。
    main_fid, main_port = create_fixture("MAIN")
    gate_fid, gate_port = create_fixture("GATE")
    check(main_fid is not None and H.wait_active(int(main_fid)),
          "G6.setup the main-path fixture Forward converges", f"id={main_fid} port={main_port}")
    check(gate_fid is not None and H.wait_active(int(gate_fid)),
          "G6.setup the readiness-gate fixture Forward converges", f"id={gate_fid} port={gate_port}")
    if main_fid is None or gate_fid is None:
        raise RuntimeError("夹具 Forward 未建立")

    # ⑥ 归属租约：扫描只评估**有租约**的 Forward（`placementLease.findMany`）。
    check(lease_epoch(int(main_fid)) != "" and lease_epoch(int(gate_fid)) != "",
          "G6.setup both fixtures hold a placement lease (the sweep only walks leased Forwards)",
          f"main={lease_epoch(int(main_fid))!r} gate={lease_epoch(int(gate_fid))!r}")

    FIXTURES.update({
        "provider_id": provider_id,
        "ctrl_ip": ctrl_ip,
        "main": {"id": int(main_fid), "port": main_port, "domain": f"g6-main-{int(time.time())}.tunex.test"},
        "gate": {"id": int(gate_fid), "port": gate_port, "domain": f"g6-gate-{int(time.time())}.tunex.test"},
        "policy_before": read_failover_policy(),
        "ingress_b": H.state["nodes"]["ingress_secondary"]["id"],
        "ingress_a": H.state["nodes"]["ingress"]["id"],
    })


def g6_0_trigger_wiring():
    """G6.0 —— record the current trigger wiring.

    DDNS successor execution is coupled to the failover scan, so auto-resolve requires
    the failover policy loop to run. This gate asserts that implementation fact explicitly.
    """
    main = FIXTURES["main"]
    # 前一段：策略关闭 ⇒ 零外呼（此刻夹具还没绑定 DNS，先绑上再看）。
    ok, state, note = bind_dns(main["id"], main["domain"], auto=True, provider_id=FIXTURES["provider_id"])
    check(ok and state.get("state") == "pending",
          "G6.0 the fixture binds with auto_resolve=true (state starts at `pending`)",
          f"ok={ok} {note} state={state.get('state')}")
    set_failover_policy('{"auto_failover":false,"auto_failback":false}')
    wait_ticks(DEADLINE_TICKS)
    off_writes = STUB.write_count(main["domain"])
    check(off_writes == 0,
          "G6.0 [fact] with FAILOVER_POLICY off the successor never runs: zero outbound even though auto_resolve=true",
          f"writes={off_writes} policy={read_failover_policy()!r}")

    # 后半段：策略打开 ⇒ 同一个转发立刻开始同步（下一拍）。断言"从 0 变成 >0"而不是
    # "几秒内变成 1"，因为这一刻恰好与 G6.2 的"恰好写一次"重合：由 G6.2 精确断言。
    set_failover_policy('{"auto_failover":true,"auto_failback":false}')
    ok = H.wait_until(lambda: STUB.write_count(main["domain"]) >= 1, timeout=WAIT_TICKS_S, interval=5)
    check(ok, "G6.0 [fact] with FAILOVER_POLICY on the same Forward syncs on the reconcile tick",
          f"writes={STUB.write_count(main['domain'])} policy={read_failover_policy()!r}")
    check(bool(H.wait_until(lambda: "failover sweep:" in worker_logs(time.time() - 120), timeout=WAIT_TICKS_S, interval=5)),
          "G6.0 the worker really runs the failover sweep each tick (that is the tick DNS hangs off)")


def g6_1_opt_in_gate():
    """G6.1（契约 DoD 4 / F5③）：未开自动解析 ⇒ 只回报建议值集，**零外呼**。

    为什么这条必须真的等一拍：零外呼只有在"同步器真的跑过、并且决定不写"时才有意义。
    "没跑"和"跑了但没写"在证据上必须能区分 —— 后者由 G6.0 的后半段钉住（同一拓扑下
    打开开关就写）与 G6.7 的闸门对照共同保证。
    """
    # 绑定由 G6.PRE 完成（auto_resolve=false）：这里只断言"没开开关就不写"。
    gate = FIXTURES["gate_tunnel_optin"]

    t0 = time.time()
    wait_ticks(DEADLINE_TICKS)
    check(STUB.write_count(gate["domain"]) == 0,
          "G6.1 零外呼：the stub received no write while auto_resolve=false",
          f"writes={STUB.write_count(gate['domain'])} ticks={ticks_since(t0)}")

    ok, view = wait_dns(gate["id"], lambda s: s.get("state") == "pending", timeout=20)
    check(ok and view.get("state") == "pending",
          "G6.1 the state stays `pending` (not `synced`, not `error`) with auto_resolve off",
          json.dumps(view, ensure_ascii=False)[:240])
    expected = view.get("expected_values") or []
    check(expected == [owner_ip(gate["id"])],
          "G6.1 it still reports the suggested value set (the owner's connect_ip), just without writing it",
          f"expected={expected} owner={owner_ip(gate['id'])!r}")


def g6_2_first_sync():
    """G6.2（契约 DoD 2 前半 / F5③）：开启后**恰好写一次**，值 = owner 的 `connect_ip`，
    读回一致 ⇒ `synced`。

    "恰好一次"是本条的重点：`planDdnsValueChanges` 是集合运算，值集没变的下一拍必须是
    **零外呼**。写成"至少写了一次"会让"每拍都重写 DNS"这个缺陷顺利通过。
    """
    main = FIXTURES["main"]
    epoch_before = lease_epoch(main["id"])
    # G6.0 已经让这条转发写过一次；"恰好一次"因此必须按**重新绑定之后**的增量来数。
    writes_before = STUB.write_count(main["domain"])
    # 重新绑定 = 期望值集作废 ⇒ 状态退回未确认（这才是"第一次同步"的起点）。
    ok_bind, state, note = bind_dns(main["id"], main["domain"], auto=True, provider_id=FIXTURES["provider_id"])
    check(ok_bind and state.get("state") == "pending",
          "G6.2 rebinding with auto_resolve=true resets the state to `pending`",
          f"ok={ok_bind} {note} state={state.get('state')}")

    t_bind = time.time()
    ok, view = wait_dns(main["id"], lambda s: s.get("state") == "synced")
    OBSERVATIONS["first_sync_settle_ms"] = int((time.time() - t_bind) * 1000)
    ip = owner_ip(main["id"])
    check(ok, "G6.2 the sync reaches `synced` (write + read-back agreed) within the deadline",
          json.dumps(view, ensure_ascii=False)[:300])
    check(view.get("state") == "synced" and view.get("verified") is True,
          "G6.2 `synced` carries `verified=true` (it is the read-back that made it so)",
          json.dumps(view, ensure_ascii=False)[:240])

    # 写次数：等一拍之后再数 —— 只有"下一拍没有再写"才能证明幂等。
    wait_ticks(1)
    delta = STUB.write_count(main["domain"]) - writes_before
    check(delta == 1, "G6.2 exactly ONE write reached the provider (the next tick is a no-op)",
          f"writes_delta={delta} total={STUB.write_count(main['domain'])}")

    check(STUB.values(main["domain"]) == [ip],
          "G6.2 the provider's own record set is exactly the owner's connect_ip",
          f"provider={STUB.values(main['domain'])} owner={ip!r}")
    check((view.get("confirmed_values") or []) == [ip],
          "G6.2 the panel's confirmed value set equals the owner's connect_ip",
          json.dumps(view, ensure_ascii=False)[:240])
    check(lease_epoch(main["id"]) == epoch_before,
          "G6.2 a DNS sync never touches the placement epoch (DNS is a side effect, not a placement fact)",
          f"{epoch_before} -> {lease_epoch(main['id'])}")
    FIXTURES["main"]["synced_ip"] = ip


def g6_3_value_set_safety():
    """G6.3（**防事故那条**，契约「F4 更正」第 1 条）：写出去的值集里**不含任何非 owner
    的节点地址**。

    为什么它比"值集非空"重要得多：把一台**不服务这条转发**的机器写进 A 记录，客户端按
    轮询大约一半会连到黑洞，而面板、日志、Gate 全都会显示"同步成功"——这是静默地坏。
    反过来说"少写一条记录"客户端至少会重试。
    """
    main = FIXTURES["main"]
    owner = owner_ip(main["id"])
    ips = all_node_ips()
    foreign = sorted({ip for nid, ip in ips.items() if ip and ip != owner and nid != FIXTURES["ingress_a"]})
    written = STUB.written_values(main["domain"])
    record_set = STUB.values(main["domain"])

    leaked = [v for v in set(written) | set(record_set) if v in set(foreign) and v != NON_OWNER_DECOY]
    check(not leaked,
          "G6.3 the DNS value set contains NO address of a node that is not serving this Forward",
          f"leaked={leaked} all_nodes={ips} written={written}")
    check(all(v == owner for v in written),
          "G6.3 every value ever written for this domain is the owner's connect_ip",
          f"written={written} owner={owner!r}")
    check(record_set == [owner],
          "G6.3 the record set is exactly {owner.connect_ip} — not the node group, not the candidate list",
          f"record_set={record_set}")


def g6_3b_multi_entry_same_value_set():
    """G6.3b：把 `multi_entry` 形态真的同步一次 —— 值集仍只有 owner 的地址。

    契约「F4 更正」第 2 条说两种形态**今天算出同一个值集**。这条把它做实：`multi_entry`
    的期望值集不得按"入口组里合格的节点"去凑（那会把不服务的机器写进记录 = G6.3 的
    反面）。做法：把 GATE 夹具按 multi_entry 绑定并同步一次。
    """
    gate = FIXTURES["gate"]
    ok_bind, state, note = bind_dns(gate["id"], gate["domain"], auto=True, mode="multi_entry",
                                    provider_id=FIXTURES["provider_id"])
    check(ok_bind, "G6.3b a multi_entry binding is accepted",
          f"ok={ok_bind} {note} state={state.get('state')}")
    ok, view = wait_dns(gate["id"], lambda s: s.get("state") == "synced")
    owner = owner_ip(gate["id"])
    check(ok, "G6.3b the multi_entry binding syncs within the deadline",
          json.dumps(view, ensure_ascii=False)[:300])
    check(STUB.values(gate["domain"]) == [owner],
          "G6.3b multi_entry ALSO resolves to exactly the owner's address (F4 更正: no group-scraped values)",
          f"provider={STUB.values(gate['domain'])} owner={owner!r}")
    check(view.get("mode") == "multi_entry",
          "G6.3b the panel reports the declared multi_entry mode", json.dumps(view, ensure_ascii=False)[:200])


def g6_4_non_owner_node_updown():
    """G6.4（契约「F4 更正」第 3 条第 2 项）：一个**非 owner 的入口节点**上下线 ⇒ 零 DNS 写。

    这不是"因为值集里没有它所以没变"的同义反复：值集的**来源**今天只取 owner，而这条
    断言问的是"节点上下线这件事会不会引起一次外呼"。如果实现改成了按组凑值集，这里会
    立刻红 —— 记录集里出现第二台机器，或者一次多余的写。
    """
    main = FIXTURES["main"]
    before_writes = STUB.write_count(main["domain"])
    before_values = STUB.values(main["domain"])
    ingress_b = int(FIXTURES["ingress_b"])

    H.docker(["stop", INGRESS_B_CONTAINER], timeout=120)
    node_status = lambda: H.scalar(f"SELECT IFNULL(status,'') FROM node WHERE id={ingress_b};")
    # HTTP-polling Agents do not drive the websocket offline marker, so this gate uses
    # stale node_state_report timestamps as the observable offline fact.
    stale = lambda: H.scalar(
        "SELECT COUNT(*) FROM node_state_report WHERE node_id=%d AND "
        "reported_at > NOW() - INTERVAL 90 SECOND;" % ingress_b
    ) == "0"
    t_stop = time.time()
    offline = H.wait_until(stale, timeout=240, interval=5)
    OBSERVATIONS["agent_reports_stale_after_s"] = int(time.time() - t_stop)
    OBSERVATIONS["stopped_agent_node_status"] = node_status()
    OBSERVATIONS["stopped_agent_status_flips"] = node_status() != "active"
    check(offline, "G6.4 [offline] the stopped Agent really stops reporting "
                   "(panel-side freshness, since node.status only flips on a websocket disconnect)",
          f"reports_fresh=no status={node_status()!r}")

    t0 = time.time()
    wait_ticks(DEADLINE_TICKS)
    check(STUB.write_count(main["domain"]) == before_writes,
          "G6.4 [offline] zero DNS writes when a NON-owner ingress node goes down",
          f"writes={before_writes}->{STUB.write_count(main['domain'])} ticks={ticks_since(t0)}")
    check(STUB.values(main["domain"]) == before_values,
          "G6.4 [offline] the record set is unchanged (still exactly the owner)",
          f"{before_values} -> {STUB.values(main['domain'])}")

    H.docker(["start", INGRESS_B_CONTAINER], timeout=120)
    back = H.wait_until(lambda: H.scalar(
        "SELECT COUNT(*) FROM node_state_report WHERE node_id=%d AND "
        "reported_at > NOW() - INTERVAL 60 SECOND;" % ingress_b) == "1", timeout=240, interval=5)
    check(back, "G6.4 [online again] the node's own reports resume (it is really back)",
          f"status={node_status()!r}")

    t1 = time.time()
    wait_ticks(DEADLINE_TICKS)
    check(STUB.write_count(main["domain"]) == before_writes,
          "G6.4 [online again] still zero DNS writes when the NON-owner node comes back",
          f"writes={before_writes}->{STUB.write_count(main['domain'])} ticks={ticks_since(t1)}")
    check(STUB.values(main["domain"]) == before_values,
          "G6.4 [online again] the record set is still unchanged",
          f"{before_values} -> {STUB.values(main['domain'])}")


def g6_5_ownership_migration():
    """G6.5（契约 DoD 2 后半 / F5①）：归属迁移 ⇒ 值集跟随**新 owner**，且在
    `DDNS_SYNC_DEADLINE_MS` 内落定。

    触发方式是改 `ingress_node_id`（走用户界面同一条 `patchForward` 路径）。这里刻意
    量出"从改归属到 DNS 落定"的真实秒数并要求它 ≤ 120s —— 契约把 DNS 写从可用性关键
    路径上摘掉的正是这条期限。
    """
    main = FIXTURES["main"]
    new_owner = int(FIXTURES["ingress_b"])
    new_ip = node_ip(new_owner)
    old_ip = FIXTURES["main"]["synced_ip"]

    status, body = patch_ingress(main["id"], new_owner)
    t0 = time.time()
    check(status == 200, "G6.5 the ownership migration is accepted", f"status={status} body={json.dumps(body, ensure_ascii=False)[:160]}")
    applied = H.wait_active(main["id"], timeout=DDNS_DEADLINE_S)
    check(applied, "G6.5 the rollout to the new ingress reaches applied_revision == config_revision",
          f"row={H.tunnel_row(main['id'])}")
    check(tunnel_field(main["id"], "ingress_node_id") == str(new_owner),
          "G6.5 the Forward's owner really moved",
          f"owner={tunnel_field(main['id'], 'ingress_node_id')!r}")

    ok, view = wait_dns(main["id"], lambda s: s.get("state") == "synced" and (s.get("confirmed_values") or []) == [new_ip],
                        timeout=DDNS_DEADLINE_S)
    elapsed_ms = int((time.time() - t0) * 1000)
    OBSERVATIONS["migration_settle_ms"] = elapsed_ms
    check(ok, "G6.5 the DNS value set follows the NEW owner within DDNS_SYNC_DEADLINE_MS",
          f"elapsed_ms={elapsed_ms} view={json.dumps(view, ensure_ascii=False)[:260]}")
    check(elapsed_ms <= DDNS_SYNC_DEADLINE_MS,
          "G6.5 that settling really happened inside the frozen deadline",
          f"elapsed_ms={elapsed_ms} deadline_ms={DDNS_SYNC_DEADLINE_MS}")
    check(STUB.values(main["domain"]) == [new_ip],
          "G6.5 the provider's record set is exactly the new owner's address (the old one was removed)",
          f"provider={STUB.values(main['domain'])} new={new_ip!r} old={old_ip!r}")
    check(old_ip not in STUB.values(main["domain"]),
          "G6.5 the previous owner's address is gone from the record set",
          f"record_set={STUB.values(main['domain'])}")
    FIXTURES["main"]["synced_ip"] = new_ip


def g6_6_no_fake_success():
    """G6.6（契约 F7 / D2）：**禁止假成功**。

    provider 接受写入只证明"我们发了请求"。把读回与期望做成不一致 ⇒ 状态必须是
    `synced_unverified`。写成"状态在 {synced, synced_unverified} 里"会让这条断言毫无
    用处：多租户下"面板说切了、客户端还连旧 IP"正是最坏的一类故障。
    """
    main = FIXTURES["main"]
    back_owner = int(FIXTURES["ingress_a"])
    back_ip = node_ip(back_owner)
    writes_before = STUB.write_count(main["domain"])

    STUB.mismatch = True
    status, _body = patch_ingress(main["id"], back_owner)  # 值集变了 ⇒ 必然触发一次写
    check(status == 200, "G6.6 the migration that forces a DNS write is accepted", f"status={status}")
    check(H.wait_active(main["id"], timeout=DDNS_DEADLINE_S),
          "G6.6 that rollout reaches applied", f"row={H.tunnel_row(main['id'])}")

    t_unverified = time.time()
    ok, view = wait_dns(main["id"], lambda s: s.get("verified") is False and s.get("synced_at"), timeout=DDNS_DEADLINE_S)
    OBSERVATIONS["unverified_settle_ms"] = int((time.time() - t_unverified) * 1000)
    check(ok, "G6.6 the provider accepted the write but the read-back disagreed (write + read-back are two facts)",
          f"writes {writes_before}->{STUB.write_count(main['domain'])} view={json.dumps(view, ensure_ascii=False)[:240]}")
    check(view.get("state") == "synced_unverified",
          "G6.6 the state is `synced_unverified` — NOT `synced`",
          json.dumps(view, ensure_ascii=False)[:240])
    check(view.get("state") != "synced",
          "G6.6 (explicit) a failed read-back never produces the product-visible `synced`",
          json.dumps(view, ensure_ascii=False)[:200])
    check(not view.get("last_error"),
          "G6.6 it is not misreported as `error` either: the write succeeded, the confirmation did not",
          json.dumps(view, ensure_ascii=False)[:200])

    # 观察（不是断言）：读回不一致时 `dns_confirmed_values` 不会被更新，于是"值集变了"
    # 在下一拍仍然成立 ⇒ **每一拍都会重写一次**，而写入本身是"成功"的（不排退避）。
    # 记下来是为了让下一个人知道这条路径的形状，而不是把它翻成一条要求。
    at_mismatch = STUB.write_count(main["domain"])
    wait_ticks(1)
    # 名字里带 `_one_tick_window` 是刻意的：窗口只有一拍，而写入发生在拍内，
    # 所以 0 不代表"不会重写"，只代表"这一拍窗口里没观测到重写"。
    OBSERVATIONS["rewrites_observed_in_one_tick_window"] = STUB.write_count(main["domain"]) - at_mismatch

    # 读回恢复 ⇒ 下一拍确认 ⇒ `synced`（这条同时证明状态不是卡死的）。
    STUB.mismatch = False
    ok2, view2 = wait_dns(main["id"], lambda s: s.get("state") == "synced" and s.get("verified") is True)
    check(ok2, "G6.6 once the read-back agrees the state becomes `synced` (self-healing, no manual step)",
          json.dumps(view2, ensure_ascii=False)[:260])
    check(STUB.values(main["domain"]) == [back_ip],
          "G6.6 and the record set really is the current owner's address",
          f"provider={STUB.values(main['domain'])} owner={back_ip!r}")
    FIXTURES["main"]["synced_ip"] = back_ip


def g6_7_readiness_gate():
    """G6.7（契约 F5④ / DoD 3 的同族）：DNS 路径不可用 + `auto_failover` ⇒ **不迁移**、
    epoch 不变、原因可见（`dns_path_unready`）。

    "可见"是这条的另一半：静默地不迁移与"没有需要迁移的"在日志里长得一样，而前者排查
    成本极高。所以断言落在 worker 日志里那句带 `tunnel_id` 的结构化原因上。

    构造成对照组：同一个转发、同一条扫描，
      · stub **不可达** ⇒ 扫描把它挡在闸门前（`dns_path_unready`），一次外呼都没有；
      · stub **可用** ⇒ 闸门不再拦它，同一拍就完成同步。
    两种状态的差别只有一个变量（DNS 路径是否就绪），所以这条断言不是"恰好没迁移"。
    """
    gate = FIXTURES["gate"]
    fid = gate["id"]
    epoch_before = lease_epoch(fid)
    owner_before = tunnel_field(fid, "ingress_node_id")
    domain = gate["domain"]

    # DNS 路径**先**不可用，再让这条转发变成"从来没同步成功过" —— 顺序不能反：
    # 反了的话，"绑定"与"停掉 stub"之间只要恰好落到一拍，扫描就会**在路径还通的时候**
    # 完成一次同步，于是闸门看起来"没触发"，而真正没被验证的是夹具的起点。
    # （第一版就是这么写的，红得很有教育意义：它证明的是夹具的竞态，不是产品的行为。）
    STUB.stop()
    H.mysql(f"UPDATE tunnel SET dns_synced_at=NULL, dns_confirmed_values=NULL, "
            f"dns_verified=0, dns_last_error=NULL, dns_attempt_count=0, dns_next_attempt_at=NULL WHERE id={fid};")
    ok_bind, state, note = bind_dns(fid, domain, auto=True, mode="multi_entry", provider_id=FIXTURES["provider_id"])
    check(ok_bind and state.get("state") == "pending",
          "G6.7 the gate fixture is bound with auto_resolve=true and has never synced",
          f"ok={ok_bind} {note} state={state.get('state')}")

    t0 = time.time()
    # Compare writes within this assertion window; earlier successful writes are unrelated.
    writes_before_gate = STUB.write_count(domain)
    ticks = wait_ticks(DEADLINE_TICKS + 1)
    # Poll logs because container log visibility is not guaranteed to be immediate.
    saw_gate = H.wait_until(lambda: bool(gated_lines(t0, fid)), timeout=WAIT_TICKS_S, interval=6)
    lines = gated_lines(t0, fid)
    check(saw_gate and bool(lines),
          "G6.7 the sweep reports `dns_path_unready` for this Forward (the reason is visible, not silent)",
          f"ticks={ticks} lines={lines[-1][:200] if lines else 'none'}")
    OBSERVATIONS["gated_ticks"] = ticks
    OBSERVATIONS["gated_lines"] = len(lines)
    check(any("dns_path_unready" in line for line in lines),
          "G6.7 the reason code is exactly `dns_path_unready`", f"{lines[-1][:200] if lines else 'none'}")
    check(lease_epoch(fid) == epoch_before,
          "G6.7 [gated] the placement epoch did NOT move (fail-closed: no migration with a broken DNS path)",
          f"{epoch_before} -> {lease_epoch(fid)}")
    check(tunnel_field(fid, "ingress_node_id") == owner_before,
          "G6.7 [gated] ownership is unchanged",
          f"{owner_before!r} -> {tunnel_field(fid, 'ingress_node_id')!r}")
    check(STUB.write_count(domain) == writes_before_gate and not tunnel_field(fid, "dns_synced_at"),
          "G6.7 [gated] and it did not sneak a write in: the successor was never called",
          f"writes_delta={STUB.write_count(domain) - writes_before_gate} "
          f"synced_at={tunnel_field(fid, 'dns_synced_at')!r}")
    # 第二个**独立**判据，用来区分"闸门拦住了"与"放行了但写失败"：
    # 放行的话执行器/后继会真的去写，写不通 ⇒ `dns_last_error` 有值 + `dns_attempt_count` > 0。
    # 只assert“没写成功”是不够的 —— 失败也是"没写成功"。
    check(not tunnel_field(fid, "dns_last_error") and tunnel_field(fid, "dns_attempt_count") in ("", "0"),
          "G6.7 [gated] no failed attempt was recorded either: the successor was never CALLED (not merely unsuccessful)",
          f"last_error={tunnel_field(fid, 'dns_last_error')!r} attempts={tunnel_field(fid, 'dns_attempt_count')!r}")

    # 对照组：路径恢复 ⇒ 同一条扫描不再拦它，并且真的同步成功。
    STUB.start()
    t1 = time.time()
    ok, view = wait_dns(fid, lambda s: s.get("state") == "synced", timeout=DDNS_DEADLINE_S)
    OBSERVATIONS["control_resync_ms"] = int((time.time() - t1) * 1000)
    check(ok, "G6.7 [control] once the DNS path is reachable the same Forward syncs within the deadline",
          json.dumps(view, ensure_ascii=False)[:260])
    check(not gated_lines(t1, fid),
          "G6.7 [control] the gate stops firing for this Forward — the only difference was DNS readiness",
          f"lines_since_control={gated_lines(t1, fid)[:1]}")
    check(lease_epoch(fid) == epoch_before,
          "G6.7 [control] still no migration was triggered by DNS facts (DNS never drives placement)",
          f"{epoch_before} -> {lease_epoch(fid)}")
    check(STUB.values(domain) == [owner_ip(fid)],
          "G6.7 [control] the record set is the owner's address, and only it",
          f"provider={STUB.values(domain)} owner={owner_ip(fid)!r}")


def g6_setup_optin_fixture():
    """G6.1 需要一条**从未绑定过**的夹具（`pending` 才是它的起点）。"""
    fid, port = create_fixture("OPTIN")
    check(fid is not None and H.wait_active(int(fid)), "G6.setup the opt-in fixture Forward converges",
          f"id={fid} port={port}")
    if fid is None:
        raise RuntimeError("opt-in 夹具未建立")
    FIXTURES["gate_tunnel_optin"] = {"id": int(fid), "port": port, "domain": f"g6-optin-{int(time.time())}.tunex.test"}


# ---------------------------------------------------------------------------
# cleanup
# ---------------------------------------------------------------------------

def cleanup():
    # 策略还原成进入时的样子：这是**共享**的运维开关，不是本门禁的夹具。
    try:
        before = FIXTURES.get("policy_before")
        if before is not None:
            set_failover_policy(before)
            check(read_failover_policy() == before, "G6.cleanup FAILOVER_POLICY restored to its pre-gate value",
                  f"now={read_failover_policy()!r} before={before!r}")
    except Exception as exc:  # noqa: BLE001
        record(False, f"G6.cleanup restore FAILOVER_POLICY: {type(exc).__name__}: {exc}")

    try:
        STUB.stop()
    except Exception as exc:  # noqa: BLE001
        record(False, f"G6.cleanup stop stub: {type(exc).__name__}: {exc}")

    # Agent 必须回到运行状态（G6.4 停过它）；即使中途失败也要尝试。
    try:
        H.docker(["start", INGRESS_B_CONTAINER], allow=True, timeout=120)
    except Exception as exc:  # noqa: BLE001
        record(False, f"G6.cleanup start ingress-b: {type(exc).__name__}: {exc}")

    try:
        H.cleanup_fixtures()
        # 夹具 Forward 的名字来自 harness 的前缀（`H.create_forward` 自己拼的），不是本文件的
        # `FIXTURE_PREFIX` —— 用错前缀的"清理干净了"是一条永远为真的假断言。
        left = H.scalar(f"SELECT COUNT(*) FROM tunnel WHERE name LIKE '{H.FIXTURE_PREFIX}%';")
        check(left == "0", "G6.cleanup every fixture Forward this gate created was removed", f"left={left}")
    except Exception as exc:  # noqa: BLE001
        record(False, f"G6.cleanup fixtures: {type(exc).__name__}: {exc}")

    try:
        # provider 是**凭据**（设置域），tunnel 的清理不会带走它：不删就是一次凭据泄漏。
        H.db(f"await db.dNSProvider.deleteMany({{where:{{name:{{startsWith:'{FIXTURE_PREFIX}'}}}}}});return true;")
        left = H.scalar(f"SELECT COUNT(*) FROM dns_provider WHERE name LIKE '{FIXTURE_PREFIX}%';")
        check(left == "0", "G6.cleanup the fixture DNS provider (sealed credential) was removed", f"left={left}")
    except Exception as exc:  # noqa: BLE001
        record(False, f"G6.cleanup provider: {type(exc).__name__}: {exc}")


def main():
    signal.signal(signal.SIGALRM, H.alarm)
    ready = False
    try:
        signal.setitimer(signal.ITIMER_REAL, min(300, OVERALL_SECONDS))
        H.acquire_lock()
        setup()
        g6_setup_optin_fixture()
        ready = True
        signal.setitimer(signal.ITIMER_REAL, 0)
        for name, fn, budget in [
            ("G6.PRE bind route reachable", g6_pre_bind_route, 180),
            ("G6.0 trigger wiring (facts)", g6_0_trigger_wiring, 300),
            ("G6.1 opt-in gate", g6_1_opt_in_gate, 300),
            ("G6.2 first sync", g6_2_first_sync, 300),
            ("G6.3 value set safety", g6_3_value_set_safety, 180),
            ("G6.3b multi_entry same value set", g6_3b_multi_entry_same_value_set, 300),
            ("G6.4 non-owner node up/down", g6_4_non_owner_node_updown, 600),
            ("G6.5 ownership migration", g6_5_ownership_migration, 420),
            ("G6.6 no fake success", g6_6_no_fake_success, 420),
            ("G6.7 readiness gate", g6_7_readiness_gate, 480),
        ]:
            case(name, fn, budget)
    except Exception as exc:  # noqa: BLE001
        record(False, f"G6 prerequisite/setup: {type(exc).__name__}: {exc}; remaining tests NOT EXECUTED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.setitimer(signal.ITIMER_REAL, 300)
        try:
            cleanup()
        except Exception as exc:  # noqa: BLE001
            record(False, f"G6.cleanup: {type(exc).__name__}: {exc}; inspect topology before rerun")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        RESULT.write_text(
            "# V5-G6 DDNS front-door gate (WP17.5)\n"
            f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
            "topology: scripts/v3-e2e/docker-compose.e2e.yaml (b2x-* containers, real Agents)\n"
            "trigger: worker cron_reconcile_v3 (~30s) -> failover sweep -> dns gate -> successor\n"
            f"fixture: {FIXTURE_PREFIX}; setup={'executed' if ready else 'incomplete'}\n"
            f"elapsed_seconds: {int(time.monotonic() - START)}\n"
            f"ddns_sync_deadline_ms: {DDNS_SYNC_DEADLINE_MS}\n"
            + json.dumps(
                {
                    "provider_id": FIXTURES.get("provider_id"),
                    "observations": dict(OBSERVATIONS),
                    "stub_endpoint": f"http://{FIXTURES.get('ctrl_ip')}:{STUB.port}",
                    "records": {f"{d}|{t}": v for (d, t), v in STUB.records.items()},
                    "writes": STUB.writes,
                },
                ensure_ascii=False, indent=2,
            )
            + "\n"
            + "\n".join(H.RESULTS)
            + f"\nV5-G6 TOTAL PASS={H.PASS} FAIL={H.FAIL}\n",
            encoding="utf-8",
        )
        TRACE.write_text(json.dumps({"http": H.HTTP}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        H.release_lock()
        print(f"V5-G6 TOTAL PASS={H.PASS} FAIL={H.FAIL} evidence={RESULT}", flush=True)
    return 1 if H.FAIL or not ready else 0


if __name__ == "__main__":
    raise SystemExit(main())
