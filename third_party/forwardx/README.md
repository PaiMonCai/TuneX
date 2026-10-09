# ForwardX FXP component

The standalone `forwardx-fxp` executable is imported from ForwardX 2.3.281,
commit `cb0ef0bb156dc114e4344c887328018491fbd638`. `UPSTREAM.json` records each
original source hash. The user's `Forwardx/` checkout is not a build dependency.

The upstream license and dependency notices are retained alongside the source.
This component is AGPL-3.0-only. Distributors/operators must include the source,
license, modification notices and applicable source-access arrangements for the
modified component. No license for unrelated TuneX source is assigned here.

TuneX modifications retain the FXP wire framing and add opt-in exit authorization
(`requireBindingAuth`, `allowedBindings`). The managed Link compiler must always
enable it: a carrier key authenticates a peer, while the configured rule/target
mapping authorizes the business destination. Native UDP keeps upstream's configured
target mapping; that mapping is checked against the same authorization policy.

`managedReload:true` adds a private config-file watcher with a SHA256 applied
confirmation. The exit swaps exact authorization/UDP target snapshots, closing
changed or removed rules. The entry group preserves unchanged listeners, TCP
sessions, UDP mappings, gates and buckets while rebuilding changed rules. Bind
failures compensate before a rejection. Managed rule shutdown closes both ends
of its TCP streams and interrupts limiter waits. Carrier key/port changes remain
explicit restarts. These modifications and new tests are indexed in
`MODIFICATIONS.json`; original hashes in `UPSTREAM.json` remain unchanged.

`-managed-traffic` and `-managed-traffic-producer` opt a managed entry group into
private, atomic cumulative payload snapshots. TCP and UDP counters for one rule
share a producer/rule/Shanghai-day identity. Existing FXP counter collection is
reused with one-second sampling and a final normal-stop flush; exits do not
produce a second report. The Agent supplies no panel or node credential to this
channel and owns authenticated delivery and ledger acknowledgements. Snapshot
size, sample count and counter values are bounded; persistence failures stop
the process rather than silently discard accounting. Abrupt termination can
still lose an unsampled/unpersisted window. This is not exact crash-safe
financial metering. See the [current traffic contract](../../docs/forwarding-runtime.md#traffic)
and [acceptance guide](../../docs/testing.md) for rollout and capacity boundaries.

The default remains upstream-compatible for reference regression tests. This does
not enable FXP in the public TuneX support matrix; managed lifecycle, provenance,
endpoint-version checks and network acceptance remain separate gates.

F1 adds opt-in `-managed-traffic-rotation-v1 <private-control-path>`, negotiated
through `-managed-traffic-capabilities`. Live epoch snapshots are v2 and final
sealed snapshots v3. Under the same accounting mutex the executable persists
an empty successor, seals predecessor totals, then redirects future deltas to
the new random producer identity. Listeners, sessions, UDP mappings and admission
budgets remain alive. Repeated controls never reset cumulative data. The Agent
persists authorized preparation before control, verifies both durable snapshots,
and reclaims sealed totals only after exact authenticated storage acknowledgement.
Legacy invocations retain snapshot v1 and receive no rotation control argument.

F2 adds negotiated `-managed-targets-v1`. The executable probe
`-managed-target-capabilities` returns `{"managed_targets":1}`. Versioned ordered
business target sets reuse the upstream endpoint selector for fallback/RR/random
and require complete rule/protocol authorization. Bounded auxiliary TCP probes
use explicit failure/recovery windows; UDP silence is not a failure signal.
New TCP connections select at the exit; a UDP mapping retains its target until
confirmed failure. Retargeting keeps replay/AEAD sequence state and rejects late
old-socket responses. Existing TCP is not migrated. Unchanged sibling rules keep
their sockets and health state during target policy reloads. Digest-bound status
logs contain only indexes/states/times, never target addresses or credentials.
The public FXP feature flag and support matrix remain unchanged.

F3 adds `-managed-source-v1` and the bounded secret-free executable probe
`-managed-source-capabilities` (`{"managed_source":1}`). Shared TCP source policies
adapt the upstream PROXY parser/formatter and IP_HASH selector, adding trusted
CIDRs, absolute bounded header reads, effective-source admission, authenticated
rule/policy-bound source metadata and exit-owned send/version authority. Old
policy attestations fail after reload; unchanged siblings stay intact. UDP/both
source policies remain rejected. The ingress node/key is the attestation trust
boundary; this is not protection against a malicious authorized ingress.
