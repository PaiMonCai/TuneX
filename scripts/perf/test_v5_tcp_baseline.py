#!/usr/bin/env python3
"""V5-WP3 基线采集器的自检（标准库 unittest，不需要任何外部服务）。

    python3 scripts/perf/test_v5_tcp_baseline.py

只测**纯函数**：统计口径、产物形状，以及 V5.1a 新增的 TLS/WS 客户端里那些
可离线断言的部分（RFC 6455 的 accept 值、帧编解码、握手响应校验、场景注册表）。
唯一的例外是 `WSClientLoopbackTest`：它用一个 20 行的本地回显服务端验证
WSClient 的读侧缓冲（握手响应与首个数据帧同段到达时不能吞帧）。真实拓扑的
采集仍然由 `v5-tcp-baseline.py` 自己跑 —— 把易波动的端到端测量塞进单测，只会
得到一条随机器负载变红的测试。
"""

from __future__ import annotations

import csv
import importlib.util
import json
import socket
import ssl
import sys
import tempfile
import threading
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("v5-tcp-baseline.py")
spec = importlib.util.spec_from_file_location("v5_tcp_baseline", MODULE_PATH)
baseline = importlib.util.module_from_spec(spec)
assert spec.loader is not None
# dataclasses resolves annotations through sys.modules[cls.__module__], so the
# module must be registered before exec_module — otherwise every @dataclass in
# the harness fails with a confusing AttributeError.
sys.modules["v5_tcp_baseline"] = baseline
spec.loader.exec_module(baseline)


class PercentileTest(unittest.TestCase):
    def test_empty_is_none_not_zero(self):
        # 0.0 会被下游读成"测到了 0 毫秒"，把"没测到"伪装成"极快"。
        self.assertIsNone(baseline.percentile([], 50))

    def test_single_sample(self):
        self.assertEqual(baseline.percentile([7.0], 95), 7.0)

    def test_median_of_even_count(self):
        self.assertAlmostEqual(baseline.percentile([1, 2, 3, 4], 50), 2.5)

    def test_p95_of_known_series(self):
        values = list(range(1, 101))
        self.assertAlmostEqual(baseline.percentile(values, 95), 95.05, places=2)

    def test_extremes(self):
        values = [5, 1, 9]
        self.assertEqual(baseline.percentile(values, 0), 1)
        self.assertEqual(baseline.percentile(values, 100), 9)


class ThroughputTest(unittest.TestCase):
    def test_mib_per_second(self):
        # 1 MiB in 1s = 1 MiB/s
        self.assertAlmostEqual(baseline.throughput_mib_s(1024 * 1024, 1.0), 1.0)

    def test_zero_elapsed_does_not_produce_infinity(self):
        # inf 会把整组中位数污染成 inf，整份基线就废了。
        self.assertEqual(baseline.throughput_mib_s(1024, 0.0), 0.0)
        self.assertEqual(baseline.throughput_mib_s(1024, -1.0), 0.0)

    def test_summary_shape(self):
        summary = baseline.summarize_throughput([(1024 * 1024, 1.0), (2 * 1024 * 1024, 1.0)])
        self.assertEqual(summary.count, 2)
        self.assertEqual(summary.unit, "MiB/s")
        self.assertAlmostEqual(summary.median, 1.5)
        self.assertAlmostEqual(summary.max, 2.0)


class SummaryTest(unittest.TestCase):
    def test_empty_summary_serialises_null_not_zero(self):
        payload = baseline.Summary.of([], "ms").to_json()
        for key in ("median", "p95", "min", "max", "mean"):
            self.assertIsNone(payload[key], key)
        self.assertEqual(payload["count"], 0)

    def test_p95_is_never_below_median(self):
        summary = baseline.Summary.of([1, 2, 3, 100], "ms")
        self.assertGreaterEqual(summary.p95, summary.median)


class FlattenTest(unittest.TestCase):
    RESULT = {
        "schema_version": baseline.SCHEMA_VERSION,
        "scenarios": {
            "direct": {
                "direct_throughput": {"count": 2, "median": 10.0, "p95": 12.0,
                                      "min": 9.0, "max": 12.0, "mean": 10.5, "unit": "MiB/s"},
                "direct_concurrency": 16,
            }
        },
    }

    def test_csv_rows_cover_every_statistic(self):
        rows = dict((f"{scenario}.{name}", value) for scenario, name, value in baseline.flatten_metrics(self.RESULT))
        self.assertEqual(rows["direct.direct_throughput.median"], 10.0)
        self.assertEqual(rows["direct.direct_throughput.p95"], 12.0)
        self.assertEqual(rows["direct.direct_concurrency"], 16)

    def test_artifacts_are_machine_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            json_path, csv_path = baseline.write_outputs(self.RESULT, Path(tmp))
            reloaded = json.loads(json_path.read_text())
            self.assertEqual(reloaded["scenarios"]["direct"]["direct_concurrency"], 16)
            with csv_path.open() as fh:
                rows = list(csv.reader(fh))
            self.assertEqual(rows[0], ["scenario", "metric", "value"])
            self.assertIn(["direct", "direct_throughput.median", "10.0"], rows)


class EnvironmentTest(unittest.TestCase):
    def test_environment_reports_machine_facts(self):
        env = baseline.environment(None)
        for key in ("python", "platform", "kernel", "cpu_count", "timestamp_utc", "loadavg"):
            self.assertIn(key, env)
        # 容器里跑时 CPU 配额才是真正的核数；缺它会让跨机器比较失去意义。
        self.assertIn("cgroup_cpu_max", env)


class ProfileTest(unittest.TestCase):
    def test_profiles_exist_and_scale_up(self):
        self.assertIn("quick", baseline.PROFILES)
        self.assertIn("full", baseline.PROFILES)
        quick, full = baseline.PROFILES["quick"], baseline.PROFILES["full"]
        for key in ("transfers", "setups", "concurrency", "conn_rounds"):
            self.assertGreater(full[key], quick[key], key)


class CpuAccountingTest(unittest.TestCase):
    def test_own_process_cpu_is_measurable(self):
        # 采样器必须能读到自己（基线里读的是被测 Agent 进程）。
        import os
        value = baseline._cpu_seconds(os.getpid())
        self.assertIsNotNone(value)
        self.assertGreaterEqual(value, 0.0)

    def test_cpu_of_a_child_that_burns_cpu_is_nonzero(self):
        """回归：/proc/<pid>/stat 的 utime 是**字段 14**，切掉 comm 之后落在
        index 11。曾经写成 13/14，读到的是 cutime/cstime（已回收子进程的累计
        值）—— 对刚启动的进程恒为 0，症状是"CPU 永远是 0.0"，看起来像负载太轻。
        真实跑一段 CPU 的子进程必须能被测到大于 0。"""
        import subprocess
        import sys
        import time

        child = subprocess.Popen(
            [sys.executable, "-c", "x=0\nfor i in range(40_000_000): x += i"]
        )
        try:
            deadline = time.time() + 10
            ticks = 0
            while time.time() < deadline:
                time.sleep(0.2)
                ticks = baseline._cpu_ticks(child.pid) or 0
                if ticks > 0:
                    break
            self.assertGreater(ticks, 0, "a CPU-burning child must not report 0 ticks")
            self.assertGreater(baseline._cpu_seconds(child.pid), 0.0)
        finally:
            child.kill()
            child.wait()


class WSAcceptKeyTest(unittest.TestCase):
    def test_rfc6455_published_test_vector(self):
        # RFC 6455 §1.3 的示例：客户端 key → 服务端必须回的 accept 值。
        self.assertEqual(baseline.ws_accept_value("dGhlIHNhbXBsZSBub25jZQ=="),
                         "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")


class WSHandshakeTest(unittest.TestCase):
    KEY = "dGhlIHNhbXBsZSBub25jZQ=="

    def _response(self, status: str = "HTTP/1.1 101 Switching Protocols",
                  accept: str | None = None) -> bytes:
        value = baseline.ws_accept_value(self.KEY) if accept is None else accept
        return (f"{status}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {value}\r\n\r\n").encode()

    def test_request_carries_the_required_upgrade_headers(self):
        req = baseline.ws_handshake_request(self.KEY).decode()
        for token in ("GET / HTTP/1.1", "Upgrade: websocket", "Connection: Upgrade",
                      f"Sec-WebSocket-Key: {self.KEY}", "Sec-WebSocket-Version: 13"):
            self.assertIn(token, req, token)
        self.assertTrue(req.endswith("\r\n\r\n"))

    def test_valid_101_is_accepted(self):
        ok, _detail = baseline.ws_handshake_ok(self._response(), self.KEY)
        self.assertTrue(ok)

    def test_wrong_accept_is_rejected(self):
        # 只检查 101 会把"对端算错握手"伪装成后面的"吞吐为 0"。
        ok, detail = baseline.ws_handshake_ok(self._response(accept="bm90IHRoZSBrZXk="), self.KEY)
        self.assertFalse(ok)
        self.assertIn("mismatch", detail)

    def test_non_upgrade_response_is_rejected(self):
        ok, detail = baseline.ws_handshake_ok(self._response("HTTP/1.1 200 OK"), self.KEY)
        self.assertFalse(ok)
        self.assertIn("no 101", detail)

    def test_missing_accept_header_is_rejected(self):
        ok, detail = baseline.ws_handshake_ok(b"HTTP/1.1 101 Switching Protocols\r\n\r\n", self.KEY)
        self.assertFalse(ok)
        self.assertIn("Sec-WebSocket-Accept", detail)


class XorMaskTest(unittest.TestCase):
    def test_matches_the_naive_rfc6455_definition_at_every_alignment(self):
        mask = b"\x11\x22\x33\x44"
        for size in (0, 1, 2, 3, 4, 5, 7, 8, 300, 65536):
            payload = bytes((i * 7 + 3) % 256 for i in range(size))
            naive = bytes(payload[i] ^ mask[i % 4] for i in range(size))
            self.assertEqual(baseline.xor_mask(payload, mask), naive, size)

    def test_mask_is_its_own_inverse(self):
        payload = b"round trip"
        mask = b"\xde\xad\xbe\xef"
        once = baseline.xor_mask(payload, mask)
        self.assertEqual(baseline.xor_mask(once, mask), payload)

    def test_rejects_a_mask_that_is_not_four_bytes(self):
        with self.assertRaises(ValueError):
            baseline.xor_mask(b"abc", b"\x00\x00\x00")


class WSFrameCodecTest(unittest.TestCase):
    MASK = b"\x01\x02\x03\x04"

    def test_masked_client_frame_roundtrips(self):
        payload = b"tunex-ws"
        raw = baseline.encode_ws_frame(baseline.WS_OP_BINARY, payload, mask=self.MASK)
        self.assertTrue(raw[1] & 0x80, "client frames MUST set the MASK bit")
        frames, rest = baseline.decode_ws_frames(raw)
        self.assertEqual(rest, b"")
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["opcode"], baseline.WS_OP_BINARY)
        self.assertEqual(frames[0]["payload"], payload)
        self.assertTrue(frames[0]["masked"])

    def test_server_frame_is_unmasked_with_16bit_length(self):
        raw = baseline.encode_ws_frame(baseline.WS_OP_BINARY, b"x" * 300)
        self.assertEqual(raw[1] & 0x80, 0)
        self.assertEqual(raw[1] & 0x7F, 126)
        frames, _ = baseline.decode_ws_frames(raw)
        self.assertEqual(frames[0]["payload"], b"x" * 300)
        self.assertFalse(frames[0]["masked"])

    def test_64k_payload_uses_the_64bit_length_form(self):
        # --profile full 的 payload_kib=1024 会走到这里；长度前缀写错会在真实
        # 链路（大 payload）上才炸，而不是在 quick 档。
        payload = b"y" * (1 << 16)
        raw = baseline.encode_ws_frame(baseline.WS_OP_BINARY, payload, mask=b"\x00\x00\x00\x00")
        self.assertEqual(raw[1] & 0x7F, 127)
        frames, _ = baseline.decode_ws_frames(raw)
        self.assertEqual(frames[0]["payload"], payload)

    def test_partial_frame_stays_in_the_remainder(self):
        raw = baseline.encode_ws_frame(baseline.WS_OP_BINARY, b"abcdef", mask=self.MASK)
        frames, rest = baseline.decode_ws_frames(raw[:6])
        self.assertEqual(frames, [])
        self.assertEqual(rest, raw[:6])
        frames, rest = baseline.decode_ws_frames(rest + raw[6:])
        self.assertEqual(frames[0]["payload"], b"abcdef")
        self.assertEqual(rest, b"")

    def test_two_frames_arriving_in_one_chunk(self):
        one = baseline.encode_ws_frame(baseline.WS_OP_BINARY, b"a", mask=b"\x00\x00\x00\x00")
        two = baseline.encode_ws_frame(baseline.WS_OP_CONTINUATION, b"b", mask=b"\x00\x00\x00\x00")
        frames, rest = baseline.decode_ws_frames(one + two)
        self.assertEqual([f["payload"] for f in frames], [b"a", b"b"])
        self.assertEqual(rest, b"")

    def test_fragmented_message_flags_survive_decoding(self):
        raw = baseline.encode_ws_frame(baseline.WS_OP_BINARY, b"head", mask=self.MASK, fin=False)
        frames, _ = baseline.decode_ws_frames(raw)
        self.assertFalse(frames[0]["fin"])

    def test_ping_control_frame_is_decodable(self):
        raw = baseline.encode_ws_frame(baseline.WS_OP_PING, b"hb", mask=self.MASK)
        frames, _ = baseline.decode_ws_frames(raw)
        self.assertEqual(frames[0]["opcode"], baseline.WS_OP_PING)
        self.assertEqual(frames[0]["payload"], b"hb")

    def test_empty_payload_frame_is_valid(self):
        raw = baseline.encode_ws_frame(baseline.WS_OP_BINARY, b"", mask=self.MASK)
        frames, rest = baseline.decode_ws_frames(raw)
        self.assertEqual(rest, b"")
        self.assertEqual(frames[0]["payload"], b"")


class TLSClientTest(unittest.TestCase):
    def test_context_verifies_nothing_on_loopback_self_signed(self):
        # 基线的临时证书不进信任库：这里量的是数据面成本，不是信任链。
        ctx = baseline.tls_client_context()
        self.assertEqual(ctx.verify_mode, ssl.CERT_NONE)
        self.assertFalse(ctx.check_hostname)
        self.assertGreaterEqual(ctx.minimum_version, ssl.TLSVersion.TLSv1_2)

    def test_certificate_command_shape(self):
        argv = baseline.certificate_command("openssl", Path("/tmp/perf.crt"), Path("/tmp/perf.key"))
        self.assertEqual(argv[0], "openssl")
        for flag in ("-x509", "-keyout", "-out", "-nodes", "-addext", "-subj"):
            self.assertIn(flag, argv, flag)
        self.assertIn("/tmp/perf.crt", argv)
        self.assertIn("/tmp/perf.key", argv)
        san = argv[argv.index("-addext") + 1]
        self.assertIn("IP:127.0.0.1", san)

    def test_missing_openssl_message_is_actionable(self):
        msg = baseline.openssl_missing_message()
        self.assertIn("openssl", msg)
        # 必须指出"不测 tls 时该跑什么"，否则读的人只会看到一条红。
        self.assertIn("--scenarios", msg)
        self.assertIn("direct", msg)


class ScenarioRegistryTest(unittest.TestCase):
    def test_default_scenarios_are_the_frozen_tcp_ones(self):
        self.assertEqual(baseline.parse_args([]).scenarios, ["direct", "relay"])

    def test_tls_and_ws_are_selectable(self):
        args = baseline.parse_args(["--scenarios", "direct", "relay", "tls", "ws"])
        self.assertEqual(args.scenarios, ["direct", "relay", "tls", "ws"])

    def test_protocol_mapping_distinguishes_all_three_protocols(self):
        self.assertEqual(baseline.SCENARIO_PROTOCOL["direct"], "tcp")
        self.assertEqual(baseline.SCENARIO_PROTOCOL["relay"], "tcp")
        self.assertEqual(baseline.SCENARIO_PROTOCOL["tls"], "tls")
        self.assertEqual(baseline.SCENARIO_PROTOCOL["ws"], "ws")

    def test_every_scenario_has_a_factory_and_a_transfer(self):
        for scenario, protocol in baseline.SCENARIO_PROTOCOL.items():
            self.assertTrue(callable(baseline.scenario_factory(scenario)), scenario)
            self.assertIn(protocol, baseline.PROTOCOL_TRANSFER, scenario)
            self.assertIn(protocol, baseline.PROTOCOL_SETUP, scenario)
        # 只有需要会话建立的协议才有 opener；TCP 的并发轮保持原样。
        self.assertEqual(sorted(baseline.PROTOCOL_OPENER), ["tls", "ws"])

    def test_unknown_scenario_fails_loudly(self):
        with self.assertRaises(ValueError):
            baseline.scenario_factory("quic")


class WSClientLoopbackTest(unittest.TestCase):
    """WSClient 读侧缓冲的回归：握手响应与首个数据帧同段到达时不能吞帧。

    这是真实链路上会发生的事（服务端先写 101、紧接着写第一帧），而"读到
    \\r\\n\\r\\n 就把尾巴丢掉"的实现会静默少一个 payload —— 症状是吞吐偏低，
    不是报错，正好是基线最不该有的失败模式。
    """

    def test_coalesced_handshake_and_first_frame_are_not_swallowed(self):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        host, port = server.getsockname()
        first = b"coalesced"

        def serve() -> None:
            conn, _ = server.accept()
            try:
                head = b""
                while b"\r\n\r\n" not in head:
                    head += conn.recv(1024)
                key = [ln.split(":", 1)[1].strip() for ln in head.decode().split("\r\n")
                       if ln.lower().startswith("sec-websocket-key:")][0]
                response = ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                            "Connection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n"
                            % baseline.ws_accept_value(key)).encode()
                # 一帧数据与握手响应在**同一次** write 里发出。
                conn.sendall(response + baseline.encode_ws_frame(baseline.WS_OP_BINARY, first))
                buf = b""
                while True:
                    chunk = conn.recv(4096)
                    if not chunk:
                        return  # 客户端关闭：recv 会一直返回 b""，必须在这里收手
                    buf += chunk
                    frames, buf = baseline.decode_ws_frames(buf)
                    if frames:
                        return  # 客户端发来的 masked 帧解得出来即可
            finally:
                conn.close()
                server.close()

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        try:
            with baseline.WSClient(host, port, timeout=5) as client:
                self.assertGreater(client.handshake_ms, 0.0)
                got = b""
                while len(got) < len(first):
                    chunk = client.recv(1024)
                    if not chunk:
                        break
                    got += chunk
            self.assertEqual(got, first)
        finally:
            thread.join(timeout=5)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
