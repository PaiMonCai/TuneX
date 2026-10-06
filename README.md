# TuneX

> 多租户网络转发平台：通过线路（Route Profile）与转发（Forward）组织 TCP / TLS / WebSocket / UDP 数据面。

[![CI](https://github.com/PaiMonCai/TuneX/actions/workflows/ci.yml/badge.svg)](https://github.com/PaiMonCai/TuneX/actions/workflows/ci.yml)
[![Integration](https://github.com/PaiMonCai/TuneX/actions/workflows/integration.yml/badge.svg)](https://github.com/PaiMonCai/TuneX/actions/workflows/integration.yml)

## 当前状态

TuneX 已进入 **V1 产品化 / Production Beta 准备阶段**。V5 主线与 WP17–WP21 已合入 `main`；
基线提交 `8d0ac83` 已通过 Source CI、完整 Integration、Unified Image 与 Release。

当前主要能力：

- TCP / TLS / WebSocket / UDP；TCP/TLS/WS 支持 DIRECT / RELAY，UDP 支持 DIRECT / 单跳 RELAY；
- 2-hop / 3-hop 路径、HA、fencing、自动 failover / failback；
- Node enrollment、NodeGroup、Route Profile、Forward revision / hot reload / reconcile；
- Node lifecycle、health、telemetry、诊断、Support Bundle 与 Agent 升级命令；
- Workspace RBAC、自定义角色、套餐/订单/支付、订阅周期与流量结算；
- DDNS、公告、Email / Webhook / Telegram 通知渠道；
- 延迟历史、链路拓扑、默认关闭的 Looking Glass；
- Federation 的身份、信任、授权、远端租约、用量与产品级 remote egress；
- 一键安装、备份/恢复/回滚、真实多 Agent Integration 与发布流水线。

当前明确保持关闭的边界：QUIC、UDP 分片重组 / packets 计费 / hop AEAD/MAC / 跨面板 UDP、
remote transit、跨面板 3+ hop / arbitrary graph、跨面板自动 failover、TLS remote egress 与多 Panel
信任传递闭包。未开放能力均保持 fail-closed。

## 产品模型

普通用户主要面对：

```text
线路（Route Profile）
        ↓
转发（Forward）
        ↓
流量 / 套餐 / 支持
```

管理员负责 Node、NodeGroup、Route Profile、容量/健康、诊断与 Federation 等基础设施能力。
`Tunnel` 保留为兼容与内部 desired/runtime 对象，不再作为新的用户产品入口。

## 架构

```text
Browser
   │
   ▼
Web / Backend ───── MySQL / Redis / Worker
   │
   ├─ Route Profile / Forward / Policy
   │
   └─ desired → revision → ACK → applied → reconcile
                              │
                              ▼
                            Agent
                              │
             ┌────────────────┼────────────────┐
             ▼                ▼                ▼
          DIRECT           RELAY          Multi-hop
             │                │                │
             └────────────────┴────────────────┘
                              ▼
                            Target
```

Agent 只主动连接 Panel，不要求公网开放 Agent 管理端口。

## 快速开始

需要 Docker 与 Docker Compose v2。

```bash
git clone https://github.com/PaiMonCai/TuneX.git
cd TuneX
cp .env.example .env
# 修改 .env 中的数据库密码与安全密钥
docker compose up -d --build
```

检查服务：

```bash
docker compose ps
curl http://localhost:8787/healthz
```

默认本地入口为 `http://localhost:9091`。

生产部署请使用 [docs/production-deploy.md](docs/production-deploy.md) 与
`docker-compose.prod.yaml`。已有 Nginx / 宝塔 / 1Panel 时可直接负责 TLS；
无宿主机反代时可使用 standalone Caddy overlay。

## Agent

推荐在管理界面创建 Node，再使用 Panel 生成的一键安装命令部署 Agent。

本地验证：

```bash
cd agent
go test ./...
go build ./...
```

## 验证

当前冻结基线的主要 Gate：

```text
G0   contract compatibility     137/0
G1A  TLS / WebSocket             73/0
G1B  UDP DIRECT / RELAY          77/0
G2   target intelligence         23/0
G3   resilience / HA             50/0
G4   multi-hop                   25/0
G5   federation                 206/0
G6   DDNS / placement            72/0
G7   subscription billing        33/0
```

PR 走 Source CI + Fast Integration；`main` 在 Source CI 后只构建一次 Unified/Agent 候选镜像，完整 Integration 直接按候选 digest 验证，Release 只提升同一 digest，不重新构建。
历史 Gate、冻结不变量与证据索引见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 文档

- [DEVELOPMENT.md](DEVELOPMENT.md)：冻结架构、Gate、不变量与 V1 产品化下一步；
- [docs/production-deploy.md](docs/production-deploy.md)：生产部署、升级、备份、恢复与回滚；
- [docs/release-notes-v4.md](docs/release-notes-v4.md)：V4 冻结兼容基线；
- [docs/release-record-v4.5.md](docs/release-record-v4.5.md)：V4.5 历史发布记录；
- [docs/tunex-devmap-v3.md](docs/tunex-devmap-v3.md)：历史架构与迁移背景。
