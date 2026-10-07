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

The default remains upstream-compatible for reference regression tests. This does
not enable FXP in the public TuneX support matrix; managed lifecycle, provenance,
endpoint-version checks and network acceptance remain separate gates.
