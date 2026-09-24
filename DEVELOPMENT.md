# TuneX 开发规范（团队协作版）

> 本文档记录既有实现与运维经验；产品定位、优先级和发布验收以 [`PLAN.md`](PLAN.md) 为准。提交代码前请阅读二者。
> 最后更新：2026-09-24 ｜ 状态：单节点全链路实测可用，多节点主链路打通（详见 §7）
>
> **最短上手路径**：§2 启动 → §3 硬性规范 → §4 Agent 配置下发（最容易踩坑的部分）→ §7 挑任务

---

> 品牌展示名为 **TuneX**。隧道类型、环境变量、Cookie、数据库及容器资源名均已统一为 `tunex`。重新运行 seed 只会迁移站点配置中的旧默认品牌文案，不覆盖管理员自定义内容。

## 1. 项目概况

### 1.1 是什么

TuneX 定位为个人与团队使用的多租户 SaaS：注册/创建工作空间 → 部署 Agent → 创建隧道 → 安全访问与协作管理。套餐和支付代码为既有实现，后续作为默认关闭的可选能力，不是核心使用路径。

三个端点：

| 组件 | 技术栈 | 端口 | 代码量 |
|---|---|---|---|
| **Backend** | Hono + Prisma + Bun | 3000（HTTP）+ 3001（Socket.IO） | ~10.7k 行 |
| **Web** | Next.js 16 + React 19 + Tailwind | 3000 | ~9.3k 行 |
| **Agent** | Go 1.22（零依赖，纯标准库） | 无入站 | ~4.2k 行 |

### 1.2 目录结构

```
/opt/TuneX/
├── docker-compose.yaml       # 7 个服务：mysql/redis/db-migrate/backend/worker/web/caddy
├── .env                      # 所有配置，勿提交
├── Caddyfile                 # 反向代理：/api/* 和 /healthz → backend，其余 → web
├── backend/
│   ├── Dockerfile            # oven/bun:1-debian（trixie）
│   ├── prisma/schema.prisma  # 25 个 model
│   ├── prisma/seed.ts        # 初始数据
│   └── src/
│       ├── index.ts          # HTTP (Hono) + startSocketServer()
│       ├── app.ts            # 路由挂载 + 中间件链
│       ├── routes/           # 12 个路由文件，63 个端点
│       ├── socket/           # ★ agent 接入层（见 §4）
│       ├── middlewares/auth.ts
│       └── services/
├── web/
│   ├── Dockerfile            # 3 阶段 node:20-alpine
│   ├── next.config.ts
│   └── src/app/              # 12 页面 + src/components/ + src/lib/api.ts
├── agent/
│   ├── main.go
│   ├── go.mod                # module github.com/tunex/agent，零依赖
│   └── internal/             # 10 个包
└── reports/                  # 验证报告
```

---

## 2. 环境与启动

### 2.1 前置要求

- Docker + Docker Compose v2
- Node 20+（仅本地开发 web 时需要）
- Go 1.22+（仅本地开发 agent 时需要）

### 2.2 一键启动

```bash
cd /opt/TuneX
docker compose up -d --build
```

服务状态应是：

| 服务 | 期望状态 |
|---|---|
| mysql / redis | healthy |
| db-migrate | Exited(0) |
| backend | healthy（监听 3000 + 3001） |
| web | healthy |
| caddy | Up |
| worker | Up |

### 2.3 端口映射

| 宿主机 | 容器 | 用途 |
|---|---|---|
| 9091 | caddy 80 | **前端入口**（开发用 http://localhost:9091） |
| 9445 | caddy 443 | HTTPS |
| 8787 | backend 3000 | HTTP API |
| 8788 | backend 3001 | Socket.IO（agent 接入） |
| 3000 | — | 已废弃，勿用 |
| 3001 | — | 已废弃，勿用 |
| 3307 | mysql 3306 | DB 调试 |
| 6380 | redis 6379 | Redis 调试 |

注意：`MYSQL_HOST_PORT` 默认 3307、`REDIS_HOST_PORT` 默认 6380，与标准端口错开。

### 2.4 常用命令

```bash
# 重建单个服务（改代码后）
docker compose build --no-cache backend && docker compose up -d --force-recreate backend

# 看日志
docker compose logs -f backend

# 进容器
docker compose exec backend sh

# 跑 agent（本地测试）
/tmp/tunex-agent -s http://127.0.0.1:8788 -t <group-token> -d

# 数据库
docker compose exec mysql mysql -uroot -p tunex

# 编译 agent
cd agent && go build -o /tmp/tunex-agent .
```

---

## 3. 硬性规范（必读）

### 3.1 提交前检查清单

**Backend 改动**：

```bash
cd /opt/TuneX/backend
bun build src/index.ts --target=bun --external external   # 必须 exit 0
```

**Web 改动**：

```bash
cd /opt/TuneX/web
bun run typecheck   # tsc --noEmit
```

**Agent 改动**：

```bash
cd /opt/TuneX/agent
go build ./...      # 必须 exit 0
go vet ./...        # 必须无输出
```

### 3.2 命名约定

| 类型 | 规范 | 示例 |
|---|---|---|
| 路由文件 | kebab-case，`xxx-routes.ts` 或单名词 | `node-groups.ts`、`tunnels.ts` |
| 路由导出 | `<name>Routes` | `tunnelsRoutes` |
| Agent 包 | 小写单词，`internal/` 下 | `internal/fernet/` |
| 环境变量 | `SCREAMING_SNAKE` | `SITE_URL`、`COOKIE_SECURE` |
| Prisma model | PascalCase 单数 | `NodeGroup`、`Tunnel` |
| Prisma 字段 | snake_case | `node_group_id`、`listen_port` |

### 3.3 禁止事项

1. **不要改 `.env` 里的 `SITE_URL` 为 `https://tunex.local`** — 当前是测试值 `http://127.0.0.1:8788`，改了 agent license 校验会失败（agent `-s` 参数必须与 `SITE_URL` 一致）。
2. **不要动 `docker-compose.yaml` 的端口映射** — 9091/9445 是为避开本机已占用端口而设定的默认值。
3. **使用 Git 管理变更** — 项目已初始化 `main` 分支；改动需经过 CI 验证，严禁提交 `.env`、凭证与构建产物。
4. **不要 Node 的 `aes-128-cbc` 自动 padding** — Fernet 必须手动 PKCS7 + `setAutoPadding(false)`（见 §4.3）。
5. **不要把 `public/` 加入 `.dockerignore`** — Dockerfile 有 `COPY public ./public`。

### 3.4 代码风格

- TypeScript：无分号（除必要），双引号，2 空格缩进
- Go：标准 `gofmt`，tab 缩进
- 中文注释用于业务逻辑，英文注释用于协议/技术细节

### 3.5 中间件链与安全开关

`app.ts` 的中间件顺序（顺序即语义，勿随意调整）：

```
① 请求 IP 提取 + 访问日志 → ② CORS（仅非生产）→ ③ 健康检查 /healthz /readyz
→ ④ authRequired（白名单内部短路）→ ⑤ 审计日志 → ⑥ 全局限流
→ ⑦ [/api/admin/*] adminRequired → adminPermissionGuard → 路由
```

- **审计在限流之前**：被限流的请求同样留痕，且审计/限流对免认证白名单（登录/注册/支付回调）也生效。
- **两者均可用环境变量关闭**：`AUDIT_LOG_ENABLED=false`、`RATE_LIMIT_ENABLED=false`（默认开启）。
- 限流规则表在 `middlewares/rate-limit.ts#GLOBAL_RATE_LIMIT_RULES`；计数 key `ratelimit:<rule>:<identity>`，
  身份 `user:<id>` 优先、未登录回退 `ip:<ip>`。登录/注册按 IP，全站兜底按用户。
- 审计写入在 `middlewares/audit.ts`（响应后写入，失败吞掉、不阻断主响应），纯逻辑/写入器在 `services/audit.ts`；
  **永不写请求体**，敏感路径（password/token/callback/login…）强制丢弃 metadata。

---

## 4. 核心机制：Agent 配置下发（★ 最重要）

这是全项目最复杂、最容易出错的部分。**改动前必须读完本节**。

### 4.1 架构

```
┌──────────────┐  Socket.IO:3001   ┌──────────────┐
│   Backend    │ ◄───────────────► │  Go Agent    │
│              │  ① register       │  (每节点一个) │
│  Fernet 加密 │  ② config (push)  │  解密 + 应用  │
│  gost 配置   │  ③ sysinfo (10s)  │  端口监听     │
└──────────────┘                   └──────────────┘
```

### 4.2 事件流（必须严格遵守）

| 事件 | 方向 | 载荷 | 说明 |
|---|---|---|---|
| `register` | agent → server | `{node_id, connect_ip[], ports, sysinfo, version}` | 带 ack |
| register ACK | server → agent | `{license, site_url, type, now}` | `43<id>[json]` |
| `sysinfo` | agent → server | `{node_id, sysinfo}` | 每 10s，无 ack |
| `config` | server → agent | **裸 Fernet 字符串** | `42["config","<token>"]` |
| `listen` | agent → server | `{port, type, name}` | 端口分配回传 |

**关键**：`config` 事件的 payload 是**单个 JSON 字符串**（Fernet token），不是数组、不是对象。

### 4.3 Fernet 加密（已修复的重大 bug）

文件：`backend/src/services/license-sign.ts`

```typescript
// 正确实现要点：
const cipher = createCipheriv("aes-128-cbc", encryptionKey, iv);
cipher.setAutoPadding(false);        // ★ 必须！否则双重 padding
const padded = pkcs7Pad(Buffer.from(plaintext, "utf8"), 16);
const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);

// 结构：0x80 || timestamp(8B) || iv(16B) || ciphertext || HMAC-SHA256(32B)
// key 结构：前 16 字节 = signing key，后 16 字节 = encryption key
```

**历史 bug**：Node crypto 默认自动 PKCS7，加手动 pad 会多 16 字节 → Go 端 `pkcs7Unpad` 后残留 `\x02\x02\x10\x10...` → `license: invalid payload`。

**两把不同的 key（每套部署独立生成）**：

| 用途 | 环境变量 | 说明 |
|---|---|---|
| License（register ACK）| `TUNEX_LICENSE_KEY` | 由本部署签发与校验，代码内无默认值 |
| Config（gost 配置）| `TUNEX_CONFIG_KEY` | 由本部署加密下发，Agent 经环境变量读取 |

> 历史版本曾内置上游通用密钥，现已移除：缺失上述变量时后端/Agent 快速失败。不存在任何回退密钥名。

### 4.4 配置生成与推送

```typescript
// backend/src/socket/config-generator.ts
const { json } = await generateNodeConfig(groupId);  // json 是 gost 配置字符串

// backend/src/socket/config-pusher.ts
const encrypted = fernetEncryptWith(FERNET_CONFIG_KEY, config.json);
// ★ 必须用 config.json，不是 JSON.stringify(config)（后者含 nodeGroupId/nodeType/fingerprint 包装）
io.to(`node_group/${groupId}`).emit("config", encrypted);
```

**已修复 bug**：曾用 `JSON.stringify(config)` 把 `{nodeGroupId,nodeType,config,json,fingerprint}` 整个下发 → agent 解析出 `services=0`。

### 4.5 何时触发推送

分层职责（**不要绕层**）：

| 层 | 文件 | 负责 |
|---|---|---|
| 编排 | `socket/config-refresh.ts` | 事件 → 受影响组集合 → 推送；`refreshNodeGroupsForUsers` / `refreshNodeGroupsForPlans` |
| 执行 | `socket/config-pusher.ts` | 单组推送 + 指纹去重 + `force` 覆盖 |

已实现的 hook 全景：

| 操作 | 位置 | 备注 |
|---|---|---|
| 创建隧道 | `routes/tunnels.ts` | `force: true` |
| 更新隧道 PATCH | `routes/tunnels.ts` | 换组时额外推旧组；`force: true` |
| 停用/启用 toggle | `routes/tunnels.ts` | status 影响过滤；`force: true` |
| 删除隧道 DELETE | `routes/tunnels.ts` | 删除前取节点组信息；`force: true` |
| 用户停用/启用 | `routes/admin-extended.ts` | `status` 变化时触发 |
| 用户删除 | `routes/admin-extended.ts` | 事务前算组，事务后推 |
| 套餐停用/删除/绑定变更 | `routes/admin-extended.ts` | `all_in/out`、`node_group_ids` 及状态变化均触发 |
| 节点组删除 | `routes/admin-extended.ts` | 清理 `plan_node_group` 后触发 |
| 节点 register 上线 | `socket/index.ts` | `force: true`（重连必拿配置） |

**隧道侧一律 `force: true`**（用户直接操作，应"改了就看到"）；
用户/套餐侧走默认指纹去重——状态变化必然改变配置内容，去重只挡无效重复。

### 4.6 协议键名契约（写端必须与读端严格一致）

Redis 里这三个 key 曾在多节点验证中因写/读口径不一致而断裂过，改动前先对照：

| key | 写端 | 读端 | field 形态 |
|---|---|---|---|
| `tunnel:out_listen`（常量 `OUT_LISTEN_KEY`） | `socket/index.ts` listen handler 出口分支 | `config-generator.ts` `loadOutListens()` | `<node.id>:<type>`，值 = 端口字符串 |
| `sysinfo:<groupId>:<node_id>` | `socket/index.ts` sysinfo | `offline-detector.ts` 心跳判定 + 各查询处 | TTL 30s |
| `dc:<groupId>:<node_id>` | `socket/index.ts` disconnect | `offline-detector.ts#runOfflineCheck`（worker cron 消费） | 值 = 断开时刻 ms；TTL 180s |

**离线标记禁用 `socket.id`**：每次重连都会变，用它做 key 等于无法反查节点。register 时把 `node_id` 绑到 `socket.data.nodeId`，disconnect 时用它。

**出口 listen 分支要点**：`node_id` 是字符串标识，必须先 `db.node.findUnique({where:{node_id}})` 换成数字主键 `node.id`，因为 hops 拼 addr 用的是 `node.id`。

**`dc:*` 消费闭环**（`socket/offline-detector.ts`，见 §4.7）：标记值存断开时刻，TTL = 防抖 60s + 宽限 120s（保证 worker 在防抖到点后至少扫到一次）。节点重连时 `register` / `sysinfo` 会 `DEL` 该标记取消待处理离线；worker 每 10s（`cron_check_node_offline`）扫描，仅当「防抖到点 ∧ 无 `sysinfo:*` 心跳 ∧ DB 仍 active」才置 `inactive`，并按需清理 `alive_groups`。

### 4.7 离线检测闭环（`dc:*` → `inactive`）

`disconnect` 只写标记；**消费端**在 `backend/src/socket/offline-detector.ts`：

- **判定**（`decideOffline`，纯函数）：`node 不存在` > `防抖未到` > `心跳存活` > `已 inactive` > `离线`，任一短路即跳过，避免误判在线节点。
- **60s 防抖**：距标记写入不足 60s 一律跳过（节点可能正在重连）；重连时 `register`/`sysinfo` 会删标记，等价于「取消待处理离线」。
- **心跳双重确认**：即使防抖到点，只要 `sysinfo:<gid>:<node_id>` 还在，就判定节点存活、清掉残留标记。
- **幂等**：`updateMany({where:{status:"active"}})` 只翻转一次，重复消费/多 worker 并存不重复写；`SCAN` 游标扫描不阻塞 Redis。
- **`alive_groups` 清理**：节点翻转后若组内再无 active 节点，`SREM alive_groups <gid>`。
- **触发**：worker `cron_check_node_offline`（每 10s）。单条失败被吞并计入 `errors`，不阻断整轮。
- **延迟预算**：`断开被 socket 层发现` + `防抖 60s` + `≤扫描间隔 10s`。即最坏情况下从节点消失到置 `inactive` ≈ 70s。若验收要求「≤60s 显示离线」（`PLAN.md` §5），需与产品确认是否接受该下限（防抖窗口本身是需求核心），或进一步压缩防抖窗口。

单测：`backend/src/socket/__tests__/offline-detector.test.ts`（`bun test`，纯逻辑 + fake deps，不依赖 Redis/DB）。

### 4.8 添加新推送点的模板

```typescript
import { refreshNodeGroupsForUsers, refreshNodeGroupsForPlans } from "../socket/config-refresh.ts";

// 单个用户相关变更（用户侧走默认去重）
void refreshNodeGroupsForUsers([userId]).catch(() => {});

// 套餐相关变更
void refreshNodeGroupsForPlans([planId]).catch(() => {});

// 隧道侧（强制下发，跳过去重）
import { pushNodeConfig } from "../socket/config-pusher.ts";
void pushNodeConfig(groupId, { force: true }).catch(() => {});
```

三个入口全部 fire-and-forget，内部已吞异常，不会冒泡到路由主响应。
不要直接在路由里调 `generateNodeConfig` + `io.emit`——那样绕过去重和 FERNET 分层，必然出 bug。

---

## 5. 数据模型速查

25 个 model，按域分组：

**用户域**：`User`（含 status/admin_roles）、`UserCredential`、`AdminRole`
**套餐域**：`Plan`、`UserPlan`、`PlanNodeGroup`、`PlanOrder`、`PlanCoupon`
**节点域**：`NodeGroup`（含 token/node_type/load_balance_type）、`Node`、`DNSProvider`
**隧道域**：`Tunnel`、`TunnelChain`、`TunnelTraffic`
**财务域**：`TopupOrder`、`TopupActivity`、`BalanceLog`、`CommissionLog`、`WithdrawRequest`
**工单域**：`Ticket`、`TicketReply`
**系统域**：`SystemConfig`、`Payment`、`InNodeGroupDNS`、`AuditLog`

Schema：`backend/prisma/schema.prisma`
迁移：`backend/prisma/migrations/20260923170000_init/`、`…/20260924130000_add_audit_log/`（审计日志表）
Seed：`backend/prisma/seed.ts`（幂等，创建 config/super_admin/plans/nodes/node_groups）

测试账号：查看 seed 写入的 `.admin-credentials`（未设置 `SEED_ADMIN_PASSWORD` 时为随机强口令）。

---

## 6. 前端开发约定

### 6.1 API 调用

统一走 `web/src/lib/api.ts`：

```typescript
import { api } from "@/lib/api";

// SSG/RSC 中：API_BASE = http://backend:3000（服务端）
// 浏览器中：API_BASE = ""（同源，Caddy 代理）
```

**不要**在前端组件里直接 `fetch("/api/...")` 做 SSR 请求 — 会打到 Next.js 自己（404 → 重定向登录）。

### 6.2 页面结构

```
web/src/app/
├── login / register
├── dashboard                # 统计
├── tunnels / tunnels/[id]   # 隧道管理
├── plans                    # 套餐
├── topup                    # 充值
├── tickets                  # 工单
├── settings                 # 个人设置
└── admin/                   # 管理后台
    ├── nodes
    └── [segment]            # 动态段
```

管理后台资源页（`/admin/[segment]`）覆盖十一个分段：

| segment | 组件 | 能力 |
|---|---|---|
| `nodes` / `node-groups` / `plans` / `users` | 各 manager（客户端） | 列表 + 新建/编辑（对话框表单）+ 删除确认 |
| `roles` | `roles-manager.tsx` | RBAC 角色 CRUD + 按资源分组的权限矩阵（无/只读/读写） |
| `users`（附加） | `users-manager.tsx` | 用户详情抽屉 + 后台角色分配（仅超管） |
| `tunnels` / `orders` / `tickets` | `admin-readonly-manager.tsx` | 只读列表 + 搜索/状态过滤/刷新（无写操作） |
| `audit-logs` | `admin-audit-manager.tsx` | 审计日志只读列表 + 关键字/操作者类型/方法过滤（仅超管可读；后端 `GET /admin/audit-logs`） |
| `settings` | `settings-manager.tsx` | 系统配置按组编辑（布尔项下拉，长文本 textarea） |
| `license` | `license-panel.tsx` | License 授权只读面板 |

### 6.3 组件

`web/src/components/` — Radix UI + Tailwind。

管理端组件集中在 `web/src/components/admin/`，均复用 `admin-ui.tsx` 的
`AdminToolbar` / `FormDialog` / `ConfirmDeleteDialog` / `RowActions` / `useForm`。
所有列表页的初始数据由服务端组件预取（`admin-resource-list.tsx`），客户端只负责交互。

mock 端点（`web/src/mocks/handler.ts`）已为上述页面补齐：
`GET/POST/PUT/DELETE /admin/role`、`GET /admin/meta/resources`、`PUT /admin/user/:id/roles`、
`GET /admin/system/config`、`PUT /admin/system/config/:name`、`GET /admin/license`、
`GET /admin/balance-logs`、`GET /admin/audit-logs`（关键字/`actor_type`/`method` 过滤），
以及 `GET /auth/me`（与 `lib/api.ts` 的会话探测对齐）。
可用 `bun run scripts/verify-admin-mock.ts` 直接驱动 handler 做回归。

---

## 7. 待办与团队分工建议

### P0（阻塞生产）

| 任务 | 归属 | 说明 |
|---|---|---|
| `.env` SITE_URL 生产值 | 运维 | 改为真实域名，agent `-s` 同步 |
| Fernet key 配置化 | 后端 | 当前硬编码，需移到 `.env` + KMS |
| 删除 agent 启动脚本硬编码 IP | 运维 | 当前 `-s http://127.0.0.1:8788` |

### P1（功能完整）

| 任务 | 归属 | 说明 |
|---|---|---|
| ~~用户停用/删除 → 配置刷新~~ | 后端 | ✅ 已完成，实测停用后 1 秒内 agent 移除该用户全部服务 |
| ~~套餐停用/删除/绑定变更 → 刷新~~ | 后端 | ✅ 代码已接入 `admin-extended.ts`（`config-refresh.ts` 编排层） |
| plan_node_group 变更 → 刷新 | 后端 | ✅ 已随套餐 hook 一并覆盖 |
| ~~exit_listen 读写键名不一致~~ | 后端 | ✅ 已修（`OUT_LISTEN_KEY` + `<node.id>:<type>`），契约已验证 |
| ~~disconnect 标记按 socket.id~~ | 后端 | ✅ 已改为 `dc:<groupId>:<nodeId>`，实测可反查 |
| ~~离线检测 worker~~ | 后端 | ✅ 已实现（`socket/offline-detector.ts`）：worker `cron_check_node_offline` 每 10s 消费 `dc:*`，防抖 60s 到点且无心跳 → 节点置 `inactive` + 清 `alive_groups`；重连自动取消标记并拉回 active |
| ~~多节点端口竞争（动态端口）~~ | 后端 | ✅ 已修：控制面在生成入口配置时为动态端口确定性分配唯一固定端口（`socket/port-allocator.ts`），同组 agent 拿到同一映射、同隧道 tcp/udp 不同号；agent 侧 `usedPorts` 改为协议感知 + 确定性启动顺序 + 区间耗尽回 `ERR_NO_FREE_PORT` |
| admin 前端页面补齐 | 前端 | ✅ 已完成：新增 roles/settings/license 三段，tunnels/orders/tickets 改只读管理组件，users 增加详情与角色分配；`tsc` 与 `next build` 通过 |

### P2（优化）

| 任务 | 归属 | 说明 |
|---|---|---|
| sing-box 二进制集成 | Agent | 当前用自研 Go 转发（功能等价） |
| Worker BullMQ delay job | 后端 | ✅ 已落地（`cron_check_node_offline`，每 10s）：`dc:*` 标记由 worker 消费，实现 60s 防抖后置离线 |
| ~~`listen_error` 服务端 handler~~ | 后端 | ✅ 已补（`socket/listen-events.ts`）：`ERR_PORT_IN_USE` → 隧道置 `inactive` + 写 `port_conflict_at`（复刻上游语义）；`listen` 回填遇 `P2002` 也记 `port_conflict_at` 并重推该组 |
| ~~`pushNodeConfig` 增量去重~~ | 后端 | ✅ 已落地：`config-pusher.ts` 默认路径用 `fingerprint` 与 Redis `node_group:config_hash` 比对，未变则跳过 `emit`（不加密/不下发）；`force:true`（隧道/register）仍强制下发并落缓存。Redis 故障 fail-open（照样推）。单测 `config-pusher-dedup.test.ts`（10 例） |
| ~~全局限流~~ | 后端 | ✅ 已落地：`middlewares/rate-limit.ts` 固定窗口 + Redis Lua 原子计数（`ratelimit:<rule>:<identity>`），规则表覆盖登录/注册/找回/支付回调/全站 `api-global`；超限 429 + `Retry-After`，Redis 故障 fail-open。单测 `rate-limit.test.ts`（18 例） |
| ~~审计日志~~ | 后端 | ✅ 已落地：`middlewares/audit.ts` + `services/audit.ts`，响应后落 `audit_log` 表（新迁移）；非 GET 全记 + 管理端 GET + 敏感端点，**不落请求体**；`GET /api/admin/audit-logs`（仅超管）+ 前端 `/admin/audit-logs` 只读页。单测 `audit.test.ts`（24 例） |
| ~~`port_conflict_at` 落库~~ | 后端 | ✅ 已落库：`listen` 回填 P2002 冲突、`listen_error` 端口占用两条路径都会写 `port_conflict_at` |

### 已验证可用的机制（2026-09-24 实测）

| 机制 | 触发点 | 实测结果 |
|---|---|---|
| 用户停用/启用 | `PATCH /api/admin/users/:id` | ✓ 停用后 agent 1s 内移除该用户全部服务（4→0） |
| 隧道 CRUD | `POST/PATCH/DELETE /api/tunnels` | ✓ 新建/改端口/删除均实时生效 |
| 隧道开关 | `POST /api/tunnels/:id/toggle` | ✓ 关→移除，开→监听新端口 |
| 节点注册首推 | Socket.IO `register` | ✓ `force: true`，重连必拿配置 |
| 指纹去重 | `pushNodeConfig` 默认路径 | ✓ 配置不变则不推（Redis `node_group:config_hash`） |
| 同组多节点广播 | room `node_group/<id>` | ✓ 3 个并发同组连接各收到 config |
| 端口冲突预检（API） | `POST /api/tunnels` | ✓ 同组同端口返「监听端口已被占用」 |
| 离线标记可反查 | Socket.IO `disconnect` | ✓ kill 后 Redis 写 `dc:<gid>:<nodeId>` |
| 离线检测闭环 | worker `cron_check_node_offline` | ✓ 真实 Redis 集成校验：防抖到点+无心跳→置 `inactive`、清标记；防抖内保留；心跳存活清残留；组空清 `alive_groups`（10/10 断言通过） |
| 出口端口缓存契约 | listen → `loadOutListens` | ✓ 写 `2:tcp`=21099，读端原值返回 |
| 动态端口控制面分配 | 入口配置生成 `resolveDynamicServicePorts` | ✓ 同组动态隧道得到唯一固定端口（tcp/udp 不同号），组内不再撞号；单测 `config-generator-ports.test.ts` |
| `listen_error` 运行时闭环 | Socket.IO `listen_error` | ✓ `ERR_PORT_IN_USE` → 隧道置 inactive + `port_conflict_at`；单测 `listen-events.test.ts` |

**隧道侧强制下发**：`pushTunnelConfig` 用 `{ force: true }` 绕过指纹去重 ——
用户直接操作的对象应"改了就看到"；用户/套餐侧走默认去重（状态变化必然改变配置内容，去重无害）。

**自保护**：管理员不能停用/删除自己（`adminPermissionGuard` → 403），修改自身状态需直接操作 DB。

**多节点验证报告**：完整报告（含原始证据）在 `reports/multi-node-verification.md`，结论——
注册/下发/心跳主链路单节点与多节点均打通；剩余问题见上方 P1/P2。

**测试套件状态**：已恢复**针对性回归测试**（不依赖数据库，可离线运行）：
- 后端 `backend/src/socket/__tests__/`（`bun test`）：动态端口分配器（`port-allocator`）、`listen_error` 处理器（`listen-events`）、离线检测（`offline-detector`：判定纯逻辑 + 扫描编排 + 幂等 + 组清理）、`pushNodeConfig` 增量去重（`config-pusher-dedup`），以及 `buildInNodeConfig` 端到端端口落点。
- 后端 `backend/src/middlewares/__tests__/`（`bun test`）：全局限流纯逻辑（`rate-limit`：规则选择/身份/窗口/超限/维度隔离/fail-open）、审计日志（`audit`：路径归一化/资源解析/敏感判定/记录取舍/actor 分类/写入容错）。
- Web 前端：`web/scripts/verify-admin-mock.ts` 直接驱动 mock handler（含审计日志过滤回归）；`web` `tsc` + `next build`。
- Agent `agent/internal/{engine,netutil}/*_test.go`（`go test ./...`）：tcp/udp 不同号、确定性启动顺序、区间耗尽 `ERR_NO_FREE_PORT`、协议感知空闲端口探测。
运行：`cd backend && bun test`；`cd web && bun run typecheck && bun run scripts/verify-admin-mock.ts`；`cd agent && go test ./...`。其余模块的回归仍需按需补齐。

---

## 8. 故障排查

### agent 连不上

```bash
# 1. Socket.IO 是否在听
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8788/socket.io/?EIO=4&transport=polling
# 期望 200；401 = auth 白名单问题；404 = startSocketServer 没调用

# 2. 看 backend 日志
docker compose logs --tail=50 backend | grep -i "socket\|error"

# 3. 节点组 token 是否正确
curl -b /tmp/ck.txt http://127.0.0.1:8787/api/node-groups
```

### agent 注册后 config services=0

见 §4.3/§4.4 — 80% 是 Fernet padding 或 config 包装问题。

**调试方法**：在 agent 的 `handleConfig` 加临时日志打印 `len(plaintext)` 和 `string(plaintext[:200])`，**上线前删掉**（我们曾因此留了 debug 残留）。

### 隧道改了但节点没反应

检查 `pushTunnelConfig` 是否被调用，以及 `globalThis.__io` 是否已设置（`startSocketServer()` 里）。

### 出口链路 hops 为空 / 出口转发不通

查出口端口缓存（`tunnel:out_listen`）——写入端与读端 key/field 必须严格一致：

```bash
docker compose exec -T redis redis-cli HGETALL tunnel:out_listen
```

- 空：agent 从未上报出口 listen，或该隧道没有 `tunnel_chains` 记录（单跳直连隧道不走 chain，正常为空）
- 有值但不匹配：写端是否用了 `node_id` 字符串而非 `node.id` 数字主键（见 §4.6）

### 节点下线了面板还显示在线

先确认 worker 在跑、且 `dc:*` 标记被写：

```bash
docker compose logs --tail=50 worker | grep -i offline
docker compose exec -T redis redis-cli --scan --pattern 'dc:*'
```

- 无 `dc:*`：agent 从未 register 过（`socket.data.nodeId` 为空，disconnect 不写标记），或标记 TTL（180s）已过。
- 有 `dc:*` 但 `node.status` 仍 active：检查 worker 是否启（`DISABLE_WORKER` 必须为 `false`），以及 `sysinfo:<gid>:<node_id>` 是否还在（心跳存活则**不**置离线，属正常）。
- 也可手动触发一轮判定（无需等 30s cron）：重启 worker 后 `<30s` 内即可自纠。

若长期显示在线，多为 `HIDE_NODE_STATUS` / 前端缓存问题，而非本机制。

### Web 502

```bash
docker compose logs --tail=20 web
docker compose logs --tail=20 caddy
```

多半是 web 容器没起来或 Caddyfile 路由错（`web:3000` 不是 `web:80`）。

### 登录后重定向回 login

检查：
1. `.env` 的 `COOKIE_SECURE`（HTTP 测试栈必须 `false`）
2. Cookie 名 `COOKIE_NAME`
3. `AUTH_SECRET` 是否与签发时一致

---

## 9. 联系与参考

- 验证报告：`/opt/TuneX/reports/multi-node-verification.md`
- 子代理派发规范：`/root/.hermes/skills/main-session-delegation/SKILL.md`
- 本项目的 Agent 对接设计文档：本文档 §4

---

## 附录：环境变量全表

| 变量 | 当前值 | 说明 |
|---|---|---|
| `NODE_ENV` | production | |
| `TZ` | Asia/Shanghai | |
| `SITE_URL` | **http://127.0.0.1:8788** | ⚠️ 测试值，agent license 依赖 |
| `PORT` | 3000 | backend 容器内端口 |
| `MYSQL_ROOT_PASSWORD` | --- | |
| `MYSQL_DATABASE` | tunex | |
| `DATABASE_URL` | mysql://root:***@mysql:3306/tunex | |
| `REDIS_URL` | redis://redis:6379 | |
| `AUTH_SECRET` | --- | JWT 签名密钥 |
| `JWT_ISSUER` | tunex | |
| `JWT_TTL_SECONDS` | 3600 | |
| `COOKIE_SECURE` | **false** | ⚠️ HTTP 测试栈必须 false |
| `COOKIE_NAME` | access | |
| `ALLOW_REGISTER_FALLBACK` | — | |
| `LICENSE_TYPE` | business | 空则 `loadAvailableTunnels` 返回 [] |
| `LICENSE_EXPIRED_AT` | 0 | 0 = 不过期 |
| `DISABLE_WORKER` | false | |
| `MYSQL_HOST_PORT` | 3307 | |
| `REDIS_HOST_PORT` | 6380 | |
