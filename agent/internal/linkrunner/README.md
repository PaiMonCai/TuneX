# Managed FXP lifecycle

The Agent stays standard-library-only. Build the imported executable separately
from `third_party/forwardx/forwardx-fxp`. Its runtime log version is **2.2.117**;
the containing source project's import version is **2.3.281**. These are separate
facts. This implementation does not change the public matrix or planned gate.

```go
New(binaryPath, stateDir, agentID string) (*Manager, error)
(*Manager).SetPortGuard(PortGuard) error
(*Manager).EnableTraffic() error
(*Manager).TrafficSamples() ([]TrafficSample, error)
(*Manager).AckTraffic([]TrafficSample) error
(*Manager).Apply(Config) (Observation, error)
(*Manager).Remove(id string, generation int64) (Observation, error)
(*Manager).Status() []Observation
(*Manager).Restore() ([]Observation, error)
(*Manager).Reconcile(*Snapshot) ([]Observation, error)
(*Manager).NodeDBID() int64
(*Manager).Close() error
```

Use one Manager per dedicated state directory. New loads fences without starting
children. SetPortGuard before Apply/Restore. The guard is the native TunnelManager
with `ReserveExternal(owner, []portlease.Binding) error` and
`ReleaseExternal(owner)`. Candidate and rollback ports stay reserved across the
restart gap; the slot is released only after exit. Lease timers and exit release
work independently of the command mutex.

Config matches `link-compiler.ts`: id, link_id, workspace_id, node_id, role,
generation, lease_expires_at, config_digest, runner_config, runtime_ids, ports.
Digest is SHA256 of sorted canonical renderer JSON; HTTP object insertion order
is immaterial. Port claims are verified against the renderer before reservation.
Ingress `runner_config:null` requires empty ports/runtime IDs and succeeds with
state passive, ready false, no process. Egress runs independently.

Observation contains desired/observed generation, desired/running digests, ports,
runtime IDs, lease, PID, readiness, state, safe bounded events and update_mode
`managed_reload` or `stop_start`. It excludes raw runner JSON and arbitrary child
output. Startup requires every listener's bound marker, a survival interval, and
the applied digest when managed mode is enabled.

The renderer opts in with top-level `managedReload:true`. Agent writes sorted
canonical JSON bytes (no trailing newline) to one stable private CLI `-config`
file; `config_digest` is SHA256 of those exact bytes. Runtime polls only that
file and emits `managed applied sha256=<64 lowercase hex>` after validation and
binding changes, or `managed rejected sha256=<hex> code=invalid|immutable|bind`.
The log timestamp prefix is allowed. Agent accepts only its authorized digest,
atomically writes the candidate, waits for its fresh ACK, then commits encrypted
restore state. Rejection rewrites the old bytes and waits for a fresh rollback
ACK. Timeout, unknown digest, or unconfirmed compensation stops the process.
Generation fences survive failed updates and restarts. Managed plaintext files
exist only while the child is running and are removed on exit/Close.

With carrier key/tunnel/listen transport unchanged, exit replaces authorization
and UDP target snapshots; entry-group retains unchanged ruleID runtimes, their
listeners, TCP sessions, UDP mappings, gates and token buckets. A changed rule's
target, business listener port or policy rebuilds only that rule; its old TCP/UDP
sessions close explicitly, including both ends of its encrypted stream. Managed
rule stop cancels blocked limiter waits rather than waiting for their rate budget.
Both protocols of one `both` entry share the same input/output token buckets and
connection gate. Every candidate is validated before mutation; child bind failure
compensates affected old entries. The real test continuously holds B TCP and a
fixed-source UDP mapping across adding/editing/deleting A, and bind rollback.

Transport key/carrier ports or immutable carrier settings still restart the placement.
Legacy `managedReload:false` retains upstream behavior. Restart allows built-in
5-second TCP drain (6-second signal grace, then bounded kill); persistent sessions
can close and UDP mappings reset, including sibling bindings. Failed starts
restart the still-leased committed config; observed_generation exposes the old
generation while the failed higher command remains fenced. Lease expiry uses its
independent short stop bound and cannot wait for a reload or another command.

Cache secrets and permanent tombstones are authenticated together with AES-GCM in
state.enc.json. The random machine.key is independent of AUTH_SECRET. Missing keys
with existing ciphertext, corrupt/foreign caches, symlinks and uncertain writes
fail closed. Directories use 0700, files 0600. Windows uses atomic MoveFileEx and
a KILL_ON_JOB_CLOSE child job; Windows creates the child suspended, binds the
job, verifies its unique initial thread and only then resumes execution. Linux
uses rename/directory sync and parent-death kill. A parent crash before Windows
job attachment can leave a suspended, unexecuted process requiring service-account
cleanup, but it cannot start listeners or write traffic. POSIX mode flags do not
set Windows ACLs: provision the state directory for
the Agent service account only. Link configs never enter legacy LKG.

Runtime opt-in: `TUNEX_FXP_LINKS_ENABLED=true`; executable `TUNEX_FXP_BINARY`, default
`/usr/local/bin/tunex-fxp`. Capability/actions receive runtime facts only after
executable, cache and guard construction succeed. This does not open the product
gate. apply_link requires sibling link and matching envelope id/generation.
remove_link needs only envelope resource_id/revision and checks persisted identity.
ACKs include secret-free link_observation.
Stable wire errors include stale_generation, generation_conflict, lease_expired,
identity_mismatch, port_conflict, cache_unavailable, reload_rejected,
reload_timeout and config_tampered. Authoritative omission/remove fences the
current generation; activation after that requires a strictly higher generation.
Runtime capabilities include forward.link.fxp.v1/actions only for a constructed
FXP runtime. forward.policy.runtime.v1 also comes from the constructed native
policy runtime, independently of the FXP flag. Selector manifest facts use
selector_fallback; native ParseStrategy accepts FALLBACK/IP_HASH. Production has
no trusted client-source producer on EGRESS, so selector_ip_hash_client_ip is NOT
advertised. IP_HASH is exercised through trusted runtime injection tests; legacy
source-less relay IP_HASH remains explicitly refused. DIRECT business API remains
single-target and does not imply production IP_HASH support.
The production reporter uses WithLinkPlacements with Manager.Status; the reporter
projects a closed field set excluding runner config, PID, child logs and arbitrary
errors. A disabled runtime has a nil provider and makes no placement claim.

HTTPSource uses node Bearer auth at `/api/internal/node/desired`, forbids redirects,
and expects data.snapshot.node_db_id plus an explicit links array. Optional
snapshot.agent_id must match physical AgentID. Numeric node identity is persisted;
AgentNodeID strings/UUIDs are never parsed. Only network/5xx failures allow private
cache restore. Unauthorized, missing/malformed links and foreign identity do not.
An empty authoritative list durably removes omitted placements.

Tests use GOARCH=amd64 and TUNEX_TEST_FXP_BINARY pointing to the imported executable.
Real helper processes also cover missing readiness, ignored shutdown signals,
crashes, secret output and cache boundaries.

Files: config.go (wire contract, canonical digest and listener validation),
manager.go (fences and lifecycle), process.go (readiness, logs, leases and stop),
cache.go (encrypted atomic state), portguard.go (shared external slots),
platform_linux.go and platform_windows.go (signals, process containment and atomic
replacement), http_source.go (desired fetch and reconciliation), manager_test.go,
cache_test.go, portguard_test.go, http_source_test.go, real_flow_test.go, README.md.
managed.go (reload classifier and ACK commit), managed_test.go (ACK timeout and
durable cache boundaries), managed_real_test.go (persistent shared traffic and
tamper acceptance). Vendored integration: managed_reload.go/test, main.go,
binding_auth.go and udp_direct.go. Control integration: client.go, protocol.go,
runtime.go, link_test.go, manifest.go/test and Agent runtime.go.

## Versioned business target sets

`TargetSetsSupported()` executes the secret-free, bounded two-second
`-managed-target-capabilities` probe and accepts exactly `{"managed_targets":1}`.
Only a constructed runtime with this support advertises `forward.targets.fxp.v1`.
Supported children always receive `-managed-targets-v1`, allowing legacy-single
bindings to be updated in place. Apply and Restore reject target sets when the
executable lacks support; they never silently select the first destination.

The compiler supplies an entry `targetSet` and exit `targetSets`, with complete
rule/protocol/target authorization. Exit selection is per new TCP connection or
UDP source mapping. Confirmed auxiliary TCP probe failure retargets only the
affected UDP socket while retaining wire replay and encryption sequence state;
recovery leaves existing healthy mappings pinned. `probe:none` never converts
UDP silence into failure. A target policy edit closes the changed rule's sessions
but preserves unchanged siblings and their selectors, budgets and sockets.

Egress TargetStatus is a closed, bounded projection of indexes/states, latest
selected TCP/UDP indexes, last check and reason. Child events must match the
authorized committed/candidate digest and declared rule/target count. Events
expire after 15 seconds; reports/checks use the control plane's fresh generation,
digest, lease and 60-second gates. Removed rules are pruned on reload. Health
does not grant or revoke listener Ready and arbitrary child output stays dropped.

## Durable ingress traffic collector

F1 negotiates `-managed-traffic-capabilities` before starting children. Supported
programs receive a private rotation control path; legacy programs keep the v1
collector. v2 is an active accounting epoch and v3 its sealed immutable final
snapshot. A durable encrypted PreparedFrom manifest precedes each request; the
runner persists the empty successor before sealing old totals and redirecting
new deltas under its counter mutex. The Agent verifies both snapshots before
transferring the child's active producer. A whole exact committed ACK can then
reclaim the predecessor without stopping the process or business sessions.

An old accounting day, 1024 rule/day or rule mappings, or maximum epoch age
triggers rotation. `TUNEX_FXP_TRAFFIC_EPOCH_SECONDS` is 30–86400 (default 86400).
Current and candidate bindings are authorized before switching so rejected
reloads and late reporter deltas have no blind spot. Missing empty preparation
can be recovered after exit only before predecessor sealing; missing successor
after sealing fails closed. Manifest format v2 intentionally prevents unsafe
old-Agent downgrade. The database keeps historical checkpoints and deployments.

Optional secret-free TrafficStatus reports retained capacity and last ACK from
memory separately from Ready; it may become unknown after restart. Controls do
not carry keys or credentials. Capability probes also exclude node/auth secrets.

Collection is **disabled by default**. Call `EnableTraffic()` immediately after
`New`, before the first `Apply` or `Restore`. Late opt-in returns
`ErrTrafficStarted`. Existing fake/legacy process invocations remain unchanged
when disabled. Enabled non-passive ingress requires `managedReload:true`; an
unsupported ingress cannot silently run without accounting. Egress and passive
ingress never produce counters.
Managed traffic is supported only on Linux and Windows; other GOOS builds have
an explicit fail-closed opener and `EnableTraffic` rejects the unsupported platform.

Each fresh ingress process gets a cryptographically random 32-lowercase-hex
producer ID and these additional CLI arguments:

```text
-managed-traffic <private-absolute-stateDir/traffic/producer.snapshot.json>
-managed-traffic-producer <producer>
```

Negotiated programs also receive `-managed-traffic-rotation-v1` with a private
control-file path. Each subsequent epoch gets a new random producer ID without
restarting the ingress process.

The destination is new, not pre-created by the Agent: FXP atomically creates its
initial empty snapshot before starting listeners. `AUTH_SECRET` is always
excluded from child environments; with collection enabled, `NODE_CREDENTIAL` is
also excluded, including for egress. The child receives no panel credentials.

`traffic/<producer>.manifest.json` is an AES-GCM sidecar using the existing
machine-key cache AEAD. Authentication binds the Agent ID and filename producer.
Its secret-free contents bind producer to placement ID, node, workspace, link
and ingress role, and map each actual authorized entry-group `ruleId` to its
**first-known generation/config digest for that epoch**. TCP and UDP of a
`both` rule share one forward ID. New mappings are synced before publishing a
managed candidate config; a rejected proposal can conservatively retain its
mapping. Existing/removed/re-added rule mappings are never rebased or evicted
within an epoch; a sealed, exactly acknowledged epoch is reclaimed as a whole.
No runner JSON, transport key or network credential enters the traffic spool.

FXP snapshots have exactly `version`, `producer_id`, and `samples`, containing
`forward_id`, `date`, and decimal-string `bytes_in`, `bytes_out`, `connections`.
Dates are FXP's Asia/Shanghai accounting dates; the collector does not re-bucket
them. Version 1 is the legacy process-wide collector, version 2 is an active
epoch, and version 3 is its sealed final snapshot. Totals are cumulative per
producer/rule/day across managed updates, not deltas. Counters and input+output
totals must stay within `9007199254740991`.
The exported `TrafficSample` wire fields are exactly:

```text
producer_id link_id workspace_id node_id forward_id generation config_digest
date bytes_in bytes_out connections
```

`TrafficSamples()` scans the durable spool, including stopped processes, removed
placements and prior Agent runs. Authenticated manifests are checked against
retained placement identity and generation fences. Counter high-water marks are
persisted before samples are returned; regression or loss of a previously seen
rule/day is rejected, even after restart. Swapped producer snapshots/manifests,
symlinks (including directory ancestors), path escapes, non-private POSIX files,
unknown fields, duplicate JSON keys, malformed dates/counters and unreadable data
fail closed. Atomic snapshots are read through pinned kernel no-follow handles,
with bounded metadata/sharing retries, including Windows directory-enumeration
and sharing/access races. A legitimate replacement between Lstat and open is
not confused with a producer identity mismatch; both file modes/sizes and the
actual snapshot producer identity are still validated.
Windows uses `FILE_FLAG_OPEN_REPARSE_POINT` with read/write/delete sharing;
Linux uses `O_NOFOLLOW`. The opened handle's regular-file type, private POSIX
permissions and 1 MiB size limit are rechecked, and the handle closes before
JSON decoding. Each transient metadata/open retry phase is limited to eight
attempts with 5 ms sleeps. A disappearing writer `*.tmp` entry is tolerated,
but a missing manifest/snapshot is never skipped (except authenticated ACK
deletion recovery). Persistent sharing/access failures still return `ErrTraffic`
and leave the spool untouched. Some Windows replacements can wait for an open
reader to close; the existing atomic writer's bounded retry remains required.

`AckTraffic` compares full metadata and all current persisted totals. It never
removes an active producer, even when its snapshot is empty or its lease has
expired but exit is unconfirmed. Only a stopped or sealed producer whose entire
current snapshot is exactly covered by ACKs is reclaimed. Partial/stale ACKs retain data;
repeated ACKs are idempotent. A durable exact-total deletion intent and ordered
snapshot/manifest unlinks allow interrupted ACK cleanup to recover safely. A
changed snapshot during that cleanup is an error, never permission to delete it.
`AckTraffic(nil)` can reclaim stopped or sealed empty producers without a network request;
it retains all active producers and all nonzero/unacknowledged samples.

The runtime owns the sole 10-second delivery loop, HTTP authentication and the
shared **current** panel URL callback. Send a whole producer (at most 2048
samples) per request and pass only acknowledged samples to `AckTraffic`. Call
`AckTraffic(nil)` after successful flushes, including empty flushes, to reclaim
stopped or sealed zero-traffic producers. There is deliberately no second delivery loop,
reporter integration or HTTP client in linkrunner.

Limits: 1 MiB per manifest/snapshot, 2048 samples and historical rule mappings
per producer, 128 retained producers, and at most 129 bounded writer `*.tmp`
files (one per producer plus the Agent). All files are counted, giving a hard
385 MiB spool-size bound. No unacknowledged producer or historical mapping is
evicted to make room. Private directories are 0700 and files 0600; Windows
service-account ACL provisioning is still required. Capacity, validation or
uncertain persistence failures reject launch/update and stop traffic-enabled
ingress children; data remains for explicit recovery. Missing snapshots are
errors except during an already-authenticated ACK deletion or recoverable empty
epoch preparation described above. A failed launch
before FXP initializes can leave a conservative manifest requiring operator
inspection/recovery, rather than guessing that missing data was zero.

Remove, lease expiry, process restart and `Close` preserve traffic files. `New`
cleans only the separate `runtime/` plaintext-config directory. Keep `machine.key`,
encrypted fences and `traffic/` together for recovery, and use one Manager owner.
Authenticated checkpoints protect against snapshot regression and filename replay,
not a malicious service-account owner replaying an entire machine-key/state backup.

**Counter window limitations:** FXP samples active TCP/UDP counters every second
and persists cumulative snapshots every second, so an abrupt Agent/FXP kill or
power loss can lose the unpersisted sampling+flush window (nominally up to about
two seconds; scheduler/storage delays can extend it). Previously persisted
snapshots survive restart and use old producer IDs; the replacement always gets
a new ID. Graceful FXP shutdown attempts a final sample/flush, but Agent `Close`
and lease expiry have bounded stop timeouts and can force-kill a draining child;
they cannot guarantee a final flush. A delivery failure loses no persisted data,
but eventual durable accounting is not an exactly-once claim for unsampled bytes.

Collector files: `traffic.go`, `traffic_store.go`, `traffic_file_linux.go`,
`traffic_file_windows.go`, `traffic_file_unsupported.go` (no unsafe generic-open
fallback), `platform_unsupported.go` (conservative native-build portability),
lifecycle hooks in
`manager.go`/`managed.go`/`process.go`, and `traffic_test.go`,
`traffic_windows_test.go`, `traffic_real_test.go`, `traffic_rotation.go`,
`traffic_rotation_test.go` and `traffic_rotation_real_test.go`.
The optional real-binary acceptance checks known BOTH TCP+UDP payloads while TCP
remains open, rule deletion, active ACK retention, final snapshots, Close/reopen,
Restore and producer replacement:

```powershell
$env:GOARCH = 'amd64'
$env:TUNEX_TEST_FXP_BINARY = '<absolute path to current FXP executable>'
go test ./internal/linkrunner -run 'TestTraffic|TestRealFXPTraffic' -count=1
```

`TUNEX_TEST_FXP_TRAFFIC_BINARY` is also accepted for collector-only acceptance.
