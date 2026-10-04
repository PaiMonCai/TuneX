# V5.5 Federation 契约冻结（WP14 / WP15 / WP16）

> 状态：**FROZEN（2026-10-05，Lead 冻结）**
> 依据：`DEVELOPMENT.md` §1（V4 frozen baseline）、§3（工作纪律）、§10（V5.5 Federation）。
> 范围：Panel ↔ Panel 的信任、容量授予、远端租约、用量归因与部分失败对账，以及 Gate V5-G5。
> 本文件与 `DEVELOPMENT.md` 冲突时，以 `DEVELOPMENT.md` 的既有硬不变量为准；本文件只**细化**
> §10，不放松任何一条 V4/V5 已有契约。

---

## 0. 一句话定义

Federation 是**两个独立 Panel 之间、基于显式信任与授予的资源协作**：
发起方（home panel）拥有 Forward 的期望状态与 rollout 账本；承载方（host panel）拥有自己的
Node / 端口 / 租约 / Agent 控制链。**跨面板资源不得被复制成本地资源，也不得产生第二份真相。**

~~~text
Panel A (home)                                Panel B (host)
  Forward desired / revision                    Node / NodePortLease
  ForwardRollout 账本                            Agent（唯一控制人 = B）
  FederatedPlacement（镜像，证据）      ←→       FederatedLease（权威）
  FederatedUsageRecord（收到的事实）             用量真实计数（数据面侧）
~~~

---

## 1. §10 九个必答问题的正式答案

| 问题 | 答案 | 依据/理由 |
|---|---|---|
| Forward ownership | **发起方 Panel 独占**。Forward / ForwardRevision / rollout 账本只存在于 home panel。host panel 不得为同一条 Forward 建第二份 desired。 | §1.4 状态真相链；禁止第二份 desired |
| Node / capacity ownership | **host panel 独占**。远端节点在 home panel 里**不是** `node` 行，只是一条 `federated_placement` 里的**不透明引用**（`peer_node_ref` 字符串）。 | §1.2 一个 Agent 一个 immutable agent_id；跨面板复制 Node 行=第二份身份 |
| Port lease ownership | **host panel 独占**。只有 host 能写 `node_port_lease` / `placement_lease`；home 侧不得写任何端口租约。 | §1.5 端口归 NodePortLease 统一管理 |
| Quota authority | **host panel**（grant 的发出方即配额权威）。home 侧额度不足时拒绝创建，不"先建后补"。 | 容量事实发生在 host。 |
| Usage authority | **host panel**：数据面计数在 host 侧产生，作为**用量事实**上报。home 侧持久化为事实并归因到 Forward/Workspace，不反过来覆盖 host 计数。 | 计量发生在最接近数据面的一侧 |
| Billing / audit authority | 各自对自己资源权威：home 对用户计费与 workspace 审计；host 对其节点的审计。跨面板动作两边都留审计，带 `peer_panel_id` + `message_id` 可互查。 | §14 审计完整性 |
| Revocation authority | host 可撤销 grant → 相关 `federated_lease` 立即失效并**停止服务**；任一方可撤销信任（trust）→ 全部跨面板租约失效。撤销**不可逆**（同一 key/grant 不得复活）。 | §14 fail-closed |
| Partition behavior | fail-closed：租约到期即停；**禁止**静默回落到本地节点或另一条路径（那是未经用户同意的重放置）。恢复后按 revision 对账续跑。 | §1.4 自动恢复不得绕过 lease/revision |
| Conflict reconciliation | 以 **(intent_id, revision) 幂等** + host 侧单调 `lease_epoch` 为序：host 对"自己的运行时状态"权威，home 对"自己想要什么"权威，两边比对 `applied_revision` 与 `lease_epoch` 收敛。 | §9 V5.3 两阶段交接/fencing 同源 |

---

## 2. WP14 —— Panel 身份与信任

### 2.1 身份

- 每个 Panel 有一个**稳定 `panel_id`**（UUID，首次启动生成并持久化，卸载才变），与一个 **Ed25519 密钥对**。
- 私钥：只以密文形态落库 —— AES-256-GCM + `HKDF-SHA256(AUTH_SECRET, info="tunex-federation-v1")` 派生密钥
  （`AUTH_SECRET` 已是启动强制项；**注意**：per-install Fernet key `TUNEX_CONFIG_KEY` 已在 V4 WP15 删除，
  当前 `backend/src/crypto/` 只有 HMAC token 工具，所以这里的 AEAD 封装是**新造件**，见 `federation/seal.ts`）。
  **私钥永不进入** API 响应、审计 metadata、诊断、Support Bundle。
- 公钥以 JWK 形式对外公布；每个密钥有 `key_id`（`sha256(public_key)` 前 16 hex）。

### 2.2 信任建立（bootstrap）

沿用 V4 `NodeEnrollment` 已经证明有效的模式（一次性 token + 过期 + 一次性消费 + 可撤销）：

~~~text
1. B 侧管理员生成本地信任邀请（enrollment token，哈希存储，TTL 默认 15 分钟，单次使用）
2. token 经带外渠道交给 A 侧管理员
3. A → B: POST /api/federation/v1/handshake
     { peer_panel_id(A), public_key(A), token, nonce }
4. B 校验 token（未过期 / 未使用 / 未撤销），把 A 记为 trusted peer，
   返回 B 的 panel_id + public_key + B 对 A 的签名的信任声明
5. A 校验 B 的公钥指纹与带外信息一致（可选更强：指纹人工核对），把 B 记为 trusted peer
~~~

握手请求本身**不需要**先有信任（它携带 token）；但除握手外的**所有**跨面板调用都必须签名。

### 2.3 签名与 replay 防护（强制）

所有跨面板 HTTP 请求必须带：

~~~text
x-tunex-panel-id     发起方 panel_id
x-tunex-key-id       签名公钥的 key_id
x-tunex-message-id   全局唯一（ULID/uuid），服务端唯一索引去重
x-tunex-issued-at    Unix 秒
x-tunex-expires-at   Unix 秒（issued_at + ≤ 60s）
x-tunex-signature    对 raw body（含空 body）的 Ed25519 detached 签名（base64url）
~~~

校验顺序（任一失败即 **401/403 + 审计**，且**不改任何状态**）：

1. `panel_id` 是已知 peer 且信任未撤销；
2. `key_id` 属于该 peer 且未过期/未吊销；
3. `expires_at > now` 且 `issued_at <= now + 60s`（时钟偏移容忍 60s）；
4. `message_id` **未被消费过**（`federation_message_receipt` 唯一索引；重复 → 409 `duplicate_message`，
   且**返回上一次的响应快照**，保证重投递幂等而不是报错）；
5. 签名对 raw body 验证通过。

> 实现用 `jose`（已有依赖）的 Ed25519（EdDSA）。**不发明密码学**：只用标准签名原语，
> 不自定义 KDF、不做自创 AEAD。

### 2.4 轮转与撤销

- **轮转**：`POST /api/federation/v1/keys/rotate`，由**旧密钥签名**；新公钥立即生效，
  旧密钥进入 `retiring`（默认 24h 内仍可验签，之后 `retired`）。轮转**不中断**已有租约。
- **撤销**：任一方管理员可撤销信任（`revoked_at` 置位）。撤销后：该 peer 的所有请求被拒、
  该 peer 的所有 `federated_lease` 标 `revoked`、host 侧**立即停止**相关链路（不等租约到期）。
  撤销不可逆：`panel_id` 重新信任必须重新走 out-of-band token，且 **`lease_epoch` 不回退**。

### 2.5 审计

- 每个跨面板变更都在**两侧**写审计，actor 用既有 `actor_type = "system"`，
  metadata 固定含：`{ actor_kind: "federation_peer", peer_panel_id, direction: "inbound"|"outbound", message_id }`。
- **不扩展 `AuditActorType` 枚举**：MySQL enum 加值会让旧二进制读到未知值时失败（§3.4 同一风险），
  旧 Panel 必须能安全忽略新行。
- 审计 metadata 只允许 allowlist 字段（§14）：禁止 public key 之外的任何密钥材料、禁止 token 明文。

---

## 3. WP15 —— Resource Grant / Remote Lease

### 3.1 Grant（容量与范围）

Grant 由 **host panel 签发给某个 peer（grantee）**，字段语义：

~~~text
grant_id            本地自增 id（对外用 uuid 引用）
peer_panel_id       被授权方
workspace_scope     允许被哪个本地 Workspace 消费（可为空=该 peer 的全部已授权 workspace）
grant_epoch         单调递增，每次"实质变更"（容量/范围/过期）都 +1；绝不回退
scope               允许的 node_group_ids[]、允许的 target 策略、允许的 hop role（ingress/egress/transit）
capacity            max_legs / max_bandwidth_mbps / max_connections（可空=不限，但仍受本地 quota 约束）
quota_reserved      是否从本地 quota 中**预留**（true 时创建 grant 即扣减，撤销即归还）
expires_at          到期即失效（不允许"续期掩盖过期"：续期必须新建 epoch）
status              active | suspended | revoked | expired（应用层字符串，不用 DB enum）
~~~

规则：

1. **grant 不等于 authorization**（§1.6）：grant 只说明 host **愿意提供多少容量**；
   每次 intent 仍要过 host 自己的 RBAC / resource scope / quota / runtime admission。
2. 签发 grant 必须写审计并记录 `created_by`。
3. `quota_reserved = true` 时，预留额度在 host 侧同一事务内扣减；撤销/过期时归还。
4. 撤销 grant：所有基于它的 lease 立即 `revoked` 并停服（fail-closed）。
5. `scope.allow_target_policy` 是**字符串白名单**（允许的 target 策略名）；缺省 = 不限制
   （仍受 host 自己的 RBAC / quota / runtime admission）。非数组、含非字符串元素或未知键
   → `grant_scope_violation`（这是输入问题，**不是** internal_error）。
6. `suspend` 与 `revoke` 的差别必须明确：`suspend` **只拒新 intent**（`grant_not_active`），
   已有 active lease 继续服务但**到期不再续期**（到期即停服），配额不归还；
   `revoke` 才级联停服 + 释放端口 + 归还预留。
7. `lease_epoch` 只在**新的占用**时 +1（新建 lease 行，或撤销/过期后的重新占用）；
   同一条 lease 的 revision 更新**不** bump epoch，只更新 `applied_revision`，
   并以读到的 epoch 作为 CAS 前提（epoch 变了就拒绝，不写入）。

### 3.2 Remote Lease（两阶段）

**home 侧**（`federated_placement`，镜像/证据）与 **host 侧**（`federated_lease`，权威）成对存在。
创建是两阶段，第二阶段的失败**必须**触发补偿：

~~~text
阶段 1（host 侧预留）
  home → host: POST /api/federation/v1/leases
    { intent_id, grant_id, forward_ref, revision, hop_role, requested: {node_ref?, port?, lb?} }
  host: 校验 grant/scope/capacity → 分配具体 Node + 端口（写自己的 NodePortLease）
        → 落 federated_lease（state=reserved, lease_epoch = 上一个 +1）
        → 返回 { lease_id, lease_epoch, node_ref, port, expires_at }
阶段 2（host 侧应用）
  home → host: POST /api/federation/v1/leases/:lease_id/apply
    { intent_id, revision, link: {…与本地 leg 同形状的期望…} }
  host: 用自己的 orchestrator 下发到自己的 Agent（复用 dispatchEgress / dispatchTransit）
        → 等 ACK → federated_lease.applied_revision = revision, state = active
        → 返回 { applied_revision, lease_epoch, ok }
失败：
  host 侧任一阶段失败 → 释放已分配端口/租约（自己的补偿），返回结构化错误码；
  home 侧收到失败 → **不得**把该 hop 当成已放置；rollout 走既有补偿路径。
~~~

**幂等**：`(intent_id, revision)` 是幂等键。同一 `intent_id` 的新 `revision` 是**更新**；
重复投递同一 `(intent_id, revision)` 必须返回**首次结果**（不重复分配端口、不重复下发）。

**释放**：`DELETE /api/federation/v1/leases/:id` → host 停服并释放端口租约。释放幂等。
租约到期（`expires_at` 到）未续 → host **主动停服**并释放；home 侧把对应 placement 标 `expired`。

### 3.3 顺序铁律（§1.3 在联邦上的推广）

~~~text
先远端（host 侧 lease + apply + ACK）→ 再本地入口
撤销/拆除：先本地入口停 → 再远端释放
~~~

任何一步失败都执行补偿：**已建成的远端租约不得泄漏**（与 G4 学到的"失败创建的遗留 runtime"同源）。

### 3.4 home 侧 rollout 集成边界

- home 侧 rollout 在遇到"放置到 peer 的 hop"时调用 `FederationClient`，其余 hop 仍走本地 orchestrator。
- **不新增第二套 revision**：跨面板只传 home 的 `ForwardRevision` 数值与 `intent_id`；
  host 侧的 `applied_revision` 是"host 应用了哪个 revision"的**汇报事实**，不是 host 的 desired 真相。
- `federated_placement` 只是账本中的证据行；**reconcile 的权威期望仍是 Forward desired**。
- 若 peer 不可达：该 hop 进入 `degraded`（可解释错误码），**不自动改用本地节点**。

---

## 4. WP16 —— Usage / 部分失败 / 对账

### 4.1 用量

- host 侧按窗口统计该 lease 的 `bytes_in / bytes_out / connections`，周期推给 home：
  `POST /api/federation/v1/usage`，字段含 `usage_id`（唯一）、`lease_id`、`window_start/end`、计数。
- home 侧按 `usage_id` **唯一去重**（重复/乱序投递必须安全）；归因到 `forward_ref` / workspace。
- 缺失窗口不补 0：**"不知道"不是"零流量"**（与 `TargetObservation` 的 `latency_ms` 同口径）。

### 4.2 必须处理的消息异常

| 异常 | 行为 |
|---|---|
| duplicate delivery | `message_id` / `usage_id` 去重；重复请求返回首次响应快照（幂等） |
| reordered | 以 `revision` / `lease_epoch` / `window_start` 判定新旧；旧消息**只记事实不改状态** |
| network partition | 各自 fail-closed 到租约过期；恢复后由 reconnect reconcile 收敛 |
| stale grant | 引用已撤销/过期 grant 的 intent 一律拒绝（`grant_not_active`），不部分执行 |
| lease expiry | host 停服 + 释放；home 标 `expired` 并在账本留可解释原因 |
| partial commit | host 侧用"预留 → 应用 → 激活"状态机，任何中间态都有超时清理 |
| retry | 所有写接口幂等；重试**不得**产生第二份租约/端口 |
| reconnect reconcile | home 重连后按 `(intent_id, revision)` 重发未确认的 intent；host 侧按同键去重 |
| usage attribution | 用量必须能落到具体 forward/workspace；无法归因的用量进 `unattributed` 桶并告警，不静默丢弃 |

### 4.3 后台循环

复用 `backend/src/worker.ts` 的周期 reconcile（与 `failoverSync` 同层，**顺序**：先本地 reconcile，
再 federation 租约过期/续期，再用量上报/对账）。每一拍必须打印 `evaluated/expired/renewed/reported`
之类的汇总（§8 教训：**决策不留痕的机制与从未运行过的机制无法区分**）。

---

## 5. 分区与失效行为矩阵（必须可解释）

| 场景 | home 侧 | host 侧 | 数据面 |
|---|---|---|---|
| host 不可达 | placement → `degraded(unreachable)`；不回落本地 | —— | 远端链路继续跑到租约到期（不擅自续期） |
| home 不可达 | —— | 租约到期即停服并释放 | 停服 |
| 双方可达但 grant 被撤销 | placement → `revoked` | 停服 + 释放端口 | 停服 |
| 信任被撤销 | 全部 placement → `revoked` | 全部 lease → `revoked` | 停服 |
| 时钟偏移 > 60s | 拒绝签名请求（`clock_skew`） | 同 | 不影响既有链路（只拒新请求） |
| 重复/乱序消息 | 幂等吸收，不回退已应用 revision | 返回首次结果 | 不变 |

---

## 6. 错误码（分层，§13）

~~~text
federation_disabled            功能未开启
peer_unknown / peer_revoked    未知或被撤销的 peer
signature_invalid              签名校验失败
clock_skew / message_expired   时间窗失败
duplicate_message              重复消息（幂等返回首次结果）
grant_not_found / grant_not_active / grant_scope_violation / grant_expired
quota_exhausted                容量/配额耗尽
lease_not_found / lease_expired / lease_revoked
intent_revision_stale          intent 的 revision 比已应用的旧
peer_unreachable               网络不可达
internal_error                 其它（必须带 correlation id）
~~~

错误响应体统一：`{ code, message, retryable: boolean, peer_panel_id, correlation_id }`。
**禁止**把所有联邦失败压成一个 500。

---

## 7. 禁止项（与 V4/V5 既有契约的边界）

- 不建立第二套 desired state / 第二套 reconcile / 第二套 port ownership；
- 不把远端 Node 复制成本地 `node` 行，不给远端资源建本地 `node_port_lease`；
- 不让 Agent 直接接受第二个 Panel 的控制（Agent 仍只认自己的 host panel）；
- 不用 heartbeat / 心跳超时直接改 Forward desired；
- 不把 capability / grant 当成 authorization；
- 不在联邦路径里引入新的长期明文 secret；
- 不做"网络不可达就自动改用本地节点"的隐式重放置。

---

## 8. Gate V5-G5 映射（DEVELOPMENT.md §10.3）

| Gate 场景 | 对应实现 | 断言要点 |
|---|---|---|
| normal grant/use/revoke | WP15 | 租约建立 → host 侧真实 runtime → 撤销后停服且端口归还 |
| credential rotate | WP14 | 轮转后旧密钥仍可验签至 retiring 结束、新密钥可用、链路不中断 |
| credential revoke | WP14 | 撤销后请求被拒、租约全部 revoke、两侧审计齐全 |
| quota exhaustion | WP15 | 超出 capacity 的 intent 被拒且**不产生**任何端口/租约泄漏 |
| lease expiry | WP15/WP16 | 到期后 host 主动停服；home 标 expired |
| Panel A offline | WP16 | host 侧租约到期停服；A 回来后对账收敛 |
| Panel B offline | WP16 | A 侧 placement → degraded；不回落本地 |
| network partition | WP16 | 上述两条的组合：两侧各自 fail-closed |
| duplicate messages | WP14/WP16 | 同 message_id 重放返回首次结果且不重复执行 |
| reordered messages | WP16 | 旧 revision/epoch 不覆盖新状态 |
| partial failure | WP15 | 阶段 2 失败 → host 补偿释放端口，A 侧无残留 |
| reconnect reconcile | WP16 | 重连后按 (intent_id, revision) 收敛到一致 |
| cross-tenant isolation | WP15/WP16 | 另一 workspace 无法消费他人 grant；用量归因不串租户 |
| audit completeness | WP14 | 每个变更两侧各一条审计，含 peer_panel_id / message_id |

---

## 9. 第一阶段支持边界（不开放项，必须 fail-closed 拒绝）

- 任意拓扑图 / 动态 middle pool / 跨面板最短路径路由；
- 跨面板 3+ 跳（第一版只支持"一个远端 hop"：远端 ingress **或** 远端 egress）；
- 跨面板自动 failover/failback（第一版只有"到期停服 + 可解释状态"，不做自动迁移）；
- 远端资源的本地计费结算（只上报用量事实，不做跨面板结算）；
- 多 Panel 信任的传递闭包（A 信任 B、B 信任 C ⇒ A 不自动信任 C）。

---

## 10. 实现清单（供 PR 交付对齐）

~~~text
WP14
  backend/src/services/federation/identity.ts       panel_id / 密钥对 / 加解密
  backend/src/services/federation/signing.ts        签名 + 校验 + replay window
  backend/src/services/federation/trust.ts          握手 / 轮转 / 撤销
  backend/src/routes/federation.ts                  /api/federation/v1/*
  backend/src/middlewares/federation-auth.ts        跨面板请求鉴权
  prisma: federation_peer / federation_credential / federation_message_receipt / federation_setting

WP15
  backend/src/services/federation/grant.ts          签发/撤销/容量
  backend/src/services/federation/lease.ts          host 侧 lease 状态机
  backend/src/services/federation/placement.ts      home 侧镜像 + rollout 集成
  backend/src/services/federation/client.ts         home 侧出站客户端（超时/重试/错误分类）

WP16
  backend/src/services/federation/usage.ts          用量去重/归因
  backend/src/services/federation/reconcile.ts      过期/续期/重连对账
  backend/src/worker.ts                             周期接入（Lead 接线）

Gate
  scripts/v3-e2e/v5-g5.py                           两 Panel 联邦 Gate
  scripts/v3-e2e/bootstrap-federation.py            第二 Panel + 信任/授予引导
~~~
