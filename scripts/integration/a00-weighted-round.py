#!/usr/bin/env python3
"""A00 weighted_round real distribution + Agent restart acceptance.

Prerequisite:
    scripts/integration/setup.sh

The test uses the existing isolated 4-Agent topology and public Forward actions.
DB writes only prepare the desired egress policy/target fixture; runtime changes
still have to travel through suspend/resume or Agent startup restore.

Evidence pinned here:
- pool strategy NULL inherits the egress Node strategy;
- an explicit pool strategy overrides the Node default;
- target weights are actually executed (3:1), not only serialized;
- egress Agent restart rebuilds the same weighted policy from desired state.
"""
from __future__ import annotations

import importlib.util
import json
import os
import signal
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "evidence"
OUT.mkdir(exist_ok=True)
RESULT = OUT / "a00-weighted-round-result.txt"
TRACE = OUT / "a00-weighted-round-http.json"
SAMPLES = int(os.environ.get("A00_WEIGHTED_SAMPLES", "40"))


def load_harness():
    spec = importlib.util.spec_from_file_location("weighted_harness", HERE / "protocol-suite.py")
    if spec is None or spec.loader is None:
        raise SystemExit("cannot load protocol-suite.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


H = load_harness()


def check(condition: bool, message: str, detail: str = "") -> None:
    H.check(condition, message, detail)


def configure_policy(
    fid: int,
    *,
    pool_strategy: str | None,
    node_strategy: str | None,
    weight_a: int = 3,
    weight_b: int = 1,
) -> dict:
    pool_js = "null" if pool_strategy is None else json.dumps(pool_strategy)
    node_js = "null" if node_strategy is None else json.dumps(node_strategy)
    return H.db(
        f"""
        const tunnel = await db.tunnel.findUnique({{
          where: {{ id: {fid} }},
          select: {{ egress_pool_id: true, egress_node_id: true }}
        }});
        if (!tunnel || !tunnel.egress_pool_id || !tunnel.egress_node_id) throw new Error("relay fixture missing pool/node");
        await db.$transaction(async (tx) => {{
          await tx.node.update({{
            where: {{ id: tunnel.egress_node_id }},
            data: {{ lb_strategy: {node_js} }}
          }});
          await tx.egressPool.update({{
            where: {{ id: tunnel.egress_pool_id }},
            data: {{ lb_strategy: {pool_js}, status: "active" }}
          }});
          await tx.egressTarget.deleteMany({{ where: {{ pool_id: tunnel.egress_pool_id }} }});
          await tx.egressTarget.createMany({{
            data: [
              {{ pool_id: tunnel.egress_pool_id, host: "target-a", port: 3030, weight: {weight_a}, order_by: 10, status: "active" }},
              {{ pool_id: tunnel.egress_pool_id, host: "target-b", port: 3030, weight: {weight_b}, order_by: 20, status: "active" }}
            ]
          }});
        }});
        return {{
          pool_id: tunnel.egress_pool_id,
          egress_node_id: tunnel.egress_node_id,
          pool_strategy: {pool_js},
          node_strategy: {node_js},
          weights: [{weight_a}, {weight_b}]
        }};
        """
    )


def reapply(fid: int, label: str) -> None:
    st, body, _ = H.req("POST", f"/api/forwards/{fid}/suspend", None, timeout=120)
    check(st == 200, f"{label}: suspend accepted", f"status={st} body={json.dumps(body, ensure_ascii=False)[:160]}")
    st, body, _ = H.req("POST", f"/api/forwards/{fid}/resume", None, timeout=180)
    check(st == 200, f"{label}: resume/reapply accepted", f"status={st} body={json.dumps(body, ensure_ascii=False)[:160]}")
    check(H.wait_active(fid, timeout=150), f"{label}: Forward converges after reapply", f"id={fid}")


def distribution(port: int, samples: int = SAMPLES) -> tuple[dict[str, int], list[str]]:
    counts = {"A": 0, "B": 0, "other": 0, "failed": 0}
    details: list[str] = []
    for _ in range(samples):
        ok, detail = H.tcp_probe(port, timeout=5)
        if not ok:
            counts["failed"] += 1
            details.append(detail)
            continue
        upper = detail.upper()
        if "TARGET-A" in upper:
            counts["A"] += 1
        elif "TARGET-B" in upper:
            counts["B"] += 1
        else:
            counts["other"] += 1
            details.append(detail)
    return counts, details[-6:]


def assert_weighted(counts: dict[str, int], label: str) -> None:
    good = counts["A"] + counts["B"]
    check(good >= max(16, int(SAMPLES * 0.8)),
          f"{label}: enough successful target-labelled connections",
          json.dumps(counts))
    if counts["B"] <= 0:
        check(False, f"{label}: weight-1 target receives traffic", json.dumps(counts))
        return
    ratio = counts["A"] / counts["B"]
    # The Agent's selector is deterministic for an unchanged healthy pool, but
    # the real-network gate allows a small window for failed probes/health timing.
    check(2.2 <= ratio <= 3.8,
          f"{label}: observed distribution is consistent with 3:1 weights",
          f"ratio={ratio:.3f} counts={json.dumps(counts)}")
    check(counts["other"] == 0,
          f"{label}: every successful connection names one configured target",
          json.dumps(counts))


def assert_round(counts: dict[str, int], label: str) -> None:
    good = counts["A"] + counts["B"]
    check(good >= max(16, int(SAMPLES * 0.8)),
          f"{label}: enough successful target-labelled connections",
          json.dumps(counts))
    if min(counts["A"], counts["B"]) <= 0:
        check(False, f"{label}: both targets receive traffic", json.dumps(counts))
        return
    ratio = counts["A"] / counts["B"]
    check(0.65 <= ratio <= 1.55,
          f"{label}: explicit pool round overrides a weighted node default",
          f"ratio={ratio:.3f} counts={json.dumps(counts)}")


def main() -> int:
    signal.signal(signal.SIGALRM, H.alarm)
    ready = False
    original_node_strategy = None
    H.acquire_lock()
    try:
        signal.setitimer(signal.ITIMER_REAL, 300)
        H.setup()
        ready = True
        signal.setitimer(signal.ITIMER_REAL, 0)

        status, fid, port, body = H.create_forward("A00-WEIGHTED", "tcp", mode="relay", target_port=3030)
        check(status in (200, 201) and fid is not None and port > 0,
              "A00.WEIGHTED relay fixture is created",
              f"status={status} port={port} body={json.dumps(body, ensure_ascii=False)[:180]}")
        if fid is None or status not in (200, 201):
            return 1
        check(H.wait_active(fid), "A00.WEIGHTED relay fixture converges", f"id={fid}")
        original_node_strategy = H.db(
            f"const n=await db.node.findUnique({{where:{{id:{H.EGR}}},select:{{lb_strategy:true}}}});"
            "return n ? n.lb_strategy : null;"
        )

        # 1) Node inheritance: NULL pool policy must inherit weighted_round.
        facts = configure_policy(fid, pool_strategy=None, node_strategy="weighted_round")
        reapply(fid, "A00.WEIGHTED node inheritance")
        inherited, tail = distribution(port)
        assert_weighted(inherited, "A00.WEIGHTED node inheritance")
        H.record(True, f"A00.WEIGHTED node inheritance fixture [facts={facts} counts={inherited} tail={tail}]")

        # 2) Pool override: an explicit round pool must beat a weighted node.
        facts = configure_policy(fid, pool_strategy="round", node_strategy="weighted_round")
        reapply(fid, "A00.WEIGHTED pool override")
        overridden, tail = distribution(port)
        assert_round(overridden, "A00.WEIGHTED pool override")
        H.record(True, f"A00.WEIGHTED pool override fixture [facts={facts} counts={overridden} tail={tail}]")

        # 3) Explicit weighted pool beats a random node and survives egress restart.
        facts = configure_policy(fid, pool_strategy="weighted_round", node_strategy="rand")
        reapply(fid, "A00.WEIGHTED explicit pool")
        before, tail = distribution(port)
        assert_weighted(before, "A00.WEIGHTED explicit pool before restart")
        H.record(True, f"A00.WEIGHTED explicit pool before restart fixture [facts={facts} counts={before} tail={tail}]")

        H.docker(["restart", H.EGRESS_CONTAINER], timeout=120)
        served = H.wait_until(lambda: H.tcp_probe(port, timeout=3)[0], timeout=180, interval=5)
        check(served, "A00.WEIGHTED relay serves again after egress Agent restart", f"port={port}")

        after, tail = distribution(port)
        assert_weighted(after, "A00.WEIGHTED explicit pool after restart")
        H.record(True, f"A00.WEIGHTED explicit pool after restart fixture [facts={facts} counts={after} tail={tail}]")
    except Exception as exc:  # noqa: BLE001
        H.record(False, f"A00.WEIGHTED prerequisite/case failure: {type(exc).__name__}: {exc}")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        try:
            H.cleanup_fixtures()
            if ready:
                strategy_js = "null" if original_node_strategy is None else json.dumps(original_node_strategy)
                H.db(
                    f"await db.node.update({{where:{{id:{H.EGR}}},data:{{lb_strategy:{strategy_js}}}}});"
                    "return true;"
                )
        except Exception as exc:  # noqa: BLE001
            H.record(False, f"A00.WEIGHTED cleanup: {type(exc).__name__}: {exc}")
        RESULT.write_text(
            "# A00 weighted_round real distribution / restart gate\n"
            f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
            "topology: scripts/integration/docker-compose.yaml\n"
            f"samples_per_phase={SAMPLES}\n"
            f"setup={'executed' if ready else 'incomplete'}\n"
            + "\n".join(H.RESULTS)
            + f"\nA00 WEIGHTED TOTAL PASS={H.PASS} FAIL={H.FAIL}\n",
            encoding="utf-8",
        )
        TRACE.write_text(json.dumps({"http": H.HTTP}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        H.release_lock()
        print(f"A00 WEIGHTED TOTAL PASS={H.PASS} FAIL={H.FAIL} evidence={RESULT}", flush=True)
    return 1 if H.FAIL or not ready else 0


if __name__ == "__main__":
    raise SystemExit(main())
