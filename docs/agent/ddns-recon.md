# DDNS 产品化预研（R3-A 收束 + Leader 真实样本）

> 只读预研结论 + 真实响应样本。用于 backlog #4「DDNS UI：接 TuneX 已有 backend」的切片设计与验收。**不授权编码，不代表功能已完成。**

## 1. 核心结论：后端几乎完整，Web 侧**完全没有**

`grep -ril "ddns|DnsProvider|dns_provider" web/src` = **0 文件**（页面/组件/API 客户端/i18n/mock 全无；admin 域也没有）。典型「后端已有、只缺 UI」→ 主路径 **REUSE / EXPOSE**。

### 1.1 TuneX 已有能力（文件:行）

| 层 | 落点 |
|---|---|
| 路由/权限 | `routes/ddns.ts:28-34`（GET=`settings:read`、写=`settings:manage`）、`:52-58`（`super_admin`）、`:93/101/117` |
| Forward 前门 | `routes/forwards.ts:446-470`（GET，`forward:read`）、`:472-493`（POST）、`:495-505`（DELETE）；**必须注册在 `/:id/:action` catch-all 之前**（曾实测被吃成 400） |
| 绑定服务 | `services/ddns-binding.ts`：`:17-41` 错误码、`:46` TTL 60..3600、`:52` 五态、`:66` provider 仅 cloudflare\|huawei、`:335-460` bind（`connect_ip` 空即拒、**绝不回落**）、`:466-505` 幂等 unbind、`:533-620` provider CRUD（**`providerView` 永不含凭据**） |
| 执行/退避 | `services/ddns-executor.ts:25` 退避阶梯 5s→15min、`:318-479` `syncForwardDns`（读回确认；失败不动 epoch/revision；可重试错误写 `now+delay`，不可重试写 `null`） |
| 闸门/后继 | `services/ddns-successor.ts:69-110` 就绪判据、`:135-162` `waiting_for_rollout`、`:224-263` desiredValues **只返回 owner `connect_ip`** |
| 接线 | `services/failover-loop.ts:264-286`（闸门先于迁移）、`:304-320`（后继后于迁移）；`worker.ts:31` 30s 节拍 |

### 1.2 Leader 抓到的真实响应（scratch 拓扑，D4 之前的镜像）

```json
GET /api/ddns/providers → 200 { "data": [] }
GET /api/forwards/1/dns → 200 { "data": {
  "state": "unbound", "domain": null, "record_type": null, "mode": null, "provider_id": null,
  "expected_values": ["172.33.10.20"], "confirmed_values": [], "synced_at": null,
  "verified": false, "last_error": null } }
```

要点：**expected_values 是服务端从入口节点 `connect_ip` 推导的**，前端不得自己拼；`unbound` 是正常初始态；未绑定 `sync`。

D4 已补三个读投影字段（`auto_resolve` / `attempt_count` / `next_attempt_at`，`DnsBindingState` 与 GET select 同步扩展，69 pass / 0 fail）——**上面这段样本来自 D4 之前的镜像，所以看不到它们**；切片开发时须以重建后的后端为准。

## 2. 必须在 UI 里如实呈现的两条语义陷阱（首发不得提供）

- `multi_entry` 今天**只写 owner 单地址**（`ddns-successor.ts:243-261`）⇒ 不得把它当 HA/容灾卖点，否则会把客户端静默指向不服务的机器。
- `CNAME` 会被执行器**写成一个 IP 值**（`ddns-executor.ts:309/415`）⇒ 首发不提供 CNAME 入口。

## 3. 缺口（G1–G13 摘要）

G1 Web 全缺（EXPOSE）；G2 原 GET 不回 `auto_resolve`（**D4 已修**）；G3 原不回退避字段（**D4 已修**，退避可见性此前不可能诚实实现）；G4 `dns_provider_unconfigured`/`dns_path_unready` 只在 worker 日志；G5 TTL 被接受后丢弃（无列）⇒ UI 不得暴露 TTL；G6 CNAME 陷阱；G7 multi_entry 只写单地址；G8 列表无 DNS 字段；G9 无凭据测试端点；G10 provider 不可编辑（无 PATCH）；G11 权限三态不对称（读 `settings:read`／写 `settings:manage`／绑定需 `forward:update`）；G12 原缺 `/forwards/:id/dns` 路由级测试（**D4 已补**）；G13 平台级 provider 无 UI。

## 4. 推荐切片与硬约束

范围：①设置页 Workspace 级「DNS 服务商」CRUD（token **只写不读**）；②Forward 详情页「DNS 前门」卡片（绑定/解绑/五态 + 人话原因 + expected/confirmed + `synced_at` + 退避）；③mocks + 行为测试。

必须读服务端、**禁止推断**：
- 五态 / `verified` / `synced_at` / `last_error` / `confirmed_values` / `expected_values` / `next_attempt_at`；
- **只有 `state === "synced"` 才可写"已切换"**；`synced_unverified` = "已写入，尚未确认"；
- `POST 200` ⇒ 只能是 `pending`，不等于已同步；`auto_resolve=true` ⇒ 不等于"已切换"；
- 区分"将于 X 重试"与"不会自动重试"，两者都读服务端（`next_attempt_at` 为 `null` vs 有值）；
- `connect_ip` 为空 ⇒ `dns_address_unavailable`，**不得展示猜测地址**；
- provider 列表为空 ⇒ 不等于"平台没配"。

护栏：带 `x-workspace-id`；切 Workspace 丢弃晚到响应（复用既有 fence）；token 不进 URL/toast/localStorage/SSR/mock 日志，输入不回填、成功即清空；`auto_resolve` 开关旁必须说明"DNS 路径不可用会闸住自动迁移、epoch 不动"；权限三态不得放宽或代建。

明确不做：新增端点/schema/migration/CI；admin 平台级 provider 页面；host 级 DDNS；webhook provider；UI 暴露 TTL；CNAME 入口；列表 DNS 列/筛选；凭据测试按钮；DDNS 通知；多入口容灾承诺；不改执行器/闸门/failover。

## 5. ForwardX 参考（只读行为，未复制代码/文案）

可吸收：两级心智（Provider → 域名 → 绑定对象 → 地址变化 → 写 → 失败退避 → 用户看到 lastValue/时间/人话错误与"未切换"兜底）；未配 provider 时开关不可用并给原因；密钥只写不读、留空保留旧值；状态可见（含"未切换""DDNS 同步异常"）。

不吸收：全局单例设置平铺（会废掉 Workspace 作用域与 `NULL` fail-closed）；"掩码即安全"式可解密回显；host 级 DDNS（会造第二份 desired state 绕过 `config_revision`/rollout）；事件即写 DNS（会指向未 applied 的入口）；进程内锁/重试（多实例不成立）；`lastDdnsValue` 字符串幂等（与 `confirmed_values` 双判据打架）。

## 6. 未验证

真实 cloudflare/huawei 适配器与真实 API 形状未验证（窄契约、需凭据自带 endpoint）；CNAME 在真实 provider 上被拒还是被接受未验证；存量 `dns_provider.workspace_id IS NULL` 行与 `dns_confirmed_values` 的运行时 Json 形状未验证；30s 节拍与退避到期未运行时观察。
