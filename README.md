# TuneX

> 多租户 TCP 端口转发控制面，围绕 **Node + Forward** 管理 DIRECT / RELAY 数据面。

[![CI](https://github.com/PaiMonCai/TuneX/actions/workflows/ci.yml/badge.svg)](https://github.com/PaiMonCai/TuneX/actions/workflows/ci.yml)
[![Integration](https://github.com/PaiMonCai/TuneX/actions/workflows/integration.yml/badge.svg)](https://github.com/PaiMonCai/TuneX/actions/workflows/integration.yml)

> [!NOTE]
> **2026-10-02：Gate V4-F4 与 V4-F5 已在真实四 Agent 拓扑上通过。**
>
> ```text
> v3 verify 51/0 · F1 rollout 30/0 · F1 REST 67/0 · F1 S10 58/0 · F1 topology 32/0
> F2 37/0 · F3 21/0 · F4 58/0 · F5 133/0
> ```
>
> 本轮补齐：WP11B 升级闭环（真实拓扑验证：排空期间拒新连接、重建后 agent_id 不变、
> 既有 Forward 再收敛、回退锚点可用）与 WP11A 关机顺序/缓存并发收口。
>
> 补齐范围：WP10 权限模型（F4）、WP11A 耐久性/关机、WP11B 能力协商与升级闭环、
> WP11C Forward/Node 诊断与 Support Bundle、WP11D 运维脚本与发布文档，以及前端入口
> （诊断面板 / 支持包下载 / 升级命令生成）。逐条状态与已知边界见
> [V4 发布说明](<docs/release-notes-v4.md>) 与 [DEVELOPMENT](<DEVELOPMENT.md>)。
>
> **V4.5 Stable 已放行**：发布窗口已完成（发布提交 `14305c8`、《[V4.5 发布记录](<docs/release-record-v4.5.md>)》），
> 演练覆盖面板升级、回滚双向、以及发布镜像在安装布局下的 Agent 升级（换镜像不换身份）。
> 唯一待办是 `docker push` 这两个 tag（需要 registry 凭证）。

## 当前状态

TuneX 已具备：

- TCP DIRECT / RELAY 转发；
- Node enrollment、不可变 `agent_id`、INGRESS / EGRESS / BOTH；
- Forward 全字段编辑、revision、hot reload、desired/applied reconcile；
- Node lifecycle、health、telemetry、maintenance / disabled / retiring；
- 服务端分页、筛选、批量操作、Binding usage、Dashboard attention；
- outbound-only Agent 控制链；
- 工作空间 RBAC：固定四角色 + 自定义角色，资源级判定与逐项批量鉴权；
- Agent 耐久性：面板中断时从本地已知良好配置恢复，面板恢复后按权威期望状态对账；
- 有界优雅关机（关闭监听 → 排空 → 强制收敛 → 最终上报）；
- 控制协议协商：Agent 上报协议版本与真实实现的能力清单，面板在下发前拒绝节点未实现的动作；
- MySQL / Redis / Worker / Web / Go Agent；
- CI、真实多 Agent Integration Gate 与统一 Docker 镜像验证。

V4 当前 Gate：

```text
F1 Forward Edit / Hot Reload        ✅ 已关闭
F2 Managed Node Lifecycle           ✅ 已关闭
F3 Monitoring / Scale / UX          ✅ 已关闭
F4 Authorization / NodeGroup        ✅ 已关闭（真实拓扑 PASS=58 / FAIL=0）
F5 Durability / Ops / Capability    ✅ 已关闭（真实拓扑 PASS=68 / FAIL=0）
   └ 未含 WP11B 升级闭环与 WP11C 诊断/Bundle（见下）
```

Gate 命令（需要 Docker 与真实多 Agent 拓扑）：

```bash
bash scripts/v3-e2e/setup.sh
python3 scripts/v3-e2e/v4-gate-f4.py
python3 scripts/v3-e2e/v4-gate-f5.py
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

**当前进度：V4-WP10（Gate F4）与 V4-WP11（Gate F5）均已实现并关闭** —— Gate F4 = 58/0、
Gate F5 = 133/0（真实四节点拓扑，含升级闭环、Forward/Node 诊断、Support Bundle、
优雅关机、能力协商、运维脚本与真实备份/恢复演练）。逐项状态与已知边界见
[V4 发布说明](<docs/release-notes-v4.md>)。
