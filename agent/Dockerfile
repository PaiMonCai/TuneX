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

# curl 是**升级脚本身份校验**的硬依赖，不是便利工具。
#
# 为什么必须装：校验要在容器内用节点自己的长期凭据访问
# `<panel>/api/internal/node/snapshot`。busybox 自带的 wget（本镜像里唯一能发 HTTP 的
# 工具）**无法禁止跟随重定向**（v1.37 的 `--help` 里只有 -cqS/--spider/-O/-o/--header/
# -U/-T，没有 --max-redirect），而 `--header` 会随跳转重发 —— 于是"Panel（或中间反代）
# 回一个 3xx 指向另一台主机"就足以把 `Authorization: Bearer <节点长期凭据>` 交给那台
# 主机。curl 不加 `-L` 时根本不跟随重定向，凭据只会发给我们真正想校验的那个地址。
#
# 兜底仍然保留 wget（老节点镜像 / 自定义镜像可能没有 curl），但那条路径下结论只会是
# "未校验"：它取**第一个**状态行并且要求响应体是 Panel 的 JSON，所以既不会被跳转后的
# 200 骗过，也不会假装通过。
#
# jq 是**同一段落的后半句**：`curl` 解决了"凭据只发给谁"，jq 解决"响应体到底是 JSON 还是
# 长得像 JSON 的字符串"。没有 jq 时探针只能做形状匹配（对象起始 + `"data":` 键 + 对象
# 收尾），那种判定会把 `{"data": oops`（"data" 键存在但不是合法 JSON）也算成 Panel 的
# 响应 —— 于是"200 + 像 Panel JSON"里的"像"字不够硬。装了 jq 就是**真解析**：不是合法
# JSON、或顶层不是对象、或 `data` 不是对象，一律"未校验"。老镜像没有 jq 时会退回形状
# 匹配，并且**把这件事告诉操作者**（不会假装做过解析）。
RUN apk add --no-cache curl jq

ENTRYPOINT ["/usr/local/bin/tunex-agent-entrypoint"]
