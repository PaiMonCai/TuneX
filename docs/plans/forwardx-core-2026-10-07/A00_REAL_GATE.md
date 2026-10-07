# A00 real core-forwarding gate

This package does **not** create a second test topology. TuneX already has a stronger disposable topology in `scripts/integration/`: MySQL, Redis, Panel, Worker, four credential-enrolled Agents, isolated control/data networks and real TCP/UDP targets.

## One command

```bash
scripts/integration/a00-core-gate.sh
```

The gate starts from a fresh disposable topology by default, builds the current backend/Agent checkout, provisions Nodes through the real enrollment path, and then runs:

1. `current-protocol.py` — current stream/UDP regression: real TCP payload, UDP DIRECT and RELAY payload, UDP mapping lifecycle, retarget without listener rebuild, conservative TCP/UDP port ownership, Agent restart recovery, Panel restart continuity, suspend/drain, diagnostics and payload-redaction checks.
2. `a00-delete-reuse.py` — the missing destructive lifecycle proof for both TCP DIRECT and TCP RELAY:
   - create and converge;
   - real payload;
   - confirm one active ingress lease (and relay egress lease);
   - DELETE through the public Forward API;
   - wait until desired row, listener, Agent-reported runtime and active DB lease are gone;
   - create another Forward requesting the **exact same ingress port**;
   - converge and carry real payload;
   - replay DELETE for the old id and prove it is a bounded 404 that does not affect the replacement.

The second test deliberately checks both the DB lease and Agent report. “DELETE returned 200” is not enough evidence that a remote listener stopped.

Set `A00_KEEP_STACK=0` to tear down after a green run. The default keeps the isolated stack for the remaining browser/status/weighted-round inspection and preserves evidence files.

## What this closes

This makes the existing integration topology an explicit A00 gate instead of treating scattered protocol scripts as implicit evidence. It adds the previously missing delete → cleanup → same-port reuse proof without mocking the DB or calling an Agent admin API.

## Still pending before A00 can be called complete

This PR must **not** be described as full A00 acceptance. The following task-book items remain separate evidence gates:

- browser login/hydration in a production-like web build; PR #70 only fixes the no-JS/default-GET credential leakage hazard;
- `weighted_round` real distribution and post-Agent-restart distribution/state verification;
- replayed current-main batch-delete implementation with cancel/cross-page/delete-only-role/mixed-failure/disconnect/remote-unconfirmed acceptance before its feature flag can become true;
- explicit stale/unknown status projection checks so desired `active` is never painted as reported online;
- a recorded run of this gate on the merge candidate. The scripts being committed is not itself a passing network run.

## Rollback / safety

The topology uses only `tunex-it-*` containers, `tunex_it_*` networks/volumes and generated integration credentials. It does not connect to production. `teardown.sh` is the rollback for the disposable environment. Runtime leases are verified released before a port is declared reusable; the test never deletes a DB lease directly to force green.
