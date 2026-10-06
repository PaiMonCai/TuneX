# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM golang:1.22-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
# ── Agent 版本：构建时注入（task-37）─────────────────────────────────────────
# 面板判定"节点 Agent 是否落后"比的是 **Agent 上报的 version**（`agent/main.go` 的
# `version` 变量 → 状态上报体 → `node_state_report.version`）与部署方配置的
# `TUNEX_AGENT_LATEST_VERSION`（`backend/src/services/node-health.ts:isVersionOlder`）。
# 本 Dockerfile 以前**没有**注入它 ⇒ 所有镜像都上报源码常量 `0.13.22`（实测），
# 于是"落后判定"在真实部署里永远不会触发 —— 又一条"能力有、永不触发"。
#
# 口径：必须与上报值同口径（首段是数字，如 `0.14.0`）。用 git tag 时把前导 `v` 去掉
# （见下面 `${AGENT_VERSION#v}`），这样 `--agent-version v0.14.0` 与上报值可直接比较。
# 默认 `unknown` = **没有版本信息**，不是某个具体版本：面板对 `unknown` 只给「无法判定」，
# 所以"没 stamp"既不会被读成"最新"，也不会被读成"落后"。发布构建请显式传：
#   docker build -f agent/Dockerfile --build-arg AGENT_VERSION=v0.14.0 -t ghcr.io/paimoncai/tunex-agent:v0.14.0 .
ARG AGENT_VERSION=unknown
WORKDIR /src
COPY agent/go.mod ./
COPY agent ./
RUN set -eu; \
    case "$AGENT_VERSION" in "") echo "AGENT_VERSION 不能为空：省略时请用默认值 unknown，发布时传真实版本号" >&2; exit 1 ;; esac; \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -buildvcs=false -ldflags="-s -w -X main.version=${AGENT_VERSION#v}" -o /out/tunex-agent .

FROM alpine:3.22
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/tunex-agent /usr/local/bin/tunex-agent
COPY --chmod=0755 agent/docker-entrypoint.sh /usr/local/bin/tunex-agent-entrypoint

# 身份校验**不需要**额外安装任何 HTTP 工具：agent 二进制自带探针
# （`tunex-agent --identity-probe`，见 internal/identityprobe）。
#
# 为什么不再装 curl/jq（2026-10-07，task-29 收口）：
#   · 校验要在容器内用节点长期凭据访问 `<panel>/api/internal/node/snapshot`；
#   · busybox wget（本镜像里原本唯一能发 HTTP 的东西）**无法禁止跟随重定向**，且会
#     把 `--header` 一起重发到跳转目标 ⇒ 一次 3xx 就能把节点凭据交给别的 host；
#   · 用 curl + jq 兜住这两点要 **+6.1MB**（15,003,286 → 21,114,130 bytes），而且
#     "curl/wget/无 jq"三条路径的结论必须保持一致 —— 那本身就是缺陷源；
#   · Go stdlib 两行就够：`CheckRedirect` 返回 `http.ErrUseLastResponse`（永不跟随）
#     + `encoding/json`（真解析，不是形状猜测）。二进制本来就在镜像里 ⇒ **零增长**。
#
# 老镜像（二进制不认识该标志）仍由渲染脚本里的 curl/wget 兜底路径服务，且文案会
# 如实标注"这是兜底路径"。

ENTRYPOINT ["/usr/local/bin/tunex-agent-entrypoint"]
