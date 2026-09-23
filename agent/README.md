# TuneX agent (`agent/`)

Go node agent for the TuneX control plane. It is a from-scratch,
**standard-library-only** re-implementation of the original `relayx-agent`
v0.13.22: it speaks the same Engine.IO v4 / Socket.IO control protocol, decrypts
the same Fernet-encrypted gost config, and reports the same `register`/`sysinfo`
payloads, so it interoperates with the `relayx-clone` server unchanged.

## Build

```bash
cd agent
go build -o tunex-agent .          # no third-party modules; works offline
go test ./...                       # unit tests (fernet / relayx token / smux / config)
```

## Run

```bash
./tunex-agent -s https://tunex.example -t <NODE_GROUP_TOKEN> \
               -n node-01 -r 20000-30000 -d
```

All original flags are supported (`-s/-t` required; `-n -i -l -r -o -I -d
--pprof-port` and the nine per-protocol port flags; `-v` prints the version).
A flat `$HOME/.relayx-agent.yaml` (or `--config`) is read for defaults; explicit
flags override it. `RELAYX_SERVER` and `RELAYX_TOKEN` are honoured as env
overrides.

Two per-installation keys are required and have no built-in default:

```bash
export TUNEX_CONFIG_KEY="<your install config key>"    # opens the pushed config
export TUNEX_LICENSE_KEY="<your install license key>"  # verifies the register ACK
```

Both are 32-byte base64url Fernet keys generated per deployment by the TuneX
control plane. The legacy names `RELAYX_CONFIG_KEY` and `RELAYX_LICENSE_KEY`
are still accepted as a fallback while migrating an existing install. An agent
started without either key exits immediately instead of using a shared default.

## What it does

1. Connects to `<server>/socket.io/?EIO=4&transport=websocket`.
2. Sends `40{"token":"<token>"}`, waits for the `40{"sid":..}` connect ack.
3. Sends `register` with an ack (`420["register",{...}]`); the server replies
   `430[{license, site_url, type, now}]`. The license is Fernet-decrypted and its
   `expired_at` / `site_url` / `type` are validated client-side.
4. Sends `sysinfo` every 10 s.
5. On `config` (a **bare** Fernet string — not an array), decrypts it, parses the
   gost config, and starts/reloads the services: per-service TCP/UDP listeners,
   round-robin forwarders, `WAIT_LISTEN` dynamic-port allocation (reported back on
   the `listen` event), and a decoy nginx page for unmatched connections.

## Layout

| Path | Purpose |
|---|---|
| `main.go` | entry point / CLI wiring |
| `internal/agentconfig` | flag + minimal-YAML config parsing |
| `internal/socketio` | Engine.IO v4 / Socket.IO v3 client (over `internal/ws`) |
| `internal/ws` | minimal RFC 6455 client handshake + framing |
| `internal/fernet` | Fernet (AES-128-CBC + HMAC-SHA256) |
| `internal/license` | license/config key decode + license verification |
| `internal/netutil` | `/proc` metrics, public-IP detection, free-port/range |
| `internal/engine` | gost config model + listener/forwarder runtime |
| `internal/mux` | xtaci/smux v1 stream multiplexing |
| `internal/relayx` | relayx tunnel: HKDF auth, 56-byte token, WS handshake |

## Wire facts worth remembering

- register ACK frame is **`430[...]`** (4=MESSAGE, 3=ACK, id 0). `44` is the
  Socket.IO **ERROR** packet, not an ack.
- the `config` payload is a **bare JSON string**, never `[string]`.
- the Socket.IO CONNECT packet for the default namespace omits the `/` prefix.
- the license `expired_at` is an int64 Unix timestamp; `site_url` must equal the
  agent's `-s` value byte-for-byte.
- the relayx tunnel token is exactly **56 bytes** (`nonce[16] ‖ unixNano[8] BE ‖
  HMAC-SHA256(authKey, nonce‖ts)[32]`), `authKey = HKDF-SHA256(secret,
  info="relayx-auth-v1")`, accepted within a ±300 s window.

## Notes / limits

- Auto-upgrade (the `upgrade` event) is intentionally a logged no-op: the
  original verifies a minisign signature before replacing its own binary, which
  is a remote-code-execution surface. Wire it in deliberately if required.
- The `relayx` dialer/listener packages cover the WebSocket + Bearer-token +
  smux layer. `uTLS` / `REALITY` / `mieru` / WireGuard / QUIC carrier wrapping is
  not implemented (they require large third-party forks).
- `traffic_*` metrics use cumulative interface counters from `/proc/net/dev` as a
  proxy; `vnstat` is not consulted.
