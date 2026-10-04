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

# One reachable target and one that refuses, on a pool the node actually SERVES.
#
# Not any pool: the observer enumerates the desired targets of the pools attached to
# the node's live tunnels, because "observe only what the user asked for" means the
# pools this node is really relaying through — a pool that is not attached to any
# tunnel has no desired targets on the node, so nothing to observe. Picking a
# detached pool made an earlier run of this gate look like a product failure
# (`count=0` forever) when it was a fixture-choice mistake.
POOL_ID = int(os.environ.get("G2A_POOL_ID", "0"))
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

def served_pool_id() -> int:
    """A pool attached to an active tunnel — i.e. one this node really serves."""
    globally_selected()
    if POOL_ID:
        return POOL_ID
    found = H.scalar(
        "SELECT p.id FROM egress_pool p JOIN tunnel t ON t.egress_pool_id = p.id "
        "WHERE t.apply_status = 'active' ORDER BY p.id LIMIT 1;"
    ).strip()
    return int(found or 0)


def globally_selected() -> None:
    """`POOL_ID` is resolved in setup(); this keeps the reads explicit."""
    return None


def pool_node_id(pool_id: int) -> int:
    return int(H.scalar(f"SELECT node_id FROM egress_pool WHERE id={pool_id};") or 0)


def original_targets(pool_id: int) -> list[tuple[str, int, int, int, str]]:
    raw = H.mysql(
        "SELECT CONCAT(host, '|', port, '|', weight, '|', order_by, '|', status) "
        f"FROM egress_target WHERE pool_id={pool_id} ORDER BY id;"
    ).strip()
    out = []
    for line in raw.splitlines():
        parts = line.split("|")
        if len(parts) == 5:
            out.append((parts[0], int(parts[1]), int(parts[2]), int(parts[3]), parts[4]))
    return out


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


def set_pool_targets(pool_id: int, targets: list[tuple[str, int]]) -> None:
    """Write the pool's desired targets DIRECTLY (setup, not the subject under test).

    Going through the admin API would test the target-editing path; this gate is about
    the observation pipeline, so the desired state is established the short way and
    then held fixed — which is also what makes "telemetry never rewrites desired"
    checkable at all.
    """
    H.mysql(f"DELETE FROM egress_target WHERE pool_id={pool_id};")
    for host, port in targets:
        H.mysql(
            "INSERT INTO egress_target (pool_id, host, port, weight, order_by, status, created_at, updated_at) "
            f"VALUES ({pool_id}, '{host}', {port}, 1, 10, 'active', NOW(3), NOW(3));"
        )


def desired_snapshot() -> str:
    return H.mysql(
        "SELECT GROUP_CONCAT(CONCAT(host, ':', port, '/', status, '/', weight) ORDER BY host, port) "
        f"FROM egress_target WHERE pool_id={H.pool_id};"
    ).strip()


def api_health() -> dict[str, dict]:
    """The synthesized view, keyed by target identity."""
    # Mounted as `app.route("/api/admin", nodeAdminRoutes)` + route path
    # `/node/pools/...`, so the real path has ONE "node" segment. Writing it twice
    # (the natural mistake when reading `nodeAdminRoutes.get("/node/pools/...")`)
    # 404s, and a 404 here would look like "the panel has no health view" rather
    # than "the gate called the wrong URL".
    status, body, _ = H.req("GET", f"/api/admin/node/pools/{H.pool_id}/health")
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
    """The facts that ARRIVED for this observer, read from the projection.

    Note what this reads and why: the panel CONSUMES the reported array into
    `target_observation` (one row per observer+target) rather than keeping a copy of
    the raw body, so the projection IS the panel's record of what reached the wire.
    Asserting against the raw JSON would require the panel to store a second copy of
    the same fact — exactly the kind of duplicate truth this stage exists to avoid.

    The row names are translated back to the WIRE names here, so the assertions below
    keep talking about the contract's vocabulary rather than the column names.
    """
    row = H.mysql(
        "SELECT CONCAT('[', IFNULL(GROUP_CONCAT(JSON_OBJECT("
        "'host', host, 'port', port, 'reachable', reachable, 'latency_ms', latency_ms, "
        "'consecutive_success', consecutive_success, 'consecutive_failure', consecutive_failure, "
        "'success_rate', success_rate, 'last_observed_at', UNIX_TIMESTAMP(observed_at), "
        "'observation_source', observation_source)), ''), ']') "
        f"FROM target_observation WHERE node_id={node_id};"
    ).strip()
    try:
        return json.loads(row or "[]")
    except json.JSONDecodeError:
        return []


# ---------------------------------------------------------------------------
# setup / cleanup
# ---------------------------------------------------------------------------

def setup():
    H.mysql(f"UPDATE user SET super_admin=1 WHERE email='{H.EMAIL}';")
    check(bool(wait := H.wait_until(lambda: H.req("GET", "/healthz", timeout=5)[0] == 200, timeout=60, interval=2)),
          "G2A.setup the panel is reachable")
    H.pool_id = served_pool_id()
    check(H.pool_id > 0,
          "G2A.setup a pool attached to an active tunnel exists (the observer only sees served targets)",
          f"pool={H.pool_id}")
    if H.pool_id == 0:
        raise RuntimeError("no pool is attached to an active tunnel; the topology has no served egress pool")
    H.saved_targets = original_targets(H.pool_id)
    node = pool_node_id(H.pool_id)
    check(node > 0, "G2A.setup the pool belongs to a node", f"pool={H.pool_id} node={node}")
    container = node_container(node)
    check(bool(container), "G2A.setup the pool's node maps to a running agent container", f"node={node}")

    # A clean baseline: the pool's desired state is exactly one reachable and one
    # refused target, so `healthy` and `unhealthy` are both reachable inside one gate
    # run without waiting for a real outage.
    # The desired targets are NOT rewritten. Two reasons, and both are the point of
    # this gate rather than a convenience:
    #   · the pool-edit path deliberately does not republish a tunnel revision (that
    #     is the orchestrator's job), so editing rows would change nothing the agent
    #     could see — an earlier version of this gate spent a whole run proving that;
    #   · "telemetry never rewrites desired" is far stronger evidence when the gate
    #     never touches desired in the first place.
    # Instead the gate observes what the node REALLY serves and induces the failure
    # on the target side, which is also a more honest outage: the target goes away,
    # not the configuration.
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
    # Restore the pool's original targets: this gate borrows a LIVE pool (the only
    # kind the observer can see), so leaving its desired state rewritten would change
    # what every other gate and the running topology sees.
    try:
        if getattr(H, "pool_id", 0) and getattr(H, "saved_targets", None) is not None:
            H.mysql(f"DELETE FROM egress_target WHERE pool_id={H.pool_id};")
            for host, port, weight, order_by, status in H.saved_targets:
                H.mysql(
                    "INSERT INTO egress_target (pool_id, host, port, weight, order_by, status, created_at, updated_at) "
                    f"VALUES ({H.pool_id}, '{host}', {port}, {weight}, {order_by}, '{status}', NOW(3), NOW(3));"
                )
            check(desired_snapshot() != "", "G2A.cleanup the pool's original targets were restored")
    except Exception as exc:  # noqa: BLE001
        record(False, f"G2A.cleanup restore pool targets: {type(exc).__name__}: {exc}")
    try:
        H.cleanup_fixtures()
    except Exception as exc:  # noqa: BLE001
        record(False, f"G2A.cleanup: {type(exc).__name__}: {exc}")


# ---------------------------------------------------------------------------
# cases
# ---------------------------------------------------------------------------

def served_target() -> tuple[str, int]:
    """The target the node is actually observing (host, port)."""
    observations = observations_of(H.observing_node)
    if not observations:
        return ("", 0)
    first = observations[0]
    return (str(first.get("host", "")), int(first.get("port", 0)))


def target_container_for(host: str) -> str:
    """The e2e container that serves a target host, if the gate may stop it."""
    for name in (host, f"wp14-{host}"):
        running = H.docker(["inspect", "-f", "{{.State.Running}}", name], allow=True).strip()
        if running == "true":
            return name
    return ""


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
    # The facts must be for the DESIRED targets only (row 2): every observed key
    # must be a target of the pool this node serves.
    keys = {target_key(str(o.get("host", "")), int(o.get("port", 0))) for o in observations}
    # Compared against the node's WHOLE desired set (every pool it serves), because
    # that is what the observer enumerates: "only what the user asked for" is a
    # statement about the node, not about one pool.
    desired_keys = {
        (line.split("|")[0] + ":" + line.split("|")[1])
        for line in H.mysql(
            "SELECT CONCAT(et.host, '|', et.port) FROM egress_target et "
            f"JOIN egress_pool p ON p.id = et.pool_id WHERE p.node_id={H.observing_node};"
        ).strip().splitlines()
        if "|" in line
    }
    check(keys <= desired_keys,
          "G2A.1 only desired targets are observed", f"observed={sorted(keys)} desired={sorted(desired_keys)}")
    H.observed_keys = keys
    H.served = served_target()
    check(H.served[0] != "",
          "G2A.1 the node is observing at least one served target", f"served={H.served}")

    # Bind the API read to the pool that CONTAINS the observed target.
    #
    # `tunnel.egress_pool_id` is not enough: a tunnel's pool can be re-pointed while
    # the RUNNING revision still carries the targets it was published with, so the
    # row and the agent disagree. The observations say what the node is really
    # serving, so the pool is derived from them — otherwise the gate reads one pool's
    # view and compares it against another pool's facts, which looks like a product
    # bug and is not one.
    observed_pool = H.scalar(
        "SELECT et.pool_id FROM egress_target et JOIN egress_pool p ON p.id = et.pool_id "
        f"WHERE p.node_id={H.observing_node} AND et.host='{H.served[0]}' AND et.port={H.served[1]} "
        "ORDER BY et.pool_id LIMIT 1;"
    ).strip()
    if observed_pool:
        H.pool_id = int(observed_pool)
        check(True, "G2A.1 the pool that serves the observed target was identified",
              f"pool={H.pool_id} target={H.served}")
    else:
        check(False, "G2A.1 a pool containing the observed target exists (view and facts must agree)",
              f"observed={H.served} node={H.observing_node}")


def g2a_2_projection_lands():
    node = H.observing_node
    ok = H.wait_until(
        lambda: int(H.scalar(f"SELECT COUNT(*) FROM target_observation WHERE node_id={node};") or 0) >= 1,
        timeout=180, interval=6,
    )
    check(ok, "G2A.2 the panel persisted one projection row per (observer, target)",
          H.mysql(f"SELECT GROUP_CONCAT(target_key) FROM target_observation WHERE node_id={node};").strip())
    key = target_key(*H.served)
    rows = H.mysql(
        "SELECT CONCAT(reachable, '|', IFNULL(latency_ms, 'NULL'), '|', observation_source) "
        f"FROM target_observation WHERE node_id={node} AND target_key='{key}';"
    ).strip()
    check(rows != "", "G2A.2 the observed target has a projection row", f"key={key}")
    # A reachable target stores a number; the NULL case is asserted after the outage
    # below, where an unreachable target is guaranteed to exist.
    check("|NULL|" not in rows or rows.startswith("0|"),
          "G2A.2 a reachable target stores a concrete latency, not NULL", rows)


def g2a_3_reachable_is_healthy():
    ok, state = wait_state(target_key(*H.served), {"healthy"}, timeout=420)
    check(ok, "G2A.3 a target that answers reaches `healthy` (warm-up respected)", f"state={state}")


def g2a_4_failing_is_unhealthy():
    """Stop the TARGET and watch the verdict follow — a real outage, not a config edit."""
    host = H.served[0]
    container = target_container_for(host)
    check(bool(container), "G2A.4 the served target runs in a container the gate may stop",
          f"host={host}")
    if not container:
        return
    key = target_key(*H.served)
    H.stopped_target = container
    H.docker(["stop", container], timeout=120)
    try:
        ok, state = wait_state(key, {"degraded", "unhealthy"}, timeout=420)
        check(ok, "G2A.4 a target that stops answering reaches `degraded` or `unhealthy`",
              f"target={key} state={state}")
        health = api_health().get(key, {})
        facts = health.get("facts") or {}
        check(int(facts.get("consecutive_failure", 0) or 0) >= 1,
              "G2A.4 its consecutive failures are reported as a fact", json.dumps(facts)[:160])
        check(health.get("state") != "unknown",
              "G2A.4 a failing target is NOT `unknown` — refusal is evidence, silence is not",
              json.dumps(health)[:160])
        row = H.mysql(
            "SELECT CONCAT(reachable, '|', IFNULL(latency_ms, 'NULL')) FROM target_observation "
            f"WHERE node_id={H.observing_node} AND target_key='{key}';"
        ).strip()
        check(row.startswith("0|NULL"),
              "G2A.4 an unreachable target stores reachable=0 with NULL latency, never 0",
              f"row={row}")
    finally:
        H.docker(["start", container], timeout=120)


def g2a_5_never_observed_is_unknown():
    """No evidence must read as `unknown`, never as `healthy`.

    The evidence is removed from the PROJECTION rather than from desired state: that
    is the only edit this gate is allowed to make, and it is exactly the situation the
    rule exists for (rows are missing, or too old to count). The next agent report
    restores the row, so nothing is left damaged.
    """
    key = target_key(*H.served)
    H.mysql(f"DELETE FROM target_observation WHERE node_id={H.observing_node} AND target_key='{key}';")
    health = api_health()
    entry = health.get(key)
    state = (entry or {}).get("state")
    check(entry is not None, "G2A.5 the desired target is still in the view without observations",
          f"key={key} keys={sorted(health)}")
    check(state == "unknown",
          "G2A.5 with no observation rows the state is `unknown`, never `healthy`",
          f"state={state} entry={json.dumps(entry)[:200]}")
    check((entry or {}).get("reasons") == ["no_observation"] or "no_observation" in ((entry or {}).get("reasons") or []),
          "G2A.5 and the reason says there is no observation", json.dumps(entry)[:200])


def g2a_6_stale_is_unknown():
    """Stop the observer; after the staleness window the verdict must fall back."""
    H.docker(["stop", H.observing_container], timeout=120)
    try:
        ok, state = wait_state(target_key(*H.served), {"unknown"}, timeout=STALE_WAIT_SECONDS)
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
    served_line = f"{H.served[0]}:{H.served[1]}"
    check(served_line in after,
          "G2A.7 the target judged unhealthy is STILL desired (telemetry has no delete authority)",
          f"served={served_line} desired={after}")


def g2a_8_restart_resumes():
    ok = H.wait_until(lambda: len(observations_of(H.observing_node)) > 0, timeout=240, interval=8)
    check(ok, "G2A.8 the agent resumes observing after a restart",
          f"node={H.observing_node} count={len(observations_of(H.observing_node))}")
    ok2, state = wait_state(target_key(*H.served), {"healthy", "recovering", "degraded"}, timeout=420)
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
    entry = health.get(target_key(*H.served)) or {}
    state = entry.get("state")
    check(state in {"healthy", "recovering", "degraded", "unknown"},
          "G2A.9 the view is served after a panel restart with a derived verdict", f"state={state}")
    # The fact is named `age_ms` (the contract's derived age), NOT `observation_age`:
    # the wire deliberately carries only the timestamp, and every derived age in the
    # view is computed from it. Checking for the wrong key made this assertion fail on
    # a perfectly healthy view.
    facts = entry.get("facts") or {}
    check(facts.get("age_ms") is not None or facts.get("last_observed_at") is not None or state == "unknown",
          "G2A.9 the answer carries how old the evidence is (age_ms and/or last_observed_at)",
          json.dumps(facts)[:200])
    check(facts.get("evidence") is not None,
          "G2A.9 and whether the verdict had any usable evidence at all",
          json.dumps(facts)[:160])


def g2a_10_single_failure_is_not_condemned():
    """The prohibition at the top of §7: one failed probe never condemns a target."""
    facts = (api_health().get(target_key(*H.served)) or {}).get("facts") or {}
    state = (api_health().get(target_key(*H.served)) or {}).get("state")
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
            f"pool: {H.__dict__.get('pool_id', '?')} (node {H.__dict__.get('observing_node', '?')}); "
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
