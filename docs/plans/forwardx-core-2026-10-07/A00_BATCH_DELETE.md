# A00 — batch delete replay and real acceptance

> Current-main replay branch: `feat/a00-forward-batch-delete-replay`.
> Historical source slice: `feat/forwardx-core-batch-delete@659b004`.
> The historical branch is not a merge base for new work; only reviewed behavior is replayed.

## Safety boundary

Batch deletion exists in the API contract but is **disabled by default**:

```text
FORWARD_BATCH_DELETE_ENABLED=false
```

The web discovers the capability at runtime. A delete request also requires
`confirm_delete: true`, and workspace middleware authorizes it as
`forward:delete` rather than `forward:update`.

The batch layer never deletes Tunnel rows directly. Each id delegates to the
current-main `deleteForward()` path so rollout teardown, leases, dedicated pool
cleanup and federated release/reconciliation keep one owner.

Per-item processing is sequential and isolated. Scope is checked before
ownership, so a foreign-workspace id remains `not_found`. Unexpected
per-item exceptions become a generic `internal_error` result and do not erase
earlier outcomes or expose raw DB/transport messages.

## Real multi-Agent gate

The isolated integration panel must opt in explicitly:

```bash
FORWARD_BATCH_DELETE_ENABLED=true scripts/integration/setup.sh
python3 scripts/integration/a00-batch-delete.py
```

The gate uses the existing real MySQL/Redis/Panel/Worker/4-Agent topology. It
verifies:

- confirmed batch deletion of real TCP DIRECT and RELAY rules;
- duplicate-id normalization plus a `not_found` partial failure;
- desired row removal, listener shutdown, Agent-report runtime removal and
  active lease release;
- exact ingress-port reuse followed by a real payload;
- a deliberately disconnected egress Agent causing the RELAY item to fail
  without preventing a later independent DIRECT deletion;
- the failed RELAY retaining its durable Tunnel and active leases while teardown
  is uncertain;
- a refresh reading that surviving item back from durable state;
- Agent recovery followed by cleanup through the ordinary single-delete
  lifecycle.

The test never deletes a lease or Tunnel row directly to manufacture a green
result.

## Still pending before enabling

The flag must stay false until a recorded merge-candidate run is green. The
separate federation acceptance must also cover a remote panel leg whose release
cannot be confirmed; local batch success must not be interpreted as proof that
the remote placement is already gone. Browser acceptance must cover cancel,
cross-page selection, duplicate clicks and persistent per-id failure details.

No payment behavior is changed by this slice.
