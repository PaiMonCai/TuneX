# A 前端闭环验证记录

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
