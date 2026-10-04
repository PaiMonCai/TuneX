#!/usr/bin/env python3
"""V5-G2A gate — V5.2 WP5/WP6 stability (Observation → Health Synthesis).

§7.3 requires WP5/WP6 to be STABLE before WP7 (circuit breaker / health-aware LB)
starts. This is that check, executed against the real four-Agent topology:

  G2A.1  the fact flows            a node's state report carries target_observations
  G2A.2  the projection lands       the panel stores one row per (observer node, target)
  G2A.3  reachable ⇒ healthy        a target that answers reaches `healthy` (after warm-up)
  G2A.4  failing ⇒ unhealthy        a target that refuses reaches `degraded`/`unhealthy`
  G2A.5  never observed ⇒ unknown   a target with no evidence is `unknown`, NOT `healthy`
  G2A.6  stale ⇒ unknown            agent stops → the verdict falls back to `unknown`
  G2A.7  desired is never rewritten telemetry must not change the desired target list
  G2A.8  restart resumes            the agent restarts and observations come back
  G2A.9  panel restart is safe      an old observation is not resurrected as fresh
  G2A.10 single failure ≠ condemned one failed probe never reaches `unhealthy`

The harness is imported from the V5-G1A gate rather than copied (see v5-g1b.py for
the same reasoning), and all three gates share one lock because they mutate one
topology.

FAIL > 0 means WP7 must not start.
"""
from __future__ import annotations

import importlib.util
import json
import os
import signal
import time
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
RESULT = OUT / "v5-g2a-result.txt"

# One reachable target and one that refuses, on the node that serves pool POOL_ID.
POOL_ID = int(os.environ.get("G2A_POOL_ID", "8"))
REACHABLE = ("target-a", 3030)  # the e2e target answers on 3030
REFUSED = ("target-a", 9)  # nothing listens on 9: connect is refused immediately
STALE_WAIT_SECONDS = int(os.environ.get("G2A_STALE_WAIT", "150"))
OVERALL_SECONDS = int(os.environ.get("G2A_OVERALL_SECONDS", "1800"))
START = time.monotonic()


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
# helpers
# ---------------------------------------------------------------------------

def pool_node_id() -> int:
    return int(H.scalar(f"SELECT node_id FROM egress_pool WHERE id={POOL_ID};") or 0)


def node_container(node_id: int) -> str:
    """The container that runs the agent for a node id (e2e naming)."""
    agent_id = H.scalar(f"SELECT agent_id FROM node WHERE id={node_id};")
    for container in ("wp14-egress-agent", "wp14-egress-agent-b", "wp14-ingress-agent", "wp14-ingress-agent-b"):
        # The agent id is a COMMAND ARGUMENT (`--agent-id <uuid>`), not an env var —
        # looking only at Config.Env is how this mapping silently returned "" and made
        # the whole gate unable to stop the right agent. Both are checked because the
        # e2e could legitimately pass it either way.
        spec = H.docker(["inspect", "-f", "{{.Config.Cmd}}|{{.Config.Env}}", container], allow=True)
        if agent_id and agent_id in spec:
            return container
    return ""


def set_pool_targets(targets: list[tuple[str, int]]) -> None:
    """Write the pool's desired targets DIRECTLY (setup, not the subject under test).

    Going through the admin API would test the target-editing path; this gate is about
    the observation pipeline, so the desired state is established the short way and
    then held fixed — which is also what makes "telemetry never rewrites desired"
    checkable at all.
    """
    H.mysql(f"DELETE FROM egress_target WHERE pool_id={POOL_ID};")
    for host, port in targets:
        H.mysql(
            "INSERT INTO egress_target (pool_id, host, port, weight, order_by, status, created_at, updated_at) "
            f"VALUES ({POOL_ID}, '{host}', {port}, 1, 10, 'active', NOW(3), NOW(3));"
        )


def desired_snapshot() -> str:
    return H.mysql(
        "SELECT GROUP_CONCAT(CONCAT(host, ':', port, '/', status, '/', weight) ORDER BY host, port) "
        f"FROM egress_target WHERE pool_id={POOL_ID};"
    ).strip()


def api_health() -> dict[str, dict]:
    """The synthesized view, keyed by target identity."""
    status, body, _ = H.req("GET", f"/api/admin/node/node/pools/{POOL_ID}/health")
    if status != 200:
        return {}
    data = H.unwrap(body)
    out: dict[str, dict] = {}
    for entry in (data or {}).get("targets", []):
        if isinstance(entry, dict) and isinstance(entry.get("target"), str):
            out[entry["target"]] = entry
    return out


def target_key(host: str, port: int) -> str:
    return f"{host}:{port}"


def wait_state(key: str, wanted: set[str], timeout: int = 240) -> tuple[bool, str]:
    """Wait for one target to reach any of `wanted`, returning the last state seen."""
    last = "<never read>"
    end = time.time() + timeout
    while time.time() < end:
        health = api_health()
        state = (health.get(key) or {}).get("state")
        if isinstance(state, str):
            last = state
            if state in wanted:
                return True, state
        time.sleep(6)
    return False, last


def observations_of(node_id: int) -> list[dict]:
    raw = H.scalar(
        f"SELECT IFNULL(target_observations, '[]') FROM node_state_report WHERE node_id={node_id};"
    )
    try:
        return json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []


# ---------------------------------------------------------------------------
# setup / cleanup
# ---------------------------------------------------------------------------

def setup():
    H.mysql(f"UPDATE user SET super_admin=1 WHERE email='{H.EMAIL}';")
    check(bool(wait := H.wait_until(lambda: H.req("GET", "/healthz", timeout=5)[0] == 200, timeout=60, interval=2)),
          "G2A.setup the panel is reachable")
    node = pool_node_id()
    check(node > 0, "G2A.setup the pool belongs to a node", f"pool={POOL_ID} node={node}")
    container = node_container(node)
    check(bool(container), "G2A.setup the pool's node maps to a running agent container", f"node={node}")

    # A clean baseline: the pool's desired state is exactly one reachable and one
    # refused target, so `healthy` and `unhealthy` are both reachable inside one gate
    # run without waiting for a real outage.
    set_pool_targets([REACHABLE, REFUSED])
    check(desired_snapshot() != "", "G2A.setup the pool has desired targets", desired_snapshot())

    # The observer only probes targets of the pools the node SERVES, and it reports on
    # the state endpoint — so the node must be reporting before anything can be said.
    check(bool(H.wait_until(
        lambda: H.scalar(f"SELECT COUNT(*) FROM node_state_report WHERE node_id={node} "
                         "AND reported_at > NOW() - INTERVAL 1 MINUTE;") == "1",
        timeout=120, interval=3)),
        "G2A.setup the pool's node is reporting")
    H.observing_container = container
    H.observing_node = node


def cleanup():
    try:
        H.cleanup_fixtures()
    except Exception as exc:  # noqa: BLE001
        record(False, f"G2A.cleanup: {type(exc).__name__}: {exc}")


# ---------------------------------------------------------------------------
# cases
# ---------------------------------------------------------------------------

def g2a_1_fact_flows():
    """The observation facts must reach the wire — the dead-wiring guard."""
    node = H.observing_node
    ok = H.wait_until(lambda: len(observations_of(node)) > 0, timeout=180, interval=6)
    observations = observations_of(node)
    check(ok, "G2A.1 the node's state report carries target_observations",
          f"node={node} count={len(observations)}")
    if not observations:
        return
    first = observations[0]
    for key in ("host", "port", "reachable", "last_observed_at", "observation_source"):
        check(key in first, f"G2A.1 the fact `{key}` is on the wire", json.dumps(first)[:160])
    # Contract row 7: age is derived by the reader, never sent.
    check("observation_age" not in first and "observation_age_ms" not in first,
          "G2A.1 no stored age is on the wire (age is derived by the reader)",
          json.dumps(first)[:160])
    # The facts must be for the DESIRED targets only (row 2).
    keys = {target_key(o.get("host", ""), int(o.get("port", 0))) for o in observations}
    check(keys <= {target_key(*REACHABLE), target_key(*REFUSED)},
          "G2A.1 only desired targets are observed", f"observed={sorted(keys)}")
    H.observed_keys = keys


def g2a_2_projection_lands():
    node = H.observing_node
    ok = H.wait_until(
        lambda: int(H.scalar(f"SELECT COUNT(*) FROM target_observation WHERE node_id={node};") or 0) >= 2,
        timeout=180, interval=6,
    )
    check(ok, "G2A.2 the panel persisted one projection row per (observer, target)",
          H.mysql(f"SELECT GROUP_CONCAT(target_key) FROM target_observation WHERE node_id={node};").strip())
    null_latency = H.scalar(
        f"SELECT COUNT(*) FROM target_observation WHERE node_id={node} AND reachable=0 AND latency_ms IS NULL;")
    check(null_latency != "0", "G2A.2 an unreachable target stores NULL latency, never 0")


def g2a_3_reachable_is_healthy():
    ok, state = wait_state(target_key(*REACHABLE), {"healthy"}, timeout=300)
    check(ok, "G2A.3 a target that answers reaches `healthy` (warm-up respected)", f"state={state}")


def g2a_4_failing_is_unhealthy():
    ok, state = wait_state(target_key(*REFUSED), {"degraded", "unhealthy"}, timeout=300)
    check(ok, "G2A.4 a target that refuses reaches `degraded` or `unhealthy`", f"state={state}")
    # The refused target must ALSO be visible as a fact, not only as a state.
    health = api_health().get(target_key(*REFUSED), {})
    facts = health.get("facts") or {}
    check(int(facts.get("consecutive_failure", 0) or 0) >= 1,
          "G2A.4 its consecutive failures are reported as a fact", json.dumps(facts)[:160])
    check(health.get("state") != "unknown",
          "G2A.4 a refused target is NOT `unknown` — refusal is evidence, not silence",
          json.dumps(health)[:160])


def g2a_5_never_observed_is_unknown():
    """A desired target nobody has observed must be `unknown`, never `healthy`."""
    # Add a third target nobody can have observed yet, then read BEFORE the next probe
    # cycle: the honest answer for "no evidence" is unknown.
    set_pool_targets([REACHABLE, REFUSED, ("target-b", 3030)])
    health = api_health()
    state = (health.get(target_key("target-b", 3030)) or {}).get("state")
    check(state in ("unknown", "healthy", "recovering"),
          "G2A.5 a newly added desired target does not crash the view", f"state={state}")
    # And the stronger, deterministic half: a target with no observation rows at all.
    H.mysql(f"DELETE FROM target_observation WHERE target_key='{target_key('target-b', 3030)}';")
    health = api_health()
    state = (health.get(target_key("target-b", 3030)) or {}).get("state")
    check(state == "unknown",
          "G2A.5 with no observation rows the state is `unknown`, never `healthy`",
          f"state={state} entry={json.dumps(health.get(target_key('target-b', 3030)))[:160]}")
    set_pool_targets([REACHABLE, REFUSED])


def g2a_6_stale_is_unknown():
    """Stop the observer; after the staleness window the verdict must fall back."""
    H.docker(["stop", H.observing_container], timeout=120)
    try:
        ok, state = wait_state(target_key(*REACHABLE), {"unknown"}, timeout=STALE_WAIT_SECONDS)
        check(ok, "G2A.6 a stopped agent's evidence goes stale and the state falls back to `unknown`",
              f"waited {STALE_WAIT_SECONDS}s, last state={state}")
        check(state != "healthy",
              "G2A.6 stale evidence is NEVER rendered as healthy (panel-restart safety)",
              f"state={state}")
    finally:
        H.docker(["start", H.observing_container], timeout=120)


def g2a_7_desired_untouched():
    before = desired_snapshot()
    # Let a full probe cycle run with the agent back up, then compare.
    H.wait_until(lambda: len(observations_of(H.observing_node)) > 0, timeout=180, interval=6)
    time.sleep(10)
    after = desired_snapshot()
    check(before == after,
          "G2A.7 telemetry never rewrote the desired target list",
          f"before={before!r} after={after!r}")
    # And an unhealthy target is still IN desired: telemetry has no delete authority.
    check(target_key(*REFUSED).replace(":", ":") in after or f"{REFUSED[0]}:{REFUSED[1]}" in after,
          "G2A.7 the refused target is still desired after being judged unhealthy", after)


def g2a_8_restart_resumes():
    ok = H.wait_until(lambda: len(observations_of(H.observing_node)) > 0, timeout=240, interval=8)
    check(ok, "G2A.8 the agent resumes observing after a restart",
          f"node={H.observing_node} count={len(observations_of(H.observing_node))}")
    ok2, state = wait_state(target_key(*REACHABLE), {"healthy", "recovering", "degraded"}, timeout=300)
    check(ok2, "G2A.8 and the reachable target is judged again rather than stuck", f"state={state}")


def g2a_9_panel_restart_is_safe():
    """After a panel restart the projection must not be presented as fresh evidence."""
    H.docker(["restart", H.PANEL_CONTAINER], timeout=180)
    check(bool(H.wait_until(lambda: H.req("GET", "/healthz", timeout=5)[0] == 200, timeout=180, interval=3)),
          "G2A.9 the panel is back")
    # The observation rows are still there (they are facts), but their AGE is what
    # decides freshness, and age is computed at read time — so the verdict must be
    # driven by the timestamps, never by "the row exists".
    health = api_health()
    entry = health.get(target_key(*REACHABLE)) or {}
    state = entry.get("state")
    check(state in {"healthy", "recovering", "degraded", "unknown"},
          "G2A.9 the view is served after a panel restart with a derived verdict", f"state={state}")
    check(entry.get("facts", {}).get("observation_age_ms") is not None
          or state == "unknown",
          "G2A.9 the answer carries how old the evidence is", json.dumps(entry)[:200])


def g2a_10_single_failure_is_not_condemned():
    """The prohibition at the top of §7: one failed probe never condemns a target."""
    facts = (api_health().get(target_key(*REACHABLE)) or {}).get("facts") or {}
    state = (api_health().get(target_key(*REACHABLE)) or {}).get("state")
    failures = int(facts.get("consecutive_failure", 0) or 0)
    if failures == 0:
        check(state == "healthy", "G2A.10 a healthy target with no failures is `healthy`", f"state={state}")
        return
    check(failures >= 1 and state != "unhealthy" or failures >= 3,
          "G2A.10 a single failed probe never reaches `unhealthy`",
          f"state={state} consecutive_failure={failures}")


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
            ("G2A.1 the fact flows", g2a_1_fact_flows, 240),
            ("G2A.2 the projection lands", g2a_2_projection_lands, 240),
            ("G2A.5 never observed is unknown", g2a_5_never_observed_is_unknown, 180),
            ("G2A.3 reachable is healthy", g2a_3_reachable_is_healthy, 360),
            ("G2A.4 failing is unhealthy", g2a_4_failing_is_unhealthy, 360),
            ("G2A.10 a single failure is not condemned", g2a_10_single_failure_is_not_condemned, 180),
            ("G2A.7 desired untouched", g2a_7_desired_untouched, 300),
            ("G2A.6 stale is unknown", g2a_6_stale_is_unknown, 420),
            ("G2A.8 restart resumes", g2a_8_restart_resumes, 480),
            ("G2A.9 panel restart is safe", g2a_9_panel_restart_is_safe, 360),
        ]:
            case(name, fn, budget)
    except Exception as exc:  # noqa: BLE001
        record(False, f"G2A prerequisite/setup: {type(exc).__name__}: {exc}; remaining tests NOT EXECUTED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.setitimer(signal.ITIMER_REAL, 300)
        try:
            cleanup()
        except Exception as exc:  # noqa: BLE001
            record(False, f"G2A.cleanup: {type(exc).__name__}: {exc}")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        RESULT.write_text(
            "# V5-G2A WP5/WP6 stability gate\n"
            f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
            "topology: scripts/v3-e2e/docker-compose.e2e.yaml (real Agents observing real targets)\n"
            f"pool: {POOL_ID} (node {H.__dict__.get('observing_node', '?')}); "
            f"reachable={REACHABLE}; refused={REFUSED}\n"
            f"setup={'executed' if ready else 'incomplete'}\n"
            f"elapsed_seconds: {int(time.monotonic() - START)}\n"
            + "\n".join(H.RESULTS)
            + f"\nV5-G2A TOTAL PASS={H.PASS} FAIL={H.FAIL}\n",
            encoding="utf-8",
        )
        H.release_lock()
        print(f"V5-G2A TOTAL PASS={H.PASS} FAIL={H.FAIL} evidence={RESULT}", flush=True)
    return 1 if H.FAIL or not ready else 0


if __name__ == "__main__":
    raise SystemExit(main())
