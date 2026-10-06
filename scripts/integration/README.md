# Integration entrypoints

This directory is the **current, stable entry surface** for TuneX topology verification.

The implementation still lives under `scripts/v3-e2e/` because those filenames are historical
compatibility identifiers and are useful when comparing old Gate evidence. Current workflows
must call the wrappers in this directory rather than embedding V4/V5 milestone names.

## Current automatic gates

| Entrypoint | Current meaning | Historical implementation |
| --- | --- | --- |
| `setup.sh` | start the real PR/release topology | `v3-e2e/setup.sh` |
| `current-protocol.py` | canonical protocol regression | `v3-e2e/v5-g1b.py` |
| `multi-hop.py` | supported multi-hop regression | `v3-e2e/v5-g4.py` |
| `bootstrap-federation.py` | create the second Panel/peer facts | `v3-e2e/bootstrap-federation.py` |
| `federation.py` | supported Federation product regression | `v3-e2e/v5-g5.py` |
| `teardown.sh` | destroy the topology | `v3-e2e/teardown.sh` |

Everything else under `scripts/v3-e2e/` is a compatibility, diagnostic, fixture, or historical
Gate asset unless it is explicitly added to this table and the workflow.

Do not rename old migration/Gate evidence merely to make version labels disappear; provenance is
more valuable than cosmetic naming.
