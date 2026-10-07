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

Saving or changing rules reapplies the carrier and may interrupt existing connections. This module makes no claim of lossless reload. The shared reload work requires separate measured acceptance before changing that copy.

## Forward traffic snapshots

Each detail `forward` may include `traffic: null | { bytes_in, bytes_out, connections, last_received_at }`. Missing/null means **not received**, never fabricated zero. A present object must contain canonical unsigned decimal strings (`0` or digits without leading zeroes) and a valid timezone-qualified ISO timestamp; malformed counters, partial snapshots and impossible calendar dates reject the detail response with the safe `invalid_link_response` code. The projection copies only these four fields, not keys, configurations, raw processes or unrelated runtime fields.

These are backend `LinkTrafficCheckpoint` sums across all historical producers/days for the rule: client → target and target → client payload bytes, plus total admitted connections (including UDP mappings, not current concurrency). Exact decimal bytes with a `B` suffix and exact decimal connection counts avoid any `Number` conversion, including aggregates larger than `MAX_SAFE_INTEGER` or uint64. The existing bilingual rule-card grid is reused; no new route or traffic-dashboard data path is introduced. See the [current traffic contract](../../../../docs/forwarding-runtime.md#traffic); the existing dashboard/allowance ledger remains unchanged.

The receipt timestamp is separate from runtime readiness. At age **>= 60 seconds** the UI keeps the totals and explicitly says they are old, not current zero. A future receipt flags a local clock difference while retaining the historical totals. Neither fresh nor old traffic can substitute for a ready observation, and old traffic does not suppress a genuinely ready runtime.

## Verification

Optional ingress `observation.traffic_status` reports collection/backlog/blocked
state, retained capacity and the most recent committed ACK. Missing or stale
telemetry stays unknown. These facts do not change runtime readiness; capacity
numbers and rotation capability are collapsed support details.

From `web/`:

```powershell
$env:NEXT_PUBLIC_API_MOCK = "0"
bun test src/components/links/__tests__/links-api.test.ts src/components/links/__tests__/links-ui.test.tsx src/components/console/__tests__/console-boundary.test.ts
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

The backend feature defaults off. `fxp_links_not_enabled` is shown as a failed operation, with no success notification. Enabling the server feature and final real multi-node validation belong to the backend/runtime rollout.
