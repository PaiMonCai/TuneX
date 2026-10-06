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

> **先选路径**：本节是**本机试用 / 开发栈**（本地构建镜像、端口 8787/9091）。
> **长期运行或对外提供服务，请直接用[生产部署文档](docs/production-deploy.md)的 §2**
> （`docker-compose.prod.yaml` + `.env.production.example` + 预构建镜像、端口 13001-13003）。
> 本节不覆盖生产所需的 TLS 反代、备份与升级流程。

```bash
git clone https://github.com/PaiMonCai/TuneX.git
cd TuneX
cp .env.example .env
```

修改 `.env` 中的数据库密码、安全密钥和站点配置后启动：

```bash
docker compose up -d --build
```

启动时这三件事会**自动发生**（不需要手工执行命令）：

- **数据库迁移**：`db-migrate` 容器运行 `bunx prisma migrate deploy && bun prisma/seed.ts`，
  **退出码 0 才算成功**；它失败时 `up -d` 会直接报错，后端/前端不会起来；
- **管理员账号**：种子按 `.env` 的 `SEED_ADMIN_EMAIL` 创建；未设 `SEED_ADMIN_PASSWORD`
  时会随机生成并写到**项目根**的 `.admin-credentials`（`邮箱:口令`）。首次登录后请改密码并删除该文件；
- **Worker cron**：`worker` 容器会打印 `registered N cron schedulers`，用于离线检测/对账/结算等节律。

检查运行状态：

```bash
docker compose ps
curl http://localhost:8787/healthz
```

默认本地 Web 入口：

```text
http://localhost:9091
```

> ⚠️ **同机只能跑一套**：`docker-compose.yaml` 把容器名/卷名/网络名**写死**为
> `tunex-*` / `tunex-mysql-data` / 网络 `tunex`，因此 `-p <project>` **不能**隔离。
> 若本机已存在这些卷，`up` 会**复用**旧库（不是全新部署），而 `down -v` 会**删除**它们。
> 部署第二套前请先 `docker volume ls | grep tunex` 确认，并改成不同的名字
> （细节见[生产部署文档 §1.1](docs/production-deploy.md)）。

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
