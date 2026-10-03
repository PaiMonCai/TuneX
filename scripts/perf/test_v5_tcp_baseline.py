#!/usr/bin/env python3
"""V5-WP3 基线采集器的自检（标准库 unittest，不需要任何外部服务）。

    python3 scripts/perf/test_v5_tcp_baseline.py

只测**纯函数**：统计口径与产物形状。真实拓扑的采集由 `v5-tcp-baseline.py`
自己跑，那条路径需要 go 与回环端口，不适合放进单元测试（也不该：把易波动的
端到端测量塞进单测，只会得到一条随机器负载变红的测试）。
"""

from __future__ import annotations

import csv
import importlib.util
import json
import sys
import tempfile
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


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
