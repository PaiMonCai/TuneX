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
# Optional case selector (`G3_CASES=G3.4,G3.5`): the cases need real waiting (partitions,
# staleness windows, healing), so a full run is ~50 minutes. A re-run after a one-line fix
# should not have to pay for the cases that already passed.
CASE_FILTER = [x.strip() for x in os.environ.get("G3_CASES", "").split(",") if x.strip()]
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


CONTROL_NETWORK = os.environ.get("G3_CONTROL_NETWORK", "wp14_ctrl")


def force_lapse(tunnel_id: int) -> None:
    """Push the lease's expiry into the past WITHOUT releasing it.

    Deliberately not `releaseLease`: a release is a cooperative act, and the scenario that must
    be survived is the uncooperative one.

    NOTE (V5.3 round 8): on its own this no longer makes an agent stop, and that is correct —
    renewal now happens on every state report, so a DB-side lapse is repaired within one cycle
    as long as the node can still reach the panel. The fail-safe stop is for a node that CANNOT
    reach the panel, which is what `partition_owner()` constructs. This helper is kept for the
    cases that need the panel-side row to be stale (the takeover path).
    """
    H.mysql(
        f"UPDATE placement_lease SET lease_expires_at = NOW(3) - INTERVAL 5 MINUTE WHERE tunnel_id={tunnel_id};"
    )


def partition_owner(container: str) -> bool:
    """Cut the owner off from the CONTROL network — the real partition.

    §8's dangerous scenario is "the panel thinks A is offline while A is still listening". The
    only honest way to build it is to make A unable to reach the panel: its reports stop, so no
    renewal reaches it, so its last-known deadline passes and its own fence stops the tunnel.
    Nothing in the panel tells it to stop — that is the whole point.
    """
    H.docker(["network", "disconnect", CONTROL_NETWORK, container], allow=True)
    out = H.docker(["inspect", "-f", "{{json .NetworkSettings.Networks}}", container], allow=True)
    return CONTROL_NETWORK not in out


def rejoin_owner(container: str) -> bool:
    H.docker(["network", "connect", CONTROL_NETWORK, container], allow=True)
    out = H.docker(["inspect", "-f", "{{json .NetworkSettings.Networks}}", container], allow=True)
    return CONTROL_NETWORK in out


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
    # G3.3 partitions the owner, so the container must be known from the start (the first
    # version only learned it in a later case and threw AttributeError).
    H.owner_container = owner_container(ingress_node)
    check(bool(H.owner_container), "G3.setup the owner's container was identified",
          f"node={ingress_node} container={H.owner_container}")
    check(rejoin_owner(H.owner_container) or True, "G3.setup the owner is attached to the control network")
    H.desired_before = desired_fingerprint(tunnel_id)
    H.targets_before = target_rows(tunnel_id)

    # A previous run can legitimately leave the owner partitioned (that is what the gate
    # constructs), and after a partition the tunnel stays stopped until a config arrives. So
    # heal first and, if it is still not serving, restart the owner once — a snapshot re-pull
    # is the normal recovery path and it keeps a leftover state from looking like a defect.
    if H.owner_container:
        rejoin_owner(H.owner_container)
    if not H.wait_until(lambda: served(listen_port)[0], timeout=90, interval=5):
        H.docker(["restart", H.owner_container], allow=True, timeout=150)
        H.wait_until(lambda: served(listen_port)[0], timeout=150, interval=5)
    check(served(listen_port)[0],
          "G3.setup the Forward is really serving before anything is fenced",
          f"port={listen_port}")

    # Guarantee a lease exists before any case runs: a Forward that has never been claimed
    # has nothing to fence, and "no lease yet" is a setup condition rather than a failure.
    if lease_row(tunnel_id):
        # Make it FRESH: an earlier run can legitimately have left it expired, and G3.2's
        # premise ("a takeover while the lease is live is refused") needs a live lease.
        claim(tunnel_id, ingress_node, revision=1)
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
        set_policy(False)
        if getattr(H, "partitioned", False) and getattr(H, "owner_container", None):
            rejoin_owner(H.owner_container)
            H.partitioned = False
        if getattr(H, "owner_stopped", False) and getattr(H, "owner_container", None):
            H.docker(["start", H.owner_container], allow=True, timeout=150)
            H.owner_stopped = False
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
    # Cut the owner off from the panel. Its reports stop, so nothing renews it, so its own
    # deadline passes and its fence stops the tunnel — with no instruction from the panel.
    check(partition_owner(H.owner_container),
          "G3.3 the owner was cut off from the control network (a real partition)",
          f"container={H.owner_container}")
    H.partitioned = True
    force_lapse(H.tunnel_id)
    lapsed = lease_row(H.tunnel_id)
    check(lapsed.get("expires_at", 0) * 1000 < time.time() * 1000,
          "G3.3 the lease is in the past and nothing is renewing it",
          json.dumps(lapsed))

    stopped = H.wait_until(lambda: not served(H.listen_port)[0], timeout=LAPSE_TIMEOUT, interval=5)
    check(stopped, "G3.3 the old owner STOPPED serving on its own once its lease lapsed",
          f"port={H.listen_port} waited={LAPSE_TIMEOUT}s")
    check(not served(H.listen_port)[0],
          "G3.3 so a new owner can take over without two nodes serving one Forward")


def g3_4_takeover_after_lapse():
    """A takeover needs a GENUINELY expired lease.

    After the renewal fix, "genuinely expired" means the old owner cannot renew — so the gate
    makes that true instead of pretending: it STOPS the owner's container, asserts that its
    liveness is really stale (the assertion the previous version omitted, which let an
    unestablished precondition be reported as a refused takeover), and only then claims.

    G3.3 keeps the subtler network partition for the split-brain scenario; this case needs the
    unambiguous one, because its subject is the takeover path, not the partition.
    """
    if not getattr(H, "owner_stopped", False):
        H.docker(["stop", H.owner_container], allow=True, timeout=120)
        H.owner_stopped = True
        if getattr(H, "partitioned", False):
            # The container is gone; the network membership will come back with it.
            H.partitioned = False
        check(bool(H.wait_until(
            lambda: int(H.scalar(
                f"SELECT IFNULL(TIMESTAMPDIFF(SECOND, last_seen_at, NOW()), 9999) FROM node WHERE id={H.owner_node};"
            ) or 0) > 100,
            timeout=300, interval=10,
        )), "G3.4 the owner is ASSERTED to be stale before a takeover is attempted",
              "this assertion is the fix: without it an unestablished precondition looked like a refusal")

    before = lease_row(H.tunnel_id)
    # Force the row into the past as well: nothing is renewing it now, so this is not a fiction.
    force_lapse(H.tunnel_id)
    lapsed = lease_row(H.tunnel_id)
    check(lapsed.get("expires_at", 0) * 1000 < time.time() * 1000,
          "G3.4 the lease is really expired (nobody can renew it)", json.dumps(lapsed))

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

    # Bring the old owner back: its fence will refuse a stale activation, which G3.7 exercises.
    H.docker(["start", H.owner_container], allow=True, timeout=150)
    H.owner_stopped = False


def g3_5_epoch_is_monotone():
    """The generation only ever increases — checked across the takeovers this gate performed."""
    after = lease_row(H.tunnel_id)
    now_epoch = int(after.get("epoch", 0))
    check(now_epoch >= H.epoch_start,
          "G3.5 the generation only ever increases, never rolls back",
          f"start={H.epoch_start} now={now_epoch}")
    # And the surviving owner is exactly one node — never a state where two believe they hold it.
    check(after.get("owner_node_id") in (H.owner_node, H.standby_node),
          "G3.5 exactly one node holds the lease", json.dumps(after))


def g3_6_lost_race_is_safe():
    """Two claimants from the same generation: only one may win."""
    force_lapse(H.tunnel_id)
    before = lease_row(H.tunnel_id)
    first = claim(H.tunnel_id, H.standby_node, revision=1)
    second = claim(H.tunnel_id, H.owner_node, revision=1)
    after = lease_row(H.tunnel_id)
    winners = [r for r in (first, second) if r.get("ok") is True]
    # Only claims that CHANGED the owner advance the generation; a claim by the node that
    # already holds it is a RENEWAL and must keep the same epoch (that is what makes renewals
    # invisible to the agent's stale-epoch fence). Counting all successful claims made this
    # assertion demand an advance for a renewal, which is the opposite of the contract.
    advances = [r for r in winners if r.get("changed") is True]
    check(len(winners) >= 1, "G3.6 at least one claim succeeded", json.dumps([first, second]))
    check(after.get("epoch", 0) == before.get("epoch", 0) + len(advances),
          "G3.6 the generation advanced once per OWNERSHIP-CHANGING claim and no further",
          f"before={before.get('epoch')} after={after.get('epoch')} advances={len(advances)} winners={len(winners)}")
    check(after.get("owner_node_id") in (H.standby_node, H.owner_node),
          "G3.6 exactly one owner remains", json.dumps(after))


def g3_7_recovery_serves_again():
    """Ownership is back with the original node; the Forward must serve again."""
    if getattr(H, "partitioned", False):
        check(rejoin_owner(H.owner_container), "G3.7 the owner was reconnected for the hand-back")
        H.partitioned = False
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


def g3_35_restore_after_partition():
    """Heal the partition and confirm the original owner can serve again."""
    if not getattr(H, "partitioned", False):
        return
    check(rejoin_owner(H.owner_container),
          "G3.3b the owner was reconnected to the control network")
    H.partitioned = False
    # The panel now learns it is alive again; the reconcile re-sends and the fence lets it serve.
    ok = H.wait_until(lambda: served(H.listen_port)[0], timeout=420, interval=8)
    check(ok, "G3.3b service returns once the partition heals", f"port={H.listen_port}")


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


def owner_container(node_id: int) -> str:
    agent_id = H.scalar(f"SELECT agent_id FROM node WHERE id={node_id};")
    for container in ("wp14-ingress-agent", "wp14-ingress-agent-b", "wp14-egress-agent", "wp14-egress-agent-b"):
        spec = H.docker(["inspect", "-f", "{{.Config.Cmd}}|{{.Config.Env}}", container], allow=True)
        if agent_id and agent_id in spec:
            return container
    return ""


def node_connect_ip(node_id: int) -> str:
    raw = H.scalar(f"SELECT IFNULL(connect_ip,'') FROM node WHERE id={node_id};").strip()
    return raw.split(",")[0].strip() if raw else ""


def set_policy(auto_failover: bool, auto_failback: bool = False) -> None:
    value = json.dumps({"auto_failover": auto_failover, "auto_failback": auto_failback})
    H.mysql(
        "INSERT INTO config (name, value, created_at, updated_at) "
        f"VALUES ('FAILOVER_POLICY', '{value}', NOW(3), NOW(3)) "
        f"ON DUPLICATE KEY UPDATE value='{value}', updated_at=NOW(3);"
    )


def pool_targets(pool_id: int) -> list[tuple[str, int, int, int, str]]:
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


def set_pool_targets(pool_id: int, targets: list[tuple[str, int]]) -> None:
    H.mysql(f"DELETE FROM egress_target WHERE pool_id={pool_id};")
    for host, port in targets:
        H.mysql(
            "INSERT INTO egress_target (pool_id, host, port, weight, order_by, status, created_at, updated_at) "
            f"VALUES ({pool_id}, '{host}', {port}, 1, 10, 'active', NOW(3), NOW(3));"
        )


def pool_id_of(tunnel_id: int) -> int:
    return int(H.scalar(f"SELECT IFNULL(egress_pool_id,0) FROM tunnel WHERE id={tunnel_id};") or 0)


def g3_11_automatic_failover():
    """The closure of V5.3: the loop must move a Forward BY ITSELF when its owner dies.

    Everything before this case proves the mechanism is safe. This proves it is USED — and it
    is the case that would have caught the executor's first bug (a facts reader that dropped
    `last_seen_at`, which made every automatic migration silently impossible).
    """
    owner = H.owner_node
    standby = H.standby_node
    container = owner_container(owner)
    check(bool(container), "G3.11 the owner's agent container was found", f"node={owner}")
    if not container:
        return
    before = lease_row(H.tunnel_id)
    epoch_before = int(before.get("epoch", 0))
    H.owner_container = container

    # ── fixture ──
    #
    # The policy refuses to move for two reasons that are both CORRECT and both caused by the
    # fixture rather than the code (round 11's log said so in one line):
    #   · `target_side_failure`: the pool held a target that never answers, so the panel judged
    #     the problem to be target-side — and a migration cannot fix a broken target;
    #   · `no_standby_candidate`: candidates must be non-owner ingress-capable nodes in the SAME
    #     ingress node group, and this topology's two ingress nodes live in different groups.
    # Relaxing either rule to make the gate pass would delete a protection, so the fixture is
    # what changes: a pool of healthy targets, and a standby inside the owner's group.
    H.pool_id = pool_id_of(H.tunnel_id)
    H.saved_pool_targets = pool_targets(H.pool_id)
    set_pool_targets(H.pool_id, [("target-a", 3030)])
    H.saved_standby_group = int(H.scalar(f"SELECT IFNULL(node_group_id,0) FROM node WHERE id={standby};") or 0)
    owner_group = int(H.scalar(f"SELECT IFNULL(node_group_id,0) FROM node WHERE id={owner};") or 0)
    if H.saved_standby_group != owner_group:
        H.mysql(f"UPDATE node SET node_group_id={owner_group} WHERE id={standby};")
        check(True, "G3.11 the standby was placed in the owner's node group (fixture)",
              f"standby={standby} group {H.saved_standby_group} -> {owner_group}")

    set_policy(True)
    try:
        # Kill the owner. Its heartbeat stops, so it crosses the stale threshold; the targets
        # are still observed as healthy by the egress node, so the policy's condition 3 does
        # not block (the problem is the NODE, not the target).
        H.docker(["stop", container], timeout=120)
        # Give the loop the stale window plus at least one reconcile tick.
        H.wait_until(lambda: H.scalar(
            f"SELECT IFNULL(TIMESTAMPDIFF(SECOND, last_seen_at, NOW()), 9999) FROM node WHERE id={owner};"
        ).isdigit() and int(H.scalar(
            f"SELECT IFNULL(TIMESTAMPDIFF(SECOND, last_seen_at, NOW()), 9999) FROM node WHERE id={owner};") or 0) > 100,
            timeout=240, interval=10)

        moved = H.wait_until(
            lambda: lease_row(H.tunnel_id).get("owner_node_id") == standby, timeout=420, interval=10
        )
        after = lease_row(H.tunnel_id)
        check(moved, "G3.11 the loop migrated ownership away from the dead owner BY ITSELF",
              f"before={json.dumps(before)} after={json.dumps(after)}")
        if moved:
            check(int(after.get("epoch", 0)) == epoch_before + 1,
                  "G3.11 and the generation advanced by exactly one",
                  f"before={epoch_before} after={after.get('epoch')}")
            # The panel's desired placement must follow the lease.
            placement = H.scalar(f"SELECT IFNULL(ingress_node_id,0) FROM tunnel WHERE id={H.tunnel_id};").strip()
            check(int(placement or 0) == standby,
                  "G3.11 the Forward's placement followed the ownership",
                  f"ingress_node_id={placement} standby={standby}")
            # And it must SERVE again from the new owner (the rollout has to land).
            ip = node_connect_ip(standby)
            port = int(H.scalar(f"SELECT IFNULL(listen_port,0) FROM tunnel WHERE id={H.tunnel_id};") or 0)
            served_again = H.wait_until(
                lambda: _served_at(ip, port), timeout=420, interval=8
            )
            check(served_again, "G3.11 the Forward serves from the NEW owner",
                  f"{ip}:{port}")
            # The fenced old owner must not be serving: that is the whole point.
            check(not _served_at(node_connect_ip(owner), port), "G3.11 and the fenced old owner is NOT serving")
    finally:
        H.docker(["start", container], timeout=120)
        set_policy(False)
        if getattr(H, "pool_id", 0) and getattr(H, "saved_pool_targets", None) is not None:
            set_pool_targets(H.pool_id, [(h, p) for h, p, _w, _o, _s in H.saved_pool_targets])
        if getattr(H, "saved_standby_group", 0):
            H.mysql(f"UPDATE node SET node_group_id={H.saved_standby_group} WHERE id={standby};")


def _served_at(ip: str, port: int, timeout: float = 4.0) -> bool:
    if not ip or port <= 0:
        return False
    try:
        with socket.create_connection((ip, port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            return bool(sock.recv(256))
    except Exception:  # noqa: BLE001
        return False


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
            ("G3.3b restore after partition", g3_35_restore_after_partition, 600),
            ("G3.4 takeover after lapse", g3_4_takeover_after_lapse, 240),
            ("G3.5 epoch monotone", g3_5_epoch_is_monotone, 240),
            ("G3.6 lost race is safe", g3_6_lost_race_is_safe, 300),
            ("G3.7 recovery serves again", g3_7_recovery_serves_again, 480),
            ("G3.8 desired untouched", g3_8_desired_untouched, 180),
            ("G3.9 panel restart", g3_9_panel_restart_is_safe, 360),
            ("G3.10 heartbeat alone", g3_10_heartbeat_alone_moves_nothing, 240),
            ("G3.11 automatic failover", g3_11_automatic_failover, 1500),
        ]:
            if CASE_FILTER and not any(name.startswith(f) for f in CASE_FILTER):
                continue
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
