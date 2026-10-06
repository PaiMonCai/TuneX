# TuneX Integration topology

This directory is the single supported entrypoint for real multi-process topology verification.

Automatic checks:
- `setup.sh`: start Panel, worker, MySQL, Redis, real Agents and data targets.
- `current-protocol.py`: released TCP/TLS/WebSocket/UDP regression.
- `multi-hop.py`: supported multi-hop regression.
- `bootstrap-federation.py`: start and initialize the second Panel.
- `federation.py`: Federation regression.
- `teardown.sh`: remove the topology.

Shared harness code and the Docker Compose topology live in this same directory.
Run evidence is written to `scripts/integration/evidence/`.
