# TuneX

> 多租户网络转发平台，通过线路（Route Profile）与转发（Forward）统一管理 TCP、TLS、WebSocket 与 UDP 数据面。

[![CI](https://github.com/PaiMonCai/TuneX/actions/workflows/ci.yml/badge.svg)](https://github.com/PaiMonCai/TuneX/actions/workflows/ci.yml)
[![Integration](https://github.com/PaiMonCai/TuneX/actions/workflows/integration.yml/badge.svg)](https://github.com/PaiMonCai/TuneX/actions/workflows/integration.yml)

## 项目介绍

TuneX 由 Panel 与 Agent 组成。Panel 提供 Web 管理、策略编排和状态管理；Agent 部署在网络节点上，主动连接 Panel 并执行实际的数据转发。

主要能力：

- TCP / TLS / WebSocket / UDP 转发；
- DIRECT / RELAY 与多跳路径；
- Node enrollment、NodeGroup、Route Profile 与 Forward；
- revision、hot reload、reconcile、HA、fencing、自动 failover / failback；
- 节点健康、遥测、诊断、Support Bundle 与 Agent 升级；
- Workspace RBAC、套餐、订阅、订单、支付与流量结算；
- DDNS、公告、Email / Webhook / Telegram 通知；
- Federation 身份、信任、授权、远端租约、用量与 remote egress。

普通用户主要通过 **线路（Route Profile）→ 转发（Forward）** 使用 TuneX；Node、NodeGroup、容量、健康和 Federation 等基础设施能力由管理员维护。

## 快速部署

需要 Docker 与 Docker Compose v2。

```bash
git clone https://github.com/PaiMonCai/TuneX.git
cd TuneX
cp .env.example .env
```

修改 `.env` 中的数据库密码、安全密钥和站点配置后启动：

```bash
docker compose up -d --build
```

检查运行状态：

```bash
docker compose ps
curl http://localhost:8787/healthz
```

默认本地 Web 入口：

```text
http://localhost:9091
```

生产环境请使用 [生产部署文档](docs/production-deploy.md) 和 `docker-compose.prod.yaml`。已有 Nginx、宝塔或 1Panel 时，可由宿主机现有反向代理负责 TLS；没有宿主机反代时可使用项目提供的 standalone Caddy 部署方式。

## 部署 Agent

推荐先在 TuneX 管理界面创建 Node，再使用 Panel 为该节点生成的一键安装命令部署 Agent。Agent 主动连接 Panel，正常部署不需要向公网开放 Agent 管理端口。

具体安装、配置、升级和故障处理以 [生产部署文档](docs/production-deploy.md) 为准。

## 更新与升级

升级前建议先备份数据库、配置和必要的持久化数据。

使用源码部署时：

```bash
git pull
docker compose up -d --build
```

生产环境升级应遵循 [生产部署文档](docs/production-deploy.md) 中的升级、数据库迁移、备份、恢复与回滚流程，不建议跳过迁移或直接替换持久化数据。

Agent 应通过 TuneX 提供的节点升级流程或当前生产部署文档规定的方式升级，避免手工替换二进制造成版本与配置不一致。

## 运行验证

部署或升级后至少确认：

```bash
docker compose ps
curl http://localhost:8787/healthz
```

随后在管理界面确认 Node 在线，并验证至少一条实际 Forward 可以正常建立和传输流量。

## 文档

- [生产部署、升级、备份与恢复](docs/production-deploy.md)
- [架构说明](docs/architecture.md)
- [开发者入口](DEVELOPMENT.md)
- [测试与验证](docs/testing.md)
- [发布流程](docs/release.md)
