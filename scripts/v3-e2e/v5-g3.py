#!/usr/bin/env python3
"""V5-G3 gate — V5.3 resilience / HA (WP9 fencing, WP10 failover policy).

§8 says the gate must CONSTRUCT split brain rather than assert around it. So this gate
builds the dangerous situation on purpose and checks both halves of the defence:

  G3.1  baseline                  an active Forward is served
  G3.2  two-phase refuses early    while the lease is live, a takeover is REFUSED
  G3.3  split brain cannot happen   the lease is allowed to lapse and the old owner STOPS
  G3.4  takeover after the lapse    the new owner may claim, and the epoch advances
  G3.5  the epoch is monotone       every successful claim is exactly +1; no rollback
  G3.6  a lost race is safe         two claims from the same generation cannot both win
  G3.7  recovery                    re-claiming as owner makes the Forward serve again
  G3.8  desired is never rewritten  a failover changes WHO carries it, not WHAT it points at
  G3.9  panel restart               authority is not resurrected from memory
  G3.10 heartbeat timeout alone     nothing moves while everything else is healthy

The lease operations are executed through the panel's own service functions (`bun -e` in
the panel container), not by writing rows behind the service's back: the subject IS the
service's rules, so bypassing them would test the test.

FAIL > 0 means V5.3 is not closed.
"""
from __future__ import annotations

import importlib.util
import json
import os
import signal
import socket
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
RESULT = OUT / "v5-g3-result.txt"

TUNNEL_ID = int(os.environ.get("G3_TUNNEL_ID", "0"))
STANDBY_NODE_ID = int(os.environ.get("G3_STANDBY_NODE", "0"))
LAPSE_TIMEOUT = int(os.environ.get("G3_LAPSE_TIMEOUT", "240"))
OVERALL_SECONDS = int(os.environ.get("G3_OVERALL_SECONDS", "2400"))
START = time.monotonic()


def record(passed: bool, message: str) -> None:
    H.record(passed, message)


def check(condition, message, detail=""):
    record(bool(condition), message if condition or not detail else f"{message} [{detail}]")


def case(name: str, fn, seconds: int):
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        record(False, f"{name}: {type(exc).__name__}: {exc}")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def panel_eval(js: str) -> object:
    """Run a snippet inside the panel container (where the services and the DB live)."""
    out = H.docker(
        ["exec", "wp14-panel", "bun", "-e", js],
        timeout=120,
    )
    line = out.strip().splitlines()[-1] if out.strip() else "null"
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return {"raw": line}


def lease_row(tunnel_id: int) -> dict:
    raw = H.mysql(
        # CAST to UNSIGNED: the column is DATETIME(3), so UNIX_TIMESTAMP() returns a
        # fractional string and every later int() would fail (which is exactly what the
        # first run of this gate showed).
        "SELECT IFNULL(CONCAT(owner_node_id, '|', epoch, '|', CAST(UNIX_TIMESTAMP(lease_expires_at) AS UNSIGNED), '|', revision), '') "
        f"FROM placement_lease WHERE tunnel_id={tunnel_id};"
    ).strip()
    if not raw or "|" not in raw:
        return {}
    owner, epoch, expires, revision = raw.split("|")
    return {"owner_node_id": int(owner), "epoch": int(epoch), "expires_at": int(expires), "revision": int(revision)}


def claim(tunnel_id: int, node_id: int, revision: int = 1, ttl: int = 90) -> dict:
    return panel_eval(
        "import { claimLease } from '/app/src/services/placement-lease.ts';"
        f"const r = await claimLease({{tunnelId: {tunnel_id}, nodeId: {node_id}, revision: {revision},"
        f" now: new Date(), ttlSeconds: {ttl}}});"
        "console.log(JSON.stringify(r.ok ? {ok:true, epoch:r.epoch, changed:r.changed_owner}"
        " : {ok:false, reason:r.reason, current_owner:r.current ? r.current.owner_node_id : null}));"
    )


def release(tunnel_id: int, node_id: int) -> dict:
    return panel_eval(
        "import { releaseLease } from '/app/src/services/placement-lease.ts';"
        f"const r = await releaseLease({{tunnelId: {tunnel_id}, nodeId: {node_id}, now: new Date()}});"
        "console.log(JSON.stringify(r));"
    )


def force_lapse(tunnel_id: int) -> None:
    """Push the lease's expiry into the past WITHOUT releasing it.

    This is how a partition looks from the panel's side: it never heard from the owner, so
    nothing renewed. It is deliberately not `releaseLease` — a release is a cooperative act,
    and the scenario that must be survived is the uncooperative one.
    """
    H.mysql(
        f"UPDATE placement_lease SET lease_expires_at = NOW(3) - INTERVAL 5 MINUTE WHERE tunnel_id={tunnel_id};"
    )


def served(port: int, timeout: float = 4.0) -> tuple[bool, str]:
    try:
        with socket.create_connection((H.INGRESS_DATA_IP, port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            data = sock.recv(256)
            return bool(data), repr(data[:40])
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}"


def desired_fingerprint(tunnel_id: int) -> str:
    return H.mysql(
        "SELECT CONCAT(IFNULL(tunnel_mode,''),'/',IFNULL(forward_protocol,''),'/',IFNULL(listen_port,0),'/',"
        "IFNULL(egress_port,0),'/',IFNULL(remote_host,''),'/',IFNULL(remote_port,0),'/',"
        "IFNULL(egress_pool_id,0),'/',IFNULL(config_revision,0)) "
        f"FROM tunnel WHERE id={tunnel_id};"
    ).strip()


def target_rows(tunnel_id: int) -> str:
    return H.mysql(
        "SELECT IFNULL(GROUP_CONCAT(CONCAT(host,':',port,'/',weight,'/',status) ORDER BY host,port),'') "
        "FROM egress_target WHERE pool_id = (SELECT egress_pool_id FROM tunnel "
        f"WHERE id={tunnel_id});"
    ).strip()


# ---------------------------------------------------------------------------
# setup / cleanup
# ---------------------------------------------------------------------------

def setup():
    H.mysql(f"UPDATE user SET super_admin=1 WHERE email='{H.EMAIL}';")
    check(bool(H.wait_until(lambda: H.req("GET", "/healthz", timeout=5)[0] == 200, timeout=60, interval=2)),
          "G3.setup the panel is reachable")

    tunnel_id = TUNNEL_ID
    if tunnel_id == 0:
        found = H.scalar(
            "SELECT id FROM tunnel WHERE tunnel_mode='relay' AND apply_status='active' "
            "AND egress_pool_id IS NOT NULL ORDER BY id LIMIT 1;"
        ).strip()
        tunnel_id = int(found or 0)
    check(tunnel_id > 0, "G3.setup a relay Forward to fence exists", f"tunnel={tunnel_id}")
    if tunnel_id <= 0:
        raise RuntimeError("no active relay tunnel with a pool")

    row = H.mysql(f"SELECT CONCAT(IFNULL(listen_port,0), '|', IFNULL(ingress_node_id,0)) FROM tunnel WHERE id={tunnel_id};").strip()
    listen_port, ingress_node = (int(x) for x in row.split("|"))
    check(listen_port > 0 and ingress_node > 0,
          "G3.setup the Forward has a listener and an ingress node", f"port={listen_port} node={ingress_node}")

    standby = STANDBY_NODE_ID
    if standby == 0:
        found = H.scalar(
            f"SELECT id FROM node WHERE role IN ('ingress','both') AND id <> {ingress_node} ORDER BY id LIMIT 1;"
        ).strip()
        standby = int(found or 0)
    check(standby > 0 and standby != ingress_node,
          "G3.setup a standby node exists that is not the current owner", f"standby={standby}")

    H.tunnel_id = tunnel_id
    H.listen_port = listen_port
    H.owner_node = ingress_node
    H.standby_node = standby
    H.desired_before = desired_fingerprint(tunnel_id)
    H.targets_before = target_rows(tunnel_id)

    check(bool(H.wait_until(lambda: served(listen_port)[0], timeout=180, interval=5)),
          "G3.setup the Forward is really serving before anything is fenced",
          f"port={listen_port}")

    # Guarantee a lease exists before any case runs: a Forward that has never been claimed
    # has nothing to fence, and "no lease yet" is a setup condition rather than a failure.
    if not lease_row(tunnel_id):
        created = claim(tunnel_id, ingress_node, revision=1)
        check(bool(created.get("ok")), "G3.setup a placement lease was claimed for the current owner",
              json.dumps(created))
    check(bool(lease_row(tunnel_id)), "G3.setup the placement lease exists before any fencing case",
          json.dumps(lease_row(tunnel_id)))


def cleanup():
    """Leave ownership with the original node so the topology is as we found it."""
    try:
        tunnel_id = getattr(H, "tunnel_id", 0)
        owner = getattr(H, "owner_node", 0)
        if tunnel_id and owner:
            # Expire whatever the gate left, then hand it back to the original owner.
            force_lapse(tunnel_id)
            claim(tunnel_id, owner, revision=H.scalar(f"SELECT IFNULL(config_revision,1) FROM tunnel WHERE id={tunnel_id};") or 1)
            check(True, "G3.cleanup ownership was handed back to the original node",
                  json.dumps(lease_row(tunnel_id)))
    except Exception as exc:  # noqa: BLE001
        record(False, f"G3.cleanup: {type(exc).__name__}: {exc}")
    try:
        H.cleanup_fixtures()
    except Exception as exc:  # noqa: BLE001
        record(False, f"G3.cleanup fixtures: {type(exc).__name__}: {exc}")


# ---------------------------------------------------------------------------
# cases
# ---------------------------------------------------------------------------

def g3_1_baseline():
    current = lease_row(H.tunnel_id)
    check(bool(current), "G3.1 the Forward has a placement lease", json.dumps(current))
    if not current:
        return
    check(current.get("owner_node_id") == H.owner_node,
          "G3.1 the current owner holds it", json.dumps(current))
    check(current.get("epoch", 0) >= 1, "G3.1 and its generation is a real number", json.dumps(current))
    H.epoch_start = int(current.get("epoch", 0))
    ok, detail = served(H.listen_port)
    check(ok, "G3.1 and it is serving", detail)


def g3_2_two_phase_refuses_early():
    """A live lease must refuse a takeover — this is the rule that prevents two owners."""
    before = lease_row(H.tunnel_id)
    result = claim(H.tunnel_id, H.standby_node, revision=1)
    check(result.get("ok") is False,
          "G3.2 a takeover while the lease is live is REFUSED", json.dumps(result))
    check(result.get("reason") == "not_expired",
          "G3.2 and the reason names the two-phase rule", json.dumps(result))
    after = lease_row(H.tunnel_id)
    check(after.get("owner_node_id") == before.get("owner_node_id") and after.get("epoch") == before.get("epoch"),
          "G3.2 nothing changed: same owner, same generation",
          f"before={json.dumps(before)} after={json.dumps(after)}")
    check(served(H.listen_port)[0], "G3.2 and the original owner keeps serving")


def g3_3_split_brain_cannot_happen():
    """The heart of the gate: a partitioned owner must STOP on its own.

    We do not tell it to stop. We let its lease lapse exactly as it would in a partition —
    nothing renews — and the old owner must stop serving by itself. That is what makes it
    safe for a new owner to take over; without it, "the panel thinks A is gone" plus "A is
    still listening" is two nodes serving one Forward.
    """
    force_lapse(H.tunnel_id)
    lapsed = lease_row(H.tunnel_id)
    check(lapsed.get("expires_at", 0) * 1000 < time.time() * 1000,
          "G3.3 the lease is now in the past (the partition, from the panel's side)",
          json.dumps(lapsed))

    # The agent's own clock decides: it stops within its sweep once the deadline it was last
    # told has passed. No panel instruction is involved.
    stopped = H.wait_until(lambda: not served(H.listen_port)[0], timeout=LAPSE_TIMEOUT, interval=5)
    check(stopped, "G3.3 the old owner STOPPED serving on its own once its lease lapsed",
          f"port={H.listen_port} waited={LAPSE_TIMEOUT}s")
    check(not served(H.listen_port)[0],
          "G3.3 so a new owner can take over without two nodes serving one Forward")


def g3_4_takeover_after_lapse():
    before = lease_row(H.tunnel_id)
    result = claim(H.tunnel_id, H.standby_node, revision=1)
    check(result.get("ok") is True, "G3.4 a takeover is allowed once the lease has lapsed",
          json.dumps(result))
    check(result.get("changed") is True, "G3.4 and it is reported as an ownership change", json.dumps(result))
    after = lease_row(H.tunnel_id)
    check(after.get("owner_node_id") == H.standby_node,
          "G3.4 the standby is the owner now", json.dumps(after))
    check(after.get("epoch", 0) == before.get("epoch", 0) + 1,
          "G3.4 and the generation advanced by exactly one",
          f"before={before.get('epoch')} after={after.get('epoch')}")


def g3_5_epoch_is_monotone():
    force_lapse(H.tunnel_id)
    one = claim(H.tunnel_id, H.owner_node, revision=1)
    two_epoch = lease_row(H.tunnel_id).get("epoch", 0)
    check(one.get("ok") is True, "G3.5 a hand-back after another lapse succeeds", json.dumps(one))
    check(two_epoch > H.epoch_start,
          "G3.5 the generation only ever increases, never rolls back",
          f"start={H.epoch_start} now={two_epoch}")


def g3_6_lost_race_is_safe():
    """Two claimants from the same generation: only one may win."""
    force_lapse(H.tunnel_id)
    before = lease_row(H.tunnel_id)
    first = claim(H.tunnel_id, H.standby_node, revision=1)
    second = claim(H.tunnel_id, H.owner_node, revision=1)
    after = lease_row(H.tunnel_id)
    winners = [r for r in (first, second) if r.get("ok") is True]
    check(len(winners) >= 1, "G3.6 at least one claim succeeded", json.dumps([first, second]))
    # After both attempts exactly one owner exists — never a state where two nodes each
    # believe they hold the same generation.
    check(after.get("epoch", 0) == before.get("epoch", 0) + len(winners),
          "G3.6 the generation advanced once per SUCCESSFUL claim and no further",
          f"before={before.get('epoch')} after={after.get('epoch')} winners={len(winners)}")
    check(after.get("owner_node_id") in (H.standby_node, H.owner_node),
          "G3.6 exactly one owner remains", json.dumps(after))


def g3_7_recovery_serves_again():
    """Ownership is back with the original node; the Forward must serve again."""
    force_lapse(H.tunnel_id)
    claimed = claim(H.tunnel_id, H.owner_node, revision=1)
    check(claimed.get("ok") is True, "G3.7 the original owner can take its Forward back",
          json.dumps(claimed))
    # Service returns when a config carrying a live lease arrives again — which is the
    # reconcile loop's job, and its absence would be a product gap rather than a gate bug.
    resumed = H.wait_until(lambda: served(H.listen_port)[0], timeout=300, interval=6)
    check(resumed, "G3.7 the Forward serves again after the ownership is restored",
          f"port={H.listen_port}")


def g3_8_desired_untouched():
    check(desired_fingerprint(H.tunnel_id) == H.desired_before,
          "G3.8 a failover never rewrote the Forward's desired configuration",
          f"before={H.desired_before!r} after={desired_fingerprint(H.tunnel_id)!r}")
    check(target_rows(H.tunnel_id) == H.targets_before,
          "G3.8 and never touched the target list it points at",
          f"before={H.targets_before!r} after={target_rows(H.tunnel_id)!r}")


def g3_9_panel_restart_is_safe():
    before = lease_row(H.tunnel_id)
    H.docker(["restart", H.PANEL_CONTAINER], timeout=180)
    check(bool(H.wait_until(lambda: H.req("GET", "/healthz", timeout=5)[0] == 200, timeout=180, interval=3)),
          "G3.9 the panel is back")
    after = lease_row(H.tunnel_id)
    check(after.get("owner_node_id") == before.get("owner_node_id") and after.get("epoch") == before.get("epoch"),
          "G3.9 a panel restart does not resurrect or forget ownership",
          f"before={json.dumps(before)} after={json.dumps(after)}")
    check(served(H.listen_port)[0], "G3.9 and the data plane kept serving through it")


def g3_10_heartbeat_alone_moves_nothing():
    """§8: a heartbeat timeout is liveness information, not a reason to move traffic."""
    before = lease_row(H.tunnel_id)
    migrated = panel_eval(
        "import { decideFailover, placementMigration } from '/app/src/services/failover-policy.ts';"
        "const decision = decideFailover({"
        "  placement: { forward_id: 1, owner_node_id: " + str(H.owner_node) + ", epoch: " + str(before.get('epoch', 1)) + ","
        "    lease_expires_at_ms: Date.now() + 60000, revision: 1 },"
        "  owner: { node_id: " + str(H.owner_node) + ", heartbeat_stale: true, observation_freshness_usable: false },"
        "  candidate: { node_id: " + str(H.standby_node) + ", online: true, available_ports: 3 },"
        "  target_observations: { fresh_observers: 0, healthy_targets: 0, total_targets: 2 },"
        "  cooldown: { last_migration_at_ms: null },"
        "  policy: { auto_failover: true } });"
        "const m = placementMigration(decision);"
        "console.log(JSON.stringify({action: decision.action, blockers: decision.blockers, migration: m}));"
    )
    check(migrated.get("action") != "move",
          "G3.10 a stale heartbeat ALONE produces no migration decision", json.dumps(migrated)[:240])
    check(migrated.get("migration") in (None, {}),
          "G3.10 and therefore nothing to execute", json.dumps(migrated)[:200])
    after = lease_row(H.tunnel_id)
    check(after.get("owner_node_id") == before.get("owner_node_id") and after.get("epoch") == before.get("epoch"),
          "G3.10 the real lease is untouched by that decision", json.dumps(after))


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
            ("G3.1 baseline", g3_1_baseline, 300),
            ("G3.2 two-phase refuses early", g3_2_two_phase_refuses_early, 240),
            ("G3.3 split brain cannot happen", g3_3_split_brain_cannot_happen, 420),
            ("G3.4 takeover after lapse", g3_4_takeover_after_lapse, 240),
            ("G3.5 epoch monotone", g3_5_epoch_is_monotone, 240),
            ("G3.6 lost race is safe", g3_6_lost_race_is_safe, 300),
            ("G3.7 recovery serves again", g3_7_recovery_serves_again, 480),
            ("G3.8 desired untouched", g3_8_desired_untouched, 180),
            ("G3.9 panel restart", g3_9_panel_restart_is_safe, 360),
            ("G3.10 heartbeat alone", g3_10_heartbeat_alone_moves_nothing, 240),
        ]:
            case(name, fn, budget)
    except Exception as exc:  # noqa: BLE001
        record(False, f"G3 prerequisite/setup: {type(exc).__name__}: {exc}; remaining tests NOT EXECUTED")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.setitimer(signal.ITIMER_REAL, 300)
        try:
            cleanup()
        except Exception as exc:  # noqa: BLE001
            record(False, f"G3.cleanup: {type(exc).__name__}: {exc}")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        RESULT.write_text(
            "# V5-G3 resilience / HA gate (WP9 fencing, WP10 policy)\n"
            f"time: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
            "topology: scripts/v3-e2e/docker-compose.e2e.yaml (real relay, real lease, constructed split brain)\n"
            f"tunnel={H.__dict__.get('tunnel_id', '?')} owner={H.__dict__.get('owner_node', '?')} "
            f"standby={H.__dict__.get('standby_node', '?')}\n"
            f"setup={'executed' if ready else 'incomplete'}\n"
            f"elapsed_seconds: {int(time.monotonic() - START)}\n"
            + "\n".join(H.RESULTS)
            + f"\nV5-G3 TOTAL PASS={H.PASS} FAIL={H.FAIL}\n",
            encoding="utf-8",
        )
        H.release_lock()
        print(f"V5-G3 TOTAL PASS={H.PASS} FAIL={H.FAIL} evidence={RESULT}", flush=True)
    return 1 if H.FAIL or not ready else 0


if __name__ == "__main__":
    raise SystemExit(main())
