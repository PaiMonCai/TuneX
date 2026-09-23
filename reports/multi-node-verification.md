# RelayX-Clone 多节点场景验证报告

**报告日期**: 2026-09-24 (CST)
**验证对象**: `relayx-clone` 控制面（backend + Socket.IO agent 接入层 + Web）与 Go node agent（`agent/`，v0.13.22 复刻）
**验证范围**: 同一节点组内 **2 个 agent** 的：① 注册与节点发现、② 配置下发、③ 端口冲突、④ 心跳/离线
**结论**: ⚠️ **核心链路（注册/下发/心跳）在单节点与多节点下均打通；但同组多节点存在 2 个高危缺陷（离线检测缺失、出口端口回填断裂）与 4 个中/低问题，未做“同组多节点”专门收敛。**

---

## 0. 结论摘要（TL;DR）

| # | 场景 | 判定 | 一句话说明 |
|---|---|---|---|
| ① | 同组 2 agent 注册 | ✅ 通过 | 两个 agent 均注册成功、写入 `node` 表、进入同一 room，`register` ACK 正确 |
| ① | 节点发现 / 计数 | ⚠️ 部分 | 节点被正确登记并展示（`node_count`/`online_node_count`），但“在线”口径 = `status=active`，**崩溃节点永远算在线** |
| ② | 配置下发（同组广播） | ✅ 通过 | 1 个 agent 注册即向全组 room 广播；3 个并发同组连接各收到 3 条 `config`，Fernet 解密与字节校验通过 |
| ② | 出口(out)节点动态端口回填 | ❌ **缺陷（高）** | 后端写入与配置生成器读取的 **Redis key 前缀/字段名不一致**，出口端口缓存永远读空 → 出口链路 hops 恒为空 |
| ③ | 端口冲突（固定端口） | ✅ 检出 | 第 2 个 agent `bind: address already in use`，服务数 0，但**无服务端感知** |
| ③ | 端口冲突（动态 WAIT_LISTEN） | ⚠️ 部分 | 同一 agent 内 tcp/udp 端口分配**互相冲突**（tcp-8=19000 与 udp-8=19000 撞车）；跨 agent 冲突仅靠调用方预检 |
| ③ | API 层端口冲突预检 | ✅ 通过 | 同组同端口创建返回 `监听端口已被占用`；不同组同端口允许（符合 §语义） |
| ④ | 心跳 sysinfo | ✅ 通过 | 每 10s 上报，Redis `sysinfo:<gid>:<node>` TTL=30s，内容 24 项指标完整 |
| ④ | 离线检测 | ❌ **缺陷（高）** | sysinfo key 过期后 **DB 节点状态仍是 active**，无 worker 将失联节点置为 inactive；agent 的 `listen_error` 服务端也无 handler |

**总体**: 多节点**注册→下发→心跳**主链路可用；但**离线检测**与**出口端口回填**两处在多节点下语义不正确，属于“跑得起来但状态会骗人”的类型，建议在宣称支持多节点前修复。

---

## 1. 环境与拓扑

### 1.1 运行环境
- 主机：`hkthyear-1043084428`（Linux 6.8, x86_64），root
- 编排：`/opt/relayx-clone/docker-compose.yaml`
- 关键容器（实测 `docker ps`）：

| 容器 | 镜像 | 端口 | 状态 |
|---|---|---|---|
| `relayx-clone-backend` | relayx-clone-backend:latest | `8787→3000`(HTTP API), `8788→3001`(Socket.IO) | Up (healthy) |
| `relayx-clone-worker` | relayx-clone-backend:latest | — | Up (cron/BullMQ) |
| `relayx-clone-web` | relayx-clone-web:latest | `3000`(expose, via Caddy) | Up (healthy) |
| `relayx-clone-caddy` | caddy:latest | `9091→80`, `9445→443` | Up |
| `relayx-clone-mysql` | mysql:8.4.11 | `3307→3306` | Up (healthy) |
| `relayx-clone-redis` | redis:7.4-alpine | `6381→6379` | Up (healthy) |

- `SITE_URL=http://127.0.0.1:8788`（`.env`）—— license 的 `site_url` 必须与此**逐字节一致**，否则 agent 拒绝（实测见 §2）。
- 控制面版本：`backend/src/socket/index.ts` W2 接入层；agent `go build` 成功，`go test ./...` 全绿。

### 1.2 测试拓扑（同组 2 agent）

```
                 Socket.IO (Engine.IO v4)  (:8788)
   MN-Node-A ─┐
              ├──► backend  :3000  room = node_group/4
   MN-Node-B ─┘        │
                 MySQL relayx          Redis
              node_group id=4 "MN-IN"   sysinfo:4:<node>
              token b0000001-…-01       alive_groups
              port_range 19000-19010    out_listen:4 / tunnel:out_listen
```

- 新建节点组 **MN-IN（id=4, type=in, port_range=19000-19010）**，token `b0000001-0000-4000-8000-000000000001`。
- 两条隧道（同属该组）：`MN-t1`(id=8, fwd `127.0.0.1:19911`)、`MN-t2`(id=9, fwd `127.0.0.1:19912`)。
- 两个 agent 用**同一 token** 连接、`-n MN-Node-A` / `-n MN-Node-B`、`-i 127.0.0.1`。
- 另有存量组：HK-IN(id=1)、HK-OUT(id=2)。

### 1.3 复现资产（本次新建，供复核）

| 文件 | 用途 |
|---|---|
| `/tmp/mn-verify/fixture.sql` | 幂等造数：MN-IN 组 + 2 隧道 |
| `/tmp/mn-verify/run.sh` | Phase A/B/C：固定端口冲突 / 动态端口 / 心跳 |
| `/tmp/mn-verify/heartbeat.sh` | Phase D：心跳 TTL 与离线检测 |
| `/tmp/mn-verify/phaseE.sh` | Phase E：动态回填 / register_block / 重复 node_id / API 冲突 |
| `/tmp/mn-verify/probe.py` | 原始 Engine.IO/Socket.IO 探针（抓 register ACK、config 帧） |
| `/tmp/mn-verify/fanout.py` | N 个同组并发连接，统计 config 广播 |
| `/tmp/mn-verify/decrypt.py` | 抓取并 Fernet 解密 license / config |
| `/tmp/mn-verify/evidence/` | 全部原始证据（日志、DB 查询、ss 输出、帧抓包） |

---

## 2. 协议基线（本次实测复核）

与既有报告 `01-config-e2e.md` 一致，本次用**自研服务端 + 自研 agent** 再次实测确认：

```
S→C  0{"sid":...,"pingInterval":25000,"pingTimeout":20000,...}   # Engine.IO open
C→S  40{"token":"<node_group.token>"}                            # Socket.IO CONNECT
S→C  40{"sid":"..."}                                             # CONNECT ack
C→S  420["register",{node_id,connect_ip[],ports{},sysinfo,version}]
S→C  430[{license,site_url,type,now}]                            # ★ ACK=43<id>[json]
S→C  42["config","<fernet>"]                                     # ★ 裸字符串，非数组
C→S  42["sysinfo",{node_id,sysinfo{24项}}]  每 10s
```

实测抓包（`fanout.txt`）逐字节印证 `430[...]`、`42["config","…"]`。

**license 解密实测**（`decrypt.py`，密钥 `<per-install key>`）：
```json
{"expired_at":4102444799,"type":"business","site_url":"http://127.0.0.1:8788"}
```
`expired_at` 为 **int64 数字**、`site_url` 与 `-s` **逐字节一致**、`type=business` —— 三项全过，agent 打印 `License loaded successfully`。

---

## 3. 场景①：注册与节点发现

### 3.1 过程
1. 启动 `MN-Node-A` → 5s 后查 DB；2. 再启动 `MN-Node-B` → 查 DB / Redis。

### 3.2 结果（证据 `A-nodes.txt`, `A-sysinfo2.txt`）

启动 A 后即**同时**存在两行（B 是上一轮遗留），两 agent 均注册成功：

```
node_id      connect_ip   version   status   node_group_id
MN-Node-A    127.0.0.1    0.13.22   active   4
MN-Node-B    127.0.0.1    0.13.22   active   4
```
Redis：`sysinfo:4:MN-Node-A`、`sysinfo:4:MN-Node-B` 均存在 → 两节点进入同一组的心跳集合。

- **注册 ✅**：`430[{"license",...}]` ACK 正确，`node` 行 upsert（`node_id` 唯一键），`connect_ip`/`version` 随上报更新。
- **发现 ✅**：`GET /api/node-groups` 返回 `node_count`/`online_node_count`（实测 MN-IN=7/7、HK-IN=2/2）。
- **⚠️ 在线口径缺陷**：`online_node_count` 直接按 `node.status='active'` 统计（`node-groups.ts`），而**没有任何 worker 会在心跳丢失后把节点置 `inactive`**。见 §5-缺陷#2。

### 3.3 同组 2 agent 的 room 归属
两连接都用同一 token → `io.use` 中间件命中同一 `node_group` → 都 `join("node_group/4")`。**同组广播成立**（§4 验证）。

---

## 4. 场景②：配置下发

### 4.1 同组广播计数（多节点核心）
`fanout.py`：3 个并发连接，**同一 token**，各自 `register`，统计收到 `config` 帧数。

```
FANOUT-1: config_frames=3
FANOUT-2: config_frames=3
FANOUT-3: config_frames=3
```
**每个节点都收到了 3 条 config** —— 即每个 agent 注册都会 `pushNodeConfig(groupId)` 向整组广播。证据：每条连接收到的 3 条密文彼此不同（`…Id4_`/`…n-Br`/`…5QaQ`），但**同一条帧被 3 个节点同时收到**（同一密文出现在三条连接里），证明 room 广播语义正确。

> 结论：**配置下发在“同组多节点”下工作正常**，且天然是“全员重推”模型。

### 4.2 下发明文校验（正确性）
用配置密钥 `<per-install key>` 解密 `config` 帧：

```json
{
  "log": {"level":"fatal"},
  "tls": {"validity":"8760h","commonName":"127.0.0.1","organization":"127.0.0.1"},
  "services": [
    {"name":"tcp-8","addr":"0.0.0.0:19001","handler":{"type":"tcp"},"listener":{"type":"tcp"},
     "limiter":"limiter-u1","observer":"observer",
     "forwarder":{"nodes":[{"name":"127.0.0.1:19911","addr":"127.0.0.1:19911","metadata":{"weight":"1"}}],"selector":{"strategy":"round"}},
     "metadata":{"enableStats":true,"observer.resetTraffic":true,"observer.period":"10s"}},
    {"name":"udp-8", …},{"name":"tcp-9",…},{"name":"udp-9",…}
  ],
  "chains": [], "climiters": [],
  "limiters": [{"name":"limiter-u1","limits":["$ 1.25MB 1.25MB"]}],
  "bypasses": [], "admissions": [],
  "observers": [{"name":"observer","plugin":{"type":"http","addr":"http://127.0.0.1:8788/api/tunnel/observer"}}]
}
```
- `observers` **非空** ✅（原版 agent 空数组会 panic 的硬约束满足）
- 端口/转发/限速器结构正确 ✅
- agent 侧解密并 apply：日志 `config: decrypted bytes=1901` → `config applied services=4` ✅

### 4.3 ❌ 缺陷（高）：出口(out)节点动态端口回填断裂

**现象**：出口节点（`node_type=out`）的动态端口缓存读不到，导致出口链路 hops 恒为空。

**根因**：写入点与读取点的 Redis key/字段不一致（`out_listen` 三段全错）：

| 环节 | 代码 | 实际使用 |
|---|---|---|
| 写入（socket 接入层） | `socket/index.ts:153` | `HSET out_listen:<groupId>` field=`<service名>`，value=`port:type` |
| 读取（配置生成器） | `config-generator.ts:56,495` | `HGETALL tunnel:out_listen` field=`<nodeId>:<type>` |

三处不匹配：
1. **key 前缀**：写 `out_listen:<groupId>`（按组），读 `tunnel:out_listen`（全局单键）。
2. **field 形态**：写 agent 上报的服务名（如 `relayx`/`tcp`），读 `${nodeId}:${type}`。
3. **无 nodeId**：写入端根本没有节点标识，无法生成 `<nodeId>:<type>`。

**影响**：`buildOutNodeConfig` 的 `getOutListenFromCache` 永远取不到值 → `tunnelTypes` 里虽含出口隧道类型，但 `chains[].hops[].nodes` 恒为空；出口节点实测 `out_listen:4` 为**空 hash**（`E1-outlisten-A.txt`/`E1-outlisten-AB.txt` 均空）。单节点下也会踩到，多节点只是让它更明显（每个出口节点都需要自己的端口）。

### 4.4 ⚠️ 观察（中）：广播为“无条件全员重推”，无增量去重
`config-generator.ts` 已产出 `fingerprint`（sha256）供增量去重，`config-pusher.ts` 注释也提到与 `node_group:config_hash` 比对，但**当前 `pushNodeConfig` 直接 `emit`，未做 hash 比对**。同组 N 节点时，任一节点 register/隧道变更都会向全组 N 个节点全量重推。功能正确，节点多时是放大。证据：agent 每 ~6-10s 重复 `config applied services=4`。

---

## 5. 场景③：端口冲突

### 5.1 固定端口冲突（Phase A）— ✅ 检出
两隧道固定端口 `19001/19002`。A 先启动成功绑定；B 后启动：

```
# A (先)      : listening tcp-8 0.0.0.0:19001 / tcp-9 0.0.0.0:19002 → config applied services=4
# B (后)      : failed to start service name=tcp-8 err=listen tcp 0.0.0.0:19001: bind: address already in use
#              failed udp-8/tcp-9/udp-9 同样 EADDRINUSE → config applied services=0
```
`ss -ltnp` 确认 19001/19002 **仅由 A 的 PID 持有**（`A-ss-owner.txt`：pid=1925514）。B 绑定失败但进程存活、连接保持。

- **agent 侧 ✅**：正确识别 `isAddrInUse` → 触发 `OnListenError` → 发射 `listen_error` 事件（`{node_id,name,error:"ERR_PORT_IN_USE"}`）。
- **服务端 ❌**：backend **没有 `listen_error` 的 handler**（`grep` 全仓无命中）→ 该事件被**静默丢弃**，控制面**完全不知道**某节点起服务失败。见 §6-缺陷#2。

### 5.2 动态端口（Phase B）— ⚠️ 部分
`listen_port=NULL` → 配置用 `:WAIT_LISTEN19000-19010` 占位，agent 动态选端口。

- **首个 agent（A）**：`tcp-8→19000, udp-8→19001, tcp-9→19002, udp-9→19003`（首次给 tcp/udp **各自**分配了不同端口）。
- **问题**：同一 agent 的**二次刷新**后变为 `tcp-8→19000, udp-8→19000, tcp-9→19002, udp-9→19002` —— **TCP 与 UDP 使用了相同端口号**。因 TCP/UDP 是不同协议栈，内核允许同号共存，但对“同一条隧道的 tcp/udp 应否同端口”属于**语义未收敛**；对**同协议**（如两条 tcp）若同组多节点各自 `GetFreePortByRange`，则纯靠 `usedPorts`（仅进程内）与 OS 端口占用，**跨进程无协同**。
- **跨 agent**：当 A 已占 19000/19002，B 启动时**同样崩在 `EADDRINUSE`**（`E-B.log`），即“动态”并未规避同组多节点冲突。

### 5.3 API 层端口冲突预检（Phase E4）— ✅ 通过
创建隧道时的服务端预检 `db.tunnel.findFirst({in_node_group_id, listen_port})`：
- 同组同端口 `19000` → `{"error":"监听端口已被占用"}` ✅
- **不同组**同端口 `19000`（group 1）→ 允许创建 ✅（符合“端口冲突按入口组隔离”的语义，对应 `@@unique([listen_port, in_node_group_id])`）

> 注：**运行时**冲突（agent 实际 bind 失败）与**声明式**冲突（DB 唯一约束）是两条独立防线；当前只有后者生效，前者无控制面闭环。

---

## 6. 场景④：心跳与离线检测

### 6.1 心跳上报 — ✅ 通过（Phase C）
- 频次：每 **10s** 一次 `sysinfo`（agent `sysinfoInterval`）。
- 落点：`SET sysinfo:<groupId>:<nodeId> EX 30`。
- 实测 TTL=27（发出后 ~3s 读，30 - 3）✅；12s 后 `last_active` 从 `…:38.974Z` 刷新到 `…:48.956Z` ✅。
- 载荷：24 项指标齐全（cpu/disk/load/mem/net/conn/uptime…），见 `C-payload-A.txt`。
- `alive_groups` SET 维护：`{1, 4}` ✅。

### 6.2 ❌ 缺陷（高）：无离线检测，失联节点永久“在线”（Phase D）
模拟崩溃（`kill -9`）后：

| 时刻 | sysinfo key | DB `node.status` |
|---|---|---|
| kill 后 +1s | `EXISTS=1`（TTL 内） | `active` |
| kill 后 +36s（TTL 已过） | `EXISTS=0`（key 已过期） | **仍 `active`** |

即：**Redis 心跳已消失，但 `node` 表状态无人更新**。`alive_groups` 也仍是 `{1,4}`（无清理）。

- 影响：`online_node_count`、隧道“online”标记、`HIDE_NODE_STATUS` 等都基于 `status=active`，会**长期高估在线节点**。
- 现有 `disconnect` handler 只写了 `dc:<groupId>:<socketId>` 标记（`D-dc-keys.txt` 命中 1 个），注释自述“完整实现用 BullMQ delay job；此处标记供 worker 扫描（W4 接入）”——**worker 侧未实现扫描**，且该标记 key 与 node 无关联，无法反查节点。
- 该标记还是**按 `socket.id`** 而非 `node_id`，重连即换 id，无法可靠对应节点。

### 6.3 附加验证（Phase E）
| 子场景 | 结果 | 证据 |
|---|---|---|
| `register_block` 防暴破 | ✅ 命中后 ACK `430[{"error":"too many attempts"}]`，agent 拒绝注册 | `E2-rb-ack.txt` |
| 重复 `node_id`（2 agent 同 `-n`） | ✅ DB 仅 1 行（`node_id` 唯一键约束），后到者覆盖 `connect_ip`/`version` | `E3-count.txt`=1 |
| 同组多 agent 心跳并存 | ✅ 各自 key 独立，互不覆盖 | `A-sysinfo2.txt` |

---

## 7. 缺陷清单

| # | 严重度 | 位置 | 问题 | 影响 |
|---|---|---|---|---|
| 1 | ❌ **高** | 控制面 | sysinfo TTL 过期后无任何逻辑把 `node.status` 置 `inactive`；`disconnect` 标记（`dc:<gid>:<socket.id>`）无消费者且与 node 无关联 | 离线节点永久显示在线；`online_node_count`/隧道 online 失真 |
| 2 | ❌ **高** | 控制面 | 无出口节点动态端口回填：写 `out_listen:<gid>` vs 读 `tunnel:out_listen`，且 field 形态（服务名 vs `<nodeId>:<type>`）与是否带 nodeId 全不一致 | 出口(out)节点链路 hops 恒空，出口转发不可用 |
| 3 | ⚠️ **中** | 控制面 | `listen_error` 事件无 handler | agent 起服务失败（EADDRINUSE 等）控制面不可见，无告警/自动迁移 |
| 4 | ⚠️ **中** | 控制面 | `pushNodeConfig` 未用 `fingerprint` 做增量去重，同组 N 节点无条件全量重推 | 节点规模大时放大 Redis/DB/带宽与 agent 重载 |
| 5 | ⚠️ 中 | agent | 动态端口 `usedPorts` 仅进程内；同组多节点/同进程 tcp+udp 均可撞端口，无跨进程协同 | 动态端口在多节点下仍会 `EADDRINUSE` |
| 6 | ℹ️ 低 | 控制面 | `port_conflict_at` 字段无写入者（声明式预检只返回 400，不落库） | 冲突历史不可审计 |

---

## 8. 修复建议（按优先级）

1. **离线检测闭环（#1）**：worker 增 cron（如 `cron_check_node_offline`，30-60s）扫描 `node`：对无 `sysinfo:<gid>:<node_id>` key 的 `active` 节点置 `inactive` 并清 `alive_groups`；把 `disconnect` 标记改为按 `node_id` 且由 worker 消费（或直接用“心跳 TTL 缺失”判定，弃用 socket.id 标记）。
2. **统一出口端口缓存契约（#2）**：确定单一 Redis 结构（建议 `tunnel:out_listen`，field=`<nodeId>:<type>`，value=port），**写入端**（`socket/index.ts` 的 `listen` handler）改为同时 `HSET tunnel:out_listen <nodeId>:<type> <port>`；或反之统一到按组。写入端需拿到 `nodeId`（`listen` 载荷已带 `node_id`）。
3. **补 `listen_error` handler（#3）**：`socket.on("listen_error", …)` → 记录并（可选）写隧道 `port_conflict_at`/发通知，形成运行时冲突闭环。
4. **增量下发（#4）**：`pushNodeConfig` 计算/复用 `fingerprint`，与 `node_group:<gid>:config_hash` 比对，未变则跳过 `emit`。
5. **动态端口协同（#5）**：优先按“入口组维度”在服务端分配端口并下发（服务端已知全局拓扑），避免各 agent 各自 `bind` 试错。

---

## 9. 附：证据索引（`/tmp/mn-verify/evidence/`）

**A = 固定端口冲突**：`A-nodes.txt`（两节点注册行）、`A-sysinfo*.txt`、`A-B-log.txt`（EADDRINUSE×4）、`A-ss-owner.txt`（端口归属）、`A-outlisten.txt`（空）

**B = 动态端口**：`B-tunnels.txt`（listen_port=NULL）、`B-A-log.txt`（A 首次 19000/19001/19002/19003）、`B-B-log.txt`（B 冲突）、`B-tunnels-after.txt`（回填 19000/19002）

**C = 心跳**：`C-keys.txt`、`C-payload-A.txt`/`C-payload-A2.txt`（last_active 刷新）、`C-ttl-A.txt`=27、`C-alive.txt`

**D = 离线**：`D-t0-node.txt`（active）、`D-kill-exists.txt`、`D-expire-exists.txt`=0、`D-expire-node.txt`（**仍 active**）、`D-dc-keys.txt`

**E = 附加**：`E1-outlisten-*.txt`（出口缓存空→#2）、`E2-rb-ack.txt`（register_block）、`E3-count.txt`（重复 node_id=1）、`E4-conflict.json`/`E4-free.json`（API 冲突预检）

**协议/解密**：`probe-register.txt`、`fanout.txt`（3×3 广播）、`config-decrypted.json`（明文配置）、`license-ack.json`（ACK 四件套）

**原始日志**：`A-MN-Node-A.log`、`A-MN-Node-B.log`、`B-MN-Node-A.log`、`B-MN-Node-B.log`、`E-A.log`、`E-B.log`、`D-HB.log`

---

### 变更/清理说明
- 本次仅在测试中新增幂等 fixture（节点组 `MN-IN`/id=4、隧道 `MN-t1`/`MN-t2`）与 `/tmp/mn-verify/**` 资产，未修改任何源码或生产数据。
- 测试用临时节点（`MN-Node-*`、`E-*`、`DUP-1`、`HB-Node`、`DEC-1`、`PROBE-1`、`FANOUT-*`、`RB-1`）已从 `node` 表清除；`MN-t1/MN-t2` 已复位为固定端口 `19001/19002`。
- 所有 agent 进程已退出（`pgrep -x relayx-agent-mn` = 0）。
