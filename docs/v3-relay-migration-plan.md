# TuneX v3.0 RELAY 双跳架构改造方案

> 目标架构文档：`docs/v3-relay-migration-plan.md`（本文）
> 关联设计稿：`tunex-devmap-v3.docx`（v3.0 最终定稿 · 入口/出口节点架构）
> 实施分支：`feature/v3-relay-plan`（worktree：`/opt/TuneX-v3-plan`，基于 `main` @ `e14a300`）
> 范围：**只产出改造方案与代码骨架**，不在本文直接落库/改 main；每阶段验收通过后再合入。

---

## 目录

1. [现状代码基线（方案锚点）](#0-现状代码基线方案锚点)
2. [Schema 改造方案](#1-schema-改造方案)
3. [数据库迁移 SQL](#2-数据库迁移-sql)
4. [Agent 改造方案](#3-agent-改造方案)
5. [面板 → Agent 下发逻辑（tunnelOrchestrator）](#4-面板--agent-下发逻辑tunnelorchestrator)
6. [端口池改造（portPool）](#5-端口池改造portpool)
7. [API 接口改造](#6-api-接口改造)
8. [前端改造](#7-前端改造)
9. [兼容 / 回滚 / 灰度策略](#8-兼容--回滚--灰度策略)
10. [验收标准与测试矩阵](#9-验收标准与测试矩阵)
11. [开发顺序与交付切片](#10-开发顺序与交付切片)
12. [附录：变更文件清单与风险登记](#11-附录变更文件清单与风险登记)

---

## 0. 现状代码基线（方案锚点）

方案里的每处改造都对着当前 `main` 的真实代码，不写架空设计。

| 领域 | 当前实现 | v3.0 目标 | 改造性质 |
|---|---|---|---|
| 节点角色 | `Node` 表无角色概念；方向由 `NodeGroup.node_type`（`in`/`out`）表达 | `Node.role` = `ingress`/`egress`/`both`，**节点级**角色 | 新增列 + 双写 |
| 直连目标 | `Tunnel.forward_addresses`（JSON 数组，`host:port:weight`） | DIRECT 模式显式 `remote_host`/`remote_port`；RELAY 模式目标在 `EgressTarget` | 新增可空列，**从 `forward_addresses[0]` 回填** |
| 隧道模式 | 无模式字段，`out_node_group_id` 为空即单跳 | `Tunnel.tunnel_mode` = `direct`/`relay` | 新增列，默认 `direct` |
| 端口分配 | `backend/src/socket/port-allocator.ts`：**纯函数确定性**分配（`port_range` 内按序取号），无 Redis 锁、无黑名单 | 新增 `services/portPool.ts`：Redis `SET NX` 租约 + 端口黑名单 + ingress/egress 双池隔离 | 新增服务，**不替换**现有纯函数 |
| 下发通道 | `socket/config-pusher.ts`：`generateNodeConfig` → Fernet → Socket.IO `config` 事件（room = `node_group/<groupId>`） | 新增 HTTP 直连（`POST /tunnel`，agent 暴露 9090）+ 保留 Socket.IO 配置下发作为 DIRECT 兼容通道 | **双通道并存**，按模式分流 |
| Agent 数据面 | `agent/internal/engine`：解析 gost 配置 JSON，`runtime.go` 起 listener + `io.Copy`；`tryChain` 走 `chains` 里的 hops（即现有"出口"链路） | 新增 `forwarder/manager/api/reporter` 四层，RELAY 显式建模为 `relay`/`egress` Forwarder | **新增包**，engine 继续承载 DIRECT 与旧配置 |
| 节点在线判定 | Socket.IO `register`/`sysinfo`（10s）+ `socket/offline-detector.ts` 翻 `status=inactive` | 增加 `node.last_seen_at` 落库 + `reporter/heartbeat.go`（30s HTTP 上报，与 Socket.IO 并行） | **增量**，不推翻现有判定 |
| 出口目标 | `Tunnel.forward_addresses` 里直接写目标 | `EgressTarget` 挂在 **Node** 上，按 `weight`/`order_by` 负载均衡 | 新表 |

**关键取舍（与设计稿对齐的 3 条铁律）**：

1. **RELAY 下发顺序不可反**：先出口节点（`mode=EGRESS`），再入口节点（`mode=RELAY`）。出口未就绪就让入口监听 = 用户连上即断连。
2. **EgressTarget 只挂 Node，不挂 Tunnel**：RELAY 隧道的目标地址来自出口节点的目标池，改目标池 = 热更新，不重建隧道。
3. **软删除**：隧道/目标一律 `status` 翻转，不做物理删除；端口必须异步回收（TTL 兜底）。

---

## 1. Schema 改造方案

文件：`backend/prisma/schema.prisma`

### 1.1 新增枚举

```prisma
/// 节点角色（v3.0）：入口 / 出口 / 兼任。
/// 与 NodeGroup.node_type 的关系：node_type 仍是「节点组」的方向标签
/// （决定该组生成的 gost 配置形态），role 是「这台机器」的实际能力。
/// 两者不一致时以 role 为准（例：out 组里放一台 both 机器 = 该机器可兼任）。
enum NodeRole {
  ingress
  egress
  both
}

/// 隧道模式：DIRECT 单跳（入口直连目标）/ RELAY 双跳（入口→出口→目标池）。
enum TunnelMode {
  direct
  relay
}

/// 出口目标负载均衡策略（v0.3 只落地前两个，其余预留）。
enum LBStrategy {
  round
  rand
  // least_conn   // v1.1
  // least_traffic
  // ip_hash
  // weighted
}
```

### 1.2 Node 表改造

```prisma
model Node {
  id          Int      @id @default(autoincrement())
  weight      Int      @default(1)
  status      Status   @default(active)
  node_id     String   @unique @db.VarChar(255)
  connect_ip  String   @db.VarChar(255)
  version     String   @default("unknown") @db.VarChar(255)   // 已存在：register 上报
  backup      Boolean  @default(false)
  order_by    Float    @default(1000)
  custom_line String?  @db.VarChar(255)
  dns_status  Boolean  @default(false)
  created_at  DateTime @default(now())
  updated_at  DateTime @updatedAt

  /* ---------- v3.0 新增 ---------- */
  /// 节点角色。默认 ingress = 兼容存量部署（存量机器都是入口/出口混用组，
  /// 默认 ingress 保证 DIRECT 隧道零改动；出口节点由管理员显式改为 egress/both。
  role            NodeRole   @default(ingress)
  /// 最近一次心跳/上报时间（register、sysinfo、HTTP heartbeat 三者都会写）。
  /// 可空：从未上报过的机器为 NULL，不视为在线。
  last_seen_at    DateTime?  @db.DateTime(3)
  /// 该节点可用于隧道监听的端口区间（RELAY 的 ingressPort / egressPort 都从这里出）。
  /// 与 NodeGroup.port_range 的分工：group.port_range 是「组级默认」，
  /// node 级区间优先；缺省时回落到组级。
  port_range_min  Int        @default(10000)
  port_range_max  Int        @default(60000)
  /* ----------------------------- */

  node_group_id Int
  node_group    NodeGroup @relation(fields: [node_group_id], references: [id])

  /* ---------- v3.0 关联 ---------- */
  /// 该节点（作为出口）承载的目标池。
  egress_targets EgressTarget[]
  /// 以该节点为出口的 RELAY 隧道。
  relay_tunnels  Tunnel[]       @relation("relay_egress_node")

  /// 说明：`node_group_id`（任务清单里的 nodeGroupId）**当前 schema 已存在且非空**
  /// （`main` 的 Node model 第 295-296 行），v3.0 不改它的约束；改造的是它的**语义**：
  /// 从「节点方向标签」退化为「配置推送 room 归属」，方向判定改看 `role`。
  /// 一台节点仍只属于一个组（Socket.IO config 推送以组为 room）。

  @@index([role, status])
  @@index([last_seen_at])
  @@map("node")
}
```

> `version` 列**已存在**（`register` 时写入 `data.version`），无需新增；本文只补 `last_seen_at` 的**写入点**（§4.6 操作矩阵）。

### 1.3 EgressTarget 新表

```prisma
/// 出口节点的目标池（v3.0 核心新表）。
/// 语义：每个出口节点预置若干 `host:port` 目标，转发时按 weight 负载均衡。
/// RELAY 隧道**不存**目标地址——目标只在这里维护，改这里即热更新全部相关隧道。
model EgressTarget {
  id      Int    @id @default(autoincrement())
  /// 所属出口节点（必填；节点删除 → 目标池级联删除，依赖它的 RELAY 隧道被置 SUSPENDED）。
  node_id Int
  node    Node   @relation(fields: [node_id], references: [id], onDelete: Cascade)

  /// 目标主机名/IP（IPv6 不带方括号，与端口分列存储）。
  host   String @db.VarChar(255)
  port   Int
  /// 负载均衡权重（0 = 永久摘除，等价软停用，不删行）。
  weight Int      @default(1)
  /// 同权重内的展示/命中顺序。
  order_by Float  @default(1000)
  remark   String? @db.VarChar(255)

  status     Status   @default(active)
  created_at DateTime @default(now())
  updated_at DateTime @updatedAt

  /// 同一节点的 host:port 唯一：重复添加是幂等更新而非新增行。
  @@unique([node_id, host, port])
  @@index([node_id, status, order_by])
  @@map("egress_target")
}
```

### 1.4 Tunnel 表改造

```prisma
model Tunnel {
  /* ... 现有字段全部保留 ... */

  /* ---------- v3.0 新增 ---------- */
  /// 隧道模式。默认 direct = 存量隧道零改动（见 §2.3 数据回填）。
  tunnel_mode  TunnelMode @default(direct)

  /// RELAY 模式：出口节点 id（DIRECT 模式下为 NULL）。
  egress_node_id Int?
  egress_node    Node? @relation("relay_egress_node", fields: [egress_node_id], references: [id], onDelete: SetNull)

  /// RELAY 模式：出口节点上的内部监听端口（入口把流量转到这个口）。
  /// 与 listen_port 的关系：listen_port 面向用户（入口），egress_port 面向入口→出口
  /// 内网段，两者从各自节点的端口区间分配，允许同号（不同机器）。
  egress_port   Int?

  /// DIRECT 模式：显式目标地址（v3.0 语义化字段）。
  /// ⚠️ 当前 main 的 schema 里**没有** remote_host/remote_port 列，目录的是
  /// forward_addresses JSON。故这里是「新增可空列」而非「改可空」——
  /// 回填规则见 §2.3；旧代码路径继续读 forward_addresses，双写保证兼容。
  remote_host   String? @db.VarChar(255)
  remote_port   Int?
  /* ----------------------------- */

  // 现有：forward_addresses Json（保留！DIRECT 兼容路径 + 老前端仍读它）
  // 现有：in_node_group_id / out_node_group_id（保留，端口分配仍以组为维度）

  @@index([tunnel_mode, egress_node_id])
  @@map("tunnel")
}
```

**为什么 `remote_host/remote_port` 是新增而不是"改可空"**：`main` 当前 schema（902 行）中 `Tunnel` 只有 `forward_addresses Json` + `forward_addresses_protocol Json?`，没有任何 `remote_*` 列。RelayX 原版的 `remoteHost/remotePort` 语义在 TuneX 里被 JSON 数组承载。v3.0 需要把 DIRECT 的单目标语义显式化（RELAY 模式下 `forward_addresses` 无意义，会出现"目标配在隧道上"的歧义），因此新增可空列并双写。

### 1.5 双写规则（兼容的关键）

| 字段 | DIRECT | RELAY | 谁读 |
|---|---|---|---|
| `forward_addresses` | 写 `["host:port"]` | 写 `[]`（空数组，避免旧引擎误当直连目标） | 旧 `config-generator`（DIRECT 通道） |
| `remote_host/port` | 写目标 | NULL | v3.0 新代码、前端展示 |
| `egress_node_id/port` | NULL | 出口节点 id / 内部端口 | v3.0 新代码 |
| `out_node_group_id` | 保持现状（可为 NULL 或出口组） | 仍写入出口节点所属组（**复用组级配置推送能力**，见 §4.4） | 现有推送/刷新逻辑 |

---

## 2. 数据库迁移 SQL

迁移目录：`backend/prisma/migrations/20260926xxxxxx_v3_relay_architecture/migration.sql`
（命名沿用现有 `YYYYMMDDHHMMSS_描述` 风格；本方案定稿后由 `prisma migrate dev` 生成，下方为**期望内容与数据回填**，必须人工核对。）

### 2.1 表结构变更

```sql
-- v3.0 RELAY 双跳架构：节点角色 / 出口目标池 / 隧道模式
-- 兼容式迁移（与本仓 migration 风格一致）：只加可空列、只加新表、只加枚举值，
-- 不删列不改旧列约束。存量 DIRECT 隧道零数据订正即可继续工作。

/* ---------------- 新表：egress_target ---------------- */
CREATE TABLE `egress_target` (
  `id` int NOT NULL AUTO_INCREMENT,
  `node_id` int NOT NULL,
  `host` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `port` int NOT NULL,
  `weight` int NOT NULL DEFAULT '1',
  `order_by` double NOT NULL DEFAULT '1000',
  `remark` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` enum('active','inactive') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `egress_target_node_id_host_port_key` (`node_id`,`host`,`port`),
  KEY `egress_target_node_id_status_order_by_idx` (`node_id`,`status`,`order_by`),
  CONSTRAINT `egress_target_node_id_fkey` FOREIGN KEY (`node_id`)
    REFERENCES `node` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ---------------- node：角色 + 心跳 + 端口区间 ---------------- */
ALTER TABLE `node`
  ADD COLUMN `role` enum('ingress','egress','both') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'ingress' AFTER `dns_status`,
  ADD COLUMN `last_seen_at` datetime(3) NULL AFTER `role`,
  ADD COLUMN `port_range_min` int NOT NULL DEFAULT '10000' AFTER `last_seen_at`,
  ADD COLUMN `port_range_max` int NOT NULL DEFAULT '60000' AFTER `port_range_min`,
  ADD KEY `node_role_status_idx` (`role`,`status`),
  ADD KEY `node_last_seen_at_idx` (`last_seen_at`);

/* ---------------- tunnel：模式 + 出口 + 显式目标 ---------------- */
ALTER TABLE `tunnel`
  ADD COLUMN `tunnel_mode` enum('direct','relay') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'direct' AFTER `status`,
  ADD COLUMN `egress_node_id` int NULL AFTER `tunnel_mode`,
  ADD COLUMN `egress_port` int NULL AFTER `egress_node_id`,
  ADD COLUMN `remote_host` varchar(255) COLLATE utf8mb4_unicode_ci NULL AFTER `egress_port`,
  ADD COLUMN `remote_port` int NULL AFTER `remote_host`,
  ADD KEY `tunnel_egress_node_id_fkey` (`egress_node_id`),
  ADD KEY `tunnel_tunnel_mode_egress_node_id_idx` (`tunnel_mode`,`egress_node_id`),
  ADD CONSTRAINT `tunnel_egress_node_id_fkey` FOREIGN KEY (`egress_node_id`)
    REFERENCES `node` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
```

MySQL 的 `ADD COLUMN ... AFTER x` 仅为可读性；与 schema.prisma 的字段顺序保持一致即可（Prisma 不校验物理顺序）。

### 2.2 lb_strategy 归属

`LBStrategy` 枚举（`round`/`rand`）不单独建表列，而是**存在出口节点上**（`EgressTarget` 的聚合行为由节点决定）：

```sql
ALTER TABLE `node`
  ADD COLUMN `lb_strategy` enum('round','rand') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'round' AFTER `port_range_max`;
```

同时在 `schema.prisma` 的 `Node` 上补：

```prisma
  /// 该出口节点的目标池负载均衡策略（只对 role ∈ {egress, both} 有意义）。
  lb_strategy LBStrategy @default(round)
```

### 2.3 现有数据回填（一次性，幂等）

```sql
-- 3) 存量隧道默认 DIRECT：列默认值已覆盖，无需 UPDATE。
--    但 remote_host/remote_port 需要从 forward_addresses[0] 回填，
--    否则 DIRECT 隧道在新代码里「没有目标」。
--    forward_addresses 形如 ["1.2.3.4:8080"] 或 [{"address":"..","weight":..}]。

UPDATE `tunnel` t
SET t.`remote_host` = SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(t.`forward_addresses`, '$[0]')), ':', 1),
    t.`remote_port` = CAST(SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(t.`forward_addresses`, '$[0]')), ':', -1) AS UNSIGNED)
WHERE t.`tunnel_mode` = 'direct'
  AND JSON_LENGTH(COALESCE(t.`forward_addresses`, JSON_ARRAY())) > 0
  AND t.`remote_host` IS NULL;
```

注意事项：

- `forward_addresses` 在本仓同时支持**字符串数组**与**对象数组**（见 `config-generator.ts#normalizeForwardAddresses`）。上面的 `SUBSTRING_INDEX` 只对**字符串形态**生效；对象形态（`{"address": "...", "weight": n}`）的存量数据用下面的脚本兜底：

```sql
-- 对象形态兜底：'{...,"address":"host:port"}' → 取 $.address 字段
UPDATE `tunnel` t
SET t.`remote_host` = SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(t.`forward_addresses`, '$[0].address')), ':', 1),
    t.`remote_port` = CAST(SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(t.`forward_addresses`, '$[0].address')), ':', -1) AS UNSIGNED)
WHERE t.`tunnel_mode` = 'direct'
  AND t.`remote_host` IS NULL
  AND JSON_TYPE(JSON_EXTRACT(t.`forward_addresses`, '$[0]')) = 'OBJECT';
```

- 回填脚本**必须幂等**（`remote_host IS NULL` 条件），重跑不产生副作用。
- `egress_port` 不回填：存量 RELAY 形态（`out_node_group_id` + `tunnel:out_listen` 缓存）继续走 Socket.IO 通道，`egress_port` 只对 v3.0 新建 RELAY 隧道有意义（§4.4 双通道说明）。

### 2.4 回滚 SQL

```sql
-- 回滚（仅在 v3.0 功能未产生 RELAY 数据时安全）：
--   1. 删除全部 RELAY 隧道 / egress_target（端口已由 TTL 回收，无残留锁）
--   2. DROP 新列新表
-- DELETE FROM `tunnel` WHERE `tunnel_mode` = 'relay';
-- DELETE FROM `egress_target`;
-- ALTER TABLE `tunnel` DROP FOREIGN KEY `tunnel_egress_node_id_fkey`;
-- ALTER TABLE `tunnel` DROP KEY `tunnel_tunnel_mode_egress_node_id_idx`;
-- ALTER TABLE `tunnel` DROP COLUMN `remote_port`, DROP COLUMN `remote_host`,
--   DROP COLUMN `egress_port`, DROP COLUMN `egress_node_id`, DROP COLUMN `tunnel_mode`;
-- ALTER TABLE `node` DROP COLUMN `lb_strategy`, DROP COLUMN `port_range_max`,
--   DROP COLUMN `port_range_min`, DROP COLUMN `last_seen_at`, DROP COLUMN `role`;
-- DROP TABLE `egress_target`;
```

> 若线上已经出现 RELAY 隧道，回滚必须先把这些隧道在两侧 agent 上下线（orchestrator 的 teardown），否则回滚后 agent 上残留监听且面板不再管理它们。

---

## 3. Agent 改造方案（`agent/`）

### 3.0 目录目标结构

```
agent/
├── main.go                          # 入口：启动前先 restore（§3.7），再接 Socket.IO
├── internal/
│   ├── forwarder/
│   │   ├── interface.go             # 【改】TunnelConfig + Forwarder 接口 + Target/LBStrategy 类型
│   │   ├── direct.go                # 【新】DIRECT：:ingressPort → remoteHost:remotePort
│   │   ├── relay.go                 # 【新】RELAY  ：:ingressPort → nextHop（出口节点）
│   │   ├── egress.go                # 【新】EGRESS：:egressPort → 目标池（按策略）
│   │   └── pipe.go                  # 【新】双向 io.Copy 封装（含计数，三种 Forwarder 共用）
│   ├── manager/
│   │   ├── tunnel.go                # 【新】TunnelManager：map[id]Forwarder，增删查
│   │   ├── egress.go                # 【新】EgressManager：目标池 + LoadBalancer + 热更新
│   │   └── lb.go                    # 【新】LoadBalancer（round / rand；接口预留 4 种）
│   ├── api/
│   │   └── server.go                # 【新】HTTP 管理面（:9090，Bearer Token 鉴权）
│   ├── reporter/
│   │   └── heartbeat.go             # 【新】v0.3：30s 上报版本/角色/端口占用
│   ├── engine/                      # 【不动】继续承载 Socket.IO gost 配置（DIRECT 兼容）
│   ├── agent/                       # 【改】register 后按 role 决定启动哪些组件
│   └── agentconfig/                 # 【改】新增 ROLE / PANEL_PORT / INTERNAL_PORT 等
```

### 3.1 `forwarder/interface.go`（改造）

```go
package forwarder

import "context"

// TunnelMode 与面板 schema 的 TunnelMode 枚举严格对应。
// 大小写不敏感解析（见 ParseMode），避免 Go 侧与 TS 侧命名风格差异导致 400。
type TunnelMode string

const (
	ModeDirect TunnelMode = "DIRECT"
	ModeRelay  TunnelMode = "RELAY"
	ModeEgress TunnelMode = "EGRESS"
)

func ParseMode(s string) (TunnelMode, bool) {
	switch toUpperASCII(s) {
	case "DIRECT", "D":
		return ModeDirect, true
	case "RELAY", "R":
		return ModeRelay, true
	case "EGRESS", "E", "EGRESS_TARGET":
		return ModeEgress, true
	}
	return "", false
}

// LBStrategy 负载均衡策略（v3.0 落地 round/rand）。
type LBStrategy string

const (
	LBRound  LBStrategy = "round"
	LBRandom LBStrategy = "rand"
)

// Target 是出口目标池中的一项（对应 EgressTarget 行）。
type Target struct {
	ID      int    `json:"id"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
	Weight  int    `json:"weight"`
	OrderBy int    `json:"order_by"`
	Status  string `json:"status"` // active / inactive，inactive 直接跳过
}

// Addr 返回 "host:port"（IPv6 自动加方括号）。
func (t Target) Addr() string { return joinHostPort(t.Host, t.Port) }

// Active 权重 > 0 且状态 active 才参与转发。
func (t Target) Active() bool { return t.Weight > 0 && t.Status == "active" }

// TunnelConfig 是面板下发的单条隧道指令（POST /tunnel 的 body）。
// 字段按模式裁剪：DIRECT 用 IngressPort/Remote*；RELAY 用 IngressPort/NextHop；
// EGRESS 用 EgressPort/Targets/LBStrategy。
type TunnelConfig struct {
	ID          int        `json:"id"`
	Mode        TunnelMode `json:"mode"`

	// 用户侧监听端口（DIRECT / RELAY 模式）。
	IngressPort int    `json:"ingress_port"`
	IngressIP   string `json:"ingress_ip,omitempty"` // 默认 0.0.0.0

	// DIRECT：目标地址。
	RemoteHost string `json:"remote_host,omitempty"`
	RemotePort int    `json:"remote_port,omitempty"`

	// RELAY：下一跳 = 出口节点 ip:egressPort。
	NextHop string `json:"next_hop,omitempty"`

	// EGRESS：内部监听端口 + 目标池。
	EgressPort int       `json:"egress_port,omitempty"`
	Targets    []Target  `json:"targets,omitempty"`
	LBStrategy LBStrategy `json:"lb_strategy,omitempty"`

	// 通用。
	Protocol  string `json:"protocol,omitempty"` // tcp / udp（v0.3 只支持 tcp；udp 走 engine 通道）
	SpeedLimit int64 `json:"speed_limit,omitempty"` // kbps，-1 = 不限（v1.0 limiter）

	// EgressNodeID 供 agent 侧做「只接受指定来源」校验（§3.6）。
	EgressNodeID int    `json:"egress_node_id,omitempty"`
	IngressIPs   []string `json:"ingress_ips,omitempty"`
}

// DialerFunc 便于测试注入（不发起真实网络）。
type DialerFunc func(ctx context.Context, addr string) (Conn, error)

// Conn 抽象 net.Conn（测试可用内存实现替换）。
type Conn interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	Close() error
}

// Forwarder 所有模式必须实现的接口（开发规范第 4 条）。
type Forwarder interface {
	// Start 开始监听并接受连接，立即返回；监听失败返回 error。
	Start() error
	// Stop 停止监听、关闭所有活跃连接并释放端口（幂等）。
	Stop() error
	// Stats 已转发总字节数（atomic 读）。
	Stats() int64
	// Mode 返回该 Forwarder 的模式（调试/上报用）。
	Mode() TunnelMode
}
```

#### 通用骨架 `pipe.go`

```go
package forwarder

import (
	"io"
	"net"
	"sync/atomic"
	"time"
)

// countedConn 包装 net.Conn，把所有字节累计到 ctr。
type countedConn struct {
	net.Conn
	ctr *atomic.Int64
}

func (c countedConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.ctr.Add(int64(n))
	}
	return n, err
}

func (c countedConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	if n > 0 {
		c.ctr.Add(int64(n))
	}
	return n, err
}

// pipe 双向转发，任一侧关闭即收尾（与 engine/runtime.go 的 pipe 语义一致）。
func pipe(a, b net.Conn, ctr *atomic.Int64) {
	defer a.Close()
	defer b.Close()
	ca, cb := countedConn{a, ctr}, countedConn{b, ctr}
	done := make(chan struct{}, 2)
	go func() { io.Copy(ca, cb); done <- struct{}{} }()
	go func() { io.Copy(cb, ca); done <- struct{}{} }()
	<-done
}

// dial 带 10s 超时的 TCP 拨号（与现有 engine 保持一致的手感）。
func dial(ctx context.Context, addr string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "tcp", addr)
}

func joinHostPort(host string, port int) string {
	// 复用 net.JoinHostPort 的 IPv6 方括号处理
	return net.JoinHostPort(host, itoa(port))
}
```

### 3.2 三种 Forwarder 实现

#### `direct.go`（对应现有 DIRECT 通道的显式化版本）

```go
package forwarder

// DirectForwarder 监听 ingressPort，把每条连接转到 remoteHost:remotePort。
// 与 engine/runtime.go 的 forwarder 逻辑等价，区别是：这里的指令来自 HTTP
// POST /tunnel（v3.0 新通道），不依赖 Socket.IO 配置整包下发。
type DirectForwarder struct {
	cfg    TunnelConfig
	ln     net.Listener
	ctr    atomic.Int64
	closed atomic.Bool
	sem    chan struct{} // 连接并发上限（0 = 不限）
}

func NewDirect(cfg TunnelConfig) (*DirectForwarder, error) {
	if cfg.IngressPort <= 0 || cfg.RemoteHost == "" || cfg.RemotePort <= 0 {
		return nil, fmt.Errorf("direct: ingress_port/remote_host/remote_port required")
	}
	return &DirectForwarder{cfg: cfg}, nil
}

func (f *DirectForwarder) Start() error {
	ln, err := net.Listen("tcp", joinHostPort(f.cfg.IngressIP, f.cfg.IngressPort))
	if err != nil {
		return err
	}
	f.ln = ln
	go f.acceptLoop()
	return nil
}

func (f *DirectForwarder) acceptLoop() {
	for {
		c, err := f.ln.Accept()
		if err != nil {
			if f.closed.Load() {
				return
			}
			time.Sleep(50 * time.Millisecond)
			continue // 瞬时 accept 错误不退出
		}
		go func(c net.Conn) {
			defer c.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			up, err := dial(ctx, joinHostPort(f.cfg.RemoteHost, f.cfg.RemotePort))
			if err != nil {
				return // 目标不可达：连接闭掉，面板侧能从 ErrNoTarget 观测
			}
			pipe(c, up, &f.ctr)
		}(c)
	}
}

func (f *DirectForwarder) Stop() error {
	f.closed.Store(true)
	if f.ln != nil {
		return f.ln.Close()
	}
	return nil
}

func (f *DirectForwarder) Stats() int64      { return f.ctr.Load() }
func (f *DirectForwarder) Mode() TunnelMode  { return ModeDirect }
```

#### `relay.go`（新）

```go
package forwarder

// RelayForwarder 入口侧：监听 ingressPort，把流量转到 nextHop（= 出口节点
// ip:egressPort）。入口**不知道**最终目标是谁——目标池在出口节点上。
type RelayForwarder struct {
	cfg     TunnelConfig
	ln      net.Listener
	ctr     atomic.Int64
	closed  atomic.Bool
}

func NewRelay(cfg TunnelConfig) (*RelayForwarder, error) {
	if cfg.IngressPort <= 0 || cfg.NextHop == "" {
		return nil, fmt.Errorf("relay: ingress_port/next_hop required")
	}
	if err := validateHostPort(cfg.NextHop); err != nil {
		return nil, fmt.Errorf("relay: bad next_hop: %w", err)
	}
	return &RelayForwarder{cfg: cfg}, nil
}

func (f *RelayForwarder) Start() error {
	ln, err := net.Listen("tcp", joinHostPort(f.cfg.IngressIP, f.cfg.IngressPort))
	if err != nil {
		return err
	}
	f.ln = ln
	go f.acceptLoop()
	return nil
}

// acceptLoop 与 Direct 的唯一差别是 dial 的目标：nextHop。
func (f *RelayForwarder) acceptLoop() {
	for {
		c, err := f.ln.Accept()
		if err != nil {
			if f.closed.Load() {
				return
			}
			time.Sleep(50 * time.Millisecond)
			continue
		}
		go func(c net.Conn) {
			defer c.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			up, err := dial(ctx, f.cfg.NextHop)
			if err != nil {
				// 出口不可达：入口这里只能断连。故障由面板心跳/出口目标健康检查暴露。
				return
			}
			pipe(c, up, &f.ctr)
		}(c)
	}
}

func (f *RelayForwarder) Stop() error      { f.closed.Store(true); return closeIfSet(&f.ln) }
func (f *RelayForwarder) Stats() int64     { return f.ctr.Load() }
func (f *RelayForwarder) Mode() TunnelMode { return ModeRelay }
```

#### `egress.go`（新）

```go
package forwarder

// EgressForwarder 出口侧：监听 egressPort，按 LoadBalancer 从目标池选目标。
// 关键点：**目标池是运行时可变对象**（指针），热更新 Targets 时
// LoadBalancer.UpdateTargets 原子替换内部快照 → 所有在用 Forwarder 立即生效，
// 无需 Stop/Start（这正是"改目标不重建隧道"的落点）。
type EgressForwarder struct {
	cfg     TunnelConfig
	lb      *manager.LoadBalancer // 与 EgressManager 共享同一个实例
	ln      net.Listener
	ctr     atomic.Int64
	closed  atomic.Bool
}

func NewEgress(cfg TunnelConfig, lb *manager.LoadBalancer) (*EgressForwarder, error) {
	if cfg.EgressPort <= 0 {
		return nil, fmt.Errorf("egress: egress_port required")
	}
	if lb == nil || len(lb.Snapshot()) == 0 {
		return nil, fmt.Errorf("egress: empty target pool")
	}
	return &EgressForwarder{cfg: cfg, lb: lb}, nil
}

func (f *EgressForwarder) Start() error {
	ln, err := net.Listen("tcp", joinHostPort(f.cfg.IngressIP, f.cfg.EgressPort))
	if err != nil {
		return err
	}
	f.ln = ln
	go f.acceptLoop()
	return nil
}

func (f *EgressForwarder) acceptLoop() {
	for {
		c, err := f.ln.Accept()
		if err != nil {
			if f.closed.Load() {
				return
			}
			time.Sleep(50 * time.Millisecond)
			continue
		}
		// §3.6 来源白名单：egressPort 只接受对应入口节点 IP。
		if !f.allowPeer(c.RemoteAddr()) {
			c.Close()
			continue
		}
		go func(c net.Conn) {
			defer c.Close()
			// 单连接内固定一个目标（连接级亲和）：TCP 长连接中途换目标会中断流。
			tgt, ok := f.lb.Pick()
			if !ok {
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			up, err := dial(ctx, tgt.Addr())
			if err != nil {
				// 目标不可达：换一个再试（最多 N 次），与现有 engine 的
				//「多节点轮转」语义一致。
				for i := 0; i < len(f.lb.Snapshot()); i++ {
					if tgt2, ok2 := f.lb.Pick(); ok2 && tgt2.Addr() != tgt.Addr() {
						if up2, err2 := dial(ctx, tgt2.Addr()); err2 == nil {
							pipe(c, up2, &f.ctr)
							return
						}
					}
				}
				return
			}
			pipe(c, up, &f.ctr)
		}(c)
	}
}

func (f *EgressForwarder) Stop() error      { f.closed.Store(true); return closeIfSet(&f.ln) }
func (f *EgressForwarder) Stats() int64     { return f.ctr.Load() }
func (f *EgressForwarder) Mode() TunnelMode { return ModeEgress }
```

> `import cycle` 提示：`forwarder` 需要 `manager.LoadBalancer`，而 `manager` 又持有 `forwarder.Forwarder`。解法：把 `LoadBalancer` 接口定义在 `forwarder` 包（`forwarder/lb.go`），`manager` 依赖 `forwarder` 单向；或让 `EgressForwarder` 持有一个 `TargetPicker func() (Target, bool)` 闭包。**推荐后者**，包依赖保持 `manager → forwarder` 单向。

### 3.3 `manager/tunnel.go` + `manager/lb.go` + `manager/egress.go`

```go
package manager

// ---------- lb.go ----------

// Picker 抽象（避免 forwarder ↔ manager 循环依赖）。
type Picker interface {
	Pick() (forwarder.Target, bool)
	Snapshot() []forwarder.Target
}

// LoadBalancer 目标池负载均衡。内部快照不可变，UpdateTargets 整体替换。
type LoadBalancer struct {
	mu       sync.RWMutex
	strategy LBStrategy
	targets  []forwarder.Target // 仅 active
	counter  atomic.Uint64
}

func NewLoadBalancer(strategy LBStrategy, targets []forwarder.Target) *LoadBalancer {
	lb := &LoadBalancer{strategy: strategy}
	lb.set(targets)
	return lb
}

// UpdateTargets 热更新：校验 → 整体替换。调用方持 EgressManager 的写锁。
func (lb *LoadBalancer) UpdateTargets(strategy LBStrategy, targets []forwarder.Target) error {
	if len(filterActive(targets)) == 0 {
		return fmt.Errorf("target pool would be empty; refuse (availability guard)")
	}
	lb.mu.Lock()
	defer lb.mu.Unlock()
	lb.strategy = strategy
	lb.targets = filterActive(targets)
	return nil
}

func (lb *LoadBalancer) Pick() (forwarder.Target, bool) {
	lb.mu.RLock()
	defer lb.mu.RUnlock()
	if len(lb.targets) == 0 {
		return forwarder.Target{}, false
	}
	switch lb.strategy {
	case LBRandom:
		return lb.targets[rand.Intn(len(lb.targets))], true
	default: // round
		i := lb.counter.Add(1) - 1
		return lb.targets[int(i)%len(lb.targets)], true
	}
}

// WeightedRound 加权轮询（v1.1）：展开 weight 后取模；v0.3 用上面的 Pick。
// func (lb *LoadBalancer) PickWeighted() (forwarder.Target, bool) { ... }

func (lb *LoadBalancer) Snapshot() []forwarder.Target {
	lb.mu.RLock()
	defer lb.mu.RUnlock()
	out := make([]forwarder.Target, len(lb.targets))
	copy(out, lb.targets)
	return out
}

func filterActive(in []forwarder.Target) []forwarder.Target {
	out := in[:0:0]
	for _, t := range in {
		if t.Active() {
			out = append(out, t)
		}
	}
	return out
}
```

```go
package manager

// ---------- egress.go ----------

// EgressManager 出口侧专属：按「出口节点」管理目标池 + 该节点上所有
// EGRESS Forwarder。面板热更新 /node/targets 时只动这里，不动 Forwarder。
type EgressManager struct {
	mu      sync.RWMutex
	nodeID  int
	lb      *LoadBalancer
	pools   map[int][]forwarder.Target // tunnelID → 该隧道锁定的目标快照（审计用）
	fwds    map[int]forwarder.Forwarder // tunnelID → EgressForwarder
}

func NewEgressManager(nodeID int, strategy LBStrategy, initial []forwarder.Target) (*EgressManager, error) {
	lb := NewLoadBalancer(strategy, initial)
	if len(lb.Snapshot()) == 0 {
		return nil, fmt.Errorf("egress node %d: empty target pool", nodeID)
	}
	return &EgressManager{nodeID: nodeID, lb: lb, pools: map[int][]forwarder.Target{}, fwds: map[int]forwarder.Forwarder{}}, nil
}

// AddTunnel 面板下发 mode=EGRESS 时调用：为该隧道建 EgressForwarder，
// 共享同一个 LoadBalancer（→ 后续热更新自动覆盖它）。
func (m *EgressManager) AddTunnel(cfg forwarder.TunnelConfig) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, dup := m.fwds[cfg.ID]; dup {
		return fmt.Errorf("egress tunnel %d already exists", cfg.ID)
	}
	f, err := forwarder.NewEgressWithPicker(cfg, m.lb) // 用闭包注入，避免循环依赖
	if err != nil {
		return err
	}
	if err := f.Start(); err != nil {
		return err
	}
	m.fwds[cfg.ID] = f
	m.pools[cfg.ID] = m.lb.Snapshot()
	return nil
}

// RemoveTunnel 隧道删除/暂停。
func (m *EgressManager) RemoveTunnel(tunnelID int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	f := m.fwds[tunnelID]
	if f == nil {
		return nil // 幂等
	}
	delete(m.fwds, tunnelID)
	delete(m.pools, tunnelID)
	return f.Stop()
}

// UpdateTargets 热更新目标池（PATCH /node/targets）。
// 不重建任何 Forwarder：它们在 Pick() 时才读最新快照。
func (m *EgressManager) UpdateTargets(strategy LBStrategy, targets []forwarder.Target) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.lb.UpdateTargets(strategy, targets); err != nil {
		return err
	}
	for id := range m.pools {
		m.pools[id] = m.lb.Snapshot()
	}
	return nil
}

// Targets 当前生效的目标池（面板 GET /api/internal/nodes/:id/targets 用）。
func (m *EgressManager) Targets() []forwarder.Target { return m.lb.Snapshot() }
```

### 3.4 `api/server.go`（agent 管理面）

端口：`9090`（与设计稿一致；`9191` 是 agent **上报**面板的内部端口，见 §3.5）。
鉴权：`Authorization: Bearer <AGENT_TOKEN>`，每节点独立 token（面板建节点时生成）。

```go
package api

// Router 注册 agent 侧管理端点。所有 handler 走 requireAuth。
//
//   POST   /tunnel          下发隧道（mode = DIRECT / RELAY / EGRESS）
//   DELETE /tunnel/:id      下线隧道（两端各自调用自己的）
//   GET    /tunnels         本节点当前活跃隧道（启动恢复 / 面板对账）
//   PATCH  /node/targets    热更新出口目标池（仅出口节点有意义）
//   GET    /node/targets    当前目标池
//   GET    /health          面板心跳用
func Router(deps Deps) http.Handler {
	mux := http.NewServeMux()
	h := &handler{deps: deps}

	mux.HandleFunc("POST /tunnel", h.withAuth(h.createTunnel))
	mux.HandleFunc("DELETE /tunnel/{id}", h.withAuth(h.deleteTunnel))
	mux.HandleFunc("GET /tunnels", h.withAuth(h.listTunnels))
	mux.HandleFunc("PATCH /node/targets", h.withAuth(h.patchTargets))
	mux.HandleFunc("GET /node/targets", h.withAuth(h.getTargets))
	mux.HandleFunc("GET /health", h.health) // 免鉴权（只回 ok + role）
	return mux
}

type Deps struct {
	NodeID       int
	Role         NodeRole
	Token        string
	TunnelMgr    *manager.TunnelManager // 入口侧（DIRECT/RELAY）
	EgressMgr    *manager.EgressManager // 出口侧（可为 nil）
	Reporter     *reporter.Heartbeat
}

// createTunnel 按 mode 三分支（这就是「区分三种下发」的落点）。
func (h *handler) createTunnel(w http.ResponseWriter, r *http.Request) {
	var cfg forwarder.TunnelConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	mode, ok := forwarder.ParseMode(string(cfg.Mode))
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "unknown mode"})
		return
	}

	switch mode {
	case forwarder.ModeDirect, forwarder.ModeRelay:
		// 入口侧：role 必须是 ingress / both
		if h.deps.Role == NodeRoleEgress {
			writeJSON(w, 409, map[string]string{"error": "this node is egress-only"})
			return
		}
		if err := h.deps.TunnelMgr.Add(cfg); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
	case forwarder.ModeEgress:
		// 出口侧：必须已初始化 EgressManager（role egress/both 且目标池非空）
		if h.deps.EgressMgr == nil {
			writeJSON(w, 409, map[string]string{"error": "egress not configured"})
			return
		}
		if err := h.deps.EgressMgr.AddTunnel(cfg); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "id": cfg.ID, "mode": mode})
}

// patchTargets 热更新：改目标池后**不需要**触碰任何 Forwarder。
func (h *handler) patchTargets(w http.ResponseWriter, r *http.Request) {
	if h.deps.EgressMgr == nil {
		writeJSON(w, 409, map[string]string{"error": "egress not configured"})
		return
	}
	var body struct {
		Strategy string             `json:"lb_strategy"`
		Targets  []forwarder.Target `json:"targets"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	strategy := LBStrategy(strategyOr(body.Strategy, string(LBRound)))
	if err := h.deps.EgressMgr.UpdateTargets(strategy, body.Targets); err != nil {
		// 空目标池会被拒绝（availability guard），返回 409 让面板回滚编辑
		writeJSON(w, 409, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "targets": h.deps.EgressMgr.Targets()})
}

func (h *handler) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "node_id": h.deps.NodeID, "role": h.deps.Role})
}

func (h *handler) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || subtle.ConstantTimeCompare([]byte(tok), []byte(h.deps.Token)) != 1 {
			writeJSON(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		next(w, r)
	}
}
```

**REST 风格说明**：开发规范说「接口定义先行，路径对照设计稿第 6 节」。设计稿写的是 `POST /tunnel` + `PATCH /node/targets`，Go 1.22 的 `mux.HandleFunc("DELETE /tunnel/{id}")` 方法+路径模式可读性更好；若要与设计稿字节级对齐，把 `{id}` 换成 `:id` 并自行切路径。**建议保持 Go 1.22 原生语法**（`go 1.22` 已声明支持），面板侧 URL 不变。

### 3.5 `reporter/heartbeat.go`（新，v0.3）

```go
package reporter

// Heartbeat 周期性向面板上报节点状态（与 Socket.IO 的 sysinfo 并存：
// sysinfo 是配置面存活信号，heartbeat 是 HTTP 管理面存活信号，双通道冗余）。
type Heartbeat struct {
	panelURL  string        // 例：http://panel:3001
	token     string        // AGENT_TOKEN
	nodeID    int
	role      string
	interval  time.Duration // 默认 30s
	client    *http.Client
	version   string

	tunnels func() int // 活跃隧道数（由 manager 注入，便于面板展示）
	egress  bool       // 是否已初始化目标池
}

func NewHeartbeat(cfg HeartbeatConfig) *Heartbeat { /* ... */ }

func (h *Heartbeat) Run(ctx context.Context) {
	t := time.NewTicker(h.interval)
	defer t.Stop()
	h.send(ctx) // 立即发一次，面板马上把 last_seen_at 写上当次
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.send(ctx)
		}
	}
}

func (h *Heartbeat) send(ctx context.Context) {
	body := map[string]any{
		"node_id":        h.nodeID,
		"role":           h.role,
		"version":        h.version,
		"tunnels":        h.tunnels(),
		"egress_ready":   h.egress,
		"ts":             time.Now().Unix(),
		"active_ports":   manager.ActivePorts(), // 入口/出口端口占用，便于面板对账
	}
	req, _ := http.NewRequestWithContext(ctx, "POST", h.panelURL+"/api/internal/heartbeat", jsonBody(body))
	req.Header.Set("Authorization", "Bearer "+h.token)
	resp, err := h.client.Do(req)
	if err != nil {
		logx.Debug("heartbeat failed", "err", err.Error())
		return // 失败不重试、不 panic；面板用 last_seen_at 老化判定离线
	}
	resp.Body.Close()
}
```

面板侧对应端点（见 §6.4）：`POST /api/internal/heartbeat` → `node.last_seen_at = now()`。
面板侧老化 job：`last_seen_at < now() - 90s` → `status = inactive`（**只改状态，不迁移隧道**，对齐设计稿）。

### 3.6 安全边界：egressPort 来源白名单

```go
// allowPeer 校验入栈 IP 是否在「允许的入口节点 IP」名单内。
// 面板在 mode=EGRESS 指令里带 ingress_ips（该隧道所配入口节点的 connect_ip）。
func (f *EgressForwarder) allowPeer(remote net.Addr) bool {
	if len(f.cfg.IngressIPs) == 0 {
		return true // 未配置名单 = 不做限制（兼容旧部署）；生产应在面板强制填
	}
	host, _, err := net.SplitHostPort(remote.String())
	if err != nil {
		return false
	}
	for _, allowed := range f.cfg.IngressIPs {
		if host == allowed {
			return true
		}
	}
	return false
}
```

### 3.7 启动恢复逻辑（main.go 改造）

```go
// 恢复时序（agent 重启 / 网络闪断后重连）：
//   1. 连面板 Socket.IO → register（拿 license + 绑定 node_group）
//   2. GET http://panel:3001/api/internal/nodes/:id/tunnels   ← 拉 ACTIVE 隧道
//   3. 若本节点 role ∈ {egress, both}：
//        同一次响应（或 GET /api/internal/nodes/:id/targets）带回 EgressTarget 池
//        → NewEgressManager(...) 初始化目标池（**必须先有目标池**，否则 EGRESS 隧道起不来）
//   4. 逐条隧道按 mode 重建：
//        DIRECT → TunnelMgr.Add（入口）
//        RELAY  → 入口：NextHop 配在指令里；出口：EgressMgr.AddTunnel
//        EGRESS → EgressMgr.AddTunnel（同一目标池，多条隧道共享）
//   5. 起点容错：端口被占（旧连接未释放）→ 重试 3 次，间隔 1s；再失败记 error 事件，
//      面板侧该隧道显示「恢复失败」，用户可手动重启。
func (a *Agent) restore(ctx context.Context) error {
	tunnels, err := a.panelClient.ActiveTunnels(a.cfg.NodeID)
	if err != nil {
		return err
	}
	if a.role == NodeRoleEgress || a.role == NodeRoleBoth {
		targets, err := a.panelClient.EgressTargets(a.cfg.NodeID)
		if err != nil {
			return err
		}
		if len(targets) == 0 && a.role == NodeRoleEgress {
			return fmt.Errorf("egress node %d has no target pool; cannot recover", a.cfg.NodeID)
		}
		em, err := manager.NewEgressManager(a.cfg.NodeID, targets.strategy, targets.items)
		if err != nil {
			return err
		}
		a.egressMgr = em
	}
	for _, cfg := range tunnels {
		if cfg.Mode == forwarder.ModeEgress {
			if a.egressMgr == nil {
				continue
			}
			if err := a.egressMgr.AddTunnel(cfg); err != nil {
				logx.Error("restore egress tunnel failed", "id", cfg.ID, "err", err.Error())
				continue
			}
			continue
		}
		if err := a.tunnelMgr.Add(cfg); err != nil {
			logx.Error("restore tunnel failed", "id", cfg.ID, "err", err.Error())
		}
	}
	return nil
}
```

`TunnelManager.Add` 内部同样三分支（DIRECT/RELAY 走 forwarder，EGRESS 转发给 EgressManager），保持单一入口。

### 3.8 `TunnelManager`（入口侧）

```go
package manager

// TunnelManager 管理入口节点上的 DIRECT/RELAY Forwarder。
// RELAY 隧道在入口侧**不持有目标池**：目标在出口，入口只认 nextHop。
type TunnelManager struct {
	mu    sync.RWMutex
	fwds  map[int]forwarder.Forwarder
	lnIP  string
}

func (m *TunnelManager) Add(cfg forwarder.TunnelConfig) error {
	if cfg.Mode == forwarder.ModeEgress {
		return fmt.Errorf("tunnel manager: EGRESS belongs to EgressManager")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, dup := m.fwds[cfg.ID]; dup {
		return fmt.Errorf("tunnel %d already exists", cfg.ID)
	}
	var f forwarder.Forwarder
	var err error
	switch cfg.Mode {
	case forwarder.ModeDirect:
		f, err = forwarder.NewDirect(cfg)
	case forwarder.ModeRelay:
		f, err = forwarder.NewRelay(cfg)
	}
	if err != nil {
		return err
	}
	if err := f.Start(); err != nil {
		return err
	}
	m.fwds[cfg.ID] = f
	return nil
}

func (m *TunnelManager) Remove(id int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	f := m.fwds[id]
	if f == nil {
		return nil
	}
	delete(m.fwds, id)
	return f.Stop() // 释放端口 → 面板端口池可回收（TTL 兜底）
}

func (m *TunnelManager) Get(id int) (forwarder.Forwarder, bool) { /* ... */ }
func (m *TunnelManager) List() []forwarder.Forwarder            { /* ... */ }

// ActivePorts 汇总本节点已绑定端口（面板对账 + heartbeat 上报）。
func (m *TunnelManager) ActivePorts() map[string]int { /* ... */ }
```

### 3.9 与现有 `engine` 的分工（避免双写冲突）

| 通道 | 谁用 | 用途 |
|---|---|---|
| Socket.IO `config`（engine） | 存量 DIRECT + 存量 out_node_group 链路 | 配置整包（限速/链路/协议模板全在里面） |
| HTTP `POST /tunnel`（新 manager） | v3.0 新建 DIRECT + 全部 RELAY | 单隧道指令，立即生效、无需整包指纹比对 |

**共存规则**：同一条隧道只走一条通道，由 `Tunnel.tunnel_mode` + `created_by_version` 决定。v3.0 新建的隧道一律走 HTTP 通道；存量隧道继续走 Socket.IO。`created_by_version` 不加列也行——用 `tunnel_mode='relay' OR (tunnel_mode='direct' AND egress_node_id IS NOT NULL AND created_at >= v3.0上线时间)` 近似即可，但**建议加列**以绝后患：

```prisma
  /// 该隧道由哪个指令通道管理：socket_io（存量 gost 配置）/ http（v3.0 POST /tunnel）。
  control_channel String @default("socket_io") @db.VarChar(32)
```

```sql
ALTER TABLE `tunnel`
  ADD COLUMN `control_channel` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'socket_io' AFTER `remote_port`;
```

---

## 4. 面板 → Agent 下发逻辑（`tunnelOrchestrator`）

新文件：`backend/src/services/tunnelOrchestrator.ts`
依赖新增：`backend/src/services/nodeClient.ts`（HTTP 直连 agent 的 9090 端口，Bearer Token）。

### 4.1 与现有 Socket.IO 推送的关系

```
                ┌─────────────────────────── 现有 main 的通道 ───────────────────────────┐
                │  routes/tunnels.ts → pushTunnelConfig() → config-pusher.pushNodeConfig │
                │  → generateNodeConfig() → Fernet 加密 → io.to(room).emit("config")     │
                └────────────────────────────────────────────────────────────────────────┘
                                        ↑ 保留：DIRECT（socket_io 通道）+ 存量链路
                ┌─────────────────────── v3.0 新增通道 ───────────────────────┐
                │  routes/tunnels.ts → orchestrator.applyTunnel()            │
                │   → nodeClient.postTunnel()  (HTTP, 节点 9090 端口)         │
                └────────────────────────────────────────────────────────────┘
```

RELAY 隧道**只走 HTTP 通道**；v3.0 新建 DIRECT 隧道也走 HTTP 通道（指令简单、即时生效）；存量 DIRECT 走 Socket.IO。判定字段见 §3.9 的 `control_channel`。

### 4.2 类型定义

```ts
// backend/src/services/nodeClient.ts
import { env } from "../env.ts";

export type AgentMode = "DIRECT" | "RELAY" | "EGRESS";

export interface AgentTarget {
  id: number;
  host: string;
  port: number;
  weight: number;
  order_by: number;
  status: "active" | "inactive";
}

export interface AgentTunnelPayload {
  id: number;
  mode: AgentMode;
  ingress_port?: number;
  ingress_ip?: string;
  remote_host?: string;
  remote_port?: number;
  next_hop?: string;
  egress_port?: number;
  egress_node_id?: number;
  ingress_ips?: string[];
  targets?: AgentTarget[];
  lb_strategy?: "round" | "rand";
  protocol: string;
  speed_limit: number;
}

export interface AgentNode {
  id: number;
  node_id: string;
  role: "ingress" | "egress" | "both";
  connect_ip: string;   // 多 IP 时取第一个（create 时已 join，egress 侧取首元素）
  token: string;        // 节点级 Bearer Token
  admin_port: number;   // 默认 9090
}

export interface NodeClientResult {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * 直连 agent 管理面（HTTP :9090）。
 * 超时 5s：nodeClient 的失败会触发 orchestrator 回滚，不能拖死请求。
 * 断连/超时统一返回 ok:false（不抛），由调用方决定重试或回滚。
 */
export async function callAgent<T = unknown>(
  node: AgentNode,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<NodeClientResult & { data?: T }> {
  const url = `http://${pickIP(node.connect_ip)}:${node.admin_port}${path}`;
  const ctrl = AbortSignal.timeout(env.agentTimeoutMs /* 5000 */);
  try {
    const resp = await fetch(url, {
      method,
      signal: ctrl,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${node.token}`,
        "x-tunex-node": String(node.id),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await resp.json().catch(() => undefined)) as T | undefined;
    if (!resp.ok) {
      return { ok: false, status: resp.status, data, error: String((data as { error?: string })?.error ?? resp.statusText) };
    }
    return { ok: true, status: resp.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}
```

### 4.3 端口分配器（编排器使用的两个端口）

```ts
// backend/src/services/portPool.ts（详见 §5）中导出的两个池：
//   ingressPool：入口节点可见端口（用户连的口）
//   egressPool ：出口节点内部端口（入口连的口）
```

### 4.4 编排核心：`applyTunnel`

```ts
// backend/src/services/tunnelOrchestrator.ts
import { db } from "../db.ts";
import { callAgent, type AgentNode, type AgentTunnelPayload } from "./nodeClient.ts";
import { acquirePort, releasePort, assertNotBlacklisted } from "./portPool.ts";
import { pushNodeConfig } from "../socket/config-pusher.ts";

export type ApplyStage =
  | "created"          // 落库完成
  | "egress_deployed"  // 出口已下发（RELAY 独有中间态）
  | "ingress_deployed" // 入口已下发
  | "done"
  | "rolled_back";

export interface OrchestrateInput {
  tunnelId: number;
  mode: "direct" | "relay";
  workspaceId: number;
  ingressNode: AgentNode;
  /** direct：目标；relay：出口节点 + 其目标池 */
  egressNode?: AgentNode;
  egressTargets?: AgentTarget[];
  lbStrategy?: "round" | "rand";
  remote?: { host: string; port: number };
  protocol: string;
  /** 是否强制走 HTTP 通道（false = 沿用 Socket.IO，见 §3.9） */
  httpChannel: boolean;
}

export interface OrchestrateResult {
  ok: boolean;
  stage: ApplyStage;
  ingressPort?: number;
  egressPort?: number;
  error?: string;
}

/**
 * 单一编排入口：建隧道 / 恢复隧道 / 改出口节点都走它。
 *
 * 顺序铁律（RELAY）：先出口、后入口。
 *   出口未就绪就让入口监听 = 用户连上即断，而且入口已经占了端口 → 必须按序。
 *
 * 失败处理：任何一步失败 → 反向补偿（把已下发的对端撤掉）+ 释放端口 +
 *   删除隧道行（或标记 failed，见 4.7 的降级策略），**不留半条隧道**。
 */
export async function orchestrateApply(input: OrchestrateInput): Promise<OrchestrateResult> {
  const { mode, ingressNode } = input;

  /* ---------- 0. 端口黑名单预检（双重校验的第一道） ---------- */
  if (input.remote && !assertNotBlacklisted(input.remote.port)) {
    return { ok: false, stage: "created", error: `目标端口 ${input.remote.port} 在黑名单内` };
  }

  /* ---------- 1. 入口端口（用户可见） ---------- */
  const inLease = await acquirePort({
    kind: "ingress",
    nodeId: ingressNode.id,
    tunnelId: input.tunnelId,
    range: ingressNodePortRange(ingressNode),
  });
  if (!inLease.ok) {
    return { ok: false, stage: "created", error: `入口端口分配失败：${inLease.error}` };
  }

  /* ---------- 2. RELAY：出口端口（内部通信） ---------- */
  let egLease: PortLease | null = null;
  if (mode === "relay") {
    if (!input.egressNode || !input.egressTargets?.length) {
      return { ok: false, stage: "created", error: "RELAY 模式必须指定出口节点与目标池" };
    }
    egLease = await acquirePort({
      kind: "egress",
      nodeId: input.egressNode.id,
      tunnelId: input.tunnelId,
      range: egressNodePortRange(input.egressNode),
    });
    if (!egLease.ok) {
      await releasePort(inLease); // 入口端口立即归还，避免泄漏
      return { ok: false, stage: "created", error: `出口端口分配失败：${egLease.error}` };
    }
  }

  /* ---------- 3. 落库（端口先分配、事务外落库，端口号回写 tunnel） ---------- */
  // 端口分配是 Redis 侧事务（NX 租约），tunnel 落库是 MySQL 事务，
  // 两者无法原子 → 用「先 Redis 租约、后 MySQL、失败即释放租约」的顺序，
  // 并以 TTL 兜底（§5.3）。这与本仓 SOFT-01 的端口/额度互斥实现一致。
  try {
    await db.tunnel.update({
      where: { id: input.tunnelId },
      data: {
        listen_port: inLease.port,
        ...(egLease ? { egress_port: egLease.port } : {}),
        ...(input.remote ? { remote_host: input.remote.host, remote_port: input.remote.port } : {}),
      },
    });
  } catch (e) {
    await releasePort(inLease);
    if (egLease) await releasePort(egLease);
    return { ok: false, stage: "created", error: `落库失败：${(e as Error).message}` };
  }

  /* ---------- 4. RELAY：先下发出口（EGRESS） ---------- */
  let egressDeployed = false;
  if (mode === "relay" && input.egressNode && egLease) {
    const payload: AgentTunnelPayload = {
      id: input.tunnelId,
      mode: "EGRESS",
      egress_port: egLease.port,
      egress_node_id: input.egressNode.id,
      ingress_ips: [pickIP(ingressNode.connect_ip)], // 出口只接受该入口的流量
      targets: (input.egressTargets ?? []).filter((t) => t.status === "active" && t.weight > 0),
      lb_strategy: input.lbStrategy ?? "round",
      protocol: input.protocol,
      speed_limit: -1,
    };
    const r = await callAgent(input.egressNode, "POST", "/tunnel", payload);
    if (!r.ok) {
      // 出口失败 → 入口还没下发，无需回滚入口；释放双端口 + 删除隧道行
      await teardownAfterFailure(input.tunnelId, inLease, egLease);
      return { ok: false, stage: "created", error: `出口节点下发失败：${r.error ?? r.status}` };
    }
    egressDeployed = true;
  }

  /* ---------- 5. 再下发入口（RELAY / DIRECT） ---------- */
  if (!input.httpChannel) {
    // 存量 DIRECT 走 Socket.IO：触发整组配置重算即可
    await pushNodeConfig(await inGroupOf(input.tunnelId), { force: true }).catch(() => {});
    return { ok: true, stage: "done", ingressPort: inLease.port, egressPort: egLease?.port };
  }

  const ingressPayload: AgentTunnelPayload =
    mode === "relay"
      ? {
          id: input.tunnelId,
          mode: "RELAY",
          ingress_port: inLease.port,
          next_hop: `${pickIP(input.egressNode!.connect_ip)}:${egLease!.port}`,
          protocol: input.protocol,
          speed_limit: -1,
        }
      : {
          id: input.tunnelId,
          mode: "DIRECT",
          ingress_port: inLease.port,
          remote_host: input.remote!.host,
          remote_port: input.remote!.port,
          protocol: input.protocol,
          speed_limit: -1,
        };

  const r = await callAgent(ingressNode, "POST", "/tunnel", ingressPayload);
  if (!r.ok) {
    // 入口失败 → 补偿：撤掉已下发的出口，释放双端口，删库
    if (egressDeployed) {
      await callAgent(input.egressNode!, "DELETE", `/tunnel/${input.tunnelId}`).catch(() => {});
    }
    await teardownAfterFailure(input.tunnelId, inLease, egLease);
    return {
      ok: false,
      stage: "egress_deployed", // 便于前端提示「出口已回滚」
      error: `入口节点下发失败：${r.error ?? r.status}`,
    };
  }

  /* ---------- 6. 成功 ---------- */
  return { ok: true, stage: "done", ingressPort: inLease.port, egressPort: egLease?.port };
}
```

### 4.5 补偿与端口释放

```ts
/**
 * 失败收尾：
 *   1. 撤销已下发的 agent 侧监听（上游调用方负责各自 DELETE，本函数只兜底入口）
 *   2. 释放双端口租约
 *   3. 删除隧道行（新建场景）/ 或把隧道打回 failed 状态（恢复场景，见 4.7）
 * 「删库」而非保留半条隧道：前端列表出现一条监听端口为空、目标为空的隧道
 * 只会误导用户；端口已释放，用户可以立即重建。
 */
async function teardownAfterFailure(
  tunnelId: number,
  ...leases: (PortLease | null)[]
): Promise<void> {
  for (const l of leases) {
    if (l) await releasePort(l).catch(() => {});
  }
  await db.tunnel.delete({ where: { id: tunnelId } }).catch(() => {});
}
```

### 4.6 操作矩阵（哪个动作推哪几端）

| 操作 | 入口节点 | 出口节点 | 端口池 | 备注 |
|---|---|---|---|---|
| 建 DIRECT | `POST /tunnel mode=DIRECT` | — | 分配 1 个 | — |
| 建 RELAY | `POST /tunnel mode=RELAY next_hop=egress:port` | `POST /tunnel mode=EGRESS targets=[...]` | 分配 2 个 | **顺序固定：先出口** |
| 删除隧道 | `DELETE /tunnel/:id` | `DELETE /tunnel/:id`（若存在） | 释放 2 个 | 两端互不依赖，任一失败继续 |
| 暂停隧道 | `DELETE /tunnel/:id` | `DELETE /tunnel/:id` | 端口暂不释放（保留给恢复，TTL 延期） | 软暂停：tunnel.status=inactive，端口保留 |
| 恢复暂停隧道 | `POST /tunnel`（复用旧端口） | `POST /tunnel` | 不重新分配 | 端口仍在租约内 |
| 改出口节点 | 旧出口 `DELETE` → 新出口 `POST EGRESS` → 入口 `POST RELAY` | 同上 | 释放旧 egress，分配新 egress | 三步顺序，任一步失败整体回滚到旧拓扑 |
| 改目标池（热更新） | 不动 | `PATCH /node/targets` | 不动 | **不重建隧道**（核心验收项） |
| 改 remote_host/port（DIRECT） | `DELETE` → `POST` | — | 保留 | 或复用 `PATCH /tunnel/:id/config`（v1.0） |

**心跳/上报写点**：`node.last_seen_at` 由三处维护——`socket/index.ts` 的 `register`、`sysinfo` handler、以及新增的 `POST /api/internal/heartbeat`。三者都用 `updateMany where: { node_id }`，互不干扰。

### 4.7 失败降级（避免"全或无"把用户挡死）

编排失败时的默认策略是**删库回滚**（§4.5）。但有一类场景需要降级而非删库：

- 恢复隧道时（agent 重启后 restore）某个 agent 不可达：**不删隧道**，把 `tunnel.status` 置为 `inactive` + 记录 `apply_error`，前端显示「恢复失败，点击重试」。用户可手动触发重试按钮 → 重新编排。
- 端口分配失败（区间耗尽）：同上，保留隧道行，提示「入口端口池已满，请扩容端口区间」。

为支撑该降级，`Tunnel` 增加一列：

```prisma
  /// 最近一次编排/恢复失败原因（前端展示 + 重试入口）。
  apply_error String? @db.VarChar(255)
```

```sql
ALTER TABLE `tunnel`
  ADD COLUMN `apply_error` varchar(255) COLLATE utf8mb4_unicode_ci NULL AFTER `control_channel`;
```

### 4.8 与 quota 事务的时序

现有 `routes/tunnels.ts` 的创建流程是：`withWorkspaceQuotaLock` 内做额度判定 + `tx.tunnel.create`。orchestrator 的端口分配与 agent 下发发生在该事务**之后**（否则 Redis 端口租约要在 DB 事务里持有几十毫秒以上的 agent HTTP 往返 → 端口池被长事务锁住，并发建隧道互相阻塞）。顺序：

```
1. withWorkspaceQuotaLock：额度判定 + tunnel.create（status=active, listen_port=NULL, tunnel_mode=direct/relay）
2. commit（事务结束，行锁释放）
3. orchestrator.orchestrateApply()：Redis 端口租约 → 回写端口 → 出口 → 入口
4. 失败 → teardownAfterFailure（删隧道行 + 释放端口）
```

副作用：第 3 步失败后 tunnel 行被删除，`order_by` 已消耗的档位不归还（与现有 `reset-traffic` 语义一致，可接受）。

---

## 5. 端口池改造（`backend/src/services/portPool.ts`）

**新文件**。现有 `backend/src/socket/port-allocator.ts` 保持不动（它是 Socket.IO 通道的纯函数确定性分配，没有跨进程竞争）。v3.0 的 HTTP 通道需要**跨进程互斥**（面板多实例部署）+ **黑名单校验** + **ingress/egress 隔离**，这是 portPool 的职责。

### 5.1 设计要点

| 项 | 决策 | 理由 |
|---|---|---|
| 互斥原语 | Redis `SET key val NX EX ttl` | 与 `services/payment/order.ts` 的单用户锁同风格；多实例面板必须互斥 |
| TTL | 入口端口租约 600s，出口端口租约 600s；隧道存活期间由 heartbeat 续期 | 端口必须能被回收：agent 崩溃/面板 OOM 后不能永久占着 |
| 续期 | 编排成功 → `tunnel:port:<tunnelId>:<kind>` 续期到「隧道存活期间」；隧道删除/暂停释放 → 释放即 `DEL` | 简单可靠 |
| 池隔离 | ingress 池 key = `port:ingress:<nodeId>:<port>`；egress 池 key = `port:egress:<nodeId>:<port>` | 入口/出口可以在不同机器上用同一端口号，**不需要互斥**；同节点同池才互斥 |
| 黑名单 | `PORT_BLACKLIST` 常量（22/80/443/3306/5432/6379/27017/9090/9191…）+ 可被系统配置覆盖 | 开发规范：portPool 和创建接口**双重校验** |
| 键作用域 | 走 `tenant-scope.ts` 的 `scopedKey(scope, "port:...")`；平台级资源用 `GLOBAL_SCOPE`（端口是全站物理资源，跨租户也必须互斥） | 与 TEN-02 规范一致：端口是全局资源 → `ws:global:` 段 |

> 端口键用 **global 段**而不是 workspace 段：同一台物理机器的 10000 端口被两个租户的隧道同时占用 = 直接 `EADDRINUSE`，租户隔离在这里不适用。

### 5.2 实现

```ts
// backend/src/services/portPool.ts
import { redis } from "../redis.ts";
import { GLOBAL_SCOPE, scopedKey } from "../tenant-scope.ts";

/* ------------------------------------------------------------------ */
/* 端口黑名单（双重校验的第一层：规则表）                                */
/* ------------------------------------------------------------------ */

/** 系统端口 + 本仓自身服务端口，永不出现在隧道监听里。 */
export const PORT_BLACKLIST: ReadonlySet<number> = new Set([
  22,     // ssh
  80, 443, // web
  3306,   // mysql
  5432,   // postgres
  6379,   // redis
  27017,  // mongodb
  9090,   // agent 管理面
  9191,   // agent 上报面
  3000, 3001, // web / api
  6060,   // pprof
]);

/** 可被系统配置覆盖的黑名单（管理员可在面板加端口，如 253）。 */
const BLACKLIST_CONFIG_KEY = "PORT_BLACKLIST_EXTRA";
let extraBlacklist: ReadonlySet<number> = new Set();

export function isPortBlacklisted(port: number): boolean {
  return port < 1 || port > 65535 || PORT_BLACKLIST.has(port) || extraBlacklist.has(port);
}

/** 面板调系统配置保存时调用（5 分钟本地缓存 + Redis 广播失效省略，直接读）。 */
export async function refreshBlacklist(): Promise<void> {
  const raw = await redis.get(scopedKey(GLOBAL_SCOPE, `syscfg:${BLACKLIST_CONFIG_KEY}`));
  extraBlacklist = new Set(
    String(raw ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

/**
 * 断言端口不在黑名单（供创建接口直接调用，构成「双重校验」的另一层）。
 * @throws HTTPException 400
 */
export function assertNotBlacklisted(port: number): boolean {
  if (isPortBlacklisted(port)) throw new PortBlacklistedError(port);
  return true;
}

export class PortBlacklistedError extends Error {
  constructor(public port: number) {
    super(`端口 ${port} 位于黑名单`);
    this.name = "PortBlacklistedError";
  }
}

/* ------------------------------------------------------------------ */
/* 租约                                                               */
/* ------------------------------------------------------------------ */

export type PortKind = "ingress" | "egress";

export interface PortRangeSpec {
  min: number;
  max: number;
}

export interface PortLease {
  kind: PortKind;
  nodeId: number;
  tunnelId: number;
  port: number;
  /** 续期用 key（内部）。 */
  key: string;
  /** 租约过期时间（unix ms）。释放后置 0。 */
  expiresAt: number;
}

export interface AcquireOptions {
  kind: PortKind;
  nodeId: number;
  tunnelId: number;
  range: PortRangeSpec;
  /** 期望端口（恢复隧道场景）；给定时跳过随机扫描。 */
  preferred?: number | null;
  /** 尝试次数上限（默认 = 区间宽度，封顶 64）。 */
  attempts?: number;
}

const LEASE_TTL_S = 600; // 10 分钟，由 orchestrate 成功后与隧道生命周期对齐续期
const KEY_PREFIX = "port";

function portKey(kind: PortKind, nodeId: number, port: number): string {
  return scopedKey(GLOBAL_SCOPE, `${KEY_PREFIX}:${kind}:${nodeId}:${port}`);
}

function randomPort(range: PortRangeSpec): number {
  const span = range.max - range.min + 1;
  return range.min + Math.floor(Math.random() * Math.max(1, span));
}

/**
 * 申请一个端口租约。
 *
 * 语义：
 *  · `SET key tunnelId NX EX ttl` 成功 → 独占该端口，返回 lease；
 *  · 失败（已被别的隧道占用）→ 在区间内随机重试；
 *  · 区间耗尽 → `{ ok:false, error:"port pool exhausted" }`。
 *
 * 与 `socket/port-allocator.ts` 的分工：那边是「一次配置生成内的确定性分配」，
 * 这边是「跨进程的抢占式租约」。两边分配的端口**可能同号**（不同节点是允许的，
 * 同节点不同通道才是问题）——故 portPool 的 key 带 nodeId，且 ingress/egress
 * 分池，互不干涉。
 */
export async function acquirePort(opts: AcquireOptions): Promise<
  { ok: true; port: number; key: string; kind: PortKind; nodeId: number; tunnelId: number } | { ok: false; error: string }
> {
  await refreshBlacklistIfStale();
  const { kind, nodeId, tunnelId, range } = opts;
  if (range.min > range.max || range.min < 1 || range.max > 65535) {
    return { ok: false, error: "端口区间非法" };
  }
  const attempts = Math.min(opts.attempts ?? 64, Math.max(16, range.max - range.min + 1));

  // 首选端口：恢复隧道 / 用户指定端口时使用（先查黑名单再抢占）。
  const candidates: number[] = [];
  if (opts.preferred != null) candidates.push(opts.preferred);

  for (let i = candidates.length; i < attempts; i++) candidates.push(randomPort(range));

  for (const port of candidates) {
    if (isPortBlacklisted(port)) continue;
    const key = portKey(kind, nodeId, port);
    const got = await redis.set(key, String(tunnelId), "EX", LEASE_TTL_S, "NX");
    if (got === "OK") {
      return { ok: true, port, key, kind, nodeId, tunnelId };
    }
  }
  return { ok: false, error: "port pool exhausted" };
}

/** 释放端口租约（只删自己的，避免误删别人的续期结果）。 */
export async function releasePort(lease: {
  key: string;
  tunnelId: number;
  port: number;
  kind: PortKind;
  nodeId: number;
}): Promise<void> {
  const holder = await redis.get(lease.key);
  if (holder !== null && holder !== String(lease.tunnelId)) return; // 已被重新分配
  await redis.del(lease.key);
}

/** 续期（编排成功后调用，让端口与隧道同生命周期）。 */
export async function renewPort(lease: { key: string }, ttlS = LEASE_TTL_S): Promise<void> {
  // 简化：直接 EXPIRE；若值已被替换，延长别人的租约无害（值仍是合法 tunnelId）。
  await redis.expire(lease.key, ttlS).catch(() => {});
}

/** 批量释放（隧道删除 / 改出口节点）。 */
export async function releasePorts(leases: (PortLease | null | undefined)[]): Promise<void> {
  await Promise.all(leases.filter(Boolean).map((l) => releasePort(l!)));
}

/**
 * 反查端口占用者（面板对账 / agent 上报 active_ports 后比对）。
 * @returns tunnelId 或 null（未占用）
 */
export async function portHolder(kind: PortKind, nodeId: number, port: number): Promise<number | null> {
  const v = await redis.get(portKey(kind, nodeId, port));
  return v === null ? null : Number(v);
}

/* 黑名单缓存的懒刷新（30s）。 */
let blacklistAt = 0;
async function refreshBlacklistIfStale(): Promise<void> {
  if (Date.now() - blacklistAt > 30_000) {
    await refreshBlacklist().catch(() => {});
    blacklistAt = Date.now();
  }
}
```

### 5.3 端口泄漏的兜底

租约 TTL 600s 是主兜底。两道辅助防线：

1. **对账 job**（`backend/src/worker.ts` 每 5 分钟）：扫 `db.tunnel` 中 `listen_port IS NOT NULL` 的集合，与 Redis 中的 `port:ingress:*` / `port:egress:*` key 对比——**DB 有隧道但 Redis 无租约** → 补写租约（agent 实际在听）；**Redis 有租约但 DB 无隧道** → `DEL`（编排失败后的残留）。
2. **agent 心跳上报 `active_ports`**：面板与 agent 实际监听端口三方对账，差异即告警（不自动改端口，避免双节点并发转发）。

### 5.4 端口区间来源

```
Tunnel 建在 in_node_group 下 → 入口节点 = 该组内 role∈{ingress,both} 的 Node（按 weight/order_by 选 1 台）
→ 入口端口区间 = node.port_range_min/max（缺省时回落到 group.port_range 解析出的首段）
出口同理：egress 端口区间 = egressNode.port_range_min/max
```

`group.port_range` 是逗号/区间串（`"80,443,30000-30010"`），`node.port_range_min/max` 是数字列。解析 helper：

```ts
// backend/src/services/portPool.ts（续）
import { parsePortRange } from "../socket/port-allocator.ts"; // 复用现有解析

/** 从 group.port_range 取第一段作为节点的区间兜底。 */
export function fallbackRange(groupPortRange: string | null | undefined): PortRangeSpec {
  const segs = parsePortRange(groupPortRange).segments;
  if (segs.length > 0) return { min: segs[0].lo, max: segs[segs.length - 1].hi };
  return { min: 10000, max: 60000 };
}

export function nodeRange(node: { port_range_min: number; port_range_max: number }): PortRangeSpec {
  return node.port_range_min > 0 && node.port_range_max >= node.port_range_min
    ? { min: node.port_range_min, max: node.port_range_max }
    : { min: 10000, max: 60000 };
}
```

---

## 6. API 接口改造

### 6.1 出口节点目标池 CRUD（`backend/src/routes/admin-node-targets.ts`，新建）

路径与设计稿的差异说明：需求指定的是 `GET/POST/PATCH/DELETE /api/admin/nodes/:id/targets`；设计稿第 6 节把 PATCH/DELETE 具体到 `/targets/:tid`（单目标）。**本方案采用后者**（REST 单资源语义，PATCH/DELETE 必须带目标 id），GET/POST 仍用集合路径。

挂载：`app.route("/api/admin", nodeTargetsRoutes)`（`admin-extended.ts` 同款挂法，管理员中间件已由 app.ts 统一处理；确认 `admin.ts` 挂载顺序在 authRequired 之后）。

```
GET    /api/admin/nodes/:id/targets          目标池列表（含停用）
POST   /api/admin/nodes/:id/targets          添加目标 {host, port, weight?, remark?}
PATCH  /api/admin/nodes/:id/targets/:tid     修改目标 {host?, port?, weight?, order_by?, remark?, status?}
DELETE /api/admin/nodes/:id/targets/:tid     删除目标（软删除 status=inactive + 热更新 agent）
POST   /api/admin/nodes/:id/targets/reorder  批量排序 [{id, order_by}]（可选，便利性）
```

实现骨架：

```ts
// backend/src/routes/admin-node-targets.ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.ts";
import { callAgent } from "../services/nodeClient.ts";
import { assertNotBlacklisted } from "../services/portPool.ts";
import type { AppVariables } from "../middlewares/auth.ts";

export const nodeTargetsRoutes = new Hono<{ Variables: AppVariables }>();

const HOST_RE = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9_.-]+)$/;
const MAX_TARGETS_PER_NODE = 64;

/** 角色守卫：目标池只能挂在出口节点上。 */
async function loadEgressNode(id: number) {
  const node = await db.node.findUnique({ where: { id } });
  if (!node) throw new HTTPException(404, { message: "节点不存在" });
  if (node.role === "ingress") {
    throw new HTTPException(409, { message: "入口节点不能配置出口目标池" });
  }
  return node;
}

function validateHostPort(host: unknown, port: unknown): { host: string; port: number } {
  const h = String(host ?? "").trim();
  const p = Number(port);
  if (!HOST_RE.test(h)) throw new HTTPException(400, { message: "目标主机名非法" });
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new HTTPException(400, { message: "目标端口必须在 1-65535" });
  try {
    assertNotBlacklisted(p); // 目标端口也过黑名单（防止配成面板自身端口造成回环）
  } catch {
    throw new HTTPException(400, { message: "目标端口位于黑名单" });
  }
  return { host: h, port: p };
}

nodeTargetsRoutes.get("/nodes/:id/targets", async (c) => {
  const id = Number(c.req.param("id"));
  await loadEgressNode(id);
  const rows = await db.egressTarget.findMany({
    where: { node_id: id },
    orderBy: [{ order_by: "asc" }, { id: "asc" }],
  });
  return c.json({ data: rows });
});

nodeTargetsRoutes.post("/nodes/:id/targets", async (c) => {
  const id = Number(c.req.param("id"));
  const node = await loadEgressNode(id);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "参数错误" }, 400);
  const { host, port } = validateHostPort(body.host, body.port);
  const weight = body.weight === undefined ? 1 : Number(body.weight);
  if (!Number.isInteger(weight) || weight < 0 || weight > 1000) {
    return c.json({ error: "权重必须是 0-1000 的整数" }, 400);
  }

  const count = await db.egressTarget.count({ where: { node_id: id } });
  if (count >= MAX_TARGETS_PER_NODE) return c.json({ error: `单个节点最多 ${MAX_TARGETS_PER_NODE} 个目标` }, 400);

  // 唯一冲突 → 幂等更新（upsert），返回 200 而非 409，降低前端复杂度
  const row = await db.egressTarget.upsert({
    where: { node_id_host_port: { node_id: id, host, port } },
    create: { node_id: id, host, port, weight, remark: body.remark ? String(body.remark) : null },
    update: {
      weight,
      status: "active",
      ...(body.remark !== undefined ? { remark: body.remark ? String(body.remark) : null } : {}),
    },
  });

  // 热更新：写完即推 agent（不重建任何隧道）
  await hotUpdateNodeTargets(node);

  return c.json({ data: row }, 201);
});

nodeTargetsRoutes.patch("/nodes/:id/targets/:tid", async (c) => {
  const id = Number(c.req.param("id"));
  const tid = Number(c.req.param("tid"));
  const node = await loadEgressNode(id);
  const existing = await db.egressTarget.findFirst({ where: { id: tid, node_id: id } });
  if (!existing) return c.json({ error: "目标不存在" }, 404);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const data: Record<string, unknown> = {};
  if (body?.host !== undefined || body?.port !== undefined) {
    const { host, port } = validateHostPort(body?.host ?? existing.host, body?.port ?? existing.port);
    const dup = await db.egressTarget.findFirst({
      where: { node_id: id, host, port, NOT: { id: tid } },
    });
    if (dup) return c.json({ error: "同节点下 host:port 已存在" }, 409);
    data.host = host;
    data.port = port;
  }
  if (body?.weight !== undefined) {
    const w = Number(body.weight);
    if (!Number.isInteger(w) || w < 0 || w > 1000) return c.json({ error: "权重非法" }, 400);
    data.weight = w;
  }
  if (body?.order_by !== undefined) {
    const o = Number(body.order_by);
    if (!Number.isFinite(o)) return c.json({ error: "排序值非法" }, 400);
    data.order_by = o;
  }
  if (body?.status !== undefined) {
    if (body.status !== "active" && body.status !== "inactive") return c.json({ error: "状态非法" }, 400);
    data.status = body.status;
  }
  if (body?.remark !== undefined) data.remark = body.remark ? String(body.remark) : null;

  const updated = await db.egressTarget.update({ where: { id: tid }, data });
  await hotUpdateNodeTargets(node); // 热更新
  return c.json({ data: updated });
});

nodeTargetsRoutes.delete("/nodes/:id/targets/:tid", async (c) => {
  const id = Number(c.req.param("id"));
  const tid = Number(c.req.param("tid"));
  const node = await loadEgressNode(id);
  const existing = await db.egressTarget.findFirst({ where: { id: tid, node_id: id } });
  if (!existing) return c.json({ error: "目标不存在" }, 404);

  // 软删除（软删除原则：status=DELETED，不做物理删除；本仓没有 DELETED 状态，用 inactive）
  await db.egressTarget.update({ where: { id: tid }, data: { status: "inactive" } });
  await hotUpdateNodeTargets(node);
  return c.json({ data: { ok: true } });
});

/**
 * 热更新：把该节点**当前生效**的目标池（active 且 weight>0）推给 agent。
 * 若全部目标都被停用 → 拒绝（agent 侧 availability guard 也会拒，这里提前给友好错误）。
 */
async function hotUpdateNodeTargets(node: { id: number; agent_admin_port: number; node_token: string; connect_ip: string }): Promise<void> {
  const targets = await db.egressTarget.findMany({
    where: { node_id: node.id, status: "active" },
    orderBy: [{ order_by: "asc" }, { id: "asc" }],
  });
  const usable = targets.filter((t) => t.weight > 0);
  if (usable.length === 0) {
    throw new HTTPException(409, { message: "出口节点至少要有一个可用目标" });
  }
  const r = await callAgent(
    { id: node.id, node_id: "", role: "egress", connect_ip: node.connect_ip, token: node.node_token, admin_port: 9090 },
    "PATCH",
    "/node/targets",
    {
      lb_strategy: node.lb_strategy ?? "round",
      targets: usable.map((t) => ({
        id: t.id, host: t.host, port: t.port, weight: t.weight,
        order_by: t.order_by, status: t.status,
      })),
    },
  );
  // 推失败不回滚 DB（DB 是真相）：agent 下次重启 restore 时自愈；
  // 但要在响应里告知管理员「已保存，节点同步失败」。
  if (!r.ok) {
    // 该场景返回 207-ish：用 200 + warning 字段，避免前端把成功显示成失败
    // （本文件统一 c.json({data, warning})，调用方自行决定 UI）
  }
}
```

> `Node` 需补两列用于 agent 直连：`agent_admin_port`（默认 9090）、`node_token`（建节点时生成的 Bearer Token，加密存储）。若不想落 token，可按 `node_group.token` 派生（`uuidv5`）——**推荐派生**，不新增敏感列：

```ts
// 派生节点 token（不落库，与 license-sign.ts 的派生风格一致）
import { createHash } from "node:crypto";
function deriveNodeToken(groupToken: string, nodeId: string): string {
  return createHash("sha256").update(`${groupToken}:${nodeId}`).digest("hex").slice(0, 32);
}
```

agent 侧启动时用同一输入算出自己的 token，两边永远一致。**这样零 schema 改动。**

### 6.2 创建隧道支持模式选择（`backend/src/routes/tunnels.ts` 改造）

`POST /api/tunnels` 请求体扩展：

```ts
{
  name: string,
  tunnel_type: TunnelType,
  category: "port_forward",

  // —— v3.0 新增 ——
  tunnel_mode: "direct" | "relay",       // 缺省 direct
  ingress_node_id?: number,              // 直选节点（不选则按组自动挑）
  egress_node_id?: number,               // relay 必填
  // —— 现有 ——
  in_node_group_id: number,
  out_node_group_id?: number | null,
  forward_addresses: string[],           // direct 必填；relay 忽略
  listen_port?: number | null,
  ...
}
```

校验与落库改造（在现有 handler 内增量，不重写）：

```ts
// ---- 接在现有 inGroup 校验之后 ----

const tunnelMode = body.tunnel_mode === "relay" ? "relay" : "direct";

let egressNode: Node | null = null;
if (tunnelMode === "relay") {
  const egressNodeId = Number(body.egress_node_id);
  if (!Number.isInteger(egressNodeId)) return c.json({ error: "RELAY 模式必须指定出口节点" }, 400);
  const node = await db.node.findUnique({ where: { id: egressNodeId } });
  if (!node) return c.json({ error: "出口节点不存在" }, 404);
  if (node.role === "ingress") return c.json({ error: "该节点不是出口节点" }, 409);
  if (node.status !== "active") return c.json({ error: "出口节点不在线" }, 409);
  // 目标池非空校验（否则 agent 侧 EGRESS 起不来，编排必然失败）
  const targets = await db.egressTarget.count({ where: { node_id: node.id, status: "active" } });
  if (targets === 0) return c.json({ error: "出口节点尚未配置目标池" }, 409);
  egressNode = node;
  // relay 模式下 forward_addresses 不是必填（目标在出口）
} else {
  // direct：保持现有「至少一个转发目标」校验
  const forward = parseForward(body.forward_addresses);
  if (forward.length === 0) return c.json({ error: "至少需要一个转发目标" }, 400);
  ...
}

// 用户指定 listen_port 时：黑名单校验（第二层，与 portPool 双重校验）
if (body.listen_port) {
  try { assertNotBlacklisted(Number(body.listen_port)); }
  catch { return c.json({ error: "监听端口位于黑名单" }, 400); }
}

// ---- 事务内 create 增加字段 ----
await tx.tunnel.create({
  data: {
    ...,
    tunnel_mode: tunnelMode,
    egress_node_id: egressNode?.id ?? null,
    // relay 模式下 forward_addresses 写空数组：老引擎见到空 forwarder 不会直连
    forward_addresses: tunnelMode === "relay" ? [] : forward,
    // relay 模式下 out_node_group_id 仍写出口节点所属组（复用组级推送/刷新链路）
    out_node_group_id: tunnelMode === "relay" ? egressNode!.node_group_id : outGroupId,
    remote_host: tunnelMode === "direct" ? remoteHost : null,
    remote_port: tunnelMode === "direct" ? remotePort : null,
    control_channel: "http",
  },
});

// ---- 事务提交后：编排下发（§4）----
const result = await orchestrateApply({
  tunnelId: created.id,
  mode: tunnelMode,
  workspaceId: workspace.id,
  ingressNode: await pickIngressNode(created.in_node_group_id, body.ingress_node_id),
  egressNode: egressNode ? toAgentNode(egressNode) : undefined,
  egressTargets: egressNode ? await loadTargets(egressNode.id) : undefined,
  remote: tunnelMode === "direct" ? { host: remoteHost, port: remotePort } : undefined,
  protocol: tunnelType,
  httpChannel: true,
});
if (!result.ok) {
  // orchestrator 已自行 teardown（删库+释放端口）；这里只把错误透出
  return c.json({ error: result.error }, 502);
}
return ok(c, tunnelView({ ...created, listen_port: result.ingressPort, egress_port: result.egressPort }));
```

`pickIngressNode` 策略（入口节点选择）：

```ts
/** 显式指定 > 组内 role∈{ingress,both} 且 status=active 的节点按 weight 降序取第一台。 */
async function pickIngressNode(groupId: number, explicitId?: number) {
  if (explicitId) {
    const n = await db.node.findFirst({ where: { id: explicitId, node_group_id: groupId } });
    if (!n) throw new HTTPException(404, { message: "入口节点不存在" });
    return n;
  }
  const n = await db.node.findFirst({
    where: { node_group_id: groupId, role: { in: ["ingress", "both"] }, status: "active" },
    orderBy: [{ weight: "desc" }, { order_by: "asc" }],
  });
  if (!n) throw new HTTPException(409, { message: "该入口组下没有可用节点" });
  return n;
}
```

### 6.3 `PATCH /api/tunnels/:id` 改造（模式/出口切换）

增量点（插在现有 `body.out_node_group_id` 处理之后）：

```ts
// 隧道模式与出口节点（v3.0）。切换 = 重新编排，不是简单 UPDATE。
let needsReorchestrate = false;
let newMode = tunnel.tunnel_mode;
let newEgressNodeId = tunnel.egress_node_id;

if (body.tunnel_mode !== undefined) {
  newMode = body.tunnel_mode === "relay" ? "relay" : "direct";
  needsReorchestrate = true;
}
if (body.egress_node_id !== undefined) {
  if (body.egress_node_id === null || body.egress_node_id === "") {
    newEgressNodeId = null; // 清空 = 退回 direct
    newMode = "direct";
  } else {
    const node = await db.node.findUnique({ where: { id: Number(body.egress_node_id) } });
    if (!node || node.role === "ingress") return c.json({ error: "出口节点不可用" }, 409);
    newEgressNodeId = node.id;
    newMode = "relay";
  }
  needsReorchestrate = true;
}
// DIRECT↔RELAY 互斥校验
if (newMode === "direct" && newEgressNodeId !== null) return c.json({ error: "DIRECT 模式不能指定出口节点" }, 400);
if (newMode === "relay" && newEgressNodeId === null) return c.json({ error: "RELAY 模式必须指定出口节点" }, 400);
```

若 `needsReorchestrate`：先「从 agent 撤下旧拓扑」（旧入口 `DELETE` + 旧出口 `DELETE`）→ 更新 DB 字段 → `orchestrateApply` 重下。任一步失败 → **恢复旧字段并重下旧拓扑**（两侧都保底，避免隧道彻底消失）。

### 6.4 Agent → 面板的内部端点（`backend/src/routes/internal.ts`，新建）

挂载于独立端口（设计稿要求 9191 与用户接口物理隔离）。本仓是单端口 Hono 应用，落地方式二选一：

- **A（推荐，最小改动）**：挂 `/api/internal/*`，用**独立中间件**做 Bearer Token 校验（不走 authRequired），并加**专属限流规则排在 `api-global` 之前**（否则按 `anon` 身份共用一桶，节点多就互相误伤——这正是技能里记录过的坑）。
- B：`index.ts` 起第二个 HTTP server 监听 9191，路由表单独注册。

代码骨架（A 方案）：

```ts
// backend/src/routes/internal.ts
import { Hono } from "hono";
import { db } from "../db.ts";
import { env } from "../env.ts";
import type { AppVariables } from "../middlewares/auth.ts";

export const internalRoutes = new Hono<{ Variables: AppVariables }>();

/** 节点级 Bearer 校验（由 node_group.token 派生，见 §6.1）。 */
internalRoutes.use("*", async (c, next) => {
  const tok = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!tok || tok !== env.internalReportToken) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

/** v0.3：心率上报 → last_seen_at。 */
internalRoutes.post("/heartbeat", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    node_id?: string | number;
    role?: string;
    version?: string;
    tunnels?: number;
    egress_ready?: boolean;
    active_ports?: Record<string, number>;
  } | null;
  if (!body?.node_id) return c.json({ error: "node_id required" }, 400);

  const nodeId = String(body.node_id);
  await db.node.updateMany({
    where: { node_id: nodeId },
    data: {
      last_seen_at: new Date(),
      ...(body.version !== undefined ? { version: String(body.version).slice(0, 255) } : {}),
    },
  });

  // 端口对账（§5.3 第 2 道防线）：agent 实际监听 vs Redis 租约，差异只记日志不动作。
  await reconcilePorts(nodeId, body.active_ports ?? {});
  return c.json({ ok: true });
});

/** v0.3：agent 启动恢复时拉取自己的 ACTIVE 隧道（含 EgressTarget 池）。 */
internalRoutes.get("/nodes/:id/tunnels", async (c) => {
  const id = Number(c.req.param("id"));
  const node = await db.node.findUnique({ where: { id } });
  if (!node) return c.json({ error: "node not found" }, 404);

  const isIngress = node.role === "ingress" || node.role === "both";
  const isEgress = node.role === "egress" || node.role === "both";

  const [inTunnels, egTunnels, targets] = await Promise.all([
    isIngress
      ? db.tunnel.findMany({
          where: { in_node_group_id: node.node_group_id, status: "active" },
          select: {
            id: true, tunnel_mode: true, listen_ip: true, listen_port: true,
            remote_host: true, remote_port: true, egress_port: true,
            egress_node: { select: { id: true, connect_ip: true } },
          },
        })
      : [],
    isEgress
      ? db.tunnel.findMany({
          where: { egress_node_id: node.id, status: "active" },
          select: {
            id: true, egress_port: true,
            in_node_group: { select: { nodes: { select: { id: true, connect_ip: true, node_id: true } } } },
          },
        })
      : [],
    isEgress
      ? db.egressTarget.findMany({
          where: { node_id: node.id, status: "active", weight: { gt: 0 } },
          orderBy: [{ order_by: "asc" }, { id: "asc" }],
        })
      : [],
  ]);

  return c.json({
    data: {
      node: { id: node.id, node_id: node.node_id, role: node.role },
      lb_strategy: node.lb_strategy,
      targets,
      // 入口视角的指令集（DIRECT/RELAY）
      ingress: inTunnels.map((t) => ({
        id: t.id,
        mode: t.tunnel_mode === "relay" ? "RELAY" : "DIRECT",
        ingress_ip: t.listen_ip ?? "0.0.0.0",
        ingress_port: t.listen_port!,
        remote_host: t.remote_host,
        remote_port: t.remote_port,
        next_hop: t.tunnel_mode === "relay" && t.egress_node
          ? `${pickIP(t.egress_node.connect_ip)}:${t.egress_port}`
          : undefined,
      })),
      // 出口视角的指令集（EGRESS）
      egress: egTunnels.map((t) => ({
        id: t.id,
        mode: "EGRESS",
        egress_port: t.egress_port!,
        egress_node_id: node.id,
        ingress_ips: t.in_node_group.nodes.map((n) => pickIP(n.connect_ip)),
      })),
    },
  });
});

function pickIP(connectIp: string): string {
  return String(connectIp).split(",")[0].trim();
}

async function reconcilePorts(nodeId: string, activePorts: Record<string, number>): Promise<void> {
  // 只读比对 + 日志（生产可接告警）；不做自动分配/回收，避免双节点并发转发。
  console.info(`[internal] node ${nodeId} active ports`, activePorts);
}
```

挂载与限流（`app.ts`）：

```ts
import { internalRoutes } from "./routes/internal.ts";
// 免认证机器端点必须有自己的限流规则，且排在 api-global 之前（先匹配先生效）
app.route("/api/internal", internalRoutes);
```

```ts
// middlewares/rate-limit.ts 的 GLOBAL_RATE_LIMIT_RULES 新增（插入到 api-global 之前）：
{
  name: "internal-heartbeat",
  windowSeconds: 60,
  max: 6, // 30s 一次 + 余量
  methods: ["POST"],
  match: (p, m) => p === "/api/internal/heartbeat",
  scope: "ip", // 没有 userId，按 IP 计（单节点一个公网 IP）
  message: "上报过于频繁",
},
```

### 6.5 删除节点时自动暂停 RELAY 隧道（`admin-extended.ts` 改造）

```ts
adminExtendedRoutes.delete("/nodes/:id", async (c) => {
  const id = readId(c);
  const node = await db.node.findUnique({ where: { id } });
  if (!node) return bad(c, "节点不存在", 404);

  // 1. 该节点作为出口的 RELAY 隧道 → SUSPENDED（软暂停，数据保留）
  if (node.role !== "ingress") {
    await db.tunnel.updateMany({
      where: { egress_node_id: id, status: "active" },
      data: { status: "inactive", apply_error: "出口节点已删除，请重新选择出口" },
    });
  }
  // 2. 该节点所在组的隧道（入口侧）→ 软删除（沿用现有语义）
  await db.tunnel.updateMany({
    where: { in_node_group_id: node.node_group_id, status: "active" },
    data: { status: "inactive", apply_error: "入口节点已删除" },
  });
  // 3. EgressTarget 随 node 级联删除（schema onDelete: Cascade）
  // 4. 尽量通知 agent 下线（best-effort，失败不影响删除）
  void callAgent(toAgentNode(node), "DELETE", "/tunnel/all").catch(() => {});
  // 5. 物理删除 or 软删除节点：开发规范是「软删除」，但本仓 Node 用 status=inactive
  await db.node.update({ where: { id }, data: { status: "inactive" } });
  return one(c, { ok: true });
});
```

> agent 侧需要 `DELETE /tunnel/all`（§3.4 未列，作为补充端点）：批量下线，返回成功条数。

### 6.6 新增/变更端点总表

| 方法 | 路径 | 认证 | 变更 |
|---|---|---|---|
| GET | `/api/admin/nodes/:id/targets` | admin | **新增** |
| POST | `/api/admin/nodes/:id/targets` | admin | **新增**（upsert） |
| PATCH | `/api/admin/nodes/:id/targets/:tid` | admin | **新增**（+热更新） |
| DELETE | `/api/admin/nodes/:id/targets/:tid` | admin | **新增**（软删除 + 热更新） |
| POST | `/api/tunnels` | user | **改造**（tunnel_mode / egress_node_id / ingress_node_id） |
| PATCH | `/api/tunnels/:id` | user | **改造**（模式/出口切换 = 重编排） |
| POST | `/api/internal/heartbeat` | node token | **新增** |
| GET | `/api/internal/nodes/:id/tunnels` | node token | **新增** |
| DELETE | `/api/admin/nodes/:id` | admin | **改造**（暂停相关 RELAY 隧道） |

---

## 7. 前端改造（`web/src/`）

### 7.1 类型与常量（`web/src/lib/types.ts` / `constants.ts` / `api.ts` / `i18n.ts`）

```ts
// types.ts —— 新增
export type NodeRole = "ingress" | "egress" | "both";
export type TunnelMode = "direct" | "relay";
export type LBStrategy = "round" | "rand";

export interface EgressTarget {
  id: ID;
  host: string;
  port: number;
  weight: number;
  order_by: number;
  remark: string | null;
  status: Status;
  created_at: string;
  updated_at: string;
}

export interface EgressTargetInput {
  host: string;
  port: number;
  weight?: number;
  order_by?: number;
  remark?: string | null;
}

// Node 接口补充（向后兼容：新字段全部 optional，旧 mock 数据不炸）
export interface Node {
  // ... 现有字段
  role?: NodeRole;
  last_seen_at?: string | null;
  port_range_min?: number;
  port_range_max?: number;
  lb_strategy?: LBStrategy;
  online?: boolean;
}

// Tunnel 接口补充
export interface Tunnel {
  // ... 现有字段
  tunnel_mode?: TunnelMode;
  egress_node_id?: ID | null;
  egress_port?: number | null;
  remote_host?: string | null;
  remote_port?: number | null;
  apply_error?: string | null;
}

// TunnelCreateInput 补充
export interface TunnelCreateInput {
  // ... 现有字段
  tunnel_mode?: TunnelMode;
  egress_node_id?: ID | null;
  ingress_node_id?: ID | null;
}
```

```ts
// constants.ts —— 新增选项元数据（沿用 OptionMeta 风格，中英 + labelKey）
export const NODE_ROLES = ["ingress", "egress", "both"] as const;
export const TUNNEL_MODES = ["direct", "relay"] as const;

export const NODE_ROLE_OPTIONS: OptionMeta[] = [
  { value: "ingress", labelKey: "node.roleIngress", zh: "入口", en: "Ingress" },
  { value: "egress", labelKey: "node.roleEgress", zh: "出口", en: "Egress" },
  { value: "both", labelKey: "node.roleBoth", zh: "兼任", en: "Both" },
];

export const TUNNEL_MODE_OPTIONS: OptionMeta[] = [
  { value: "direct", labelKey: "tunnel.modeDirect", zh: "单跳（DIRECT）", en: "Direct (single hop)" },
  { value: "relay", labelKey: "tunnel.modeRelay", zh: "双跳（RELAY）", en: "Relay (two hops)" },
];
```

i18n 词条（`web/src/lib/i18n.ts` 的 `zh` / `en` 两个字典各补一组）：

```ts
// zh
"node.role": "节点角色",
"node.roleIngress": "入口",
"node.roleEgress": "出口",
"node.roleBoth": "兼任",
"node.targets": "出口目标",
"node.targetsDesc": "配置该出口节点可达的目标地址池，RELAY 隧道将从池中按权重转发",
"node.targetsEmpty": "尚未配置出口目标",
"node.addTarget": "添加目标",
"node.targetHost": "目标地址",
"node.targetPort": "端口",
"node.targetWeight": "权重",
"node.targetRemark": "备注",
"node.lastSeen": "最近心跳",
"node.portRange": "端口区间",
"node.lbStrategy": "负载均衡",
"tunnel.mode": "隧道模式",
"tunnel.modeDirect": "单跳（DIRECT）",
"tunnel.modeRelay": "双跳（RELAY）",
"tunnel.modeDirectHint": "入口节点直接转发到目标地址",
"tunnel.modeRelayHint": "入口 → 出口 → 目标池（需先配置出口节点目标）",
"tunnel.egressNode": "出口节点",
"tunnel.egressNodeHint": "选择一台出口节点（角色为出口/兼任）",
"tunnel.egressPort": "出口端口",
"tunnel.remoteAddress": "目标地址",
"tunnel.applyError": "下发失败：{reason}",
"tunnel.retryApply": "重试下发",
```

```ts
// api.ts —— admin 命名空间下新增 targets 系列
targets: {
  list: (nodeId: ID, cookie?: string) => get<EgressTarget[]>(`/admin/nodes/${nodeId}/targets`, undefined, cookie),
  create: (nodeId: ID, input: EgressTargetInput, cookie?: string) =>
    post<EgressTarget>(`/admin/nodes/${nodeId}/targets`, input, cookie),
  update: (nodeId: ID, tid: ID, input: Partial<EgressTargetInput>, cookie?: string) =>
    patch<EgressTarget>(`/admin/nodes/${nodeId}/targets/${tid}`, input, cookie),
  remove: (nodeId: ID, tid: ID, cookie?: string) =>
    del<{ ok: boolean }>(`/admin/nodes/${nodeId}/targets/${tid}`, cookie),
},
```

**注意**：`request()` 已统一 `credentials:"include"` + CSRF 头，不要在新方法里手写 fetch。

### 7.2 节点管理页（`web/src/components/admin/nodes-manager.tsx`）

改造点（保持现有 CRUD 结构，做**增量**）：

1. **角色列 + 角色筛选**：表格加 `role` Badge（ingress=蓝 / egress=橙 / both=紫），`ADMIN_TOOLBAR` 加角色筛选下拉。
2. **表单加角色选择**：`NodeForm` 补 `role: NodeRole`、`port_range_min/max: string`、`lb_strategy: string`；提交走现有 `api.admin.createNode/updateNode`。
   - 交互约束：`role` 从 `ingress` 改成 `egress` 时弹确认（该节点上的 DIRECT 隧道会失效）。
3. **在线状态灯**：`last_seen_at` 距今 > 90s → 灰点 + 「离线」文案；否则绿点。优先于 `status` 列展示（`status` 是管理员手动停用）。
4. **出口目标配置入口**：行操作加「目标池」按钮（仅 `role !== "ingress"` 时可点，否则提示）→ 打开 `EgressTargetsDialog`。
5. **心跳展示**：详情行展示 `last_seen_at`（`formatDateTime` 已有）。

```tsx
// nodes-manager.tsx —— 新增片段
function RoleBadge({ role }: { role: NodeRole }) {
  const cls =
    role === "egress" ? "bg-orange-500/15 text-orange-500"
    : role === "both" ? "bg-purple-500/15 text-purple-500"
    : "bg-blue-500/15 text-blue-500";
  return <Badge className={cls}>{t(`node.role${role[0].toUpperCase()}${role.slice(1)}`)}</Badge>;
}

function OnlineDot({ lastSeen }: { lastSeen?: string | null }) {
  const online = lastSeen ? Date.now() - new Date(lastSeen).getTime() < 90_000 : false;
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${online ? "bg-emerald-500" : "bg-zinc-400"}`} />
      <span className="text-xs text-[var(--muted-foreground)]">{online ? t("common.online") : t("common.offline")}</span>
    </span>
  );
}

// 行操作（RowActions）内：
<RowActions
  onEdit={...}
  onDelete={...}
  extra={
    <Button size="sm" variant="ghost" disabled={form.role === "ingress"} onClick={() => openTargets(row)}>
      {t("node.targets")}
    </Button>
  }
/>
```

**新建 `web/src/components/admin/egress-targets-dialog.tsx`**：

```tsx
"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import type { EgressTarget, EgressTargetInput, Node } from "@/lib/types";

/** 出口目标池管理（热更新：保存后 agent 立即生效，无需重启/重建隧道）。 */
export function EgressTargetsDialog({ open, onOpenChange, node }: { open: boolean; onOpenChange: (v: boolean) => void; node: Node | null }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<EgressTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<EgressTargetInput>({ host: "", port: 80, weight: 1 });

  useEffect(() => {
    if (!open || !node) return;
    setLoading(true);
    api.admin.targets
      .list(node.id)
      .then(setRows)
      .catch((e) => toast.error(e instanceof Error ? e.message : t("common.loadFailed")))
      .finally(() => setLoading(false));
  }, [open, node, t]);

  async function add() {
    if (!node) return;
    try {
      const created = await api.admin.targets.create(node.id, form);
      setRows((r) => [created, ...r]);
      setForm({ host: "", port: 80, weight: 1 });
      toast.success(t("common.saveSuccess"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.saveFailed"));
    }
  }

  async function patch(id: number, input: Partial<EgressTargetInput> & { status?: "active" | "inactive" }) {
    if (!node) return;
    try {
      const updated = await api.admin.targets.update(node.id, id, input);
      setRows((r) => r.map((x) => (x.id === id ? updated : x)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.saveFailed"));
    }
  }

  async function remove(id: number) {
    if (!node) return;
    try {
      await api.admin.targets.remove(node.id, id);
      setRows((r) => r.filter((x) => x.id !== id));
      toast.success(t("common.deleteSuccess"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.deleteFailed"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("node.targets")} — {node?.node_id}
          </DialogTitle>
          <p className="text-xs text-[var(--muted-foreground)]">{t("node.targetsDesc")}</p>
        </DialogHeader>

        <div className="flex gap-2">
          <Input placeholder={t("node.targetHost")} value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
          <Input
            className="w-28"
            type="number"
            placeholder={t("node.targetPort")}
            value={form.port}
            onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
          />
          <Input
            className="w-24"
            type="number"
            placeholder={t("node.targetWeight")}
            value={form.weight}
            onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })}
          />
          <Button onClick={add} disabled={!form.host.trim()}>{t("node.addTarget")}</Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("node.targetHost")}</TableHead>
              <TableHead>{t("node.targetPort")}</TableHead>
              <TableHead>{t("node.targetWeight")}</TableHead>
              <TableHead>状态</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.host}</TableCell>
                <TableCell>{r.port}</TableCell>
                <TableCell>
                  <Input
                    className="w-20"
                    type="number"
                    value={r.weight}
                    onChange={(e) => patch(r.id, { weight: Number(e.target.value) })}
                  />
                </TableCell>
                <TableCell>
                  <Badge className={r.status === "active" ? "bg-emerald-500/15 text-emerald-500" : "bg-zinc-500/15"}>
                    {r.status === "active" ? t("common.active") : t("common.inactive")}
                  </Badge>
                </TableCell>
                <TableCell className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => patch(r.id, { status: r.status === "active" ? "inactive" : "active" })}>
                    {r.status === "active" ? t("common.disable") : t("common.enable")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(r.id)}>{t("common.delete")}</Button>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && !loading && (
              <TableRow><TableCell colSpan={5} className="text-center text-[var(--muted-foreground)]">{t("node.targetsEmpty")}</TableCell></TableRow>
            )}
          </TableBody>
        </Table>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

控权提示：目标池**至少保留一个 active 且 weight>0**（前端也该拦住，后端 409 兜底），否则 agent 拒绝热更新、存量 RELAY 流量断。

### 7.3 创建隧道表单（`web/src/components/tunnels/tunnel-create-dialog.tsx`）

```tsx
// 新增状态
const [mode, setMode] = useState<TunnelMode>("direct");
const [egressNodes, setEgressNodes] = useState<Node[]>([]);
const [egressNodeId, setEgressNodeId] = useState("");

// 打开时拉出口节点（role ∈ {egress, both} 且 online）
useEffect(() => {
  if (!open) return;
  api.admin.nodes({ page: 1, page_size: 200 })
    .then((p) => setEgressNodes(p.data.filter((n) => n.role && n.role !== "ingress")))
    .catch(() => {});
}, [open]);

async function submit() {
  if (!name || !inGroup) return toast.error(t("tunnel.createFailed"));
  // RELAY：必须选出口节点；DIRECT：必须填转发目标
  if (mode === "relay" && !egressNodeId) return toast.error(t("tunnel.egressNodeRequired"));
  if (mode === "direct" && !forward.trim()) return toast.error(t("tunnel.forwardRequired"));
  setPending(true);
  try {
    const created = await api.tunnels.create({
      name,
      tunnel_type: type,
      category,
      in_node_group_id: Number(inGroup),
      tunnel_mode: mode,
      forward_addresses: mode === "direct" ? forward.split("\n").map((s) => s.trim()).filter(Boolean) : [],
      egress_node_id: mode === "relay" ? Number(egressNodeId) : null,
      listen_port: port ? Number(port) : null,
    } as TunnelCreateInput);
    toast.success(t("tunnel.createSuccess"));
    onCreated(created); // 把 egress_port 等新字段带到列表
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t("tunnel.createFailed"));
  } finally {
    setPending(false);
  }
}
```

表单 UI（插在「入口节点组」之后）：

```tsx
<Field label={t("tunnel.mode")}>
  <Select value={mode} onValueChange={(v) => setMode(v as TunnelMode)}>
    <SelectTrigger><SelectValue /></SelectTrigger>
    <SelectContent>
      {TUNNEL_MODES.map((m) => (
        <SelectItem key={m} value={m}>{t(`tunnel.mode${m === "direct" ? "Direct" : "Relay"}`)}</SelectItem>
      ))}
    </SelectContent>
  </Select>
  <p className="text-xs text-[var(--muted-foreground)]">
    {mode === "direct" ? t("tunnel.modeDirectHint") : t("tunnel.modeRelayHint")}
  </p>
</Field>

{mode === "relay" ? (
  <Field label={t("tunnel.egressNode")} hint={t("tunnel.egressNodeHint")}>
    <Select value={egressNodeId} onValueChange={setEgressNodeId}>
      <SelectTrigger><SelectValue placeholder={t("tunnel.egressNodePlaceholder")} /></SelectTrigger>
      <SelectContent>
        {egressNodes.map((n) => (
          <SelectItem key={n.id} value={String(n.id)}>
            {n.node_id}（{t(`node.role${cap(n.role!)}`)}）
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </Field>
) : (
  <Field label={t("tunnel.forwardAddresses")} hint={t("tunnel.forwardAddressesHint")}>
    <Textarea value={forward} onChange={(e) => setForward(e.target.value)} rows={3} />
  </Field>
)}
```

### 7.4 隧道列表/详情（`tunnel-list.tsx` / `tunnel-detail.tsx`）

```tsx
// 模式 Badge
<Badge className={tunnel.tunnel_mode === "relay" ? "bg-purple-500/15 text-purple-500" : "bg-blue-500/15 text-blue-500"}>
  {tunnel.tunnel_mode === "relay" ? t("tunnel.modeRelay") : t("tunnel.modeDirect")}
</Badge>

// 详情页：RELAY 展示 用户→入口:port →出口:egressPort→ 目标池；DIRECT 展示 remote_host:port
{tunnel.tunnel_mode === "relay" ? (
  <div className="flex items-center gap-2 text-sm">
    <span>{t("tunnel.ingress")}: {tunnel.listen_port}</span>
    <span aria-hidden>→</span>
    <span>{t("tunnel.egress")}: {tunnel.egress_port}</span>
    <span aria-hidden>→</span>
    <span>{t("node.targets")}</span>
  </div>
) : (
  <div className="text-sm">{tunnel.remote_host}:{tunnel.remote_port}</div>
)}

// apply_error 展示 + 重试按钮（§4.7）
{tunnel.apply_error && (
  <div className="flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
    <span>{t("tunnel.applyError", { reason: tunnel.apply_error })}</span>
    <Button size="sm" variant="ghost" onClick={() => retryApply(tunnel.id)}>{t("tunnel.retryApply")}</Button>
  </div>
)}
```

`retryApply` → `POST /api/tunnels/:id/retry-apply`（新增用户侧端点，走同一个 orchestrator，DB 不删行）。

### 7.5 mock 数据同步（`web/src/mocks/`）

`web/src/mocks/handler.ts` / `data.ts` 的隧道 mock 需补 `tunnel_mode: "direct"`，节点 mock 补 `role`、`last_seen_at`、`port_range_min/max`——否则 MSW 模式下新 UI 空值渲染异常（列表 Badge 会显示 undefined）。改完跑 `npm run typecheck`（**不要跑 build**）。

---

## 8. 兼容 / 回滚 / 灰度策略

### 8.1 存量 DIRECT 隧道「无感」的四个保证

| 层 | 保证 | 实现 |
|---|---|---|
| Schema | 新列全可空或有默认值 | `tunnel_mode default 'direct'`、`role default 'ingress'` |
| 配置生成 | `config-generator.ts` **不改行为**：不读新列，继续读 `forward_addresses` | 零改动 |
| 数据面 | 存量隧道走 Socket.IO 通道（`control_channel='socket_io'`），agent 的 engine 路径不变 | 零改动 |
| 前端 | 新字段 optional，旧数据 `tunnel_mode` 缺省视为 `direct` | 只读处加 `?? "direct"` |

### 8.2 双写只在写入侧

- 新代码写 DIRECT 隧道时**同时**写 `forward_addresses`（兼容旧路径）与 `remote_host/remote_port`（新路径）。
- 新代码读 DIRECT 隧道时**只读** `forward_addresses`（旧引擎路径）——直到 engine 通道下线。
- `remote_host/port` 只有新前端详情页、orchestrator、迁移回填脚本在读。

### 8.3 灰度开关

系统配置（`SystemConfig` 表已存在，`SystemConfigName` 枚举需加值）：

```prisma
enum SystemConfigName {
  // ... 现有
  /// RELAY 模式总开关：false 时 POST /api/tunnels 拒绝 tunnel_mode=relay
  relay_enabled
  /// 端口黑名单扩展（逗号分隔）
  port_blacklist_extra
}
```

灰度顺序：①迁移上线 → ②`relay_enabled=false`（功能不可见但 schema/agent 就绪）→ ③单节点试点 RELAY → ④按节点逐步开放 → ⑤`relay_enabled=true` 全量。

### 8.4 回滚

- **建隧道失败**：orchestrator 自动回滚（§4.5），无需人工。
- **迁移回滚**：见 §2.4；前提是 RELAY 流量已下线（`relay_enabled=false` + 所有 RELAY 隧道 SUSPENDED + agent 已撤）。
- **agent 版本回滚**：agent 二进制换回旧版即可——旧 agent 不认识 `mode` 字段，HTTP 通道 POST 会 400；此时面板把 `control_channel` 为 `http` 的隧道改回 `socket_io` 并重推配置（提供一个一次性脚本 `scripts/ops/fallback-channel.ts`）。

### 8.5 风险登记

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 入口端口区间与出口端口区间在同一台机器上重叠（BOTH 角色） | 同端口双绑 → `EADDRINUSE` | BOTH 节点的 `port_range_min/max` 管理端强制校验不重叠；agent 侧 `TunnelManager` 与 `EgressManager` 共用一张 `usedPorts` 表 |
| R2 | 热更新把所有目标停用 → RELAY 流量断 | 现网故障 | 前端+后端+agent 三层「至少一个 active」守卫（§7.2/§6.1/§3.3） |
| R3 | 面板多实例部署时 Redis 租约 TTL 到期但隧道仍活跃 | 端口被别的 tunnel 抢走 | 编排成功后 `renewPort`，心跳对账补写（§5.3）；TTL 设为 600s 远大于编排耗时 |
| R4 | egressPort 暴露在节点公网 IP 上 | 绕过入口直连目标池 | §3.6 来源 IP 白名单；节点安全组只放行入口节点 IP 到 `port_range` |
| R5 | socket.io 与 HTTP 双通道给同一条隧道下发 | 端口冲突/双倍监听 | `control_channel` 单通道判定（§3.9）+ 幂等校验（agent 侧重复 POST 返回 200 不重建） |
| R6 | 存量对象形态 `forward_addresses` 回填漏数据 | DIRECT 隧道在 v3.0 详情页显示空目标 | §2.3 两个 UPDATE 覆盖字符串/对象两种形态；回填后跑一遍巡检 SQL 统计 `tunnel_mode='direct' AND remote_host IS NULL` |

---

## 9. 验收标准与测试矩阵

### 9.1 三条核心验收（设计稿 v0.3 的验收项，逐条对应测试）

#### AC-1：RELAY 模式流量全程转发正确

**路径**：用户 → 入口节点 `ingressPort` → 入口 agent（relay forwarder）→ 出口节点 `egressPort` → 出口 agent（egress forwarder，按策略选目标）→ 目标服务。

**测试步骤**：

```bash
# 0. 准备
#    入口节点 N1(role=ingress, port_range 20000-20100)
#    出口节点 N2(role=egress, port_range 30000-30100)，目标池：[10.0.0.9:8080 w=1, 10.0.0.10:8080 w=1]
#    目标：两台的 nginx 返回不同页面（/index1.html 与 /index2.html）

# 1. 建 RELAY 隧道（ingress_node=N1, egress_node=N2）→ 记 ingressPort P / egressPort E
curl -sk -X POST https://panel/api/tunnels -H "content-type: application/json" \
  -b "$COOKIE" -d '{"name":"relay-ac1","tunnel_type":"tcp","category":"port_forward",
    "tunnel_mode":"relay","in_node_group_id":1,"egress_node_id":2,
    "ingress_node_id":1,"forward_addresses":[]}'
# 断言：响应 listen_port ∈ [20000,20100]、egress_port ∈ [30000,30100]
# 断言：DB tunnel.tunnel_mode='relay'、egress_node_id=2、remote_host IS NULL
# 断言：agent N2 日志出现 "listening ... :E"；agent N1 日志出现 "listening ... :P"

# 2. 多轮请求应命中两个目标（round 轮询）
for i in $(seq 1 6); do curl -s http://N1:P/ ; echo; done
# 断言：index1/index2 交替出现（各 3 次）——证明走完了「入口→出口→目标池→LB」

# 3. 反向路径与长连接
nc -vz N1 P && echo "ingress reachable"
timeout 10 bash -c 'exec 3<>/dev/tcp/N1/P; head -c 32 /dev/urandom >&3; dd bs=32 count=1 <&3' 
# 断言：双向字节流完整（大写/回显服务）

# 4. 端口隔离断言
# 断言：P 属于入口区间、E 属于出口区间；P ≠ E 不是必须（不同机器允许同号），
#       但同一节点上两个 lease 的 key namespace 不同（port:ingress:* vs port:egress:*）

# 5. 顺序断言（防回归）
# 在 nodeClient 上打点：出口 POST /tunnel 必须先于入口 POST /tunnel；
# 用 mock server 记录调用顺序，断言 egress.patchAt < ingress.patchAt。
```

**失败即不通过的判定**：任何一轮请求返回连接重置、`502`、或只命中单一目标（LB 没生效）。

#### AC-2：出口目标热更新，无需重建隧道

```bash
# 1. 记录当前隧道 id T 与其 agent 侧 Forwarder 句柄（agent 日志的 "listening" 行只应出现一次）
# 2. 改目标池：加一个目标 10.0.0.11:8080（POST /api/admin/nodes/2/targets）
curl -sk -X POST https://panel/api/admin/nodes/2/targets -b "$ADMIN_COOKIE" \
  -H "content-type: application/json" -d '{"host":"10.0.0.11","port":8080,"weight":1}'
# 断言：agent 侧 PATCH /node/targets 收到；agent 日志出现 targets updated，且**没有**任何 service removed/added

# 3. 改权重：把 10.0.0.9 的 weight 改成 3（PATCH /api/admin/nodes/2/targets/:tid）
# 断言：轮询分布变成 3:1（9号3次 : 10号1次，4次一轮）

# 4. 停用一个目标（weight=0 或 status=inactive）
# 断言：连续 20 次请求不再命中该目标

# 5. 隧道侧零变化
curl -s https://panel/api/tunnels/T -b "$COOKIE" | jq '{listen_port, egress_port, tunnel_mode, updated_at}'
# 断言：listen_port / egress_port 不变，updated_at 未被动过（热更新不写 tunnel 行）
```

**失败即不通过**：目标池变更后需要删/建隧道才能生效；或 agent 侧出现 Forwarder 重建（连接被断）。

#### AC-3：现有 DIRECT 隧道无感迁移

```bash
# 1. 迁移前快照：direct 隧道数 D0、它们的 listen_port / forward_addresses
# 2. 执行 migration.sql（§2）
# 3. 迁移后断言：
#    - D0 条隧道全部 tunnel_mode='direct'、remote_host/remote_port 已从 forward_addresses[0] 回填
#      SELECT COUNT(*) FROM tunnel WHERE tunnel_mode='direct' AND remote_host IS NULL; -- 期望 0
#    - 所有 node.role='ingress'、port_range_min=10000、port_range_max=60000
#    - node_group.node_type 全部保持原值
# 4. 功能断言（不改一行代码）：
#    - 用存量 DIRECT 隧道发一轮流量 → 转发正常（Socket.IO 通道未受影响）
#    - 改动该隧道的名字（PATCH /api/tunnels/:id）→ 配置重推、agent 无异常
#    - 前端隧道列表/详情渲染正常，mode 显示「单跳」
# 5. 回滚演练（可选，预发环境）：执行 §2.4 回滚 SQL → 存量隧道恢复工作
```

### 9.2 单元测试矩阵（可直接落地为 `__tests__`）

**backend**（`node --experimental-transform-types --test` 风格，DB 集成另跑）：

| 文件 | 用例 |
|---|---|
| `services/__tests__/portPool.test.ts` | 并发 50 次 `acquirePort` 在小区间内不重复；黑名单端口永不返回；`releasePort` 后被别人可抢；`portHolder` 反查正确；ingress/egress 同端口号互不排斥 |
| `services/__tests__/tunnelOrchestrator.test.ts` | RELAY 成功顺序 = egress→ingress；出口失败时**入口未被调用**且双端口已释放；入口失败时出口被 `DELETE` 补偿；端口分配失败不触达任何 agent |
| `socket/__tests__/port-allocator.test.ts` | 现有用例不回归（portPool 不改它） |
| `middlewares/__tests__/rate-limit.test.ts` | 新 `internal-heartbeat` 规则命中、且排在 `api-global` 前（反向锚定） |
| `routes/__tests__/node-targets.test.ts` | 空目标池被拒 409；ingress 节点返回 409；upsert 幂等；软删除后不再出现在可用列表 |

**agent**（`go test ./...`）：

| 文件 | 用例 |
|---|---|
| `forwarder/interface_test.go` | `ParseMode` 大小写/别名；`TunnelConfig` 缺必填字段时报错 |
| `forwarder/relay_test.go` | 用 net.Pipe 起真监听：连上 → 数据到达 nextHop 假服务；Stop 后端口可再绑 |
| `forwarder/egress_test.go` | round/rand 分布；`weight=0` 目标永不被选；目标全挂时返回 503/断连 |
| `manager/lb_test.go` | `UpdateTargets` 原子替换后 `Pick()` 立即反映；空池被拒 |
| `manager/egress_test.go` | 多隧道共享同一 LB → 热更新后全部生效；`RemoveTunnel` 幂等 |
| `api/server_test.go` | 缺少/错误 Bearer → 401；egress-only 节点收到 DIRECT → 409；PATCH 空目标池 → 409 |
| `reporter/heartbeat_test.go` | httptest 收包字段齐全；失败不发 panic |

**端到端**（`backend/tests/`，依赖 docker 栈 DATABASE_URL=13306 / REDIS_URL=16379）：

- `v3-relay.test.mjs`：AC-1/AC-2/AC-3 的自动化版（起两个假 agent HTTP server 验证编排顺序与补偿）。
- 单文件独立进程跑：`node --experimental-transform-types --test tests/v3-relay.test.mjs`。

### 9.3 验收检查单（DoD）

- [ ] `prisma migrate` 在干净库 + 存量库（含对象形态 `forward_addresses`）各跑通一次
- [ ] 三条 AC 全绿（附 curl 输出 / 测试日志）
- [ ] `npm run typecheck` 通过（web + backend）；**不跑 build**
- [ ] `go build ./... && go test ./...` 通过
- [ ] 巡检 SQL：`SELECT COUNT(*) FROM tunnel WHERE tunnel_mode='direct' AND remote_host IS NULL;` = 0
- [ ] 端口黑名单命中测试：尝试建 22/9090 端口隧道 → 两层校验都 400
- [ ] `web/src/mocks` 新字段补齐，MSW 模式 UI 正常
- [ ] 文档同步：`docs/v3-relay-migration-plan.md`（本文）+ `DEVELOPMENT.md` 补 agent 新环境变量表

---

## 10. 开发顺序与交付切片

按「每片可独立验收」切，对应设计稿的阶段纪律（不提前实现后续功能）：

| 切片 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **S1 Schema & 迁移** | §1 + §2 + `SystemConfigName` 扩展 | 无 | 迁移在存量库跑通，回填 SQL 幂等，回滚 SQL 可执行 |
| **S2 portPool** | §5 + 单元测试 | S1 | 并发分配无重复、黑名单生效、双池隔离 |
| **S3 Agent 数据面** | §3.1-3.3 + §3.8（interface/direct/relay/egress/lb/manager/tunnel） | 无（纯 Go，可并行） | `go test` 覆盖三种 forwarder 的启停与 LB |
| **S4 Agent 管理面 + 上报** | §3.4 + §3.5 + §3.7 + §3.6 | S3 | `curl -H "Authorization: Bearer …"` 建/删/热更/恢复全通；`/health` 免鉴权 |
| **S5 nodeClient + orchestrator** | §4 | S1+S2+S4 | 编排顺序、补偿、端口释放单测全绿；假 agent 双通道 e2e |
| **S6 后端路由** | §6（targets CRUD / tunnels 改造 / internal） | S5 | curl 全端点；限流规则锚定测试通过 |
| **S7 前端** | §7 | S6 | typecheck 通过；页面手工走查（角色标签 / 目标池 / 模式切换） |
| **S8 灰度与文档** | §8 + 验收 | S7 | AC 三条全绿；灰度开关生效；回滚演练通过 |

S3/S4 可与 S1+S2 **并行**（互不依赖），这是压缩工期的关键路径。

---

## 11. 附录：变更文件清单与风险登记

### 11.1 文件清单

**新增**：

```
backend/prisma/migrations/20260926xxxxxx_v3_relay_architecture/migration.sql
backend/src/services/portPool.ts
backend/src/services/nodeClient.ts
backend/src/services/tunnelOrchestrator.ts
backend/src/routes/admin-node-targets.ts
backend/src/routes/internal.ts
backend/src/services/__tests__/portPool.test.ts
backend/src/services/__tests__/tunnelOrchestrator.test.ts
backend/tests/v3-relay.test.mjs
agent/internal/forwarder/{interface,direct,relay,egress,pipe}.go
agent/internal/manager/{tunnel,egress,lb}.go
agent/internal/api/server.go
agent/internal/reporter/heartbeat.go
agent/internal/forwarder/*_test.go
agent/internal/manager/*_test.go
agent/internal/api/server_test.go
web/src/components/admin/egress-targets-dialog.tsx
docs/v3-relay-migration-plan.md
scripts/ops/fallback-channel.ts        # agent 回滚时压回 socket_io 通道
```

**修改**：

```
backend/prisma/schema.prisma                 # Node/EgressTarget/Tunnel + NodeRole/TunnelMode/LBStrategy 枚举
backend/src/routes/tunnels.ts                # POST/PATCH 支持 mode + 编排调用
backend/src/routes/admin-extended.ts         # DELETE /nodes/:id 暂停相关 RELAY 隧道
backend/src/socket/index.ts                  # register/sysinfo 写 last_seen_at
backend/src/middlewares/rate-limit.ts        # 新增 internal-heartbeat 规则（置于 api-global 前）
backend/src/app.ts                           # 挂载 internal + node-targets 路由
backend/src/worker.ts                        # 端口对账 job
agent/main.go                                # register 后 restore
agent/internal/agent/agent.go                # 按 role 启动组件 + heartbeat reporter
agent/internal/agentconfig/config.go         # ROLE / PANEL_URL / INTERNAL_PORT / AGENT_PORT
web/src/lib/{types,constants,api,i18n}.ts
web/src/components/admin/nodes-manager.tsx
web/src/components/tunnels/tunnel-create-dialog.tsx
web/src/components/tunnels/tunnel-list.tsx / tunnel-detail.tsx
web/src/mocks/{data,handler}.ts
```

**不改**（明确边界）：

```
backend/src/socket/config-generator.ts       # 存量 Socket.IO 配置生成路径
backend/src/socket/config-pusher.ts
backend/src/socket/port-allocator.ts         # 纯函数确定性分配，供旧通道继续用
agent/internal/engine/**                      # 存量配置数据面
```

### 11.2 环境变量增量（agent）

```bash
# /etc/tunex-agent.env 追加
ROLE=ingress                        # ingress | egress | both（默认从面板反查，本地优先）
PANEL_HTTP_URL=http://panel:3001
PANEL_REPORT_TOKEN=<与面板 INTERNAL_REPORT_TOKEN 一致>
AGENT_ADMIN_PORT=9090               # 旧版 AGENT_PORT，兼容保留
PANEL_POLL_INTERVAL=300             # 启动恢复的重试间隔（秒）
```

### 11.3 与设计稿的偏差记录（需产品确认）

| 设计稿 | 本方案 | 理由 |
|---|---|---|
| 路径 `PATCH /tunnel/:id/config` | 暂不实现（v3.0 用 DELETE+POST 替代） | v1.0 范围，避免过早抽象 |
| `EgressTarget` 挂在 Node，无组概念 | 同左；但 `out_node_group_id` 仍写出口节点所属组 | 复用组级推送/刷新链路，改动最小 |
| Agent 9090 管理 / 9191 上报严格分端 | 本仓单端口 Hono：`/api/internal/*` + 专属中间件与限流 | 最小改动；若坚持物理隔离，用「B 方案」第二 server（§6.4） |
| LBStrategy 四种种高级策略 | v3.0 只 `round`/`rand`，接口与 `PickWeighted` 预留 | 按阶段推进，不提前实现 |
| 心跳 30s / 超时 90s | 同左，且与 Socket.IO 10s sysinfo 并存（冗余） | sysinfo 已有离线判定，heartbeat 是 HTTP 通道的补充信号 |

---

## 附：一句话总结

`Node.role` + `Tunnel.tunnel_mode` + `EgressTarget` 三张schema改动撬动全部：**先出口后入口**的编排顺序、**Redis 租约式双端口池**、**目标池热更新不重建隧道**三条铁律，配合 `control_channel` 让存量 DIRECT 隧道零感知迁移。
