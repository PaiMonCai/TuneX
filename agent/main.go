// Command tunex-agent is the node-side agent for the TuneX control plane.
//
// It connects to the control plane over Engine.IO v4 / Socket.IO (the `register`
// / `sysinfo` / `listen` events), receives a Fernet-encrypted gost config on the
// `config` event, and runs the described listeners/forwarders. It is a clean-room
// re-implementation of the original tunex-agent v0.13.22, built to interoperate
// with the tunex-clone server (see ../../ docker-compose.yaml).
//
// Wire facts this agent relies on (all verified against the original binary and
// the tunex-clone server code, see the repo reports):
//
//   - Engine.IO v4 open packet: 0{"sid":..,"pingInterval":..,"pingTimeout":..}
//   - Socket.IO CONNECT:       40{"token":"<node_group.token>"}
//   - Socket.IO CONNECT ack:   40{"sid":".."}   (44{..} = error / rejected)
//   - register (with ack):     42 0 ["register", {..}]  ->  43 0 [{..}]
//     ⚠️ the ACK frame is "430[..]" (4=engine MESSAGE, 3=ACK, 0=ack-id). "44" is
//     the Socket.IO ERROR packet, not an ack.
//   - sysinfo (no ack):        42["sysinfo", {..}] every 10s
//   - config (S->C):           42["config", "<fernet-token>"] (bare string, NOT
//     an array — the original panics on an array payload)
//   - listen (C->S):           42["listen", {name,port,type}] (only when a service
//     addr used the WAIT_LISTEN placeholder)
//
// Only the Go standard library is used, so the module builds fully offline.
//
// v3 runtime (WP4) sits alongside the legacy session: manager.TunnelManager /
// manager.EgressManager own v3 tunnels, api serves the local admin plane and
// reporter sends the heartbeat. The legacy engine in internal/engine is NOT
// touched — a DIRECT node keeps behaving exactly as before.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/tunex/agent/internal/agent"
	"github.com/tunex/agent/internal/agentconfig"
	"github.com/tunex/agent/internal/logx"
)

// version is stamped at build time with -ldflags "-X main.version=..".
// The default mirrors the original agent so servers that log/gate on the
// reported version see a familiar value.
var version = "0.13.22"

func main() {
	os.Exit(run(os.Args[1:]))
}

// run starts the v3 runtime and the legacy control-plane session, then blocks
// until the process is signalled. It returns a process exit code.
//
// Startup order is fixed:
//
//  1. v3 managers (TunnelManager + EgressManager; one shared port guard)
//  2. restore: pull the node's ACTIVE tunnels so ports are re-bound after a
//     restart (devmap §5.5). Before the WP1 contract lands this is a no-op
//     source, so the order is exercisable today.
//  3. admin API (:9090) — the mutation surface (WP4 scope; the final panel
//     orchestration is WP6 and is deliberately not wired here)
//  4. heartbeat reporter (every 30s, optional)
//  5. the legacy Socket.IO agent loop (unchanged legacy DIRECT behaviour)
//
// Shutdown is the reverse: reporter, admin API, managers, legacy engine.
func run(args []string) int {
	cfg, err := agentconfig.Parse(args, version)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fmt.Fprintln(os.Stderr, "Error:", err)
		return 2
	}

	if cfg.ShowVersion {
		fmt.Printf("TuneX agent version %s\n", version)
		return 0
	}

	logx.SetDebug(cfg.Debug)

	agent.SetVersion(version)

	a, err := agent.New(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	rt := startV3Runtime(ctx, cfg)
	if rt != nil {
		defer rt.Shutdown()
	}

	// The agent reconnects internally forever; Run only returns on ctx cancel.
	if err := a.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, "Error:", err)
		return 1
	}
	// Give in-flight listeners a moment to drain.
	time.Sleep(50 * time.Millisecond)
	return 0
}
