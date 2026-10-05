# TuneX Agent

`agent/` is the node-side data plane for TuneX. It is a Go, standard-library-only
binary that runs the listeners and relay/egress runtimes selected by the Panel.

The production control path is **outbound-only from Agent to Panel**:

```text
Panel
  ▲
  │  heartbeat / state report / command poll / ACK
  │  HTTP(S), authenticated with the per-node credential
  │
Agent
  ├─ TunnelManager      ingress listeners
  ├─ EgressManager      relay / target-side runtimes
  ├─ Control client     polls revisioned commands
  ├─ Reporter           heartbeat, state and capability facts
  ├─ Restore / LKG      restart recovery during Panel outages
  ├─ Ownership guard    epoch fencing + lease expiry
  ├─ Target DNS/health  resolution and observations
  └─ Diagnostics        bounded node/forward probes
```

The Panel does not need a public Agent management port. The optional local admin
API binds to loopback and is a diagnostic/debug surface, not the production
orchestration path.

## Supported data plane

The Agent currently advertises the protocols implemented by the same parser/runtime
that applies them:

- TCP
- TLS
- WebSocket
- UDP

TCP/TLS/WebSocket use the stream runtime and support the released DIRECT / RELAY
routing model, including the product's stream multi-hop path. UDP uses the datagram
runtime and supports DIRECT plus single-hop RELAY.

QUIC, UDP multi-hop, cross-panel UDP legs, UDP hop AEAD/MAC and UDP fragmentation /
reassembly are not advertised as implemented capabilities and remain fail-closed.

## Build and test

```bash
cd agent

go vet ./...
go test ./...
go test -race ./...
go build -buildvcs=false -o tunex-agent .
```

The module intentionally uses only the Go standard library, so the Agent can be
built without third-party Go module downloads.

## Configuration

Configuration precedence is:

```text
CLI flags > environment > flat YAML config
```

The default config file is `$HOME/.tunex-agent.yaml`. Supported runtime fields are:

```yaml
agent-id: 550e8400-e29b-41d4-a716-446655440000
node-id: node-01
role: BOTH
listen-ip: 0.0.0.0
panel-http-url: https://panel.example.com
agent-admin-port: 0
agent-admin-token: ""
ingress-range: 10000-30000
egress-range: 30001-60000
node-credential: "<per-node credential>"
debug: false
```

Equivalent environment variables use the `TUNEX_` prefix:

```text
TUNEX_AGENT_ID
TUNEX_NODE_ID
TUNEX_ROLE
TUNEX_LISTEN_IP
TUNEX_PANEL_HTTP_URL
TUNEX_AGENT_ADMIN_PORT
TUNEX_AGENT_ADMIN_TOKEN
TUNEX_INGRESS_RANGE
TUNEX_EGRESS_RANGE
TUNEX_NODE_CREDENTIAL
TUNEX_STATE_DIR
```

`TUNEX_STATE_DIR` defaults to `/var/lib/tunex-agent`. It holds durable Agent
state such as the last-known-good desired snapshot and the ownership epoch fence.
Setting it to an empty value disables durable cache state and should be treated as
an explicit operational choice.

For normal production installation, prefer the install/enrollment command generated
by the TuneX Admin Console rather than assembling credentials and flags manually.

## Container entrypoint

The published Agent image reads an env file before starting the binary:

```text
/run/tunex-agent/agent.env
```

Set `TUNEX_AGENT_ENV_FILE` to override that path. The file must be readable; the
container fails closed if it is missing.

## Startup and recovery

The runtime starts in this order:

1. construct the shared Tunnel/Egress managers and port ownership guard;
2. load the durable ownership fence;
3. restore authoritative desired state from the Panel, or fall back to the local
   last-known-good snapshot when the Panel is unavailable;
4. start the optional loopback admin API;
5. start the outbound command poll / ACK loop;
6. start target observation and heartbeat/state reporting.

When a node booted from the local cache and the Panel becomes reachable again, the
Agent re-fetches authoritative desired state and removes local runtimes the Panel
no longer owns. This prevents an outage-recovered node from serving deleted or
suspended work indefinitely.

Ownership leases and epoch fencing provide an independent fail-safe: stale ownership
must not keep serving only because the local runtime is still alive.

## Control contract

The Agent polls:

```text
GET/POST /api/internal/node/commands
POST     /api/internal/node/ack
```

and reports to:

```text
POST /api/internal/heartbeat
POST /api/internal/node/state
```

The state report carries the control protocol version, supported command actions and
a capability manifest derived from the runtime actually compiled and wired into the
process. The Panel uses those facts to refuse unsupported work instead of assuming
that every Agent supports every feature.

The per-node credential is required for the production command/state path and must
never be logged.

## Repository layout

| Path | Purpose |
| --- | --- |
| `main.go` | process lifecycle and signal handling |
| `v3runtime.go` | wires the production runtime together |
| `internal/agentconfig` | flags, env and flat YAML configuration |
| `internal/control` | outbound command polling, dispatch and ACK |
| `internal/reporter` | heartbeat, state, telemetry and capability reporting |
| `internal/manager` | tunnel/egress runtime ownership and hot updates |
| `internal/forwarder` | TCP/TLS/WebSocket/UDP data-plane implementations |
| `internal/restore` | desired-state restore and last-known-good cache |
| `internal/ownership` | epoch fence and ownership lease enforcement |
| `internal/targetdns` | target resolution with last-good fallback |
| `internal/targetobs` | target reachability / latency observations |
| `internal/diag` | bounded diagnostics and Looking Glass execution |
| `internal/selfinfo` | node diagnostic facts |
| `internal/api` | optional loopback admin API |

## Operational boundaries

- Keep the Agent's control traffic outbound-only; do not make Panel-to-Agent public
  management connectivity a deployment requirement.
- Do not add a second listener manager, desired-state store or protocol capability
  list. The running managers and capability manifest must describe the same truth.
- Do not bypass revision ACK, ownership fencing or durable restore paths for a
  "simpler" apply path.
- Keep secrets, node credentials and private key material out of logs and support
  bundles.
- New protocols remain fail-closed until their runtime, capability advertisement,
  control contract and regression Gate are delivered together.
