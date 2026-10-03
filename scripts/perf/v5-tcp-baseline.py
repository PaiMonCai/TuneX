#!/usr/bin/env python3
"""TuneX V5-WP3 —— TCP 性能基线（DIRECT / RELAY）。

设计约束（DEVELOPMENT.md §5.4）：

  · **可重复**：同一命令跑两次得到可比较的数字，不需要任何外部服务；
  · **可机器读取**：输出 JSON（权威）+ CSV（便于画趋势）；
  · **区分 DIRECT / RELAY**：RELAY 真的经过两台 Agent 进程（ingress + egress），
    不是在同一条隧道的两种配置里换名字；
  · **不需要生产凭据**：完全在回环上跑，admin token 每次随机生成、只存在于
    进程环境里，不写进任何产物；README 说明这一点；
  · **不设绝对阈值**：本脚本只**测量**，从不判定"变慢了"。共享 CI Runner 上
    毫秒级硬门槛只会制造随机红灯（§5.4「不要一开始用脆弱绝对阈值阻断 CI」）。

测量项（§5.4「至少测量」）与实现方式：

  DIRECT throughput            回环 echo 目标 + 一次 apply DIRECT
  RELAY throughput             两台 Agent（ingress/egress）+ apply RELAY
  connection setup latency     建连到首个字节返回的耗时
  concurrent connections       同时保持 N 条连接并各跑一次往返
  CPU                          /proc/<pid>/stat 的 utime+stime 增量
  RSS                          /proc/<pid>/status 的 VmRSS
  goroutine count              Agent 的 GET /debug/runtime（/proc 没有这个数）
  hot reload latency           apply 同一隧道、换 target、revision+1
  restart/reconnect convergence 重启 Agent 进程到端口重新可用
  graceful drain duration      SIGTERM 到进程退出（有界排空）

本模块只用 Python 标准库：基线脚本本身不该引入需要安装的依赖，否则"可重复"
就变成了"在一台装过东西的机器上可重复"。
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import random
import shutil
import signal
import socket
import http.server
import socketserver
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Iterable, Sequence

SCHEMA_VERSION = 1

# ── 默认工作量 ──
#
# 刻意偏小：基线要能在几分钟内跑完，否则没人会在改代码后重跑它，而没有重跑的
# 基线等于没有基线。`--profile full` 放大到"接近真实链路"的量级，用于发布前的
# 人工对比，不用于每次提交。
PROFILES = {
    "quick": {"payload_kib": 64, "transfers": 40, "conn_timeouts": 30,
              "concurrency": 16, "conn_rounds": 20, "setups": 50},
    "full": {"payload_kib": 1024, "transfers": 120, "conn_timeouts": 120,
             "concurrency": 128, "conn_rounds": 40, "setups": 400},
}


# ======================================================================
# 统计工具（纯函数：可离线单测）
# ======================================================================

def percentile(values: Sequence[float], pct: float) -> float | None:
    """线性插值分位数（numpy 之外的标准做法，与统计教材一致）。

    空输入返回 None 而不是 0.0：0.0 会被下游当成"测到了 0 毫秒"，
    把"没测到"伪装成"极快"，是性能报告里最坏的失败模式。
    """
    if not values:
        return None
    if len(values) == 1:
        return float(values[0])
    ordered = sorted(float(v) for v in values)
    if pct <= 0:
        return ordered[0]
    if pct >= 100:
        return ordered[-1]
    rank = (pct / 100.0) * (len(ordered) - 1)
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    frac = rank - low
    return ordered[low] + (ordered[high] - ordered[low]) * frac


@dataclass
class Summary:
    """一组样本的摘要。median / p95 是 §5.4 明确要求的两个口径。"""

    count: int
    median: float | None
    p95: float | None
    min: float | None
    max: float | None
    mean: float | None
    unit: str = ""

    @staticmethod
    def of(values: Sequence[float], unit: str = "") -> "Summary":
        if not values:
            return Summary(0, None, None, None, None, None, unit)
        return Summary(
            count=len(values),
            median=percentile(values, 50),
            p95=percentile(values, 95),
            min=float(min(values)),
            max=float(max(values)),
            mean=float(statistics.fmean(values)),
            unit=unit,
        )

    def to_json(self) -> dict:
        return asdict(self)


def throughput_mib_s(total_bytes: int, elapsed_s: float) -> float:
    """MiB/s。elapsed <= 0 视为无效（返回 0 而不是 inf，避免污染中位数）。"""
    if elapsed_s <= 0:
        return 0.0
    return (total_bytes / (1024 * 1024)) / elapsed_s


def summarize_throughput(samples: Iterable[tuple[int, float]], unit: str = "MiB/s") -> Summary:
    """(字节数, 秒) 样本 → 吞吐摘要。"""
    return Summary.of([throughput_mib_s(b, s) for b, s in samples], unit)


# ======================================================================
# 回环 echo 目标
# ======================================================================

class EchoTarget:
    """回环上的 echo 服务：把收到的字节原样写回，直到对端关闭。

    用纯 socket 而不是 http.server：HTTP 的 framing 会让"吞吐"里混进协议解析
    成本，而基线的对象是 TCP 数据面本身。
    """

    def __init__(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(128)
        self.host, self.port = self._sock.getsockname()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn: socket.socket) -> None:
        try:
            with conn:
                while True:
                    chunk = conn.recv(65536)
                    if not chunk:
                        return
                    conn.sendall(chunk)
        except OSError:
            return

    def close(self) -> None:
        self._stop.set()
        try:
            self._sock.close()
        except OSError:
            pass


# ======================================================================
# Agent 进程控制
# ======================================================================

# ======================================================================
# 假面板（本地、无生产凭据）
# ======================================================================
#
# 为什么要一个假面板，而不是只用 admin API：
#
#   · 真实 Agent 的期望状态是**面板下发**的。只用 admin API 就只能造出
#     "手工塞进去的隧道"，restore / LKG / 重启收敛这几条路径根本没有被走到；
#   · EGRESS 的 target pool 也必须由面板那份 desired 快照建立（restore.Apply
#     在构造 forwarder 之前先把池建好），admin API 没有"创建第一个池"的入口。
#
# 凭据是每次随机生成的本地字符串，只在该进程与 Agent 之间使用，不写入任何产物。
# 面板本身只回三种东西：desired 快照、状态上报 200、其余 404 —— 它不实现任何
# 授权语义，因此也**不能**被误当成"测过面板权限"的证据。

class FakePanel:
    """本地最小面板：按凭据返回该节点的 desired 快照。"""

    def __init__(self) -> None:
        self.desired: dict[str, list[dict]] = {}
        self.version = "perf-1"
        self.state_posts: list[str] = []
        self.port = _free_port()
        self._server: socketserver.ThreadingTCPServer | None = None
        self._thread: threading.Thread | None = None

    # -- lifecycle --
    def start(self) -> None:
        panel = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args) -> None:  # 静音：基线输出要可机读
                return

            def _json(self, code: int, payload: dict) -> None:
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802 —— BaseHTTPRequestHandler 的约定
                cred = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
                if self.path == "/api/internal/node/desired":
                    tunnels = panel.desired.get(cred)
                    if tunnels is None:
                        self._json(401, {"error": "unknown credential"})
                        return
                    self._json(200, {"data": {"snapshot": {
                        "version": panel.version, "tunnels": tunnels}}})
                    return
                self._json(404, {"error": "not found"})

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                if self.path in ("/api/internal/node/state", "/api/internal/heartbeat"):
                    panel.state_posts.append(self.path)
                    self._json(200, {"ok": True})
                    return
                self._json(404, {"error": "not found"})

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

            def handle_error(self, request, client_address) -> None:
                # Killing an Agent mid-request is normal here (that is how the
                # restart scenarios work). The resulting reset is not an error
                # worth printing: it would bury the machine-readable output.
                exc = sys.exc_info()[1]
                if isinstance(exc, (ConnectionResetError, BrokenPipeError)):
                    return
                super().handle_error(request, client_address)

        self._server = Server(("127.0.0.1", self.port), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def set_desired(self, credential: str, tunnels: list[dict], version: str | None = None) -> None:
        self.desired[credential] = tunnels
        if version:
            self.version = version

class AgentProcess:
    """一个跑在本机回环上的 Agent 进程（无面板、无凭据、无外部依赖）。

    admin token 随机生成：基线脚本不应该要求、也不应该留下任何长期有效的
    凭据（§5.4 DoD「不需要生产凭据」「不记录 secrets」）。
    """

    def __init__(self, binary: Path, state_dir: Path, role: str,
                 listen_ip: str = "127.0.0.1", label: str = "agent",
                 panel: "FakePanel | None" = None) -> None:
        self.binary = binary
        self.state_dir = state_dir
        self.role = role
        self.listen_ip = listen_ip
        self.label = label
        # admin token 与面板凭据都是随机的本地字符串：基线脚本不应该要求、
        # 也不应该留下任何长期有效的凭据（§5.4 DoD）。
        self.token = "perf-" + "".join(random.choices("0123456789abcdef", k=24))
        self.credential = "perfcred-" + "".join(random.choices("0123456789abcdef", k=24))
        self.panel = panel
        self.agent_id = "".join(random.choices("0123456789abcdef", k=32))
        self.port = _free_port()
        self.proc: subprocess.Popen | None = None
        self.stdout_path = state_dir / f"{label}.log"

    def admin_url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    def start(self, wait: bool = True) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        log = open(self.stdout_path, "ab", buffering=0)
        argv = [
            str(self.binary),
            "--agent-admin-port", str(self.port),
            "--agent-admin-token", self.token,
            "--state-dir", str(self.state_dir),
            "--listen-ip", self.listen_ip,
            "--role", self.role,
            "--node-id", self.label,
            "--agent-id", self.agent_id,
        ]
        if self.panel is not None:
            # 面板驱动的期望状态：这才让 restore / LKG / 重启收敛这些路径真的
            # 被走到（只用 admin API 只会造出"手工塞进去的隧道"）。
            argv += [
                "--panel-http-url", self.panel.url,
                "--node-credential", self.credential,
            ]
        self.proc = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT)
        if wait:
            self.wait_admin()

    def wait_admin(self, timeout: float = 20.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                raise RuntimeError(f"{self.label} exited early (see {self.stdout_path})")
            try:
                self.request("GET", "/health")
                return
            except OSError:
                time.sleep(0.05)
        raise TimeoutError(f"{self.label} admin plane did not come up within {timeout}s")

    def request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.admin_url(path), data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=20) as res:
            raw = res.read().decode() or "{}"
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"raw": raw}

    def apply_tunnel(self, config: dict) -> dict:
        return self.request("POST", "/tunnel", config)

    def remove_tunnel(self, tunnel_id: str) -> dict:
        return self.request("DELETE", f"/tunnel?id={urllib.parse.quote(tunnel_id)}")

    def runtime_stats(self) -> dict:
        try:
            return self.request("GET", "/debug/runtime")
        except OSError:
            return {}

    def gauge(self) -> dict:
        """CPU / RSS / goroutines 的当前读数。"""
        out = {"goroutines": None, "rss_bytes": None, "cpu_seconds": None, "cpu_ticks": None}
        stats = self.runtime_stats()
        if isinstance(stats.get("goroutines"), int):
            out["goroutines"] = stats["goroutines"]
        try:
            status = Path(f"/proc/{self.proc.pid}/status").read_text()
            for line in status.splitlines():
                if line.startswith("VmRSS:"):
                    out["rss_bytes"] = int(line.split()[1]) * 1024
        except (OSError, IndexError, ValueError):
            pass
        out["cpu_ticks"] = _cpu_ticks(self.proc.pid)
        out["cpu_seconds"] = _cpu_seconds(self.proc.pid)
        return out

    def stop(self, sig: int = signal.SIGTERM, timeout: float = 30.0) -> float:
        """发送信号并等待退出，返回观察到的退出耗时（秒）。"""
        if self.proc is None or self.proc.poll() is not None:
            return 0.0
        started = time.perf_counter()
        self.proc.send_signal(sig)
        try:
            self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=10)
        return time.perf_counter() - started

    def kill(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.kill()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass


def cpu_hz() -> float:
    """每秒多少个调度 tick（Linux 常见 100，即 10ms 分辨率）。"""
    try:
        return float(os.sysconf("SC_CLK_TCK"))
    except (OSError, ValueError):
        return 100.0


def _cpu_ticks(pid: int) -> int | None:
    """进程累计 CPU（utime + stime），单位是**调度 tick**。

    保留 tick 而不是只给秒：Linux 的 tick 是 10ms 量级，短负载的 CPU 增量会
    不足一个 tick —— 那时"0.0 秒"的真实含义是"低于分辨率"，不是"没测到"。
    产物里同时给出两者，读的人就不会把分辨率限制当成结果。
    """
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    # comm 字段可能含空格与括号，所以从最后一个 ')' 之后开始切。
    # 切完之后的 index 0 是 **state（字段 3）**，所以字段 N 落在 index N-3：
    #   utime = 字段 14 → index 11
    #   stime = 字段 15 → index 12
    # 写成 13/14 会读到 cutime/cstime（已回收子进程的累计值），对刚启动的进程恒为
    # 0 —— 症状是"CPU 永远是 0.0"，看起来像负载太轻，其实是读了另一列。
    tail = raw[raw.rfind(")") + 2:].split()
    try:
        return int(tail[11]) + int(tail[12])
    except (IndexError, ValueError):
        return None


def _cpu_seconds(pid: int) -> float | None:
    ticks = _cpu_ticks(pid)
    return None if ticks is None else ticks / cpu_hz()


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ======================================================================
# 负载生成
# ======================================================================

def transfer_once(host: str, port: int, payload: bytes, timeout: float = 30.0) -> tuple[int, float]:
    """建连 → 写 payload → 读回同样字节 → 关闭。返回 (字节数, 秒)。

    计时从 connect() **之前**开始：§5.4 要的 throughput 是"一次完整业务的
    成本"，把建连排除在外会让重连风暴在数字上消失。
    """
    started = time.perf_counter()
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(payload)
        received = 0
        want = len(payload)
        while received < want:
            chunk = sock.recv(65536)
            if not chunk:
                break
            received += len(chunk)
    return received, time.perf_counter() - started


def setup_latency_once(host: str, port: int, timeout: float = 10.0) -> float:
    """建连耗时（connect → 连接可用）。"""
    started = time.perf_counter()
    with socket.create_connection((host, port), timeout=timeout):
        return time.perf_counter() - started


def concurrent_round(host: str, port: int, concurrency: int, payload: bytes,
                     timeout: float = 60.0) -> tuple[int, float, list[float]]:
    """同时保持 concurrency 条连接并各跑一次往返。

    返回 (总往返次数, 墙钟秒, 每条连接的往返耗时)。墙钟时间取整轮的，而不是
    单条之和：后者永远只反映"单条有多快"，把并发退化完全藏起来。
    """
    errors: list[Exception] = []
    latencies: list[float] = []
    lock = threading.Lock()
    barrier = threading.Barrier(concurrency)

    def worker() -> None:
        try:
            with socket.create_connection((host, port), timeout=timeout) as sock:
                sock.settimeout(timeout)
                barrier.wait(timeout=timeout)
                started = time.perf_counter()
                sock.sendall(payload)
                received = 0
                while received < len(payload):
                    chunk = sock.recv(65536)
                    if not chunk:
                        break
                    received += len(chunk)
                elapsed = time.perf_counter() - started
                with lock:
                    latencies.append(elapsed)
        except Exception as exc:  # noqa: BLE001 —— 基线要把失败记成失败，而不是崩掉整轮
            with lock:
                errors.append(exc)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(concurrency)]
    started = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=timeout + 10)
    wall = time.perf_counter() - started
    if errors:
        raise RuntimeError(f"{len(errors)}/{concurrency} concurrent connections failed: {errors[0]!r}")
    return len(latencies), wall, latencies


# ======================================================================
# 场景
# ======================================================================

def direct_topology(binary: Path, root: Path) -> dict:
    """DIRECT：client → ingress agent → echo target（面板驱动的期望状态）。"""
    target = EchoTarget()
    panel = FakePanel()
    panel.start()
    ingress = AgentProcess(binary, root / "ingress", role="INGRESS", label="ingress", panel=panel)
    listen_port = _free_port()
    panel.set_desired(ingress.credential, [{
        "id": "perf-direct",
        "mode": "DIRECT",
        "protocol": "tcp",
        "ingress_port": listen_port,
        "remote_host": target.host,
        "remote_port": target.port,
        "revision": 1,
    }])
    try:
        ingress.start()
        wait_listener("127.0.0.1", listen_port)
    except Exception:
        _teardown({"agents": [ingress], "target": target, "panel": panel})
        raise
    return {"target": target, "panel": panel, "ingress": ingress,
            "listen_port": listen_port, "agents": [ingress], "probe_port": listen_port}


def relay_topology(binary: Path, root: Path) -> dict:
    """RELAY：client → ingress → egress agent → echo target。

    两台**独立进程**：同进程里跑 RELAY+EGRESS 会把两端 CPU 混成一份读数，也让
    "入口进程重启"这类测量失去意义。回环上的两台进程虽然不是跨机网络，但它真实地
    走完 RELAY 的两跳与两个 listener，且 EGRESS 的 target pool 由面板那份 desired
    快照建立（restore.Apply 在构造 forwarder 之前先建池）。
    """
    target = EchoTarget()
    panel = FakePanel()
    panel.start()
    ingress = AgentProcess(binary, root / "ingress", role="INGRESS", label="ingress", panel=panel)
    egress = AgentProcess(binary, root / "egress", role="EGRESS", label="egress", panel=panel)

    egress_port = _free_port()
    # 出口先起（§1.3 铁律一），入口再指向它。
    panel.set_desired(egress.credential, [{
        "id": "perf-egress",
        "mode": "EGRESS",
        "protocol": "tcp",
        "egress_port": egress_port,
        "targets": [{"host": target.host, "port": target.port}],
        "lb_strategy": "ROUND_ROBIN",
        "revision": 1,
    }])
    listen_port = _free_port()
    panel.set_desired(ingress.credential, [{
        "id": "perf-relay",
        "mode": "RELAY",
        "protocol": "tcp",
        "ingress_port": listen_port,
        "next_hop": f"127.0.0.1:{egress_port}",
        "targets": [{"host": "127.0.0.1", "port": egress_port}],
        "revision": 1,
    }])
    try:
        egress.start()
        ingress.start()
        wait_listener("127.0.0.1", listen_port)
    except Exception:
        _teardown({"agents": [ingress, egress], "target": target, "panel": panel})
        raise
    return {"target": target, "panel": panel, "ingress": ingress, "egress": egress,
            "listen_port": listen_port, "agents": [ingress, egress], "probe_port": listen_port}


def wait_listener(host: str, port: int, timeout: float = 30.0) -> float:
    """等到端口真的能建连为止，返回耗时（秒）。

    不能只看 admin API 起来了：admin 监听与数据面 bind 是两件事，前者先可用。
    """
    started = time.perf_counter()
    deadline = started + timeout
    last: Exception | None = None
    while time.perf_counter() < deadline:
        try:
            with socket.create_connection((host, port), timeout=2):
                return time.perf_counter() - started
        except OSError as exc:
            last = exc
            time.sleep(0.02)
    raise TimeoutError(f"listener {host}:{port} never accepted a connection: {last!r}")


def measure_throughput(topology: dict, workers_profile: dict, prefix: str) -> dict:
    payload = os.urandom(workers_profile["payload_kib"] * 1024)
    samples = [
        transfer_once("127.0.0.1", topology["listen_port"], payload)
        for _ in range(workers_profile["transfers"])
    ]
    summary = summarize_throughput(samples)
    return {f"{prefix}_throughput": summary.to_json()}


def measure_connection_setup(topology: dict, profile: dict, prefix: str) -> dict:
    samples = [
        setup_latency_once("127.0.0.1", topology["listen_port"])
        for _ in range(profile["setups"])
    ]
    summary = Summary.of([s * 1000 for s in samples], "ms")
    return {f"{prefix}_connect_ms": summary.to_json()}


def measure_concurrency(topology: dict, profile: dict, prefix: str) -> dict:
    payload = os.urandom(4096)
    rounds, latencies = [], []
    for _ in range(profile["conn_rounds"]):
        count, wall, per_conn = concurrent_round(
            "127.0.0.1", topology["listen_port"], profile["concurrency"], payload)
        rounds.append((count * len(payload), wall))
        latencies.extend(per_conn)
    return {
        f"{prefix}_concurrent_throughput": summarize_throughput(rounds).to_json(),
        f"{prefix}_concurrent_rtt_ms": Summary.of([s * 1000 for s in latencies], "ms").to_json(),
        f"{prefix}_concurrency": profile["concurrency"],
    }


def measure_gauges(topology: dict, baseline_gauges: dict | None = None) -> dict:
    """CPU / RSS / goroutines 的**结束读数**，以及整轮负载的 CPU 增量。

    两次读数（负载前 / 负载后）之差才是有意义的 CPU 数字：单次读数只是一个累计值，
    和本轮测试无关。`or None` 那种写法在这里是陷阱——CPU 增量恰好为 0.0 会被当成
    "没测到"，所以这里显式判断 None。
    """
    out: dict = {}
    total_cpu: float | None = None
    for agent in topology["agents"]:
        current = agent.gauge()
        out[f"{agent.label}_gauges"] = current
        before = (baseline_gauges or {}).get(agent.label, {})
        after_seconds, before_seconds = current.get("cpu_seconds"), before.get("cpu_seconds")
        after_ticks, before_ticks = current.get("cpu_ticks"), before.get("cpu_ticks")
        if before_seconds is not None and after_seconds is not None:
            delta = after_seconds - before_seconds
            out[f"{agent.label}_cpu_seconds_used"] = delta
            total_cpu = delta if total_cpu is None else total_cpu + delta
        if before_ticks is not None and after_ticks is not None:
            out[f"{agent.label}_cpu_ticks_used"] = after_ticks - before_ticks
    out["agents_cpu_seconds_used_total"] = total_cpu
    if total_cpu is not None:
        out["cpu_resolution_note"] = (
            "CPU 分辨率是一个调度 tick（%.1f ms）；读数为 0 表示本次负载的 CPU 时间"
            "低于该分辨率，而不是没有测到。需要可读的 CPU 数字时用 --profile full。"
            % (1000.0 / cpu_hz())
            if total_cpu == 0.0
            else "ok"
        )
    return out


def collect_gauges(topology: dict) -> dict:
    """负载开始前的读数（供 measure_gauges 做差）。"""
    return {agent.label: agent.gauge() for agent in topology["agents"]}


def measure_hot_reload(topology: dict, profile: dict, prefix: str) -> dict:
    """同一隧道换 target（revision+1）→ 新 target 生效的耗时。

    这是 §13.3.4「Target Host / Port 无影响变更」的**性能**侧面：热替换不重建
    listener，所以它必须显著快于一次完整重建。脚本只记录耗时，不判定阈值。
    """
    agent: AgentProcess = topology["ingress"]
    samples = []
    for i in range(min(profile["conn_timeouts"] // 4 + 1, 20)):
        alt = EchoTarget()
        try:
            cfg = {
                "id": "perf-direct",
                "mode": "DIRECT",
                "protocol": "tcp",
                "ingress_port": topology["listen_port"],
                "remote_host": alt.host,
                "remote_port": alt.port,
                "revision": 100 + i,
            }
            started = time.perf_counter()
            agent.apply_tunnel(cfg)
            applied = time.perf_counter() - started
            # 新目标真的要能用：只在 apply 返回后就宣布成功，会把"没生效"测成
            # "很快"。这里必须等一次真实往返穿过新 upstream。
            transfer_once("127.0.0.1", topology["listen_port"], b"hot-reload")
            effective = time.perf_counter() - started
            samples.append((applied, effective))
        finally:
            alt.close()
    return {
        f"{prefix}_hot_reload_apply_ms": Summary.of([s[0] * 1000 for s in samples], "ms").to_json(),
        f"{prefix}_hot_reload_effective_ms": Summary.of([s[1] * 1000 for s in samples], "ms").to_json(),
    }


def measure_restart_convergence(binary: Path, root: Path, factory: Callable[[Path, Path], dict],
                                prefix: str, rounds: int = 3) -> dict:
    """重启 Agent → 端口重新可用的耗时，分两条路径分别测（§5.4）。

    · `panel` 变体：重启期间面板可达 → 期望状态来自面板（正常重连路径）；
    · `lkg`   变体：重启期间面板不可达 → 走本地 last-known-good 快照（§1.6
      耐久性路径）。

    两者必须分开测：合成一个数字就看不出"面板回来时能收敛"和"面板不在时还能不能
    自己站起来"哪一条退化了 —— 而这恰好是 V4 durability 的两个不同承诺。

    计时从**进程创建**开始，而不是等 admin API 起来之后再计时：启动顺序是
    管理器 → restore → admin API，等 admin 就等于等 restore 已经做完，测到的会是
    接近 0 毫秒的假数字。这里量的就是"从拉起进程到数据面重新收连接"。
    """
    out: dict = {}
    for variant in ("panel", "lkg"):
        samples: list[float] = []
        sources: list[str] = []
        for i in range(rounds):
            topology = factory(binary, root / f"restart-{variant}-{i}")
            try:
                agent: AgentProcess = topology["ingress"]
                panel: FakePanel = topology["panel"]
                agent.kill()
                if variant == "lkg":
                    # 制造真实的"面板不可达"（连接被拒 = FetchUnreachable），
                    # 而不是让 Agent 去连一个不存在的地址：那是另一种故障。
                    panel.stop()
                marker = count_restore_lines(agent)
                agent.start(wait=False)
                samples.append(wait_listener("127.0.0.1", topology["listen_port"]))
                # 监听器在 restore 内部就 bind 好了，而 "v3 restore done" 这行日志
                # 是 restore 返回之后才写的 —— 直接读会读到**上一次**启动的行，把
                # LKG 归因成 panel。这里等本次启动的那一行出现再取。
                sources.append(wait_restore_source(agent, marker))
            finally:
                _teardown(topology)
                shutil.rmtree(root / f"restart-{variant}-{i}", ignore_errors=True)
        if samples:
            out[f"{prefix}_restart_{variant}_ms"] = Summary.of([s * 1000 for s in samples], "ms").to_json()
            out[f"{prefix}_restart_{variant}_sources"] = sorted(set(s for s in sources if s))
    return out


def count_restore_lines(agent: AgentProcess) -> int:
    """本次启动前，日志里已经有多少行 "v3 restore done"。"""
    try:
        text = agent.stdout_path.read_text()
    except OSError:
        return 0
    return sum(1 for line in text.splitlines() if "v3 restore done" in line)


def wait_restore_source(agent: AgentProcess, previous: int, timeout: float = 10.0) -> str:
    """等待并读出**本次**启动的期望状态来源（panel / lkg）。

    来源归因是"耐久性路径真的被走到了"的证据，所以不能靠猜：必须等到本次启动
    新写的那一行。读不到就返回空串（产物里表现为缺失），而不是沿用上一次的值。
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            lines = [ln for ln in agent.stdout_path.read_text().splitlines() if "v3 restore done" in ln]
        except OSError:
            lines = []
        if len(lines) > previous:
            # 取**最后**一行：前面那些是本轮更早一次启动留下的（第一次启动走的是
            # 面板，重启走的才是 LKG）。取第一行会把 LKG 归因成 panel，
            # 于是"耐久性路径真的被走到了"这条证据就变成了假证据。
            for line in reversed(lines):
                if "source=" in line:
                    source = line.rsplit("source=", 1)[1].strip()
                    if source:
                        return source
            return ""
        time.sleep(0.05)
    return ""


def measure_graceful_drain(binary: Path, root: Path, prefix: str, rounds: int = 3) -> dict:
    """SIGTERM → 进程退出的耗时，分「空载」与「有在途连接」两种（§5.4）。

    两者都要测：空载退出量的是进程收尾开销，**有在途连接**退出量的是有界排空本身。
    只测空载会把排空完全漏掉（数字看起来永远很漂亮），只测有在途连接则看不出
    排空上限是否被写死成了兜底值。有界排空的天花板是 10s，所以"有在途连接"的
    中位数接近 10s 是**预期**结果，不是退化。
    """
    out: dict = {}
    idle: list[float] = []
    held: list[float] = []
    for i in range(rounds):
        topology = direct_topology(binary, root / f"drain-{i}")
        try:
            idle.append(topology["ingress"].stop(signal.SIGTERM, timeout=30))
        finally:
            _teardown(topology)

        topology = direct_topology(binary, root / f"drain-held-{i}")
        try:
            holder = socket.create_connection(("127.0.0.1", topology["listen_port"]), timeout=10)
            try:
                holder.sendall(b"hold")
                holder.recv(4)
                held.append(topology["ingress"].stop(signal.SIGTERM, timeout=30))
            finally:
                holder.close()
        finally:
            _teardown(topology)
    out[f"{prefix}_graceful_drain_idle_ms"] = Summary.of([s * 1000 for s in idle], "ms").to_json()
    out[f"{prefix}_graceful_drain_held_ms"] = Summary.of([s * 1000 for s in held], "ms").to_json()
    return out


def _teardown(topology: dict) -> None:
    for agent in topology.get("agents", []):
        agent.kill()
    target = topology.get("target")
    if target is not None:
        target.close()
    panel = topology.get("panel")
    if panel is not None:
        panel.stop()


# ======================================================================
# 环境信息（可复现性的一半在这个字段里）
# ======================================================================

def environment(binary: Path | None) -> dict:
    env = {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpu_count": os.cpu_count(),
        "kernel": platform.uname().release,
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cpu_tick_seconds": 1.0 / cpu_hz(),
    }
    try:
        env["loadavg"] = list(os.getloadavg())
    except OSError:
        env["loadavg"] = None
    try:
        env["cpu_model"] = next(
            line.split(":", 1)[1].strip()
            for line in Path("/proc/cpuinfo").read_text().splitlines()
            if line.startswith("model name")
        )
    except (OSError, StopIteration):
        env["cpu_model"] = None
    # 容器里跑基线时 CPU 配额才是真正的核数：不记录它，跨机器比较就没有意义。
    for quota_path, label in (
        ("/sys/fs/cgroup/cpu.max", "cgroup_cpu_max"),
        ("/sys/fs/cgroup/memory.max", "cgroup_memory_max"),
    ):
        try:
            env[label] = Path(quota_path).read_text().strip()
        except OSError:
            env[label] = None
    if binary is not None:
        env["agent_version"] = _cmd([str(binary), "--version"])
        env["go_version"] = _cmd(["go", "version"]) or None
    env["git_rev"] = _cmd(["git", "rev-parse", "HEAD"])
    env["git_dirty"] = bool(_cmd(["git", "status", "--porcelain"]))
    return env


def _cmd(args: Sequence[str], cwd: Path | None = None) -> str:
    try:
        out = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip()


# ======================================================================
# 入口
# ======================================================================

def run(args: argparse.Namespace) -> dict:
    binary = Path(args.agent_binary).resolve()
    if not binary.exists():
        raise SystemExit(f"agent binary not found: {binary} (build it first, or pass --agent-binary)")

    profile = dict(PROFILES[args.profile])
    result: dict = {
        "schema_version": SCHEMA_VERSION,
        "kind": "v5-tcp-baseline",
        "profile": args.profile,
        "workload": profile,
        "environment": environment(binary),
        "scenarios": {},
    }

    root = Path(tempfile.mkdtemp(prefix="tunex-perf-"))
    try:
        for scenario in args.scenarios:
            factory = direct_topology if scenario == "direct" else relay_topology
            topology = factory(binary, root / scenario)
            try:
                key = scenario
                result["scenarios"][key] = {}
                before = collect_gauges(topology)
                result["scenarios"][key].update(measure_throughput(topology, profile, scenario))
                result["scenarios"][key].update(measure_connection_setup(topology, profile, scenario))
                result["scenarios"][key].update(measure_concurrency(topology, profile, scenario))
                if scenario == "direct":
                    # 热重载与重启收敛只跑 DIRECT：它们的对象是"单节点上的
                    # 生命周期"，在 RELAY 上重跑只是把同一个数字测两遍。
                    result["scenarios"][key].update(measure_hot_reload(topology, profile, scenario))
                result["scenarios"][key].update(measure_gauges(topology, before))
            finally:
                _teardown(topology)

        result["scenarios"]["direct"].update(
            measure_restart_convergence(binary, root, direct_topology, "direct"))
        result["scenarios"]["direct"].update(
            measure_graceful_drain(binary, root, "direct"))
    finally:
        shutil.rmtree(root, ignore_errors=True)

    return result


def write_outputs(result: dict, out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    json_path = out_dir / f"v5-tcp-baseline-{stamp}.json"
    csv_path = out_dir / f"v5-tcp-baseline-{stamp}.csv"
    json_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")

    rows = list(flatten_metrics(result))
    with csv_path.open("w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["scenario", "metric", "value"])
        writer.writerows(rows)
    return json_path, csv_path


def flatten_metrics(result: dict) -> Iterable[tuple[str, str, object]]:
    """把嵌套结果摊平成 (scenario, metric, value) —— JSON 仍是权威格式。"""
    for scenario, metrics in result.get("scenarios", {}).items():
        for name, value in sorted(metrics.items()):
            if isinstance(value, dict) and "median" in value:
                for stat in ("median", "p95", "min", "max", "mean", "count"):
                    if value.get(stat) is not None:
                        yield scenario, f"{name}.{stat}", value[stat]
            else:
                yield scenario, name, value


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="TuneX V5 TCP performance baseline")
    parser.add_argument("--agent-binary", default="agent/tunex-agent",
                        help="path to the built tunex-agent binary")
    parser.add_argument("--out", default="scripts/perf/results",
                        help="output directory for the JSON/CSV artifacts")
    parser.add_argument("--profile", choices=sorted(PROFILES), default="quick")
    parser.add_argument("--scenarios", nargs="+", choices=["direct", "relay"],
                        default=["direct", "relay"])
    parser.add_argument("--json", action="store_true", help="also print the JSON artifact to stdout")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    result = run(args)
    json_path, csv_path = write_outputs(result, Path(args.out))
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    print(f"baseline JSON: {json_path}")
    print(f"baseline CSV:  {csv_path}")
    for scenario, metrics in result["scenarios"].items():
        tput = metrics.get(f"{scenario}_throughput", {})
        median = tput.get("median")
        print(f"  {scenario}: throughput median={median if median is None else round(median, 2)} MiB/s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
