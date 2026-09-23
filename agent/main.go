// Command tunex-agent is the node-side agent for the TuneX control plane.
//
// It connects to the control plane over Engine.IO v4 / Socket.IO (the `register`
// / `sysinfo` / `listen` events), receives a Fernet-encrypted gost config on the
// `config` event, and runs the described listeners/forwarders. It is a clean-room
// re-implementation of the original relayx-agent v0.13.22, built to interoperate
// with the relayx-clone server (see ../../ docker-compose.yaml).
//
// Wire facts this agent relies on (all verified against the original binary and
// the relayx-clone server code, see the repo reports):
//
//   - Engine.IO v4 open packet: 0{"sid":..,"pingInterval":..,"pingTimeout":..}
//   - Socket.IO CONNECT:       40{"token":"<node_group.token>"}
//   - Socket.IO CONNECT ack:   40{"sid":".."}   (44{..} = error / rejected)
//   - register (with ack):     42 0 ["register", {..}]  ->  43 0 [{..}]
//     ⚠️ the ACK frame is "430[..]" (4=engine MESSAGE, 3=ACK, 0=ack-id). "44" is
//     the Socket.IO ERROR packet, not an ack.
//   - sysinfo (no ack):        42["sysinfo", {..}] every 10s
//   - config (S->C):           42["config", "<fernet-token>"]  (bare string, NOT
//     an array — the original panics on an array payload)
//   - listen (C->S):           42["listen", {name,port,type}] (only when a service
//     addr used the WAIT_LISTEN placeholder)
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

	"github.com/relayx/agent/internal/agent"
	"github.com/relayx/agent/internal/agentconfig"
	"github.com/relayx/agent/internal/logx"
)

// version is stamped at build time with -ldflags "-X main.version=..".
// The default mirrors the original agent so servers that log/gate on the
// reported version see a familiar value.
var version = "0.13.22"

func main() {
	os.Exit(run(os.Args[1:]))
}

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

	// The agent reconnects internally forever; Run only returns on ctx cancel.
	if err := a.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, "Error:", err)
		return 1
	}
	// Give in-flight listeners a moment to drain.
	time.Sleep(50 * time.Millisecond)
	return 0
}
