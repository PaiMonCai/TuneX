# TuneX 开发规范（团队协作版）

> 本文档记录既有实现与运维经验；产品定位、优先级和发布验收以 [`PLAN.md`](PLAN.md) 为准。提交代码前请阅读二者。
> 最后更新：2026-09-24 ｜ 状态：单节点全链路实测可用，多节点主链路打通（详见 §7）
>
> **最短上手路径**：§2 启动 → §3 硬性规范 → §4 Agent 配置下发（最容易踩坑的部分）→ §7 挑任务

---

> 品牌展示名为 **TuneX**。`relayx` 隧道类型、`RELAYX_*` 环境变量、Cookie、数据库及容器资源名暂保留以兼容现有协议和部署。重新运行 seed 只会迁移站点配置中的旧默认品牌文案，不覆盖管理员自定义内容。

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
/opt/relayx-clone/
├── docker-compose.yaml       # 7 个服务：mysql/redis/db-migrate/backend/worker/web/caddy
├── .env                      # 所有配置，勿提交
├── Caddyfile                 # 反向代理：/api/* 和 /healthz → backend，其余 → web
├── backend/
│   ├── Dockerfile            # oven/bun:1-debian（trixie）
│   ├── prisma/schema.prisma  # 24 个 model
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
│   ├── go.mod                # module github.com/relayx/agent，零依赖
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
cd /opt/relayx-clone
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
/tmp/relayx-agent -s http://127.0.0.1:8788 -t <group-token> -d

# 数据库
docker compose exec mysql mysql -uroot -p relayx

# 编译 agent
cd agent && go build -o /tmp/relayx-agent .
```

---

## 3. 硬性规范（必读）

### 3.1 提交前检查清单

**Backend 改动**：

```bash
cd /opt/relayx-clone/backend
bun build src/index.ts --target=bun --external external   # 必须 exit 0
```

**Web 改动**：

```bash
cd /opt/relayx-clone/web
bun run typecheck   # tsc --noEmit
```

**Agent 改动**：

```bash
cd /opt/relayx-clone/agent
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

1. **不要改 `.env` 里的 `SITE_URL` 为 `https://relayx.local`** — 当前是测试值 `http://127.0.0.1:8788`，改了 agent license 校验会失败（agent `-s` 参数必须与 `SITE_URL` 一致）。
2. **不要动 `docker-compose.yaml` 的端口映射** — 9091/9445 是被 W5 栈占用后的既定选择。
3. **使用 Git 管理变更** — 项目已初始化 `main` 分支；改动需经过 CI 验证，严禁提交 `.env`、凭证与构建产物。
4. **不要 Node 的 `aes-128-cbc` 自动 padding** — Fernet 必须手动 PKCS7 + `setAutoPadding(false)`（见 §4.3）。
5. **不要把 `public/` 加入 `.dockerignore`** — Dockerfile 有 `COPY public ./public`。

### 3.4 代码风格

- TypeScript：无分号（除必要），双引号，2 空格缩进
- Go：标准 `gofmt`，tab 缩进
- 中文注释用于业务逻辑，英文注释用于协议/技术细节

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

> 历史版本曾内置上游通用密钥，现已移除：缺失上述变量时后端/Agent 快速失败。迁移期仍接受 `RELAYX_CONFIG_KEY` / `RELAYX_LICENSE_KEY` 作为回退。

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
| `sysinfo:<groupId>:<node_id>` | `socket/index.ts` sysinfo | 各查询处 | TTL 30s |
| `dc:<groupId>:<node_id>` | `socket/index.ts` disconnect | worker 消费 | 节点标识，非 `socket.id` |

**出口 listen 分支要点**：`node_id` 是字符串标识，必须先 `db.node.findUnique({where:{node_id}})` 换成数字主键 `node.id`，因为 hops 拼 addr 用的是 `node.id`。

**离线标记禁用 `socket.id`**：每次重连都会变，用它做 key 等于无法反查节点。register 时把 `node_id` 绑到 `socket.data.nodeId`，disconnect 时用它。

### 4.7 添加新推送点的模板

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

24 个 model，按域分组：

**用户域**：`User`（含 status/admin_roles）、`UserCredential`、`AdminRole`
**套餐域**：`Plan`、`UserPlan`、`PlanNodeGroup`、`PlanOrder`、`PlanCoupon`
**节点域**：`NodeGroup`（含 token/node_type/load_balance_type）、`Node`、`DNSProvider`
**隧道域**：`Tunnel`、`TunnelChain`、`TunnelTraffic`
**财务域**：`TopupOrder`、`TopupActivity`、`BalanceLog`、`CommissionLog`、`WithdrawRequest`
**工单域**：`Ticket`、`TicketReply`
**系统域**：`SystemConfig`、`Payment`、`InNodeGroupDNS`

Schema：`backend/prisma/schema.prisma`
迁移：`backend/prisma/migrations/20260923170000_init/`
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

### 6.3 组件

`web/src/components/` — Radix UI + Tailwind，52 个组件。

已知粗糙处：admin 部分页面组件完成度不均，需要团队补齐（见 §7）。

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
| **离线检测 worker** | 后端 | ⚠️ 标记已可反查，但**仍无 worker 消费** `dc:*` 把节点置 inactive |
| 多节点端口竞争（动态端口） | 后端 | ⚠️ `usedPorts` 仅进程内，跨 agent 二次刷新仍会撞 tcp/udp 同号 |
| admin 前端页面补齐 | 前端 | 当前粗糙 |

### P2（优化）

| 任务 | 归属 | 说明 |
|---|---|---|
| sing-box 二进制集成 | Agent | 当前用自研 Go 转发（功能等价） |
| Worker BullMQ delay job | 后端 | `dc:*` 标记目前无消费者，无法实现 60s 防抖后置离线 |
| `listen_error` 服务端 handler | 后端 | agent 端口绑定失败控制面不可见 |
| `pushNodeConfig` 增量去重 | 后端 | 目前无条件全量重推（fingerprint 已有，未用） |
| 全局限流 | 后端 | register 已有 block，其余端点无 |
| 审计日志 | 后端 | 当前无 |
| `port_conflict_at` 落库 | 后端 | 声明式预检只返 400，不记录冲突历史 |

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
| 出口端口缓存契约 | listen → `loadOutListens` | ✓ 写 `2:tcp`=21099，读端原值返回 |

**隧道侧强制下发**：`pushTunnelConfig` 用 `{ force: true }` 绕过指纹去重 ——
用户直接操作的对象应"改了就看到"；用户/套餐侧走默认去重（状态变化必然改变配置内容，去重无害）。

**自保护**：管理员不能停用/删除自己（`adminPermissionGuard` → 403），修改自身状态需直接操作 DB。

**多节点验证报告**：完整报告（含原始证据）在 `reports/multi-node-verification.md`，结论——
注册/下发/心跳主链路单节点与多节点均打通；剩余问题见上方 P1/P2。

**测试套件状态**：本项目已移除全部测试文件（backend 的 `__tests__`、agent 的 `*_test.go`、web 的 `tools/selftest-mock.ts`），仓库中不再包含可运行的测试套件。如需回归验证，请先按上文补齐测试再执行。

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

`dc:<groupId>:<nodeId>` 标记已能写（disconnect 时），但**消费端 worker 尚未实现**，
所以 DB `node.status` 不会自动变 inactive。这是已知缺口（§7 P1），临时只能手动改库。

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

- 验证报告：`/opt/relayx-clone/reports/multi-node-verification.md`
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
| `MYSQL_DATABASE` | relayx | |
| `DATABASE_URL` | mysql://root:***@mysql:3306/relayx | |
| `REDIS_URL` | redis://redis:6379 | |
| `AUTH_SECRET` | --- | JWT 签名密钥 |
| `JWT_ISSUER` | relayx | |
| `JWT_TTL_SECONDS` | 3600 | |
| `COOKIE_SECURE` | **false** | ⚠️ HTTP 测试栈必须 false |
| `COOKIE_NAME` | relayx_access | |
| `ALLOW_REGISTER_FALLBACK` | — | |
| `LICENSE_TYPE` | business | 空则 `loadAvailableTunnels` 返回 [] |
| `LICENSE_EXPIRED_AT` | 0 | 0 = 不过期 |
| `DISABLE_WORKER` | false | |
| `MYSQL_HOST_PORT` | 3307 | |
| `REDIS_HOST_PORT` | 6380 | |
