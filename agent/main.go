// Command tunex-agent is the node-side agent for the TuneX control plane.
//
// Since WP15 there is exactly one runtime: the v3 data plane built from
// manager.TunnelManager / manager.EgressManager owns every listener and
// forwarder (DIRECT, RELAY and EGRESS alike), the local admin API serves the
// mutation surface, and reporter sends the state report to the panel. The
// Socket.IO / Fernet-config session that used to carry the old DIRECT engine
// was removed with it: a node now learns its tunnels from the panel's control
// contract (revisioned apply commands) instead of a pushed gost config.
//
// Wire facts the control transport relies on:
//
//   - the heartbeat / state report is an agent-initiated HTTPS POST, so a node
//     behind NAT only ever makes outbound connections (§7.9);
//   - the panel never dials the agent; the admin plane is bound to loopback
//     and the orchestrator reaches it over the node's connect_ip.
//
// Only the Go standard library is used, so the module builds fully offline.
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

// run starts the v3 runtime and blocks until the process is signalled. It
// returns a process exit code.
//
// Startup order is fixed:
//
//  1. v3 managers (TunnelManager + EgressManager; one shared port guard)
//  2. restore: pull the node's ACTIVE tunnels so ports are re-bound after a
//     restart (devmap §5.5).
//  3. admin API (:9090) — the mutation surface
//  4. heartbeat / state report (every 30s)
//
// Shutdown is the reverse: reporter, admin API, managers.
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

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	rt := startV3Runtime(ctx, cfg)
	if rt != nil {
		defer rt.Shutdown()
	}

	// Everything is asynchronous now (reporter loop, admin server, restore);
	// wait for the signal instead of returning as soon as startup is done.
	<-ctx.Done()
	// Give in-flight listeners a moment to drain.
	time.Sleep(50 * time.Millisecond)
	return 0
}
