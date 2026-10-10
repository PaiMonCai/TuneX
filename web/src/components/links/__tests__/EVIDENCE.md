# Link 前端验证记录

同步：2026-10-10。此文件保留各次前端任务的历史范围，早期段落中的分支、数量、“未提交/未运行”等仅指该次验证，不表示当前项目状态。当前合并、源码 CI 与发布边界统一见 [验收说明](../../../../../docs/testing.md)。下面的浏览器结果均为隔离 HTTP fixtures，不是实际 Panel/MySQL/Redis/Agent 的浏览器 E2E。

<a id="f5-preview"></a>

## F5 只读维护预览（2026-10-09 验收）

历史源码 `cdb847039772b0ca07291c83044aee88a88e1dc6`，验收时为草稿 PR #76，之后合并至 main `54542d3`。实现独立的预览请求/闭合投影、端点/密钥操作选择、完整影响列表、未知实时连接数、未检查/未预留端口、版本/代次 CAS、60 秒过期和晚到响应隔离；不放开执行动作或既有维护门禁。真实 15 秒轮询保留编辑草稿与选中操作，只使旧预览失效。

| 验证 | 结果 |
| --- | --- |
| 前端定向 | 191 pass / 0 fail。 |
| 前端全量（本地） | 1570 pass / 0 fail；TypeScript 通过。 |
| F5 隔离浏览器 | `runF5BrowserChecks` 45/45，`runF5PollingDraftChecks` 5/5，合计 50/50；后者等待实际轮询，不只检查静态渲染。 |
| 既有浏览器回归 | F2 44/44、F3 39/39。 |
| 对应源码 CI | [37952731562](https://github.com/PaiMonCai/TuneX/actions/runs/37952731562) web 单元/类型/构建通过；mock 构建不代表真实 API 浏览器验收。 |

浏览器覆盖只读零写入/零执行按钮、安全错误、超限/过期、输入与作用域 fence、晚到成功/失败、双语/只读及轮询草稿保留。结果来自当次工具输出，没有保存可下载的浏览器 trace/工件；不虚构证据文件。fixture 与浏览器进程验收后已停止。真实 Linux API/Agent 的 F5 11 项新增实网检查另见验收说明，不归入本浏览器结果。

重跑命令与新测试入口见 [组件 README](../README.md#verification)，解析/API/UI 与浏览器脚本位于本目录。完整迁移执行、重启补偿和真实 Panel 浏览器仍待后续。

## F3 canonical trust uniqueness follow-up (2026-10-08)

`projectLinkClientSource` now rejects duplicate **canonical** networks after masking/normalization; it does not silently deduplicate or reorder them. Regressions cover `127.0.0.1/8` + `127.0.0.2/8`, exact repeated networks, IPv4 /25 host-bit aliases, expanded/case-variant IPv6 /48, and IPv6 dotted-tail/hex aliases at /120. Duplicate rejection is checked at direct source projection, detail-response projection, form parsing, and the 32-item boundary. Distinct networks (including the same base with different prefix lengths) retain order and round-trip through normalization, repeated detail projection, edit cloning and form submission without mutating the original list. Bilingual validation and README explain canonical uniqueness.

Verification from `web/`, cached Bun 1.4.2, `NEXT_PUBLIC_API_MOCK=0`:

```powershell
bun test src/components/links/__tests__/links-client-source.test.tsx
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

Result: **16 pass / 0 fail / 243 assertions**; TypeScript exit **0**, scoped `git diff --check` passed. The new duplicate regression first failed because both /8 hosts normalized to `127.0.0.0/8` without rejection; it passed after the parser fix. No browser or real-network checks were rerun for this follow-up.

Follow-up edits only: `web/src/lib/links-types.ts`, `web/src/components/links/__tests__/links-client-source.test.tsx`, `web/src/components/links/links-copy.ts`, `web/src/components/links/README.md`, and this evidence file. No backend/Agent/vendor/Forwardx edits, commit, push or deploy.


## F3 TCP client source frontend (2026-10-08)

Scope: direct frontend edits under `web/**` only. No backend, Agent, vendor or `Forwardx/` edits by this task; concurrent changes elsewhere belong to other workflows. No commit, push, build/deploy or real data mutation.

Final verification: **167 pass / 0 fail / 2688 assertions / 8 files** (including **14 new F3 tests**). `node node_modules/typescript/bin/tsc --noEmit --incremental false` exited **0**; scoped `git diff --check -- web` passed. Cached Bun **1.4.2** was used. Before implementation the new suite failed on missing source-contract exports.

```powershell
# From web/, with locally cached Bun on PATH
$env:NEXT_PUBLIC_API_MOCK = "0"
bun test src/components/links/__tests__/links-api.test.ts src/components/links/__tests__/links-ui.test.tsx src/components/links/__tests__/links-targets.test.tsx src/components/links/__tests__/links-client-source.test.tsx src/components/console/__tests__/console-boundary.test.ts src/components/forwards/__tests__/workspace-permissions.test.ts src/components/forwards/__tests__/forward-batch-delete.test.tsx src/components/forwards/__tests__/forward-copy-usage.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

The F3 tests cover closed/strict source projection, canonical IPv4/IPv6 masking, mapped IPv6 and /0 rejection, 32/33 trust bounds, receive/list consistency, all send modes, absent legacy versus explicit all-off, full cloned edit roundtrip, TCP-only/IP-hash cross-field gates, first-target order/projection, bilingual safe errors and aliases, declared-only source detail, and session/CSRF/explicit Workspace/captured CAS requests. Unknown source facts are stripped even from a Ready observation; no source-health interface was added.

An isolated named headless Chrome session loaded the real production `LinksWorkspace`, forms and shared request layer through `browser-server.ts` on `127.0.0.1:41973`. Final **F3 39/39 checks** passed via `browser-client-source-checks.js`: new opt-in, both/UDP disabled controls, TCP-plus-explicit-source IP hash, clear protocol/source deselection errors, required empty trust and five unsafe-trust cases rejected before HTTP, canonical create, reorder/delete-first projection, full edit/CAS, B-rule preservation, PROXY v1/v2/off, internal IP-hash source with sending off, known all-off preservation, untouched legacy, all four collapsed actionable API errors, CAS conflict/reopen, bilingual/read-only and late Workspace mutation fencing. Existing **F2 44/44 browser checks** also passed with no changes to the F2 replay or production Workspace fences.

Both browser replays require resetting `/__test/scenario` before initializing the fresh page when a previous replay left a selected resource; resetting only after loading existing fixture rows can legitimately hit the current missing-resource read fence. Initial F2 reuse hit this fixture setup condition, then passed after reset-before-reload. The CLI evaluation used Windows-safe JavaScript quoting. Browser and fixture processes were stopped after verification.

Source copy describes mandatory trusted-upstream PROXY v1/v2, **absolute 5 seconds**, **v1 <=108 bytes / v2 <=536 total bytes**, destination PROXY support, and source carried internally with send off. These are runtime contract statements only, not frontend packet-parser enforcement or measured network evidence. No observed verified identity, source health or live capability facts were created. IP-hash copy warns about new-connection remapping on pool membership/health changes, not fixed session affinity or HTTP header tricks.

Changed paths:

- `web/src/lib/links-types.ts`
- `web/src/components/links/link-forms.tsx`
- `web/src/components/links/link-state.ts`
- `web/src/components/links/links-copy.ts`
- `web/src/components/links/link-detail.tsx`
- `web/src/components/links/link-target-details.tsx`
- `web/src/components/links/link-client-source-details.tsx` (new)
- `web/src/components/links/__tests__/links-client-source.test.tsx` (new)
- `web/src/components/links/__tests__/browser-client-source-checks.js` (new)
- `web/src/components/links/__tests__/browser-server.ts`
- `web/src/components/links/README.md`
- `web/src/components/links/__tests__/EVIDENCE.md`

Limitations: fixtures/static React/production-component browser tests only; no full Next-route E2E, production deployment, real database, Agent, multi-node FXP/PROXY or live source verification. Backend/compiler/runtime enforcement and final integrated acceptance remain with the main workflow. No dependencies or package locks were changed.


## F2 多目标前端（2026-10-08）

最终验证：**153 pass / 0 fail / 2469 assertions / 7 files**；`node node_modules/typescript/bin/tsc --noEmit --incremental false` 退出码 **0**；范围内 `git diff --check` 通过。新增 F2 文件包含 **25** 项契约/UI 测试，其中地址边界对照 `node:net.isIP`，显式排除 Go `net.ParseIP` 不接受的 zone ID。所有请求测试使用 fixtures。

Chrome 独立 context `tunex-f2-none-contract` 加载 `http://127.0.0.1:41973` 的真实生产组件与请求层，通过可重放 `browser-targets-checks.js`：**44 / 44 checks**。覆盖默认 legacy opt-in、UDP none / both TCP 默认与显式辅助 TCP、添加至十项、排序保值、重复/反斜杠/带端口/括号/非法 IPv6 提交前拒绝、raw IPv6 保存、删除首项回写 first fields、已有集合完整 CAS 保存与单项集合、旧单目标编辑、A 变更保留 B 配置与修订、冲突后重开使用新 CAS、两端能力升级说明、中英切换及只读。

出口场景覆盖 healthy、all_unavailable、stale、digest mismatch 后字段清除、租约过期、missing、仅入口观测、failed runtime 不投影健康、probe none、旧 last_checked_at、未来超前及 null 初始 unknown。健康和 Ready 分开；只接受符合 backend 的 Ready=true 出口健康投影，不用健康恢复 Ready。选中索引明确表示最近 TCP 连接 / UDP 映射，不代表所有 session 的当前目标。保留共享会话变更可能中断警告。重读后立即更新本机时间；每次渲染还检查观测时间的 <=60 秒及未来 <=5 秒边界，旧缓存不会保留到 180 秒租约到期。组件/parser 回归覆盖 59,999/60,000/60,001 ms、未来 4,999/5,000/5,001 ms、null 全 unknown 及 null 不能建立已知健康。浏览器只加速隔离页面时钟，验证缓存降为未知无需重新读取或实等一分钟，随后恢复时钟。浏览器 console 只有两条预期负例 HTTP 409（CAS 冲突、能力缺失），无 React/JavaScript 异常。

`probe: none` 契约纠正：只关闭主动检查，不覆盖经过出口/Ready/freshness 门禁的 `status.states`。真实 TCP dial 结果或 UDP 回包仍可形成健康观测；silence 保持 unknown，不自动形成 failure。专项单测在中英文、TCP/UDP/both 下验证无回应 unknown，以及 fresh passive healthy/suspect/recovering/unhealthy 精确展示、过期降级和 Ready=false 不采用。实际浏览器验证 `probe_none_silent` 为未知、`probe_none` 的真实 UDP 回包 fixture 为健康，以及 passive none 的缓存健康仍按 60 秒门禁过期。双语控件改为“无主动探测 / No active probe”，说明真实业务响应可提供证据。此次未改变 parser 或 `forwardTargetStatus` 的 null/Ready/freshness 语义。

验证命令（`web/`，本机缓存 Bun 1.4.2）：

```powershell
$env:NEXT_PUBLIC_API_MOCK = "0"
bun test src/components/links/__tests__/links-api.test.ts src/components/links/__tests__/links-ui.test.tsx src/components/links/__tests__/links-targets.test.tsx src/components/console/__tests__/console-boundary.test.ts src/components/forwards/__tests__/workspace-permissions.test.ts src/components/forwards/__tests__/forward-batch-delete.test.tsx src/components/forwards/__tests__/forward-copy-usage.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
bun run src/components/links/__tests__/browser-server.ts
```

在新加载的中文 fixture 浏览器中运行 `await (await import('/__test/f2-checks.js')).runF2BrowserChecks()`。本次仅使用内存 HTTP fixtures；未连接真实数据库、Agent、真实转发服务或密钥，未部署、提交或推送。共享 workspace 中其他任务的 backend / Agent / runtime 文件未由本任务写入，`Forwardx/` 未修改。

本任务修改文件（均在授权写范围内）：

| 区域 | 文件 |
| --- | --- |
| 契约 | `web/src/lib/links-types.ts` |
| 生产组件 | `link-forms.tsx`, `link-detail.tsx`, `link-target-details.tsx`（新增）, `link-state.ts`, `links-copy.ts`, `links-workspace.tsx` |
| 测试与夹具 | `__tests__/links-targets.test.tsx`（新增）, `__tests__/links-fixtures.ts`, `__tests__/browser-server.ts`, `__tests__/browser-entry.tsx`, `__tests__/browser-targets-checks.js`（新增） |
| 文档 | `README.md`, `__tests__/EVIDENCE.md` |

除契约文件外，以上相对路径均位于 `web/src/components/links/`。

日期：2026-10-07。分支：`feat/forward-core-abcd`。这里只记录本次前端及关联入口验证，不覆盖后端 / Agent / 多节点转发验收。

## 已接入的真实生产入口

| 工作流 | 实现与约束 |
| --- | --- |
| `/links` 与用户导航 | 服务端认证外壳、中文/英文；`selected` 参数选中指定资源。 |
| 创建 / 部署 | 实际 `/api/links` 接口、入出口节点与独立连接端口；创建不伪装为运行。 |
| 端点修改 | 保存携带 `expected_version`；零引用且从未部署才开放。已部署资源需先退役再新建。 |
| 密钥轮换 / 删除资源 | 零引用才开放；暂停规则仍计入引用。操作前确认影响。 |
| 新建 / 编辑规则 | TCP/UDP/both、方向字节速率、总并发与每个来源 IP 并发；编辑携带 `expected_revision`，协议不能就地修改。 |
| 暂停 / 恢复 / 重试 / 删除规则 | 使用 links 专用动作接口；完成后重新读取列表和详情。 |
| 部分应用失败 | 重新读取已保存的期望状态、关闭编辑表单、显示可执行错误说明；避免重复创建。 |
| 部署 / 运行事实 | ACK 与 `observation` 分开；没有观测为未知，过期为 stale，`passive/ready=false` 为入口待命；只有匹配版本、有效租约下 `ready/ready=true` 为运行中。退役覆盖旧观测。 |
| 普通转发中的关联规则 | 列表常驻管理入口、禁用原生动作和批量选择；详情转到专用管理提示。旧行收到 `link_managed_forward` 后重新读取关联 ID 并跳转 `/links?selected=<id>`。 |
| 权限与租户 | 原请求层的 credentials / CSRF / 明确 Workspace；节点管理与 Forward 权限分别检查；切换空间或权限丢弃旧结果。 |
| 功能关闭 | 服务端 `fxp_links_not_enabled` 表示操作失败，没有制造成功结果。 |
| 产品文案 | 原因码收进可展开支持详情；不显示 key / runner JSON / 原始异常；明确应用可能中断连接，没有无损更新宣传。 |

## 自动测试与类型检查

已执行并通过：

```powershell
bun test src/components/links/__tests__/links-api.test.ts src/components/links/__tests__/links-ui.test.tsx src/components/console/__tests__/console-boundary.test.ts src/components/forwards/__tests__/workspace-permissions.test.ts src/components/forwards/__tests__/forward-batch-delete.test.tsx src/components/forwards/__tests__/forward-copy-usage.test.ts
node node_modules/typescript/bin/tsc --noEmit
git diff --check -- src/components/forwards/forward-workspace.tsx src/components/forwards/forward-detail.tsx src/lib/nav.ts
```

测试结果：**95 pass / 0 fail / 1201 assertions / 6 files**；`web tsc --noEmit` 退出码 0；已修改的既有文件差异检查通过。

请求契约测试使用 HTTP fixtures 来验证实际共享请求层产生的 Workspace/CSRF/CAS 数据，并非真实数据库或 Agent 验收。组件测试含真实 React 静态渲染、表单输入解析、状态投影与旧控制台回归。

## 实际浏览器交互

在独立 Chrome context 中运行 `__tests__/browser-server.ts`：仅监听 `127.0.0.1:41973`，加载生产 `LinksWorkspace` 和共享 `request`，通过一次性内存 HTTP fixtures 驱动。该夹具不进入 Next 产品路由，不连接数据库或 Agent。

实际点击 / 表单提交验证通过：

1. 服务关闭：创建拒绝，资源数量仍为零，原因码默认折叠，无成功提示。
2. 创建资源：两个节点与明确连接端口，刷新后展示所建资源。
3. 首次部署前修改连接端口：请求含捕获的版本 CAS；保存后详情反映新端口。
4. 零规则部署：入口真实 passive 观测显示待命；部署后端点按钮禁止编辑。
5. 零引用轮换：确认后发出轮换请求并重新读取状态。
6. 创建 both 规则与各限额：提交值、单位一致；引用后轮换与资源删除均禁止。
7. 编辑冲突：`expected_revision` 冲突重新读取，关闭旧表单；再次打开后成功保存新名称。
8. 暂停 / 恢复 / 重试：分别调用专用动作路径，列表及详情重新读取。
9. 删除最后规则：引用归零，允许退役 / 轮换；端点仍禁止编辑。
10. 部分部署失败：规则已持久化且显示未确认错误，创建表单关闭，没有重复创建。
11. 动作中切换 Workspace：旧空间晚到响应不渲染，后续 GET 携带新空间 ID。
12. `/links?selected=1` 正确选中资源；删除最后规则后执行资源退役。

浏览器还验证了权限切换为只读后移除动作控件；最终观测映射、退役后的旧 ready 覆盖由自动测试补充。

## 验证范围和保留边界

- 这是前端点击、契约和类型证据，不是实网 FXP / 多 Agent 转发通过证据。
- 未执行生产部署、真实数据创建、Git 提交或推送，未修改 `Forwardx/` 参考目录。
- 共享 runner 已完成独立本机实测：A 新增、改目标/限制、移动端口、删除时，原 B TCP 会话与 UDP 目标 socket 保留。当前契约见 [转发运行边界](../../../../../docs/forwarding-runtime.md)，后续 Linux gate 证据见 [测试说明](../../../../../docs/testing.md)。本段记录的本机结果不是本浏览器夹具或 Linux gate 的结果；当前产品文案继续保留变更可能中断的提示。
- 后端目前未返回 deployment 配置版本时显示“未知”，不会用期望版本替代已应用配置版本。
- Agent 观测的 60 秒新鲜度、身份、digest 与租约校验由后端负责；前端只消费其闭合观测对象，定期重读。

## 策略漂移收尾补充

后端增加 deployment `policy_blocked` 后，前端补齐单独的“当前部署”显示。资源仍沿用 `degraded`，正文解释授权 / 流量策略阻止使用、租约不会续期以及恢复后自动重新应用；原因码仍放在可展开支持详情。没有新增公共资源状态枚举。

新增测试覆盖：闭合 API 投影保留 `degraded + policy_blocked + removed`；过去 ACK 不替代 removed/expired 观测；恢复后的新部署不能使用旧版本 ready 事实；暂停 / 恢复产生的规则修订及已应用修订只显示服务端值。

此次执行 links API/UI 与控制台边界三个文件：**59 pass / 0 fail / 1029 assertions**。随后 `web tsc --noEmit` 退出码 **0**。这是前端策略漂移展示证据，后端 reconcile 测试结果由后端工作流单独提供。

## 每规则流量详情最小切片（2026-10-07）

只修改 `web/src/lib/links-types.ts`、本模块 `link-detail.tsx` / `links-copy.ts`、`links-api.test.ts` / `links-ui.test.tsx` / `links-fixtures.ts` 和可选 README / 本证据文件。没有修改后端、Agent、vendor、路由、支付或既有流量仪表盘，也没有 Git 提交。

流量契约现统一维护在 [转发运行边界](../../../../../docs/forwarding-runtime.md#traffic)。本次只读核对 `getLink` 按 Forward 聚合所有历史 producer/day 的公开投影。详情在原规则卡片内新增双向累计 payload 字节、累计已接纳连接数（含 UDP 映射）和独立的最近接收时间。计数直接显示精确 decimal string，不转为 `Number`；没有收到统计为“尚未收到统计”，真正零为 `0 B` / `0`。

新增 **17 个** parser/UI 用例：缺失与 null、真零、超过 `MAX_SAFE_INTEGER` / uint64 的历史累计、每个计数字段的非 canonical 输入、缺字段、无效/自动归一化日期、闰日/时区/未来时间、闭合投影脱敏、HTTP 成功但内容非法、双语渲染、每规则独立统计、59,999 / 60,000 毫秒边界、旧值保留、缺失或未知运行观测、停止/过期状态和真实 ready 与旧流量互不覆盖。至少 60 秒未更新明确说明“不表示当前流量为零”；未来接收时间提示时钟差异，不作为在线证明。

最终执行（`web/`，本机缓存 Bun **1.4.2**）：

```powershell
$env:NEXT_PUBLIC_API_MOCK = "0"
bun test src/components/links/__tests__/links-api.test.ts src/components/links/__tests__/links-ui.test.tsx src/components/console/__tests__/console-boundary.test.ts
npm run typecheck -- --incremental false
```

结果：**76 pass / 0 fail / 1271 assertions / 3 files**；npm TypeScript 检查退出码 **0**。关闭 incremental 避免写入 scope 外的 `tsconfig.tsbuildinfo`。新增用例实施前为 **30 pass / 17 fail**，实施后全绿。

本次没有运行新浏览器流程、生产部署或真实多节点/数据库验收；这些仍由主集成工作流验证。HTTP fixtures 与 React 静态渲染不是实网统计正确性证据。
