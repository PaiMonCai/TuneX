# TuneX

> 面向个人与团队的多租户端口转发控制面：管理 Workspace、节点、入口/出口绑定、端口转发与 Agent。

[![CI](https://github.com/PaiMonCai/TuneX/actions/workflows/ci.yml/badge.svg)](https://github.com/PaiMonCai/TuneX/actions/workflows/ci.yml)
[![Integration](https://github.com/PaiMonCai/TuneX/actions/workflows/integration.yml/badge.svg)](https://github.com/PaiMonCai/TuneX/actions/workflows/integration.yml)

TuneX 由 **Web 控制台、Backend 控制面、Worker、Go Agent** 组成。用户先在控制台创建 Node，复制一键安装命令到 Linux 节点执行，然后直接在入口节点上创建 PortForward；不选出口就是 DIRECT，选择已绑定出口就是 RELAY。内部 `Tunnel` 只作为 revision/ACK/NodePortLease/Reconciler 的运行时对象，不再要求用户手工创建。支付/套餐能力保留为可选扩展，默认关闭，不参与核心权限判定。

> [!IMPORTANT]
> TuneX 仍处于积极开发阶段。当前仓库已经具备可重复 CI、真实 MySQL 升级验证、Workspace/RBAC、节点级凭据、TCP DIRECT/RELAY v3 数据面与真实 Docker 集成 Gate。**根目录的 Docker Compose 更适合作为开发/自托管基线；公网生产部署默认使用 `docker-compose.prod.yaml`，由宿主机 Nginx/宝塔/1Panel 终止 TLS，再反代到 TuneX 的单一 loopback 入口。没有宿主机反代时可叠加 `docker-compose.standalone.yaml` 让 Caddy 直接接管 80/443。**

## 当前能力

| 领域 | 当前状态 |
| --- | --- |
| 账号 | 注册/登录、邮箱验证、密码重置、Cookie JWT / Bearer API Key |
| Workspace | 个人空间、团队空间、成员邀请、owner/admin/member/viewer 固定角色 |
| 权限 | Workspace RBAC、CapabilityPolicy、默认免费策略、节点组授权 |
| 安全 | CSRF、请求限流、审计、API/订阅密钥哈希存储与一次性轮换 |
| 节点/转发 | Node 一键 enrollment、INGRESS/EGRESS/BOTH、Ingress↔Egress Binding、Node-first PortForward、TCP DIRECT/RELAY、NodePortLease、revision/ACK、重启恢复与 Reconciler |
| Web | Next.js 管理控制台、Workspace 切换与成员管理、设置页 |
| CI | Backend/Web/Agent、秘密扫描、空库/升级迁移、真实 DIRECT/RELAY E2E、统一 GHCR 镜像构建 |
| 运维 | Compose、Caddy、备份/恢复/告警/容量脚本基础框架 |

后续开发方向、依赖 Gate、迁移规则与 DoD 统一以 [DEVELOPMENT.md](DEVELOPMENT.md) 为准；[docs/tunex-devmap-v3.md](docs/tunex-devmap-v3.md) 只作为长期目标架构约束。

### 用户侧模型

`agent_id` 是物理 Agent 的稳定身份，和角色分离。同一台 Agent 选择 `BOTH` 后就是同一条 Node 同时具备入口/出口能力，不会注册成两个节点。

```text
Ingress Node
├─ PortForward（不选择出口）──────────────→ Target       # DIRECT
└─ PortForward（选择已绑定 Egress）──────→ Egress → Target # RELAY

Egress Node
└─ 先与 Ingress 建立 Binding，之后才会出现在该入口的出口选项中
```

典型使用流程：

1. 在「节点与转发」创建 Node，Panel 同时生成不可变的唯一 `agent_id`；再选择 `INGRESS`、`EGRESS` 或 `BOTH` 能力。
2. Panel 返回一条可复制的一键安装命令；命令携带 10 分钟一次性 enrollment token、agent_id 和当前节点显示名，不包含长期 credential。
3. 在节点机器执行命令后，脚本自动准备 Docker、拉取 Agent 镜像、换取长期 per-node credential，并以 host network 容器启动 Agent。
4. 选择一个入口 Node；需要 RELAY 时先绑定出口 Node。
5. 在入口 Node 上直接「添加端口转发」：不选出口 = DIRECT，选择已绑定出口 = RELAY。

## 架构

```text
                       ┌──────────────────────────┐
                       │        Browser           │
                       └────────────┬─────────────┘
                                    │ HTTPS
                       ┌────────────▼─────────────┐
                       │ Host Nginx/宝塔/1Panel   │
                       │ TLS + public 80/443      │
                       └────────────┬─────────────┘
                                    │ 127.0.0.1:13000
                             ┌──────▼──────┐
                             │ Docker Caddy│
                             └───┬─────┬───┘
                      /api/*     │     │ other routes
                                 │     │
                        ┌────────▼┐   ┌▼──────────┐
                        │ Backend │   │ Next.js Web│
                        │ Hono/Bun│   │ React 19   │
                        └──┬───┬──┘   └───────────┘
                           │   │
                   ┌───────┘   └────────┐
                   │                    │
              ┌────▼────┐          ┌────▼────┐
              │ MySQL 8 │          │ Redis 7 │
              └─────────┘          └────┬────┘
                                        │
                                   ┌────▼────┐
                                   │ Worker  │
                                   └─────────┘

        Agent ── outbound HTTP poll / ACK ─────────► Backend
          │        per-node credential
          │
          └── applies revisioned DIRECT/RELAY runtime and serves data path
```

### 技术栈

- **Web**：Next.js 16、React 19、TypeScript、Tailwind CSS
- **Backend**：Bun、Hono、Prisma 6、MySQL 8.4、Redis 7.4
- **Agent**：Go 1.22，仅使用 Go 标准库
- **入口**：Docker 内 Caddy 统一应用路由；生产默认由宿主机 Nginx/宝塔/1Panel 终止 TLS
- **CI/CD**：GitHub Actions + GHCR

## 快速开始

### 1. 前置条件

推荐使用：

- Docker
- Docker Compose v2
- Git

本地单独开发组件时还需要 Bun/Node.js 或 Go，具体见后文。

### 2. 克隆并创建配置

```bash
git clone https://github.com/PaiMonCai/TuneX.git
cd TuneX
cp .env.example .env
```

编辑 `.env`，至少替换以下值：

- `MYSQL_ROOT_PASSWORD`
- `DATABASE_URL` 中对应的 MySQL 密码
- `AUTH_SECRET`
- `LICENSE_SECRET`
- `TUNEX_CONFIG_KEY`
- `TUNEX_LICENSE_KEY`
- `SITE_URL`
- `SEED_ADMIN_EMAIL`

两个 Fernet key 必须分别是独立的 32-byte base64url key。若本机有 Node.js，可以这样生成：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`AUTH_SECRET` / `LICENSE_SECRET` 也应使用独立的高强度随机值。例如：

```bash
openssl rand -hex 32
openssl rand -hex 32
```

> 不要把实际的 `.env`、`.admin-credentials` 或任何私钥提交到 Git。

### 3. 启动

```bash
docker compose up -d --build
```

首次启动时：

1. MySQL / Redis 启动并通过健康检查；
2. `db-migrate` 执行 Prisma migration 和 seed；
3. Backend / Worker / Web 启动；
4. Caddy 提供统一 Web 入口。

查看状态：

```bash
docker compose ps
```

查看日志：

```bash
docker compose logs -f backend
docker compose logs -f web
```

### 4. 访问

默认端口：

| 地址/端口 | 用途 |
| --- | --- |
| `http://localhost:9091` | Caddy / Web 主入口 |
| `https://localhost:9445` | Caddy HTTPS 端口映射；本地证书/域名需自行配置 |
| `http://localhost:8787` | Backend HTTP API |
| `http://localhost:8788` | Backend Socket.IO / Agent 接入 |
| `localhost:3307` | MySQL 调试端口 |
| `localhost:6380` | Redis 调试端口 |

端口均可通过 Compose 对应的环境变量覆盖。

健康检查：

```bash
curl http://localhost:8787/healthz
curl http://localhost:8787/readyz
```

`/readyz` 会同时检查 MySQL 与 Redis。

### 5. 首次管理员

Seed 会创建首个管理员。推荐在 `.env` 中显式设置：

```dotenv
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=replace-with-a-strong-password
```

若没有设置 `SEED_ADMIN_PASSWORD`，seed 会生成随机强密码，并将首次凭据写到仓库根目录的：

```text
.admin-credentials
```

该文件已被 `.gitignore` 排除。首次登录后应立即妥善保管或轮换凭据。

## Agent

Agent 位于 [agent/](agent/)，Go 1.22，运行时无需第三方 Go 模块。

### 编译

```bash
cd agent
go build -o tunex-agent .
```

### 一键安装（推荐）

在「节点与转发」创建 Node 后，Panel 会显示类似下面的一条命令：

```bash
curl -fsSL 'https://panel.example.com/api/internal/node/install.sh' | \
  sudo sh -s -- \
  --panel 'https://panel.example.com' \
  --enroll-token '<10-minute-one-time-token>' \
  --role 'INGRESS' \
  --ingress-range '10000-30000'
```

安装脚本采用 **Docker-first** 部署：

1. 节点没有 Docker Engine 时自动安装并启动 Docker；
2. 先拉取 Panel 配置的 `TUNEX_AGENT_IMAGE`，镜像拉取失败不会消费一次性 token；
3. 原子消费 enrollment token，换取真正的 per-node credential；
4. credential 只写入宿主机 root-only `/etc/tunex-agent/agent.env`；
5. 启动 `tunex-agent` 容器，使用 `--network host` 让动态 DIRECT/RELAY 监听端口直接绑定宿主机网络；
6. 容器只读挂载 credential 文件，不通过 `docker run -e` 注入长期凭据，避免 `docker inspect` 直接暴露 credential。

容器默认 `--restart unless-stopped`，并仅保留 `NET_BIND_SERVICE` capability。
enrollment token 只能使用一次，重新生成安装命令会撤销该节点尚未使用的旧 token。

生产控制链仍然只有 **Agent → Panel 出站 HTTPS**；不要求 Panel 反向访问
Agent 的公网管理端口。

### 手工运行（调试）

如果已经有节点的 per-node credential，也可以直接运行：

```bash
./tunex-agent \
  --panel-http-url https://panel.example.com \
  --node-credential '<node-credential>' \
  --node-id edge-hkg-01 \
  --role BOTH \
  --ingress-range 10000-30000 \
  --egress-range 30001-60000 \
  --agent-admin-port 0
```

常用参数：

- `--panel-http-url`：Panel HTTP 基地址；用于命令轮询、ACK、状态上报与 desired-state 恢复
- `--node-credential`：节点独立凭据；服务端由凭据确定 Node 身份，不接受客户端伪造 node_id
- `-n, --node-id`：节点标识；默认主机名
- `--role`：`INGRESS` / `EGRESS` / `BOTH`
- `-l, --listen-ip`：隧道未显式指定地址时的绑定接口
- `--ingress-range` / `--egress-range`：节点允许使用的端口范围
- `--agent-admin-port`：本机调试管理 API；生产控制面不依赖该端口入站
- `-d, --debug`：调试日志
- `-c, --config`：配置文件；默认 `~/.tunex-agent.yaml`

对应环境变量使用 `TUNEX_PANEL_HTTP_URL`、`TUNEX_NODE_CREDENTIAL`、`TUNEX_ROLE`、`TUNEX_INGRESS_RANGE`、`TUNEX_EGRESS_RANGE` 等。

> Agent 目前面向 Linux。CI 会构建 `linux/amd64` 与 `linux/arm64`；代码包含 Linux-only syscall，因此当前不提供 Windows 构建。

## 配置

完整模板见 [.env.example](.env.example)。

### 必需配置

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | Prisma MySQL 连接串 |
| `AUTH_SECRET` | 登录会话/JWT 密钥，无内置生产默认值 |
| `LICENSE_SECRET` | 授权签名密钥 |
| `TUNEX_CONFIG_KEY` | 每安装实例独立的 32-byte base64url Fernet key |
| `TUNEX_LICENSE_KEY` | 与 config key 不同的第二把 Fernet key |
| `MYSQL_ROOT_PASSWORD` | Compose MySQL root 密码 |

缺少关键密钥时 Backend 会 fail-fast，不会回退到共享默认值。

### 常用配置

| 变量 | 默认值/建议 | 说明 |
| --- | --- | --- |
| `SITE_URL` | 本地按实际地址设置 | 站点/控制面地址 |
| `REDIS_URL` | `redis://redis:6379` | Redis |
| `JWT_TTL_SECONDS` | `43200` | Access token 有效期 |
| `COOKIE_SECURE` | 生产必须 `true` | HTTPS Cookie |
| `ALLOW_REGISTER_FALLBACK` | 生产建议 `false` | 注册兜底开关 |
| `PAYMENTS_ENABLED` | `false` | 可选计费后端开关 |
| `NEXT_PUBLIC_PAYMENTS_ENABLED` | `false` | Web 计费入口开关 |
| `RATE_LIMIT_ENABLED` | `true` | HTTP 限流 |
| `AUDIT_LOG_ENABLED` | `true` | 审计日志 |
| `DISABLE_WORKER` | `false` | Worker 开关 |
| `SEED_ADMIN_EMAIL` | `admin@tunex.local` | 首次管理员邮箱 |
| `SEED_ADMIN_PASSWORD` | 随机生成 | 首次管理员密码 |

Backend 还支持 SMTP 邮件配置：`SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`、`SMTP_FROM`、`SMTP_SECURE`。未配置 SMTP 时，开发环境可将邮件内容输出到日志；生产部署应配置真实邮件服务。

## 本地开发

### Backend

```bash
cd backend
bun install
bunx prisma generate
bun run typecheck
bun run dev
```

Backend 本地启动仍需要有效的 `DATABASE_URL`、Redis 与安全密钥。最简单的方式是先通过 Compose 启动 MySQL/Redis：

```bash
docker compose up -d mysql redis
```

若 Backend 在宿主机运行，请将连接地址改为宿主机映射端口（默认 MySQL `3307`、Redis `6380`）。

### Web

```bash
cd web
npm ci
npm run dev
```

开发服务器默认监听 `41000`。关闭 mock 且需要代理 Backend 时，可设置：

```bash
NEXT_PUBLIC_API_MOCK=0 NEXT_PUBLIC_API_BASE=http://127.0.0.1:8787 npm run dev
```

### Agent

```bash
cd agent
go vet ./...
go test ./...
go build ./...
```

更详细的协议、配置下发和开发约定见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 测试与 CI

GitHub Actions 分成三层，测试内容不减少：

```text
feature/** push
      └── CI

Pull Request
      ├── CI
      └── Integration

main push
      └── CI
           └── Integration
                └── Release
```

- **CI（`.github/workflows/ci.yml`）**：快速源码 Gate。包含 secret-scan、Backend（migration/typecheck/unit/HTTP/旧库升级）、Web（typecheck/unit/build）和 Agent（vet/test/build + amd64/arm64 交叉编译）。同一分支只保留最新一轮。
- **Integration（`.github/workflows/integration.yml`）**：PR 直接运行；main 上必须等 CI 成功后才运行。依次执行 `agent-image → v3-integration → unified-image`，真实启动 MySQL/Redis/Panel/双 Agent/Target，验证 enrollment、Agent ID、NodeBinding/PortForward、DIRECT/RELAY、NodePortLease、重启恢复、凭据隔离和 Reconciler。
- **Release（`.github/workflows/release.yml`）**：只会被 **main 的成功 Integration** 触发，发布 Panel `ghcr.io/paimoncai/tunex:{latest,<git-sha>}` 与多架构 Agent `ghcr.io/paimoncai/tunex-agent:{latest,<git-sha>}`。feature/PR 永远不会移动正式镜像标签。

因此正式发布链是严格的 `CI → Integration → Release`；开发分支的小提交不会反复启动重型 v3 Docker E2E。

本地常用检查：

```bash
# Backend
cd backend
bunx prisma generate
bunx tsc --noEmit
bun run test

# Web
cd ../web
npm ci
npm run typecheck
npm run build

# Agent
cd ../agent
go vet ./...
go test ./...
go build ./...
```

涉及数据库的完整 Backend 集成测试建议按 CI 的 MySQL/Redis 环境执行。

## Docker 镜像

Release workflow 在 main 的 CI + Integration 全绿后发布统一应用镜像：

```text
ghcr.io/paimoncai/tunex:latest
ghcr.io/paimoncai/tunex:<git-sha>
```

同一镜像由 Compose 以不同启动命令运行 Backend、Worker、DB migrate 和
Next.js standalone Web；它们仍是独立容器，不是单容器多进程：

```text
ghcr.io/paimoncai/tunex:<git-sha>
├── backend      → bun src/index.ts
├── worker       → bun src/worker.ts
├── db-migrate   → Prisma migrate / seed
└── web          → node server.js
```

Panel 应用角色继续共用一个不可变版本；Agent 使用独立的 slim multi-arch 镜像，生产建议两者钉同一个 git sha：

```dotenv
TUNEX_IMAGE=ghcr.io/paimoncai/tunex:<git-sha>
TUNEX_AGENT_IMAGE=ghcr.io/paimoncai/tunex-agent:<git-sha>
```

典型更新流程：

```bash
docker compose -f docker-compose.prod.yaml --env-file .env pull
docker compose -f docker-compose.prod.yaml --env-file .env run --rm db-migrate
docker compose -f docker-compose.prod.yaml --env-file .env up -d backend worker web caddy
```

默认生产入口只有一个宿主机本地端口：

```text
Host Nginx/宝塔/1Panel :80/:443
              │
              └── http://127.0.0.1:13000
                         │
                    Docker Caddy
                    ├── /api/*       → backend:3000
                    ├── /socket.io/* → backend:3001
                    └── /*           → web:3000
```

因此宿主机反代只需要指向 `127.0.0.1:13000`，不需要分别管理 Backend/Web 端口。这个端口可用 `TUNEX_HTTP_PORT` 修改，并始终只绑定 loopback。

若服务器没有现成反代，可使用 standalone overlay：

```bash
docker compose \
  -f docker-compose.prod.yaml \
  -f docker-compose.standalone.yaml \
  --env-file .env up -d
```

standalone 模式下 Caddy 使用 `Caddyfile.prod`、读取 `SITE_URL/ACME_EMAIL`，并直接绑定 80/443 自动处理 HTTPS。

回滚同样只需把 `TUNEX_IMAGE` 改回上一条已知良好的 SHA，再重新创建应用容器。
MySQL、Redis、Caddy 与远端 Agent 保持独立镜像/制品，不随应用镜像版本一起切换。

## 项目结构

```text
.
├── .github/workflows/
│   ├── ci.yml                      # 快速源码 Gate
│   ├── integration.yml             # Docker / DIRECT / RELAY 真实集成 Gate
│   └── release.yml                 # main 集成通过后发布 GHCR
├── .env.example                    # 开发/本地环境变量模板
├── .env.production.example         # 生产环境变量模板（复制为 .env）
├── Caddyfile                      # Docker 内统一 HTTP 路由（生产默认也使用）
├── Caddyfile.prod                 # standalone 公网入口（域名 + ACME + TLS）
├── docker-compose.yaml            # 开发/自托管基础栈
├── docker-compose.prod.yaml       # 生产栈（默认仅 127.0.0.1:13000 单入口）
├── docker-compose.standalone.yaml # 可选 overlay：Caddy 直接接管 80/443
├── docs/                          # 部署与运维手册
│   └── production-deploy.md       # 生产部署/备份/恢复/回滚手册
├── DEVELOPMENT.md                 # 唯一开发方案、Gate、迁移与 DoD
├── docs/tunex-devmap-v3.md         # 长期目标架构约束
├── backend/
│   ├── prisma/                    # schema / migrations / seed
│   ├── src/
│   │   ├── middlewares/           # auth / CSRF / audit / rate limit
│   │   ├── routes/                # HTTP API
│   │   ├── services/              # workspace / policy / mail / keys
│   │   └── services/              # outbound Agent control / scheduler / reconciler
│   └── tests/                     # HTTP/DB integration tests
├── web/
│   └── src/
│       ├── app/                   # Next.js routes
│       ├── components/            # UI / workspace components
│       ├── lib/                   # API / types / i18n
│       └── mocks/                 # Web mock mode
├── agent/
│   ├── main.go
│   └── internal/                  # Agent implementation
├── scripts/
│   ├── ci/                        # CI helpers
│   ├── net01-e2e/                 # network E2E harness
│   └── ops/                       # alert / backup / restore / rollback / capacity
└── reports/                       # 验证与差异报告
```

## 安全与生产部署

在公网部署前至少需要：

1. 为每个实例生成独立的 `AUTH_SECRET`、`LICENSE_SECRET`、`TUNEX_CONFIG_KEY`、`TUNEX_LICENSE_KEY`；
2. 使用真实域名和 TLS，并设置 `COOKIE_SECURE=true`；
3. 不将 MySQL / Redis 调试端口暴露到公网；
4. 使用独立数据库账号与最小权限，而不是长期使用 root；
5. 配置 SMTP、备份、恢复、日志、告警和资源限制；
6. 保持 `PAYMENTS_ENABLED=false`，除非计费链路已完成独立审查和验收；
7. 以 [DEVELOPMENT.md](DEVELOPMENT.md) 的 Integration Gate 为发布门槛；不得跳过真实 v3 网络验证。

生产部署默认使用 `docker-compose.prod.yaml` + `Caddyfile` + `.env.production.example`：宿主机 Nginx/宝塔/1Panel 负责公网 TLS，只反代到 `127.0.0.1:13000`。无宿主机反代时再叠加 `docker-compose.standalone.yaml`，切换到 `Caddyfile.prod` 自动 ACME/TLS。完整步骤、Nginx 配置、巡检阈值、备份/恢复/回滚操作与演练清单见 [docs/production-deploy.md](docs/production-deploy.md)。

仓库已提供 `scripts/ops/` 下的备份、恢复、回滚和告警脚本基础，但生产策略仍应根据实际部署环境审查和演练。

## 与参考项目的关系

TuneX 的部分产品场景和历史兼容行为参考了 RelayX 的公开产品/部署资料，但 TuneX 的目标是独立实现个人与团队多租户 SaaS 控制面，不是 RelayX 的分发版，也不应依赖其固定密钥、授权机制或未确认来源的资产。

后续开发方向统一记录在 [DEVELOPMENT.md](DEVELOPMENT.md)；历史验证、差异与测试证据保留在 [reports/](reports/) 中。

## 文档

- [DEVELOPMENT.md](DEVELOPMENT.md)：**唯一开发方案**；后续 v3 阶段、迁移规则、DoD 与工程约束均以此为准
- [docs/tunex-devmap-v3.md](docs/tunex-devmap-v3.md)：v3 目标架构约束，不作为第二套执行路线
- [docs/production-deploy.md](docs/production-deploy.md)：生产部署/备份/恢复/回滚/告警运维手册
- [scripts/net01-e2e/README.md](scripts/net01-e2e/README.md)：NET-01 网络 E2E 工具说明
- [reports/](reports/)：历史验证、差异分析和测试证据，不作为未来路线

## 贡献流程

建议所有改动通过分支 + Pull Request：

```text
feature/*  ─┐
fix/*      ├─> Pull Request -> CI + Integration -> main -> CI -> Integration -> Release
docs/*     ┘
```

提交前至少保证受影响组件的类型检查/测试通过，并且不要提交环境文件、凭据、数据库快照或构建产物。

## License

仓库当前未包含 `LICENSE` 文件。若计划公开发布或允许第三方使用，请先补充明确的项目许可证，并完成第三方依赖/来源审查。
