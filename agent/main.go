// Command tunex-agent is the node-side data plane for TuneX.
//
// There is one production runtime: TunnelManager / EgressManager own the
// listeners and forwarding state, while the Agent initiates every production
// control-plane interaction with the Panel (command polling, ACK and the
// authenticated state report). The optional local admin API binds to loopback and is not
// required for Panel-to-Agent orchestration.
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
	"github.com/tunex/agent/internal/identityprobe"
	"github.com/tunex/agent/internal/logx"
)

// version is stamped at build time with -ldflags "-X main.version=..".
// The default is a fallback for local builds; release builds may stamp it with ldflags.
var version = "0.13.22"

func main() {
	os.Exit(run(os.Args[1:]))
}

// run starts the runtime and blocks until the process is signalled.
//
// Startup order is fixed:
//
//  1. managers (TunnelManager + EgressManager; one shared port guard)
//  2. restore: pull the node's ACTIVE tunnels so ports are re-bound after a
//     restart using the authoritative desired-state restore path.
//  3. admin API (:9090) — the mutation surface
//  4. authenticated state report (every 30s)
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

	// ── 身份探针（升级脚本在容器内调用）──────────────────────────────────────
	//
	// 只打印**一行**结论（词表见 internal/identityprobe），然后退出 0。它不启动
	// 运行时、不读控制面、不写任何状态：升级脚本要回答的只是"这个容器里的凭据还能
	// 让 Panel 认出这台节点吗"。
	//
	// 为什么不做成子命令：老镜像的二进制会把位置参数当"多余参数"照常启动运行时
	// （在已经跑着 Agent 的容器里再起一个进程是危险的），而未知**标志**会被 flag 包
	// 安全拒绝 ⇒ 脚本据此回落到老的 curl/wget 路径。
	if cfg.IdentityProbe {
		fmt.Println(identityprobe.Run(identityprobe.Options{
			BaseURL: cfg.ProbeURL,
			Timeout: time.Duration(cfg.ProbeTimeoutS) * time.Second,
			EnvFile: cfg.ProbeEnvFile,
		}))
		return 0
	}

	logx.SetDebug(cfg.Debug)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	rt := startRuntime(ctx, cfg)
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
