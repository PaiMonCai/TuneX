# A01 — Forward core contract freeze

> Branch: `feat/forwardx-core-a01-contract`. Base: current `main` at the start of this package.
> ForwardX reference requested by the task: 2.3.281 / `cb0ef0bb156dc114e4344c887328018491fbd638`.

## Scope delivered by this package

This package freezes the integration vocabulary before A02/A03 add persistence or managed runners. It deliberately does **not** create LinkResource tables, enable FXP/GOST/WireGuard, add `both`, or expose new UI options.

The contract separates four dimensions:

1. business protocol: `tcp | udp | both`;
2. client front: `plain | tls | ws | wss`;
3. inter-node carrier: `native_private`, FXP/GOST/WG and the reserved ForwardX m* names;
4. execution driver: native/FXP/GOST/WG plus the later system drivers.

Current TuneX compatibility facts map as follows: existing `tcp/tls/ws/udp` remain on the native driver and `native_private` carrier. In particular, client TLS/WS **does not** imply hop encryption. `both`, FXP, GOST, WG and m* are present in the vocabulary but remain `planned`, so an enum/string cannot accidentally become product support.

## Capability and compatibility gate

New LinkResource execution is fail-closed:

- Agent version `unknown` is rejected for the new contract;
- the Agent must provide an explicit capability manifest;
- every matrix entry lists its required capabilities;
- planned/unknown combinations are rejected;
- runtime fallback is forbidden, so a secure carrier request cannot silently become `native_private`.

Existing unbound Tunnel rows stay `legacy_private` and continue through the existing rollout/reconcile writer until an explicit per-rule migration. Old plaintext is never re-labelled encrypted.

A concrete semver floor is mandatory before any **new non-native** driver changes from `planned` to `available`. No floor is invented in A01 because the managed FXP/GOST Agent build does not exist yet; A03 must stamp one as part of its release gate.

## Identity and single-writer rules

- `LinkVersion` is immutable and its canonical SHA-256 digest is calculated from sorted JSON.
- Runtime ids include link id, link version, placement id, role and concrete protocol.
- `both` has no single runtime id: A04 must create distinct TCP and UDP child runtimes.
- The future port lease identity is frozen as node + normalized bind scope + protocol + port. A04 still owns the actual IPv4/IPv6/wildcard conflict matrix and DB migration.
- Shared Link runtime config has one compiler/writer. Binding changes reference immutable versions and must not maintain a second mutable topology copy.
- Deleting one binding never implies deleting the shared carrier.

## ForwardX reference status

The task explicitly says `Forwardx/` is read-only and not tracked, and CI/release must not depend on it. The pinned upstream checkout is not available through this GitHub repository, so this PR **does not claim upstream planner parity**.

`fixtures/forwardx-reference.json` records the pinned version/commit and the first adapter cases with `upstream_executed=false`. Before A01 can satisfy the stronger “same fixture against upstream planner and adapter” acceptance item, the pinned source/license/dependency review must be completed and the permitted snapshot or executable fixture harness made available to CI. Until then, that gate remains pending rather than mocked green.

## Tests

`backend/src/integrations/forwardx/__tests__/core-contract.test.ts` covers:

- legacy protocol → orthogonal dimension mapping;
- TLS/WS not being treated as hop encryption;
- planned FXP/GOST/WG/both failing closed;
- known Agent version + explicit capabilities for new Link execution;
- no secure-to-plaintext fallback;
- canonical digest stability and invalid JSON rejection;
- deterministic runtime ids;
- TCP/UDP lease-key separation;
- explicit legacy migration boundaries;
- invariant that a future non-native `available` entry must carry a concrete minimum Agent version.

This is contract evidence only. Real MySQL/Redis/Agent/network evidence belongs to A00/A02/A03 and must not be inferred from these unit tests.
