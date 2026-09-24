# TuneX

> 面向个人与团队的多租户隧道控制面：管理账号、Workspace、节点、隧道、权限策略与 Agent 配置分发。

[![CI](https://github.com/PaiMonCai/TuneX/actions/workflows/ci.yml/badge.svg)](https://github.com/PaiMonCai/TuneX/actions/workflows/ci.yml)

TuneX 由 **Web 控制台、Backend 控制面、Worker、Go Agent** 组成。用户在控制台创建个人或团队 Workspace，部署 Agent，再通过控制面管理节点与隧道。支付/套餐能力保留为可选扩展，默认关闭，不参与核心权限判定。

> [!IMPORTANT]
> TuneX 仍处于积极开发阶段。当前仓库已经具备可重复 CI、真实 MySQL 迁移验证、Workspace/RBAC、账号安全和基础隧道链路，但部分租户作用域、流量计量与生产运维能力仍在收尾。**根目录的 Docker Compose 更适合作为开发/自托管基线，不应未经加固直接暴露到公网生产环境。**

## 当前能力

| 领域 | 当前状态 |
| --- | --- |
| 账号 | 注册/登录、邮箱验证、密码重置、Cookie JWT / Bearer API Key |
| Workspace | 个人空间、团队空间、成员邀请、owner/admin/member/viewer 固定角色 |
| 权限 | Workspace RBAC、CapabilityPolicy、默认免费策略、节点组授权 |
| 安全 | CSRF、请求限流、审计、API/订阅密钥哈希存储与一次性轮换 |
| 隧道/节点 | 节点组、节点、隧道管理，Agent 配置下发，基础 TCP 数据链路 |
| Web | Next.js 管理控制台、Workspace 切换与成员管理、设置页 |
| CI | Backend/Web/Agent 检查、秘密扫描、空库及升级迁移验证、GHCR 镜像构建 |
| 运维 | Compose、Caddy、备份/恢复/告警/容量脚本基础框架 |

仍在推进的主要工作包括：Redis/Queue/Socket/Agent 全链路租户作用域、策略在配置生成器中的全面接线、流量采集与聚合、生产部署加固。详细进度以 [PLAN.md](PLAN.md) 为准。

## 架构

```text
                       ┌──────────────────────────┐
                       │        Browser           │
                       └────────────┬─────────────┘
                                    │ HTTP/HTTPS
                             ┌──────▼──────┐
                             │    Caddy    │
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

        Agent ── Socket.IO / outbound connection ──► Backend
          │
          └── applies encrypted config and serves tunnel data path
```

### 技术栈

- **Web**：Next.js 16、React 19、TypeScript、Tailwind CSS
- **Backend**：Bun、Hono、Prisma 6、MySQL 8.4、Redis 7.4、Socket.IO
- **Agent**：Go 1.22，仅使用 Go 标准库
- **入口**：Caddy
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

### 运行

从控制台/节点组 API 获取节点组 token，然后连接 Backend 的 Agent 端口：

```bash
./tunex-agent \
  -s http://127.0.0.1:8788 \
  -t <node-group-token> \
  -d
```

常用参数：

- `-s, --server`：控制面 Socket.IO 地址
- `-t, --token`：节点组 token
- `-n, --node-id`：节点 ID；默认主机名
- `-i, --connect-ip`：上报连接 IP，可重复
- `-l, --listen-ip`：强制监听 IP
- `-r, --port-range`：允许的端口范围
- `-d, --debug`：调试日志
- `-c, --config`：配置文件；默认 `~/.tunex-agent.yaml`

也可以使用 `TUNEX_SERVER`、`TUNEX_TOKEN` 等环境变量。

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

GitHub Actions 会执行：

- **secret-scan**：扫描已跟踪文件中的疑似秘密；
- **backend**：依赖安装、Prisma migration、类型检查、HTTP/授权测试、旧数据库升级验证；
- **web**：依赖安装、TypeScript 类型检查、Next.js build；
- **agent**：`go vet`、`go test`、`go build`、Linux amd64/arm64 交叉编译；
- **images**：前述任务成功后构建并推送 Backend/Web GHCR 镜像。

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

CI 在 `main` / `feature/**` push 后构建：

```text
ghcr.io/paimoncai/tunex-backend:latest
ghcr.io/paimoncai/tunex-web:latest
```

同时会以 Git SHA 打 tag。Compose 也允许通过以下变量覆盖镜像：

```dotenv
TUNEX_BACKEND_IMAGE=ghcr.io/paimoncai/tunex-backend:latest
TUNEX_WEB_IMAGE=ghcr.io/paimoncai/tunex-web:latest
```

## 项目结构

```text
.
├── .github/workflows/ci.yml       # CI / image publishing
├── .env.example                   # 环境变量模板
├── Caddyfile                      # Web/API 反向代理
├── docker-compose.yaml            # 本地/自托管基础栈
├── PLAN.md                        # 产品定位、里程碑、发布门槛
├── DEVELOPMENT.md                 # 深入开发规范与协议说明
├── backend/
│   ├── prisma/                    # schema / migrations / seed
│   ├── src/
│   │   ├── middlewares/           # auth / CSRF / audit / rate limit
│   │   ├── routes/                # HTTP API
│   │   ├── services/              # workspace / policy / mail / keys
│   │   └── socket/                # Agent 控制面
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
│   └── ops/                       # backup / restore / rollback / alerts
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
7. 按 [PLAN.md](PLAN.md) 的 P0 发布门槛完成租户隔离与真实网络验证。

仓库已提供 `scripts/ops/` 下的备份、恢复、回滚和告警脚本基础，但生产策略仍应根据实际部署环境审查和演练。

## 与参考项目的关系

TuneX 的部分产品场景和历史兼容行为参考了 RelayX 的公开产品/部署资料，但 TuneX 的目标是独立实现个人与团队多租户 SaaS 控制面，不是 RelayX 的分发版，也不应依赖其固定密钥、授权机制或未确认来源的资产。

相关来源、差异与迁移风险记录在 [PLAN.md](PLAN.md) 和 [reports/](reports/) 中。

## 文档

- [PLAN.md](PLAN.md)：产品定位、路线图、工作包和发布门槛
- [DEVELOPMENT.md](DEVELOPMENT.md)：开发规范、Agent/Socket 协议、常见坑
- [scripts/net01-e2e/README.md](scripts/net01-e2e/README.md)：NET-01 网络 E2E
- [reports/](reports/)：历史验证、差异分析和测试证据

## 贡献流程

建议所有改动通过分支 + Pull Request：

```text
feature/*  ─┐
fix/*      ├─> Pull Request -> CI -> main
docs/*     ┘
```

提交前至少保证受影响组件的类型检查/测试通过，并且不要提交环境文件、凭据、数据库快照或构建产物。

## License

仓库当前未包含 `LICENSE` 文件。若计划公开发布或允许第三方使用，请先补充明确的项目许可证，并完成第三方依赖/来源审查。
