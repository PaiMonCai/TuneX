# R5-B' 已完成切片缺陷检修（敌意复核报告）

> 复核人：`web-forward`（持久队友）｜任务：task-24｜时间：2026-10-07（Asia/Shanghai）
> 纪律：**只读**（不改源码）、不 git 提交、不动 `tunex-it-*` 拓扑。审查面 = `git diff origin/main..HEAD` + 工作树在途改动。
>
> **已复核通过** = 我用自己的证据（命令输出 / 受控复现 / 真实 HTTP）验证过并按此结论计入验收；
> **在途未评** = 工作树里别人正在改、我只登记不深挖；**未验证** = 没测过，**不算通过**。

状态：进行中（下面按发现顺序追加）。

> **环境说明（影响结论可复现性）**：scratch Panel 跑的是**镜像** `tunex-it-backend:ci`（`docker-compose.yaml:14`，无源码 bind mount），因此**镜像构建之后**加进源码的端点在本环境里返回纯文本 `404 Not Found`（例：`/api/forwards/:id/ha`、`/api/nodes/:id/upgrade-state`，连 `/api/nodes/1` 都是 404）。这类 404 **不是**源码缺陷，我已改用源码级/测试级证据复核（见 V-3）。另：`web/src/mocks/handler.ts` 在 01:54 时处于一次在途编辑中途（引用了尚未 import 的 `handleNotificationsMock`，mock 全模式抛 ReferenceError），01:56 已自愈 —— 记在这里只是说明"探针在活体编辑期间跑过"，不是缺陷。

---

## 复核结论汇总（滚动更新）

| # | 级别 | 一句话 | 状态 |
|---|---|---|---|
| F-1 | P3 | mock 把分页 `page_size` 钳到 200，真后端 admin 列表钳到 100，且 mock 不回显顶层 `limit` | 已复核（有反例证据） |
| F-2 | P3 | 后端已有的 `GET /api/admin/notification-channels` 在 mock 里 **404**（无消费者，故当前无用户可见影响） | 已复核 |
| F-3 | P3 | 通知渠道（telegram/webhook）只能通过 `/api/admin/notification-channels` 写入，**Web 零消费者** ⇒ 默认 `enabled: []` 下产品内无法开启（未接线，非缺陷声明） | 已复核 |
| F-4 | P2 | 5 个 i18n 键在字典里不存在，界面**渲染出裸 key**（如 `admin.readOnly`、`common.price`）；**非本分支引入** | 已复核（有渲染证据） |
| F-5 | P3 | `forward-route-order.test.ts` 只测玩具 Hono 应用，**不覆盖生产路由**；命名/注释给人"生产顺序已被守住"的错觉 | 已复核 |
| V-1 | 通过 | 信封层约定（mock 给"已剥壳"，真后端给 `{data:…}`，客户端两种模式各正确取用）在抽查的 10 条 GET 上一致 | 可计入验收 |
| V-2 | 通过 | zh/en 字典键完全对等（949/949） | 可计入验收 |
| V-3 | 通过 | HA / latency / DNS 三条 literal 子路由的**可达性**由"挂真实 `forwardsRoutes`"的路由测试行为验证（5 文件 33 pass） | 可计入验收 |

---

## F-1（P3）mock 的分页上限与真后端不一致（200 vs 100），且缺顶层 `limit`

**位置**：`web/src/mocks/runtime.ts:256-261`（`paginate()`，`page_size` 钳到 200）；对照 `backend/src/routes/admin-extended.ts:112`（`Math.min(100, …)`）。

**自己的证据**（真实 HTTP + mock 对照，同一路径同一参数）：

```
GET /api/admin/tunnels?page=1&page_size=150
  真实 Panel : 200  top-level keys=[data,limit,page,page_size,total]  data.page_size = 100
  mock       : 200  keys=[data,page,page_size,total]                 page_size      = 150
GET /api/admin/tunnels?page=1&page_size=5 → 真实 data.page_size=5（正常路径一致）
```
（mock 侧调用：`handleMock("GET","admin/tunnels",{query:{page:1,page_size:150}})`。）

**影响**：请求 >100 行的 admin 列表，在 mock 下真的拿到 150+ 行、真实环境只拿 100 行；`total` 两者一致 ⇒ 生产里表现为**表格静默少行**。读顶层 `limit` 的调用方在 mock 下拿到 `undefined`。

**最小修正建议**：admin 列表的 mock 改为 `paginate(items, q, { max: 100 })`（或给 `paginate` 加 `maxPageSize` 参数：admin=100，`/forwards` 保持 200 —— 后者与 `MAX_FORWARD_PAGE_SIZE=200` 一致，已核对），并在 admin 列表响应补顶层 `limit: page_size`。

---

## F-2（P3）mock 缺后端已有的 `/api/admin/notification-channels`

**位置**：mock 侧 `web/src/mocks/handlers/`（无该路径）；后端 `backend/src/routes/notification-channels.ts:342`（mount 于 `app.ts:207` 的 `/api/admin`）。

**自己的证据**：
```
GET /api/admin/notification-channels
  真实 : 200 {"data":{"scope_kind":"platform","channels":[],"delivery_kinds":{"registered":["email","telegram"],"enabled":[],"announcement":[]},"warnings":[]}}
  mock : 404 {"message":"接口不存在","code":"NOT_FOUND"}
```
以及 `grep -rn "notification-channels" web/src/lib/api/*.ts` → 无命中。

**影响**：今天**无用户可见影响**（Web 侧还没有消费者）。风险在通知中心 UI 落地当天：mock 开发期稳定 404，会把"mock 缺实现"伪装成"后端没这功能" —— 本专项已踩过两次同类形态（mock 曾忽略 `middle_node_id`、曾在重签路径返回 404）。

**最小修正建议**：mock 增 `GET/PUT/DELETE admin/notification-channels*`，形状照抄真实响应（`scope_kind` / `channels` / `delivery_kinds.registered|enabled|announcement` / `warnings`），并在 mock 契约测试里钉住「`enabled` 与 `registered` 是两件事」。

---

## F-3（P3｜未接线，不是缺陷声明）通知渠道在产品内无法开启

**位置**：写入路径只有 `backend/src/routes/notification-channels.ts:509`（`PUT /api/admin/notification-channels/:kind`）；Web 全仓无消费者。

**自己的证据**：
- 真实 Panel：`delivery_kinds = {registered:["email","telegram"], enabled:[], announcement:[]}`（探测输出见 F-2）⇒ telegram/email 都还没过部署闸门；
- `grep -rn "notification-channels\|notificationChannel" web/src --include=*.ts --include=*.tsx`（排除测试）→ **0 命中**；
- 该后端文件自己的注释写明「`announcement` 是公告这条**今天唯一真正接线的投递路径**」。

**影响**：缺省配置部署的真实实例里 telegram/webhook 投递永不发生，而产品界面**没有任何入口**打开它（`FAILOVER_POLICY` 那条"缺省关 + 无 UI"的同类形态）。公告投递不受影响。

**最小修正建议**：这是"通知中心切片未接线"，不是本分支缺陷；建议把"渠道配置 UI"显式写进 Exit Criteria 阻塞项，避免验收时把"后端测试全绿"当成"通知可用"。

---

## F-4（P2｜非本分支引入）i18n 裸 key 直接渲染到界面

**位置 / 证据**（`translate()` 缺键时**返回 key 本身**，见 `web/src/lib/i18n.ts:19-31`；实测输出）：

```
zh/en 皆:  admin.readOnly        => "admin.readOnly"
           admin.permissions     => "admin.permissions"
           common.price          => "common.price"
           common.bonus          => "common.bonus"
（对照：admin.readOnlyHint 存在 → "该列表为只读视图…"）
```
渲染点（都在真实渲染路径上）：
- `web/src/components/admin/admin-audit-manager.tsx:126`、`web/src/components/admin/admin-readonly-manager.tsx:161`（`<Badge>`）→ 徽章写着 `admin.readOnly`
- `web/src/components/admin/roles-manager.tsx:181,247`（表头 + 小节标题）→ `admin.permissions`
- `web/src/components/topup/topup-body.tsx:123,124`（表头）→ `common.price` / `common.bonus`

**分支归属**：`git diff origin/main --stat -- <这四个文件>` 全为空 ⇒ **不是本分支引入**。

**影响**：管理员在角色 / 审计 / 只读列表与充值列表上看到原始 key，而不是「只读 / 权限 / 金额 / 赠送」。

**最小修正建议**：zh/en 各补 4 个词条（或把调用点改到已有正确键 —— `readOnlyHint` 就在 `admin` 下，说明这批 `admin.*` 漏了相邻两个）。另建议加一条**机械守卫**（我这次的 20 行扫描脚本即可）：源码里 `t("a.b")` 字面量键必须都在两个字典里。

---

## F-5（P3）路由顺序守卫是"玩具测试"，不覆盖生产路由

**位置**：`backend/src/routes/__tests__/forward-route-order.test.ts:12-23`。

**自己的证据**：该文件自己 `new Hono()` 建两条临时路由（`/:id/dns`、`/:id/:action`）断言框架优先级；注释也承认 "without parsing production source"。它**不会**在生产 `routes/forwards.ts` / `routes/nodes.ts` 里发现"literal 子路由被 `/:id/:action` catch-all 吃掉"的回归（本专项已在 DNS 前门、延迟端点、HA 三处踩过同一形态）。

**但**真正的保护在别处，且我已复核通过（V-3）：`forwards-ha-route.test.ts:219` 与 `forwards-latency-route.test.ts:204` 都 **import 真实 `forwardsRoutes` 并 `app.route()` 后 `app.request()`**。

**最小修正建议**：要么改名（`hono-precedence.test.ts`）以免误导，要么让它对生产 `forwardsRoutes` 走一遍**全部 literal 子路由**（topology/latency/dns/ha/preview/diagnose）—— 那才是它名字承诺的东西。

---

## V-1（通过）信封层约定一致（抽查）

**方法**：同一组端点分别打 mock 与真实 Panel，比较"客户端最终拿到的东西"：
- 真实后端统一 `{ data: payload }`，客户端 `request()` 剥**一层**（`web/src/lib/api/core.ts:121-128`）；
- mock 返回**已剥壳** payload，客户端在 mock 分支**不剥**（`core.ts:81-95`）；
- ⇒ 两条路径调用方看到的形状必须相同。

抽查（`mock keys` vs 真实 `data` 内层）：
```
forwards/summary        mock=[active,…,traffic_cost]      真实内层=同名 9 键        一致
forwards/1/traffic      mock=数组                          真实内层=数组             一致
nodes/1/bindings        mock=数组                          真实内层=数组             一致
admin/node/1/pools      mock={data,total}                  真实内层={data,total}     一致
admin/node-groups       mock={data,page,page_size,total}   真实内层=同形             一致
admin/tunnels           mock={data,page,page_size,total}   真实内层=同形             一致
me/capabilities         mock={data}                        真实内层={data}           一致
ddns/providers          mock={data}                        真实内层={data}           一致
announcements/preferences mock={data}                      真实内层={data}           一致
forwards/1/topology     mock=拓扑对象                      真实内层=同形             一致
```
**未验证**：其余约 140 条端点的信封层数（尤其 admin-extended 的写路径与 federation 族）。

---

## V-2（通过）zh/en 字典键完全对等

机械扫描（flatten 两侧）：`zh keys: 949 / en keys: 949 / zh 有 en 无: 0 / en 有 zh 无: 0` ⇒ 不存在"某语言漏词条"。**但**字面量键漏定义仍存在（F-4）；模板键 `t(\`x.${v}\`)` 无法静态覆盖（见"未验证"）。

---

## V-3（通过）HA / latency / DNS 子路由可达性有真实行为测试

**自己的证据**（在 `backend/` 跑，只读）：
```
bun test src/routes/__tests__/forwards-ha-route.test.ts \
         src/routes/__tests__/forwards-latency-route.test.ts \
         src/routes/__tests__/forwards-dns-route.test.ts \
         src/routes/__tests__/notification-channels.test.ts \
         src/routes/__tests__/node-groups-provision-contract.test.ts
→ 33 pass / 0 fail / 208 expect（3.64s）
```
其中 HA/latency 明确 import 真实 `forwardsRoutes` 并用 `app.request()` 打（见 F-5 的引用行），因此"literal 子路由没被 catch-all 吃掉"是**行为上**证明过的，不是靠注释。

**未验证**：`GET /api/nodes/:ingressId/upgrade-state` 的**同类顺序**保护（我没找到挂真实 `nodesRoutes` 的顺序/可达性测试），且 running 镜像太旧无法真打（纯文本 404）。**这条不能算通过。**

---

## 复现方法（只读，均在 web 目录跑；临时脚本用完即删）

- mock 与真实对照：`handleMock(method, path, {cookie:"tunex_session=u1", query})` vs `fetch("http://127.0.0.1:18180/api/<path>", {headers:{Cookie, "x-workspace-id":"3"}})`（真实侧先 POST `/api/auth/login`，凭据来自 `state.json`）。
- i18n 键扫描：`git ls-files 'web/src/**/*.ts*'` + 正则 `\bt\(\s*"([a-zA-Z][\w.]*)"` + 判据 `translate(dict, key) === key`（缺键时 `translate` 原样返回 key）。
