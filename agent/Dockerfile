# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM golang:1.22-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY agent/go.mod ./
COPY agent ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -buildvcs=false -ldflags="-s -w" -o /out/tunex-agent .

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
