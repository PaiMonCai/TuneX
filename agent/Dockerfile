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

ENTRYPOINT ["/usr/local/bin/tunex-agent-entrypoint"]
