# FXP Link frontend

`/links` is a real Workspace-scoped client for `backend/src/routes/links.ts` and `services/link-resource.ts`. Its production requests all pass through `lib/api/core.ts`; there is no production fixture or fabricated success path. Chinese and English copy is local to this module.

## Public workflows

- Create an FXP resource with entry node, exit node and explicit carrier port. Deployment is a separate action.
- Edit endpoints only before any deployment and with zero references. Deployed resources must be retired before replacement; they cannot leave a remote carrier behind by changing metadata.
- Rotate keys and retire resources only with zero references. Suspended rules remain references.
- Add TCP, UDP or both bindings, edit with captured revision CAS, suspend/resume/retry/delete, and configure directional bytes/sec and total/per-source-IP concurrent connection limits.
- Native Forward list/detail rows belonging to a Link guide to `/links?selected=<id>`. Native mutation and batch selection controls are suppressed for those rows.
- The page uses `node:read/manage` and separate Forward permissions. Workspace or permission changes remount scoped state and invalidate outstanding read/mutation tickets.
- Apply ACKs and live runtime observations are separate. Only `observation.ready === true` for a matching generation and valid lease can display a ready runtime. Absent observation is unknown; stale/failed/passive/closed/removed/mismatch states retain their meaning. A passive ingress is waiting with no enabled listener, not online traffic.
- A `policy_blocked` deployment keeps the resource's existing `degraded` status. The page explains that authorization or traffic policy prevents lease renewal, while removed/expired runtime observations remain independent. Policy recovery uses the server's newer deployment generation; it cannot inherit a previous generation's ready observation or applied rule revision. No additional public resource-status enum is introduced.
- Errors after partial deployment re-read persisted desired state and close the editor so a create is not accidentally repeated. Machine codes are collapsed support details; keys, executable JSON and raw exception messages never enter product UI state.

Managed rule reload rebuilds changed rules and may interrupt their connections. Real Linux acceptance preserves unchanged sibling TCP sessions and exact UDP target sockets across the measured rule changes; immutable carrier/endpoint/key changes remain potentially resource-wide interruptions. This module makes no blanket lossless-reload claim. Current scope and fixed-source evidence are maintained in [runtime boundaries](../../../../docs/forwarding-runtime.md) and [acceptance](../../../../docs/testing.md).

## F5 read-only maintenance preview

This slice belongs to draft/unmerged PR #76 on `feat/forward-link-maintenance`, not the merged PR #75 runtime baseline. The production component uses `POST /api/links/:id/maintenance/preview` through the existing session/CSRF/Workspace request layer. The closed request captures `expected_version`, `expected_generation`, and either complete `update_endpoints` config (`ingress_node_id`, `egress_node_id`, `carrier_port`) or `rotate_key` with no client-supplied key.

The preview includes all references (including suspended rules), current/candidate listeners, held/candidate ports, interruption warnings and a state-bound token. Current TCP connections/UDP mappings remain unknown, not cumulative traffic totals. Candidate numbers are predictions: `reserved=false`, `availability=not_checked`; `execution.supported=false`. There is no execute button, version/credential write, command dispatch or port reservation. Existing endpoint and key-rotation restrictions remain intact.

The strict projection rejects malformed scope, dates, reference/port bounds and invented runtime counts, and does not retain key/ciphertext/runner/target configuration. A preview expires after 60 seconds. Input, read, mutation, permission, resource or Workspace changes fence outstanding results; read-only preview does not use the persisted-write success/reload lifecycle. The 15-second detail polling invalidates results while preserving draft operation and input via `invalidationEpoch`, not a keyed form remount. Complete graphs are limited to 500 references / 2048 held ports, never a silently truncated impact report.

Actual migration, bounded dual generations, egress prepare/verify, ingress cutover, drain/retirement, failure recovery and cross-generation accounting are future executor work. See [the next slice](../../../../docs/DEVELOPMENT_PLAN.md#f5-next-slice).

## Forward traffic snapshots

Each detail `forward` may include `traffic: null | { bytes_in, bytes_out, connections, last_received_at }`. Missing/null means **not received**, never fabricated zero. A present object must contain canonical unsigned decimal strings (`0` or digits without leading zeroes) and a valid timezone-qualified ISO timestamp; malformed counters, partial snapshots and impossible calendar dates reject the detail response with the safe `invalid_link_response` code. The projection copies only these four fields, not keys, configurations, raw processes or unrelated runtime fields.

These are backend `LinkTrafficCheckpoint` sums across all historical producers/days for the rule: client → target and target → client payload bytes, plus total admitted connections (including UDP mappings, not current concurrency). Exact decimal bytes with a `B` suffix and exact decimal connection counts avoid any `Number` conversion, including aggregates larger than `MAX_SAFE_INTEGER` or uint64. The existing bilingual rule-card grid is reused; no new route or traffic-dashboard data path is introduced. See the [current traffic contract](../../../../docs/forwarding-runtime.md#traffic); the existing dashboard/allowance ledger remains unchanged.

The receipt timestamp is separate from runtime readiness. At age **>= 60 seconds** the UI keeps the totals and explicitly says they are old, not current zero. A future receipt flags a local clock difference while retaining the historical totals. Neither fresh nor old traffic can substitute for a ready observation, and old traffic does not suppress a genuinely ready runtime.

## F2 ordered targets

New bindings default to legacy single-target mode. Opting in submits a complete optional `target_set` version 1: 1–10 ordered, distinct host/port pairs; `fallback`, `round_robin` or `random`; integer failure/recovery windows of 10–3600 seconds; and `tcp` or `none` probing. Hosts and ports are separate. Raw IPv6 is accepted; backslashes, brackets, invalid colon addresses and IPv6 zone IDs are rejected by the same browser-safe validator in form and response parsing. Duplicate pairs use case-insensitive host comparison, matching the public backend contract. Required `target_host`/`target_port` always come from the first item after edits, deletion or moves.

`bindingFromForward` clones the full set into the captured revision editor. An existing set cannot be disabled: returning to one target means deleting other items and submitting a complete one-item set. Legacy responses with absent `target_set` retain their single `remote_host`/`remote_port` without automatic opt-in. `link_target_set_required` explains reloading the editor and submitting a complete set. `agent_fxp_targets_capability_missing` explains upgrading both entry and exit Agents/runtimes to support `forward.targets.fxp.v1`.

Only the current exit placement can supply `observation.target_status`. The closed parser bounds arrays, validates states, reasons, indices and nullable ISO timestamps, and strips unknown fields. The UI requires a matching deployment/placement/observed generation, valid lease, applied rule revision and a Ready=true exit observation, matching the backend projection. On every render, the target check timestamp must be no older than 60 seconds (inclusive) and no more than 5 seconds ahead; cached facts expire without waiting for the longer lease or another HTTP read. A null timestamp retains only an all-unknown projection. Missing, stale, mismatched or backend-stripped observations display unknown health, time, reason and choices. Health is independent of Ready, ACK and traffic: all targets can be unhealthy while the exit remains Ready, and target health never restores a failed runtime's Ready. `probe: none` disables active checks but still displays valid fresh passive health observations from actual TCP dial results or UDP replies. Without response evidence, health remains unknown; UDP silence never establishes failure. TCP probing does not prove UDP availability.

The detail shows every zero-based target index, health, shared observation time and reason. Selected indices describe the most recent TCP connection / UDP mapping choice, not all existing sessions. Existing warnings about interruption of shared sessions are retained. Re-reading updates the frontend clock immediately before displaying lease-dependent observations.

## F3 TCP client source policy (frontend slice)

Only shared FXP TCP bindings may opt in to optional `client_source`:

```json
{"version":1,"receive_proxy":false,"trusted_cidrs":[],"send_proxy":"off"}
```

The closed response projection keeps only these four fields, clones the trust list, and rejects malformed config, source config on UDP/both, or `ip_hash` without TCP plus an explicit source config. No observed/verified source identity, source health, runtime config or extra source facts enter UI state. The rule details explicitly show **declared desired policy**, socket versus trusted upstream PROXY source, and send off/v1/v2. This is neither observed health nor a claim that targets support PROXY.

New legacy forms leave the field omitted until opt-in. Editing known config round-trips it in full; disabling the source policy submits the explicit all-off object above, never omits it. An explicit all-off config remains eligible for `ip_hash`: socket source is still passed internally when PROXY sending is off. Protocol/listen-scope revision fences remain unchanged on edit. On create, switching away from TCP with source policy or IP hash selected is blocked with a clear error; a new source policy cannot be deselected while IP hash needs it. UDP/both source controls and IP hash are disabled, without affecting their existing target/probe behavior.

Trusted upstreams are at most 32 literal IPv4/IPv6 CIDRs. Mask host bits and canonicalize network text before sending; reject duplicate canonical networks (rather than silently deduplicating), /0, IPv4-mapped IPv6 (including hex spelling), DNS, zones, brackets and malformed prefixes. Receiving requires a nonempty list; receiving off submits an empty list. CIDR inputs are disabled when receiving is off, retaining their draft for re-enabling without sending it. Runtime receive policy requires an upstream socket inside the trust list and a valid PROXY v1/v2 header on every connection, an absolute 5-second deadline, v1 maximum 108 bytes and v2 maximum 536 total bytes. **These wire limits are described, not implemented or verified by this frontend.** Sending requires every destination service to support the selected PROXY version; this is not arbitrary/HTTP header injection or X-Forwarded-For.

IP hash may remap new connections when pool membership or the healthy eligible target set changes; it is not guaranteed fixed session affinity. Target ordering, the first-item projection and existing health/Ready/ACK/traffic separation remain unchanged. Source policy has no live observation fields.

Bilingual errors handle `link_client_source_required`, `agent_fxp_source_capability_missing`, `client_source_tcp_only` and `ip_hash_requires_client_source`, plus current compiler aliases `agent_fxp_client_source_capability_missing` and `link_client_source_tcp_only`. Capability copy requests upgrading both nodes for `forward.client-source.fxp.v1`; the frontend does not invent capability evidence or bypass the API gate. Safe reason codes remain collapsed; raw errors never render. The shared request layer, Workspace scope fence, cookie session, CSRF header and captured revision CAS are unchanged.

## Verification

Optional ingress `observation.traffic_status` reports collection/backlog/blocked
state, retained capacity and the most recent committed ACK. Missing or stale
telemetry stays unknown. These facts do not change runtime readiness; capacity
numbers and rotation capability are collapsed support details.

From `web/`:

```powershell
$env:NEXT_PUBLIC_API_MOCK = "0"
bun test src/components/links/__tests__ src/components/console/__tests__/console-boundary.test.ts
npm run typecheck -- --incremental false
```

The Bun tests validate the production request contract (Workspace, credentials, CSRF, CAS and errors), closed response projections, exact/nullable traffic snapshots, form boundaries, references, lifecycle restrictions, runtime observations and navigation. The source of truth for Agent freshness/digest/identity remains the backend observation projection, rather than a second UI inference.

For isolated browser interactions:

```powershell
bun run src/components/links/__tests__/browser-server.ts
```

Open `http://127.0.0.1:41973`. This loopback-only contract harness imports the actual production React components and shared request layer, with disposable in-memory HTTP fixtures under `__tests__`. It is not mounted by Next.js and never connects to a database or Agent. `/__test/scenario` accepts `enabled`, `conflict`, `partial`, `delay` and `reset` to test feature-off, stale edits, partial apply and scope switching. The fixture is distinct from real Panel/MySQL/Redis/multi-Agent forwarding acceptance.

`statistics` can seed `idle`, `collecting`, `backlogged`, `blocked`, or `unknown`
statistics on a failed ingress. This verifies that even a fresh accounting ACK
does not turn a failed runtime into a ready one.

F2 browser checks use the same isolated production-component fixture. In its browser console run:

```js
await (await import('/__test/f2-checks.js')).runF2BrowserChecks()
```

Start from a freshly loaded Chinese fixture with management permission. The runner resets disposable state and exercises real DOM inputs/clicks and production requests. `targetObservation` seeds `healthy`, `all_unavailable`, `stale`, `digest_mismatch`, `expired`, `missing`, `ingress_only`, `not_ready`, `probe_none` or `legacy`; `targetsCapabilityMissing` rejects multi-target writes. Fixtures validate first-item equality and reject omission of an existing set. See [F2 verification evidence](./__tests__/EVIDENCE.md#f2-多目标前端2026-10-08) for results and the changed-file list.

Additional target freshness scenarios are `old_checked`, `future_checked` and `initial_unknown`. `probe_none_silent` supplies unknown state without response evidence; `probe_none` supplies healthy passive reply evidence with no active probing. The replay advances only the isolated page clock to test cached health expiry, including passive none health, without a minute-long wait; it restores the clock afterward.

The backend feature defaults off. `fxp_links_not_enabled` is shown as a failed operation, with no success notification. Enabling the server feature and final real multi-node validation belong to the backend/runtime rollout.

F5 browser checks also use this isolated loopback harness. Reset fixture state before page initialization, start with a fresh Chinese management page, then run each replay from a fresh reset/reload:

```js
await (await import('/__test/f5-checks.js')).runF5BrowserChecks()
// Separately, from a fresh reset/reload; waits for actual 15-second polling:
await (await import('/__test/f5-checks.js')).runF5PollingDraftChecks()
```

The source-candidate replay results were 45/45 flow checks and 5/5 polling-draft checks; F2 44/44 and F3 39/39 also passed. These are production-component/HTTP-fixture browser interactions, not actual Panel/Agent E2E. Fixed-source evidence and limitations are in [F5 verification evidence](./__tests__/EVIDENCE.md#f5-preview).

F3 browser checks reuse the loopback fixture. Reset disposable fixture state **before loading/reloading the page**, then start with the fresh Chinese management harness and run:

```js
await (await import('/__test/f3-checks.js')).runF3BrowserChecks()
```

`sourceError` on `/__test/scenario` can force any of the four public source-policy error codes. The replay covers create/edit, canonical trust failures, empty receive trust, v1/v2/off sending, IP-hash gating, blocked protocol changes, ordered first-target projection, explicit all-off edits, untouched legacy, safe errors, conflict/reopened CAS, read-only and late Workspace mutation fencing. This test-only fixture is not mounted on product routes and is not proof of real Agent/PROXY forwarding. See [F3 verification evidence](./__tests__/EVIDENCE.md#f3-tcp-client-source-frontend-2026-10-08).
