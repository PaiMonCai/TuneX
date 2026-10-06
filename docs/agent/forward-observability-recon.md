# Forward 可观测性 / 监控预研（R3-B 收束 + Leader 真实样本）

> 只读预研结论 + Leader 在真实拓扑上抓到的响应样本。用于 backlog #5「Forward 详情监控/诊断」的切片设计与验收。**不授权编码，不代表功能已完成。**

## 1. 核心结论：`GET /api/forwards/:id/topology` 已存在且零 Web consumer

- 路由：`backend/src/routes/forwards.ts:282`（只读、`forward:read`、不发命令、无新模型）。
- 服务：`backend/src/services/forward-topology.ts`、`tunnel-diag.ts`。
- Web 侧全仓无调用：`web/src/lib/api/forwards.ts` 只有 summary/list/page/batch/detail/traffic/create/update/preview/action/remove/diagnose。
- 典型 EXPOSE：**不需要新后端**，只缺页面。

### 1.1 Leader 抓到的真实响应（scratch 集成拓扑，2026-10-06T16:18Z）

DIRECT（`/api/forwards/1/topology`，status 200）：

```json
{ "forward_id": 1, "mode": "direct", "segments": [], "observed_at": null, "stale_segments": 0 }
```

RELAY（`/api/forwards/2/topology`，status 200）：

```json
{ "forward_id": 2, "mode": "relay",
  "segments": [ { "segment": "ingress_to_egress",
    "from": { "node_id": 1, "node_key": "Integration-IN-A-NODE", "runtime_id": "tunex-2-relay",
              "running": true, "revision": 1, "diag": null },
    "to":   { "node_id": 2, "node_key": "Integration-OUT-A-NODE", "runtime_id": "tunex-2-egress",
              "running": true, "revision": 1, "diag": null },
    "hop": { "host": "172.33.20.20", "port": 22000 }, "expected_revision": 1 } ],
  "observed_at": "2026-10-06T16:18:19.976Z", "stale_segments": 0 }
```

**因此 slice 必须这样读**：
- `segments: []` 是 **DIRECT 的设计结论**（没有节点间跳），**不是缺数据**；必须画成「入口 → 目标（直连）」，不得显示空态/错误；
- `observed_at: null` = **没有任何节点上报过**（不是"链路正常"，也不是"刚检查过"）；它是"参与节点中最新一条上报的时刻"，**不是**链路检查时刻；
- `diag` 三态严格可分：`null`（没有证据）≠ `{}`（有诊断但无字段）≠ `{drops:0}`（真的没丢包）。不得把 `null` 渲染成"健康"；
- `revision` 与 `expected_revision` 只做**相等/不等/未知**三种表述，不合并成"异常"；
- `running:false` 与 revision 不一致是**两件事**，分别表述。

## 2. 顺带发现的两处生产级事实错误（均已被 Leader 实证）

| 编号 | 事实 | 证据 |
|---|---|---|
| F11 | 详情页「累计流量」读**已无写入者**的 `tunnel.traffic`：全仓 grep 不到任何 `tunnel.update/create/upsert` 携带 `traffic`；同文件注释也承认流量是归档账本事实。结果：同一张卡片里**图表用账本、数字用死列**，永远 `0 B`，与列表页口径矛盾 | `forward-service.ts:307` vs `:578-595`；`forward-detail.tsx:255-266` |
| F18 | 管理员节点运行态打复数路径 `/admin/nodes/:id/state`，后端只有单数 `/node/:id/state` → 生产 404；mock 实现复数路径掩盖它，loader `catch` 一切回落 `null` 并注释"无上报是常态" | `lib/api/admin.ts:189` vs `routes/node-admin.ts:327`；`mocks/handlers/admin.ts:343`；`node-runtime-panel.tsx:144-151` |

F11 的数值分叉未能在 scratch 复现（无流量流过，`tunnel_traffic` 0 行），修完须用真实流量再比对一次。

## 3. 真后端缺口（必须独立切片，不塞进"只补展示"）

- **延迟历史无读路由**：`readLatencySeries`（`services/latency-history.ts:498`）实现完整且有测试，但没有任何路由 → Web 拿不到。已派 D6 补只读端点。
- **用户域目标健康只有 admin 端点**（`GET /admin/node/pools/:id/health`）→ 用户看不到出口目标健康。
- **不存在 per-Forward「最近异常」数据源**（`notification_delivery` 只写、`forward_rollout` 只经支持包、`audit_event` 无 tunnel 写入）⇒ 该切片**不得**展示、**不得**编造"最近异常"。

## 4. 其他语义事实（避免误用）

- 流量账本 `tunnel_traffic` 是**日粒度**（Asia/Shanghai 日界），`cron_save_traffic */10` 归档 ⇒ **今天永远是不完整日**、滞后 ≤10 分钟；**没有实时速率**（Redis 缓冲无读路径）。
- 目标观测只覆盖**出口池目标** ⇒ DIRECT 转发没有任何延迟数据。
- 上报节拍 30s，连接窗口 90s（`node-lifecycle.ts:65`）。

## 5. 推荐切片 R3-B1「Forward 详情 · 链路与流量口径（纯 Web）」

范围：新增 `components/forwards/forward-topology.tsx`、`lib/api/forwards.ts` 的 `topology()`、类型、纯函数（流量窗口/延迟标注）、mock、局部改 `forward-detail.tsx`；**累计流量改用归档账本**并标注窗口与归档延迟。

验收硬断言：
1. DIRECT：显示「入口 → 目标（直连）」，明说无节点间跳、未做连通性验证；
2. RELAY/多跳：逐段 `from → hop → to`；`running:false` 与 revision 不一致分别表述；
3. 409/4xx：显示后端 `code` + 原文，不重试；
4. **取不到** ⇒ 独立 testid 且文案含"取不到/不代表正常"，渲染文本中**不得**出现"正常/可达/健康"；
5. `observed_at: null` ⇒ "没有任何节点上报过"；
6. `diag` 三态呈现互不相同，未知键照原样；
7. 累计流量为空 ⇒ "无数据"而**不是** `0 B`；
8. 切 Workspace 重置三态、丢弃晚到响应。

明确不做：新增后端端点、用户域暴露目标健康、展示"最近异常"、修 F18、DDNS UI、E2E/拓扑 CI。

## 6. 未验证

三跳拓扑未在真实拓扑上跑过（本次只抓到 DIRECT/RELAY）；`forward.online`（=`apply_status==="active"`）在节点离线后是否翻转**未找到翻转路径、未验证**；ForwardX 仅读源码未运行其 UI。
