# TuneX 技术分析报告

> 分析对象：`/opt/TuneX`（品牌 TuneX）
> 参照对象：`/opt/relayx-clone`（RelayX 克隆）
> 分析方式：全仓库静态审查（154 个文件，backend 9.5k 行 / web 9.3k 行 / agent 4.0k 行）
> 结论一句话：**TuneX 是 relayx-clone 的“换牌 + 小修”翻版**——两项目共有 150 个同名文件中，**121 个逐字节完全相同（81%）**，仅 29 个不同；差异集中在品牌字符串、密钥来源、测试删除上，核心协议/架构/占位实现全部原样保留。

> **整改进度（SEC-01）**：本报告描述的是整改前的快照。§4/§5.4/§7 列出的“克隆残留”
> （`github.com/relayx/agent` 模块路径、`TunnelType.relayx`、`RELAYX_*` 环境变量回退、
> `relayx-auth-v1` HKDF 标签、`/opt/relayx-clone` 绝对路径、`relayx-clone-*` 容器名、
> Cookie 名、DB 名、`W1-W6` 周次标记、`TODO(待抓包)`、演示/复刻文案等）**已全部清除并统一为
> `tunex`**，详见 commit `SEC-01`。仍作为待办保留的是文档/路线图类事项（Workspace 多租户、
> CI/测试、真实 worker 逻辑），不在本次“密钥与克隆残留”范围内。

---

## 1. 结论摘要（TL;DR）

| 判定项 | 结论 |
|---|---|
| 是否 RelayX 克隆的翻版 | **是**。整仓从 `relayx-clone` 复制而来：150 个同名文件中 121 个逐字节相同（占 TuneX 全部 154 文件的 79%），仅 29 个文件不同 |
| 与 relayx-clone 的关系 | TuneX = relayx-clone + 品牌改名(TuneX) + Fernet 密钥配置化 + 移除测试套件 + 新增 PLAN.md |
| 开发文案/占位符 | **大量存在**：`W1/W2/W3/W4/W5/W6` 周次标记 46 处、`W1 skeleton`、`TODO(抓包)`、`PLAN.md` 自述“规划稿”、`reports/` 路径仍写 `relayx-clone` |
| 未实现功能 | worker 10 个 cron 任务**全部是占位**（只打日志/计数）；离线检测无消费者；`upgrade` 是 no-op；admin 部分页面未完成 |
| 关键安全整改 | ✅ 上游固定 Fernet 密钥已移除，改为每部署独立 `TUNEX_*_KEY`；✅ 移除 `AUTH_SECRET`/`LICENSE_SECRET` 默认值；✅ seed 默认口令改为随机 |
| 残留风险 | `relayx` 命名（模块/隧道类型/DB/容器）、`github.com/relayx/agent` 模块路径、绝对路径 `/opt/relayx-clone`、无真实多租户(Workspace)模型、无 CI/无测试 |

---

## 2. 两个项目的档案与关系判定

### 2.1 仓库档案

| | `/opt/TuneX` | `/opt/relayx-clone` |
|---|---|---|
| Git | 有（`main`，单提交 `chore: initialize TuneX project`，远端 `github.com/PaiMonCai/TuneX.git`） | **无** |
| 品牌 | TuneX | RelayX |
| 文件数（不含 .git/node_modules） | 153 | 151 |
| 顶层文件 | `PLAN.md`、`DEVELOPMENT.md`、`.env.example`、`.gitignore`、`Caddyfile`、`docker-compose.yaml` | `DEVELOPMENT.md`、`.env`/`.env.bak`/`.env.w1.bak`、`.admin-credentials`、`Caddyfile`、`docker-compose.yaml` |

### 2.2 文件级重合度（硬证据）

```
diff -rq --exclude=.git --exclude=node_modules --exclude=.next ...
→ 仅 29 个文件“differ”，其余（124 个）逐字节相同
```

**完全相同的核心文件举例**（证明是复制而非独立实现）：
- `backend/src/permissions.ts`（RBAC 表，注释仍写“严格复刻原版 `packages/shared/src/permissions.ts`”，路径指向 `/root/relayx-reports/…`）
- `backend/src/auth.ts`、`backend/src/middlewares/auth.ts`、`backend/src/redis.ts`、`backend/src/db.ts`
- `backend/src/socket/config-generator.ts`（1400 行，权威依据写 `/tmp/relayx_src2/src__services__tunnel.ts`）
- `backend/src/socket/config-refresh.ts`、`backend/src/worker.ts`
- 全部 12 个路由文件（`tunnels.ts` 507 行、`admin-extended.ts` 1203 行等）、全部 payment service
- `agent/` 除 4 个文件外全部相同（`engine/runtime.go`、`ws/ws.go`、`socketio/socketio.go`、`mux/mux.go`、`fernet/fernet.go`、`relayx/tunnel.go`…）
- `web/src/mocks/handler.ts`（1420 行）、`web/src/components/**`、`Caddyfile`、`reports/reference-schema.sql`（27970 字节完全相同）

### 2.3 差异文件全清单（29 个）

**品牌/文案改名**：`web/src/app/layout.tsx`、`web/src/app/page.tsx`、`web/src/lib/i18n.ts`、`web/src/mocks/data.ts`、`web/src/mocks/handler.ts`、`web/src/components/admin/node-groups-manager.tsx`、`backend/src/app.ts`、`backend/src/index.ts`、`agent/main.go`、`agent/internal/agentconfig/config.go`、`agent/internal/agent/agent.go`、`backend/package.json`、`web/package.json`

**安全整改（密钥/口令）**：`backend/src/crypto/keys.ts`、`backend/src/crypto/license.ts`、`backend/src/crypto/node-config.ts`、`backend/src/services/license-sign.ts`、`backend/src/socket/config-pusher.ts`、`backend/src/env.ts`、`backend/prisma/seed.ts`、`backend/hashpw.ts`、`agent/internal/license/license.go`、`docker-compose.yaml`、`mysql-init/01-init.sql`

**文档/产物**：`DEVELOPMENT.md`、`agent/README.md`、`reports/multi-node-verification.md`、`backend/bun.lock`、`web/package-lock.json`

**结构性删除**：TuneX 相对 relayx-clone 删除了全部测试（`agent/internal/**/*_test.go`、`backend/src/**/__tests__/`、`web/tools/selftest-mock.ts`），删除了空目录 `web/src/app/admin/[...segment]`、`admin/nodes`。

---

## 3. 系统架构

```
浏览器 ─HTTPS─> Caddy ─┬─ /api/* , /healthz ─> Backend (Hono+Bun, :3000)
                       └─ 其余             ─> Web (Next.js 16, :3000)
私有 Agent (Go, 无入站) ─Socket.IO(:3001)─> Backend ─> MySQL(Prisma) / Redis
Backend ─Fernet 加密 gost 配置─> Agent ─> 用户内网服务
```

| 组件 | 技术栈 | 端口 | 行数 | 说明 |
|---|---|---|---|---|
| Backend | Hono + Prisma + Bun | 3000(HTTP)/3001(Socket.IO) | ~9.5k | 119 个端点，12 路由文件 |
| Web | Next.js 16 + React 19 + Tailwind | 3000 | ~9.3k | 12 页面；默认走 **mock** 数据 |
| Agent | Go 1.22 纯标准库 | 无入站 | ~4.0k | clean-room 复刻 relayx-agent v0.13.22 |
| 数据 | MySQL 24 model + Redis + BullMQ worker | 3307/6380 | — | worker 10 个 cron（占位） |

**核心机制：Agent 配置下发**（全项目最复杂部分）
- Agent 用 `node_group.token` 连 Socket.IO → 发 `register`（带 ack）→ 服务端返回 `430[{license,site_url,type,now}]` → 服务端把 **gost 配置 JSON** 用 Fernet 加密后以 `42["config","<密文>"]`（**裸字符串**）下发到 room `node_group/<id>`。
- 配置生成 `config-generator.ts`（1400 行）：复刻原版 `getInNodeConfig`/`getOutNodeConfig`，支持 tcp/udp/tls/wss/quic/relayx/socks5/ss/vless/wireguard/mieru/openvpn 等协议模板。
- 指纹去重（Redis `node_group:config_hash`）；隧道侧一律 `force:true`。

---

## 4. 开发文案 / 占位符 / 未实现清单（重点）

### 4.1 开发周次标记（`W1`–`W6`，46 处）

覆盖 `worker.ts`、`services/*`、`socket/*`、`app.ts`、`routes/*`、`web/src/lib/types.ts`、`web/src/mocks/*` 等。典型：
- `backend/src/worker.ts:32` — 注释“W1 仅注册任务骨架与调度…业务逻辑在 W2-W5 填充”
- `backend/src/app.ts` — `/healthz` 返回 `service:"tunex-backend", w:"W1"`；`/` 返回 `week:"W1"`（**线上可见的开发标记**）
- `web/src/lib/types.ts:336` — 注释“W2 前端表单直接复用”
- `backend/src/services/config.ts` — “W1 加 5s 短缓存”

### 4.2 显式占位/skeleton

| 位置 | 文案/行为 |
|---|---|
| `backend/src/worker.ts:61` | `return { note: "W1 skeleton", … }` —— **10 个 cron 全部占位** |
| `worker.ts` `cron_save_traffic` | 只 `redis.keys()` 计数，返回 `{note:"W4: buffer→DB"}`，**未落库** |
| `worker.ts` `cron_push_node_config` | 返回 `{note:"W3: sha256 增量推送"}`，**未推送** |
| `agent/internal/agent/agent.go:330` | `handleUpgrade is a no-op placeholder` —— **upgrade 事件空实现** |
| `backend/src/socket/index.ts` disconnect | 注释“完整实现用 BullMQ delay job；此处标记供 worker 扫描（W4 接入）”—— **无消费者** |

### 4.3 TODO（待实测/抓包）

- `backend/src/services/payment/bepusdt.ts:13` — 4 条 `TODO(待抓包)`：回调 Content-Type、金额字段名、字段命名、防重放字段。
- `backend/src/services/payment/heleket.ts:15` — 3 条 `TODO(待抓包)`：sign 位置、金额字段、currency 大小写。
- 两处均以 `amount_checked=false` **放行金额校验**（安全缺口的临时处理）。

### 4.4 `PLAN.md` 自述（整份是“规划稿”）

- 第 3 行：“状态：规划稿，基于当前仓库静态审查。‘已有’指代码入口存在，**不代表…通过验收**。”
- 第 26 行：“**不将当前 mock 页面视作真实 SaaS 能力。**”
- 第 34/39 行：明确列出“`backend/src/crypto/keys.ts` 与 `agent/internal/license/license.go` 含上游固定密钥”“无仓库内自动化测试/CI”“构建通过不等于安全或可运营”。
- 通篇 `0.1/0.2 SaaS Beta` 为**待做里程碑**，非完成状态。

### 4.5 文档中的“复刻/克隆”定位声明（非中性产品文案）

- `DEVELOPMENT.md` §1.2 目录树首行：`/opt/relayx-clone/`
- `agent/main.go` / `agent/README.md`：“clean-room re-implementation of the original relayx-agent v0.13.22”“interoperate with the relayx-clone server”
- `backend/src/crypto/relayx-auth.ts`：“复刻原版 dialer/listener 的隧道 token 方案（逆向确认）”
- `backend/src/permissions.ts`：“严格复刻原版 `packages/shared/src/permissions.ts`”
- `web/src/mocks/data.ts`：“后端（W1/W5）尚未就绪，前端全部走这里”

### 4.6 前端仍是 mock 优先

- `web/src/lib/api.ts`：`NEXT_PUBLIC_API_MOCK==="1"` 时全部走手写 mock（`mocks/handler.ts` 1420 行 + `mocks/data.ts` 825 行）。
- `web/src/components/topbar.tsx`：右上角常驻徽标 **“MOCK API” / “LIVE API”**（`data-testid="mock-badge"`）。
- `web/src/app/page.tsx`（relayx-clone 版本）曾写 “RelayX Clone · W6 frontend skeleton”，TuneX 版本改成 “TuneX · {tagline}”（**只删了 skeleton 字样**）。
- 登录页仍显示 `demoHint: "演示账号：demo@tunex.example / demo1234"`（**硬编码演示口令**）。

### 4.7 未实现/半成品汇总

1. worker 10 个 cron **全部占位**（流量入库、DNS 同步、自动续费、套餐到期通知、过期清理…）。
2. **离线检测闭环缺失**：`dc:<gid>:<nodeId>` 标记能写，但**无 worker 消费**，节点崩溃后 DB 状态永远 `active`；`listen_error` 也无服务端 handler。→ **✅ 已修复（后于本报告）**：`listen_error` handler 已补（`socket/listen-events.ts`）；离线检测消费端已实现（`socket/offline-detector.ts` + worker cron `cron_check_node_offline`，30s 一轮，防抖 60s → `inactive`），详见 `DEVELOPMENT.md` §4.7。
3. 动态端口冲突：`usedPorts` 仅进程内，跨 agent 二次刷新会撞 tcp/udp 同号。
4. `port_conflict_at` 只返 400，不落库；全局限流仅在 register 有 block。
5. 审计日志：**无**（`PLAN.md` 亦确认）。
6. admin 前端：`DEVELOPMENT.md` §6.3 “admin 部分页面组件完成度不均，需要团队补齐”。
7. 多跳/QUIC/WSS/REALITY/mieru/WireGuard 只存在于**枚举/模板**，agent README 明确“not implemented”。

---

## 5. 与 /opt/relayx-clone 的差异详解

### 5.1 品牌改名（RelayX → TuneX）

| 文件 | 改动 |
|---|---|
| `web/src/lib/i18n.ts` | `siteName/title/loginTitle` → TuneX；`demoHint` 邮箱 `demo@relayx.dev`→`demo@tunex.example` |
| `web/src/mocks/data.ts` | 演示账号与节点 `connect_ip`：`hk1.relayx.dev`→`hk1.tunex.example` |
| `web/src/mocks/handler.ts` | 优惠券码 `RELAYX10/RELAYX50` → `TUNEX10/TUNEX50` |
| `web/src/app/layout.tsx` / `page.tsx` | 标题、applicationName、footer |
| `backend/src/app.ts` / `index.ts` | 服务名 `relayx-clone-backend`→`tunex-backend`，启动日志 |
| `agent/main.go` / `config.go` / `agent.go` | 命令名、usage、启动日志 |
| `backend/package.json` / `web/package.json` | `name` 字段 |

### 5.2 安全整改（TuneX 相对 relayx-clone 的真实改进）

| 项 | relayx-clone | TuneX |
|---|---|---|
| Fernet 密钥 | **硬编码上游主密钥**：`<redacted: upstream config Fernet key>`（config）、`<redacted: upstream license Fernet key>`（license），客户端对称、可自签 | **移除**，改为每部署生成 `TUNEX_CONFIG_KEY`/`TUNEX_LICENSE_KEY`，缺失即**快速失败**；无回退密钥名 |
| `AUTH_SECRET` | 有弱默认值 `<redacted weak default>` | `requireSecret()` 无默认值 |
| `LICENSE_SECRET` | 有弱默认值 `<redacted weak default>` | 无默认值 |
| `DATABASE_URL` | 默认 `mysql://root:***@mysql:3306/relayx` | 无默认值 |
| seed 管理员口令 | 固定 `demo1234` | 未设 `SEED_ADMIN_PASSWORD` 时 `generatePassword(24)`；已存在凭证不重置 |
| `hashpw.ts` | 内置明文 `demo1234` 哈希 | 改为 CLI 参数传入，无样例口令 |
| `docker-compose.yaml` | `MYSQL_ROOT_PASSWORD:-relayxroot`（弱默认） | `:?required`（必填）；库名 `tunex` |
| `mysql-init/01-init.sql` | 建 `relayx`@`%` 账号 + 明文口令 `relayxroot` | 删除，仅 `SELECT 1`，不再内置共享凭证 |
| 测试套件 | 含 `*_test.go`、`__tests__/`、`selftest-mock.ts` | **全部删除**（README 称“如需回归请先补齐”） |

> 效果：TuneX 修掉了 relayx-clone 的“上游万能密钥”和“弱默认口令”两个高危项，但代价是**删光了测试**，仓库内不再有可运行回归。

### 5.3 文档差异

- `DEVELOPMENT.md`：TuneX 版本把“唯一权威规范”改为“以 PLAN.md 为准”；§1.2 目录树仍写 `/opt/relayx-clone/`；密钥表改为环境变量表；测试状态段改为“已移除全部测试”；账号说明改为读 `.admin-credentials`。
- `reports/multi-node-verification.md`：仅把两处**明文密钥**替换为 `<per-install key>`（其余原样，仍是 relayx-clone 的实测报告）。
- 新增 `PLAN.md`（31.6 KB，全新规划的 SaaS 方案，非 relayx-clone 所有）。
- 新增 `.env.example`（模板化）、`.gitignore`。

### 5.4 TuneX 未改动的“克隆痕迹”（残留风险）

1. **命名残留**：`agent/go.mod` 仍是 `module github.com/relayx/agent`（16 处 Go import 依赖它）；隧道类型枚举 `TunnelType.relayx`；`RELAYX_*` 环境变量回退；`relayx-auth-v1` HKDF info；DB 名 `relayx`（relayx-clone 侧）、Cookie、容器名 `relayx-clone-*`（TuneX compose 里 **7 个 container_name 全叫 `relayx-clone-*`**）。
2. **绝对路径残留**：`DEVELOPMENT.md`、`reports/multi-node-verification.md`、`scripts/w1_migrate_seed.sh`、`scripts/fix_schema.py`、`web/src/lib/types.ts`、`config-generator.ts` 等仍引用 `/opt/relayx-clone`、`/tmp/relayx_src2/…`、`/root/relayx-reports/…`、`/tmp/relayx-agent-reports/…`。
3. **无 Workspace 模型**：`schema.prisma` 24 个 model 无 `Workspace`/`Membership`（`PLAN.md` 自认这是发布阻断项）。
4. **无 CI**：无 `.github/`（`PLAN.md` QA-01 把 CI 列为待建）。
5. `mysql-init` 注释称“no shared database credential”，但 docker-compose 默认库名与 relayx-clone 不同的 `tunex`——仅符号改名。

---

## 6. 安全 / 合规 / 交付评估

| 维度 | 状态 |
|---|---|
| 密钥管理 | ✅ 配置化，无内置默认；⚠️ 仍沿用 relayx 协议与 HKDF 标签 |
| 认证 | Cookie JWT(HS256) + Bearer API Key(需 business license)；RBAC 复刻原版；⚠️ `adminRequired`/`adminPermissionGuard` **仍以 `licenseService.isBusinessLicense()` 为闸门**（PLAN.md 列为需改） |
| 租户隔离 | ❌ 无 workspace 作用域，查询普遍 `findUnique(id)`，PLAN.md 判定为 P0 阻断 |
| 支付 | 代码完整（epay/bepusdt/heleket），但金额校验字段 `TODO(抓包)` 未确认，且无 `payments.enabled=false` 服务端开关（PLAN.md PAY-01 待做） |
| 测试/CI | ❌ 测试已全删，无 CI |
| 合规 | `PLAN.md` 第 20 行提示“固定密钥/授权仿真/协议逆向”的来源与许可风险，建议对外发布前做权利审查 |

---

## 7. 最终结论

1. **TuneX 确认为 relayx-clone 的克隆翻版**：153 个受控文件里 124 个逐字节相同，差异仅 29 个，且改动性质是“改名 + 密钥整改 + 删测试 + 加 PLAN.md”，**没有架构级重构**。
2. **开发文案/占位符大量残留**：`W1–W6` 周次标记 46 处、`W1 skeleton`、`TODO(抓包)`、`MOCK API` 徽标、`demo1234` 演示口令、`/opt/relayx-clone` 绝对路径、文档中的“复刻/clean-room/clone”定位声明。
3. **大量功能未实现**：10 个 cron 全占位、离线检测无消费者、`upgrade` no-op、admin 页面未完成、多协议仅存于枚举/模板。
4. **TuneX 的真实增量是“安全整改 + SaaS 规划”**：移除了上游固定 Fernet 密钥与弱默认口令，并新增了一份把“多租户 SaaS”列为目标的规划文档；但规划中的核心项（Workspace 隔离、真实 TCP 纵切片、CI、支付开关）**均未落地**。

### 若要真正“去克隆化 + 可发布”，最小必做项
1. 换掉 `github.com/relayx/agent` 模块路径与 `TunnelType.relayx`/`RELAYX_*`/`relayx-auth-v1` 命名，DB/容器改名。
2. 补 `Workspace/Membership` 模型并给所有查询加租户作用域（PLAN.md TEN-01/TEN-02）。
3. `adminRequired` 去掉 `isBusinessLicense()` 依赖（AUTHZ-01）。
4. 落实 worker 真实逻辑 + 离线检测消费者（OPS-01）。
5. 恢复测试 + 建 CI（QA-01）。
6. 清理全部开发周次标记、绝对路径与 mock 演示文案。
