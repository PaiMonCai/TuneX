# TuneX

> 多租户网络转发平台，通过线路（Route Profile）与转发（Forward）统一管理 TCP、TLS、WebSocket 与 UDP 数据面。

[![CI](https://github.com/PaiMonCai/TuneX/actions/workflows/ci.yml/badge.svg)](https://github.com/PaiMonCai/TuneX/actions/workflows/ci.yml)

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

文档入口：[当前文档](docs/README.md) · [转发核心开发方案](docs/DEVELOPMENT_PLAN.md) · [生产部署](docs/production-deploy.md)。共享 FXP 及各路径的支持范围见 [转发运行边界](docs/forwarding-runtime.md)，候选分支能力不等于已正式发布。

### 核心开发状态（2026-10-10）

- 已合并：PR #75 / `main` 基线 `ef159eb`，包含共享 FXP 统计分段、多目标、共享 TCP PROXY/IP_HASH 首切片，以及 Linux plain DIRECT/自有单跳 RELAY 的原生 TCP+UDP both。
- 已合并：PR #76 / `main` 基线 `54542d3`，F5 只读维护预览与文档整理；main CI required 通过。
- 待合并：[PR #77](https://github.com/PaiMonCai/TuneX/pull/77) / `feat/link-maintenance-state`，持久维护计划、幂等提交/CAS、取消与过期/漂移回收已通过自身 CI；不执行在线端点变更/密钥轮换。
- FXP 与原生 both 的开关仍默认关闭；本轮没有生产发布。真实 Panel 浏览器、长期运行等发布条件见 [验收说明](docs/testing.md)，不能由 CI 绿色替代。
- 优先完善转发核心；支付后置、Windows 适配暂停。保留既有 Agent 恢复缓存，没有明显性能收益时不新增缓存优化。

上方能力列表是模块概览，不是所有协议/拓扑/驱动组合的可用承诺；当前维护状态以 [文档入口](docs/README.md) 和运行支持范围为准。

## 快速部署

需要 Docker 与 Docker Compose v2。

> **先选路径**：本节是**本机试用 / 开发栈**（本地构建镜像、端口 8787/9091）。
> **长期运行或对外提供服务，请使用生产栈**：`docker-compose.prod.yaml` + `.env.production.example` + 预构建镜像（端口 13001-13003）。
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

> ⚠️ **这个开发栈不要与已有部署共机**：`docker-compose.yaml` 把卷名/网络名**写死**为
> `tunex-mysql-data` / `tunex-redis-data` / 网络 `tunex`（不带 project 前缀），所以
> `-p <project>` **不能**隔离数据：`up` 会**复用**本机已有的旧库（不是全新部署），
> `down -v` 会**删除**它们。部署第二套前先 `docker volume ls | grep tunex` 确认并改名。
> 生产路径（`docker-compose.prod.yaml`）的卷是隔离的（`*-prod` 后缀）；两套栈都硬编码了
> `container_name:` ⇒ 容器名没有项目前缀，多套共存时请按
> `docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' <容器>` 确认归属
> 多套部署共存时请先确认容器、网络和卷的归属，避免复用或误删现有数据。

生产环境请使用 `docker-compose.prod.yaml` 和 `.env.production.example`。已有 Nginx、宝塔或 1Panel 时，可由宿主机现有反向代理负责 TLS；没有宿主机反代时可使用项目提供的 standalone Caddy 部署方式。

## 部署 Agent

推荐先在 TuneX 管理界面创建 Node，再使用 Panel 为该节点生成的一键安装命令部署 Agent。Agent 主动连接 Panel，正常部署不需要向公网开放 Agent 管理端口。

具体安装建议以 Panel 为 Node 生成的一键命令为准；升级 Agent 时使用 TuneX 节点升级流程，避免手工替换导致身份、版本或配置不一致。

## 更新与升级

升级前建议先备份数据库、配置和必要的持久化数据。

使用源码部署时：

```bash
git pull
docker compose up -d --build
```

生产环境升级前应备份数据库、配置和持久化数据，并使用标准迁移流程完成升级；不建议跳过迁移或直接替换持久化数据。

Agent 应通过 TuneX 提供的节点升级流程或当前生产部署文档规定的方式升级，避免手工替换二进制造成版本与配置不一致。

## 运行验证

部署或升级后至少确认：

```bash
docker compose ps
curl http://localhost:8787/healthz
```

随后在管理界面确认 Node 在线，并验证至少一条实际 Forward 可以正常建立和传输流量。

