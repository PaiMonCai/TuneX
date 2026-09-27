# TuneX

> 多租户 TCP 端口转发控制面，围绕 **Node + Forward** 管理 DIRECT / RELAY 数据面。

[![CI](https://github.com/PaiMonCai/TuneX/actions/workflows/ci.yml/badge.svg)](https://github.com/PaiMonCai/TuneX/actions/workflows/ci.yml)
[![Integration](https://github.com/PaiMonCai/TuneX/actions/workflows/integration.yml/badge.svg)](https://github.com/PaiMonCai/TuneX/actions/workflows/integration.yml)

> [!NOTE]
> **项目开发已于 2026-09-28 暂时暂停。**
> 当前代码保留为可继续开发的快照；V4 已完成 F1～F3，下一步原计划是
> **V4-WP10 Authorization + NodeGroup Model**。在 F4/F5 完成前，不把当前版本标记为 V4.5 Stable。

## 当前状态

TuneX 已具备：

- TCP DIRECT / RELAY 转发；
- Node enrollment、不可变 `agent_id`、INGRESS / EGRESS / BOTH；
- Forward 全字段编辑、revision、hot reload、desired/applied reconcile；
- Node lifecycle、health、telemetry、maintenance / disabled / retiring；
- 服务端分页、筛选、批量操作、Binding usage、Dashboard attention；
- outbound-only Agent 控制链；
- MySQL / Redis / Worker / Web / Go Agent；
- CI、真实多 Agent Integration Gate 与统一 Docker 镜像验证。

V4 当前 Gate：

```text
F1 Forward Edit / Hot Reload        ✅
F2 Managed Node Lifecycle           ✅
F3 Monitoring / Scale / UX          ✅
F4 Authorization / NodeGroup        ⏸️ paused
F5 Stable / Ops / Diagnostics       ⏸️ paused
```

高级协议、HA/failover、multi-hop、Panel federation 等已经移入 **V5 Roadmap**，不再扩大 V4 范围。

## 架构

```text
Browser
  │
  ▼
Web / Backend ── MySQL / Redis / Worker
       ▲
       │ outbound HTTP poll / ACK / state report
       │
     Agent
       │
       ├─ DIRECT ─────────────→ Target
       └─ RELAY → Egress Agent → Target
```

用户侧只需要理解 **Node** 和 **Forward**；`Tunnel` 继续作为内部 desired/runtime 对象。

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

默认本地入口为 `http://localhost:9091`。生产部署请优先参考
[docs/production-deploy.md](docs/production-deploy.md)，使用
`docker-compose.prod.yaml`；宿主机 Nginx/宝塔/1Panel 可直接负责 TLS，Caddy 为可选入口层。

## Agent

推荐在 Web 的「节点」页面创建 Node，然后直接使用 Panel 生成的一键 Docker 安装命令。
Agent 只需要主动连接 Panel，不要求公网开放 Agent 管理端口。

本地构建：

```bash
cd agent
go test ./...
go build ./...
```

## 开发文档

- [DEVELOPMENT.md](DEVELOPMENT.md)：V4/V5 路线、状态机、Gate、恢复开发入口。
- [docs/production-deploy.md](docs/production-deploy.md)：生产部署。
- [docs/tunex-devmap-v3.md](docs/tunex-devmap-v3.md)：历史架构约束与迁移背景。

开发恢复时，从 **V4-WP10 → Gate F4 → V4-WP11 → Gate F5 / V4.5 Stable** 继续。
