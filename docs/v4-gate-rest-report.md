# V4-F1 Gate — rest 切片实施报告（S3–S6）

分支：`feature/v4-gate-forward-rollout-rest`（worktree `/opt/TuneX-v4-gate-rest`，脚本提交基线
`7bc70d5`）。本报告只覆盖**文档侧**：脚本 `scripts/v3-e2e/v4-gate-rest.sh` 与 fixture 归脚本
代理；文中提到的工作区未提交改动不是本报告产物，本报告也不修改它们。

所有结论按三档标注：**已验证**（有直接证据）、**部分验证/受限验证**（只覆盖了一条分支）、
**未验证**（无真实数据面证据，仅代码勘察或单测）。凡引用证据均给出文件与行号；报告不
引用、不打印任何凭据（`scripts/v3-e2e/state.json` / `.env.wp14` 含凭据，全程未读取）。

---

## 1. 结论摘要

| # | 场景 | 状态 | 一句话证据 |
| --- | --- | --- | --- |
| S3 | listen port 修改 | **部分验证**：数据面/账本已验证；CLEANUP 暴露真实缺陷 D1 | 运行 B：`S3.5 真实数据面在新端口 21004 读到 marker` PASS；`DEFECT[S3.13/14/16]` 旧 lease 未释放 |
| S4 | multi-field single revision | **已验证** | 运行 B：`S4.3 forward_revision 只新增 1 行（不是 4 行）`、`S4.4 forward_rollout 只新增 1 行` PASS |
| S5 | update 失败旧 applied revision 继续运行 | **受限验证**：只命中「VALIDATE 前 `port_conflict` 短路」一分支 | 运行 B：`S5.3 冲突 PATCH 被真实拒绝（HTTP 409）`、`S5.6 失败不改 applied_revision` PASS |
| S6 | suspended edit + resume 最新 revision | **已验证**（首两版脚本把自身时序错误记成 FAIL，已由脚本代理修正） | 运行 B：`S6.13 resume 成功`、`S6.14 applied==config`、`S6.15 resume 后数据面只反映最后一次编辑的目标` PASS |

完整运行总账：**PASS=55 FAIL=5 DEFECT=3**（FAIL 含 3 个 DEFECT；另 2 个 FAIL 见 §6，
均为脚本自身缺陷，非产品缺陷）。

---

## 2. 证据来源与时间线（如实标注）

| 时间 | 事件 | 证据状态 |
| --- | --- | --- |
| 14:05:57–14:06:08 | 运行 A（完整跑完） | 结果文件当时读到：`PASS=55 FAIL=4 DEFECT=3`；唯一非 DEFECT FAIL 为 `S5.12 恢复后 revision 正常前进 1 [实得 '3' 期望 '4']`。该文件随后被运行 B 覆盖 |
| 14:14:49–14:15:11 | 运行 B（完整跑完） | 磁盘上现存最新完整证据：`scripts/v3-e2e/evidence/v4-gate-rest-result.txt`（mtime 14:15:11），`PASS=55 FAIL=5 DEFECT=3`。本文 DB 事实对应此运行 |
| 14:22–14:26 | 运行 C/D（脚本代理迭代脚本期间的两次重跑） | **未产出结果文件**，只残留部分证据（`s3-patch.json` 14:23:31、`s4-patch.json` 14:24:11、`s5-fail.json` 14:25:27、`s5-recover.json` 14:26:04、`s6-suspend.json` 14:26:40、`s6-edit1.json` 14:26:41）。`s6-suspend.json` = `{"error":"隧道已处于 suspended 状态","code":"invalid_state"}` ⇒ `set -e` 中止于 S6.1 |
| 早于 14:05 | 首轮（交接记录） | 结果文件未留存。「S4 因未定义 `S4_REV` 中止」「snapshot 基线 0」等事实来自交接记录，**非本报告直接验证**，仅作为背景 |
| 14:09–14:40 | 本报告 DB 取证 | `forward_revision` / `forward_rollout` / `node_port_lease` / `tunnel` 只读查询 |

当前拓扑状态（读取时间 2026-09-26 14:37–14:40，可能随后续重跑变化）：`tunnel id=3`
`listen_port=21005`、`config_revision=15`、`applied_revision=9`、`apply_status=suspended`、
`desired_status=inactive`；该 tunnel 租约 21003 released、21004 released、21005 active；
无 v4-gate-rest 进程在跑。**这不是可复跑基线**（见 §8）。

---

## 3. 断言逐条状态（完整运行 B 实测）

### S3 listen port 修改（§13.3.4「Listen Port」/ §13.3.5）

| 断言 | 状态 | 实测证据 |
| --- | --- | --- |
| S3.1 基线数据面读到旧 marker | PASS | 旧端口 21003 → `WP14-TARGET-A`（真实 TCP，client → 172.31.10.20:21003） |
| S3.2 PATCH listen_port → 200 | PASS | `s3-patch.json` 返回 200 |
| S3.3/S3.7 Forward 视图与 DB `tunnel.listen_port` 切到 21004 | PASS | 视图 `listen_port: 21004`；DB 同值 |
| S3.4/S3.9 Agent 真实 ACK（`applied_revision == config_revision`） | PASS | rev 2：`applied=2, config=2` |
| S3.5 新端口真实数据面读到 marker | PASS | client → 172.31.10.20:21004 → `WP14-TARGET-A` |
| S3.6 旧端口不再接受新连接 | PASS | 21003 `wait_dead` 为空 |
| S3.10/S3.11 只新增 1 行 snapshot、rollout 分类 `listener_replace` | PASS | DB：rev 2 一行 `forward_revision`、一行 `forward_rollout` `strategy=listener_replace` |
| S3.12 新端口持 active lease | PASS | `node_port_lease` 21004 active |
| **S3.13/S3.14/S3.16** | **DEFECT（产品缺陷 D1）** | 见 §4 |

代码路径（已勘察，与实测一致）：`PATCH /api/forwards/:id` → `patchForward`
（`backend/src/services/forward-service.ts:563`）→ `resolveForwardCandidate` →
`createForwardRevision`（`:604`）→ `computeForwardImpact` 置
`listen_port_change=true, listener_replacement=true`
（`backend/src/services/forward-revision.ts:504-516`）→ `planRollout` →
`classifyRolloutStrategy` 返回 `listener_replace`
（`backend/src/services/forward-rollout.ts:328`）→ `buildSteps` 生成
`validate → prepare:acquire_port → cutover:cutover_ingress`
（`forward-rollout.ts:484-491, 548-555`）。Agent 侧 `apply_tunnel` →
`TunnelManager.ReplaceListener` → `replaceListenerLocked` **先 bind 新端口、再换 map 项、
最后异步 drain 旧实例**（`agent/internal/manager/swap.go:324-346`），控制面与 Agent 的
「先新后旧」顺序与 §13.3.5 一致——**数据面正确，坏在 DB 租约账本**（S3.6 PASS 与
S3.13/S3.14 DEFECT 同轮并存即此证据）。

### S4 multi-field single revision（§13.3.4「多字段同时改」）

一次 PATCH 同时改 `target_host=target-b` + `target_port=3030` + `listen_port=21005` +
`name=v4-gate-direct-mf`。

| 断言 | 状态 | 实测证据 |
| --- | --- | --- |
| S4.1 HTTP 200 | PASS | `s4-patch.json` |
| S4.2 rev 只前进 1（2→3） | PASS | 响应 `config_revision: 3` |
| S4.3/S4.4 各只新增 1 行 | PASS | DB：snapshot 增量 1、rollout 增量 1 |
| S4.5 单 snapshot 内四字段全新 | PASS | 行值 `target-b:3030\|21005\|v4-gate-direct-mf` |
| S4.6/S4.7 DB 投影列同步 | PASS | `remote_host=target-b`、`listen_port=21005` |
| S4.8 数据面直接呈现新 target+新端口 | PASS | 21005 → `WP14-TARGET-B` |
| S4.9 仍归并为单一 `listener_replace` | PASS | rollout rev 3 `strategy=listener_replace` |
| S4.10 `applied_revision` 收敛 | PASS | `applied=3` |

「无中间半配置」的证据是**结构性**的：单事务内 `forwardRevision.create` +
`tunnel.update(投影列 + config_revision + desired_revision_id)` 原子写入
（`forward-revision.ts:713-775`），因此不存在「新端口 + 老 target」可被观测到的窗口；
本次只能证明终态与「恰好一行」，**不能**证明窗口为零（数据面探测粒度 1s，无法做
连续性观测）。RELAY/mode 参与的多字段组合未测（见 §7 S8）。

### S5 update 失败时旧 applied revision 继续运行（§13.3.5 失败规则 1/2）

失败注入：PATCH 的 `listen_port` 指向**另一条真实 Forward 已占用**的端口 21001
（v3 DIRECT，由 `setup.sh` 阶段 2 真实创建并 ACK）。

| 断言 | 状态 | 实测证据 |
| --- | --- | --- |
| S5.1 失败前数据面走当前 target | PASS | 21005 → `WP14-TARGET-B` |
| S5.2 找到真实占用端口 | PASS | `occupied_by_other=21001` |
| S5.3 冲突 PATCH 被真实拒绝 | PASS | `s5-fail.json`：HTTP 409 |
| S5.4/S5.5 机器可读错误码属冲突族 | PASS | `code=port_conflict`，`data.reasons=["port_conflict"]` |
| S5.6/S5.7/S5.8 `applied_revision`/`listen_port`/`remote_host` 不变 | PASS | DB 三轮查询一致 |
| S5.9 失败 revision 无 done rollout 行 | PASS（弱） | `COUNT=0` |
| S5.10 失败后数据面仍走旧 target | PASS | 21005 仍 `WP14-TARGET-B` |
| S5.11/S5.12 正确 `expected_revision` 重试成功且 revision +1 | PASS | rev 3→4 |
| S5.13 恢复编辑数据面真实切换 | PASS | 21005 → `WP14-TARGET-A` |

**覆盖边界（重要）**：本例拒绝发生在 `resolveForwardCandidate` 的校验短路
（`forward-service.ts:890-910`），即**任何一个 rollout step 都没跑、`forward_rollout`
一行都没写**。因此 §13.3.5 只验证了「VALIDATE 失败 ⇒ 旧 applied revision 完全不动」。
以下失败规则**未验证**：

- PREPARE 失败（`acquire_port` 命中 `port_taken`，`forward-rollout-exec.ts:519-545`）后
  回收新资源、旧 runtime 继续；
- CUTOVER 后失败（compensation，`forward-rollout-exec.ts:1116, 1277-1294`）；
- compensation 失败 ⇒ degraded/error 与人工 Retry。

这三条目前只有单测覆盖（`backend/src/services/__tests__/forward-rollout-exec.test.ts`、
`agent/internal/manager/swap_test.go` 的 bind 失败用例）。fixture 的
`s5_failure_old_runtime.notes2` 已自认：当前 harness 只有一台 ingress，「主要命中
VALIDATE 前 `port_conflict` 短路」。

### S6 suspended edit + resume 最新 revision（§13.3.6）

| 断言 | 状态 | 实测证据 |
| --- | --- | --- |
| S6.1/S6.2 suspend 成功、`apply_status=suspended` | PASS | `s6-suspend.json` |
| S6.3 suspend 后端口不再接受连接 | PASS | 21005 `wait_dead` 为空（Agent 已撤 runtime） |
| S6.4 suspended 期间 PATCH 200 | PASS | `s6-edit1.json` / `s6-edit2.json` |
| S6.6/S6.7/S6.10 `applied_revision` 不动、`desired_status=inactive` | PASS | 编辑期间 `applied=4` 恒定 |
| S6.8/S6.9 第二次编辑覆盖 desired | PASS | rev 5→6 |
| S6.12 最新 snapshot 是最后一次编辑的目标 | PASS | `forward_revision` rev 6 = `target-b` |
| S6.13/S6.14 resume 成功且 applied==config | PASS | `applied=7, config=7` |
| S6.15/S6.16 resume 后只反映最后一次编辑，中间态 marker 不出现 | PASS | 21005 → `WP14-TARGET-B`，非 `WP14-TARGET-A` |
| S6.17 端口未做多余 listener 重建 | PASS | resume 前后 `listen_port=21005` |
| S6.18 resume 后 `apply_status=active` | PASS | DB `apply_status=active` |
| S6.5 / S6.11 | FAIL（脚本自身缺陷，见 §6） | 运行 B：`5→5`；snapshot 增量 1 期望 2 |

代码路径：`POST /api/forwards/:id/suspend` → `runTunnelActionApi` 的 suspend 分支
（`backend/src/services/tunnel-api.ts:824-877`）：`config_revision = +1`、`desired_status=
inactive`、`apply_status=suspended`，并向 Agent `remove_tunnel`。suspended 期间 `patchForward`
以 `suspended=true` 调 `registerRollout` ⇒ **noop rollout**（`forward-service.ts:672-686`；
`forward-rollout-exec.ts:1426, 1441-1443` 创建一行 `phase=done` 但**不执行任何 step**）。
`POST /resume` 走 `deps.applyDirect` 重下发（`tunnel-api.ts:883-893`）。

**如实记录的账本缺口（本轮实测，非断言）**：DB 中 resume 产出的 revision 7 **在
`forward_revision` 与 `forward_rollout` 两表中都没有行**（两表最大 revision 均为 6，
`tunnel.applied_revision=7`）。即 resume 路径只写投影列，不写 revision/rollout 账本。
suspend 自身也只 bump `config_revision`（revision 号因此跳空：4→5→6 而 snapshot 行只有
4、6）。这不影响 S6 断言本身，但直接影响 S10（重启/对账靠 DB revision 收敛）的可证明性。

---

## 4. 真实缺陷 D1：首次 listener 重建不释放旧端口租约

**现象（两次完整运行均复现）**：`DEFECT[S3.13]` 旧端口 lease 实得 `status=active`；
`DEFECT[S3.14]` 同一 tunnel 存在 2 条 active lease（期望 1）；`DEFECT[S3.16]` rollout
计划缺 `release_old_lease`。

**根因链（代码勘察 + rollout 行实测 JSON 双向确认）**：

1. 创建路径不写 revision snapshot：`createForward` 落库时
   `config_revision: 0, applied_revision: null`
   （`forward-service.ts:478-481`），随后 `reapplyDirectTunnel` →
   `scheduler.persistSuccess` 只写 `applied_revision/config_revision/last_applied_at`
   （`backend/src/services/scheduler.ts:711-724`），**不调用
   `createForwardRevision`**（全仓唯一调用点是 `forward-service.ts:604` 的
   `patchForward`）。⇒ 首次编辑时 `forward_revision` 0 行。
2. `registerRollout` 解析 applied 用「次新 snapshot」：
   `appliedRows[0]`，snapshots 为空 ⇒ `applied === null`
   （`forward-rollout-exec.ts:400-435`，实测 rollout rev 2 行 JSON 中
   `"applied": null`、rev 3 行 `"applied"` 为完整对象，与之一致）。
3. `buildSteps` 的守卫 `const hasPreviousRuntime = applied !== null` 把 DRAIN 与
   CLEANUP **整段**跳过（`forward-rollout.ts:565-598`）⇒ 无 `drain_ingress`、
   无 `release_old_lease`（实测 rev 2 步骤仅
   `validate / prepare:acquire_port(21004) / cutover:cutover_ingress`）。
4. §13.3.5 要求「Cleanup 必须幂等……不得永久泄漏 NodePortLease」。此时新端口已落地、
   旧端口 21003 的 lease 仍 active ⇒ 同一 tunnel 在同一 ingress 节点上同时持有两条
   active lease。这与 §13.3.2「只靠 DB revision + Agent state report + NodePortLease
   就能继续/补偿 rollout」的账本前提冲突：对账方看到双 active 时无法判断哪一个端口
   是真正在跑的 runtime；同时 `acquirePort` 把这两条都占用位（`portPool.ts:478-502`），
   同一区间内可用端口被无谓压缩。

**观测到的自愈路径（不足以结案）**：后续一次换端口的 rollout 的 `release_old_lease`
经 `releaseLease({ tunnelId, nodeId })` 释放该 tunnel 在该节点上**全部** active 租约
（`portPool.ts:655-661`），因此运行 B 结束后 21003/21004 均变 released、仅 21005
active。但这条路径依赖「用户再改一次端口」，且粒度粗（连带释放本应保留的活动租约），
不符合 §13.3.5「不得泄漏」的本意。**修复方向（供脚本/后端代理决策，不在本报告落地）**：
创建路径补写首个 revision snapshot，或 `applied === null` 时按 tunnel 当前投影列
合成 baseline（`forward-rollout-exec.ts:407-420` 已有 fallback 形状）使 CLEANUP 可规划。

---

## 5. 其他真实限制（均如实标注）

| 限制 | 影响 | 证据/代码 |
| --- | --- | --- |
| S5 失败注入只到 VALIDATE 前短路 | §13.3.5 三条失败规则只验证一条 | §3 S5 |
| resume 不写 revision/rollout 账本行 | S10「DB revision 驱动恢复」缺可证明入口 | §3 S6（rev 7 两表无行） |
| suspend bump revision 但不写 snapshot | revision 跳号；任何「+1 恰好」断言都会误判 | `tunnel-api.ts:824-829` |
| 脚本对残留状态不幂等 | 重跑必须重建环境；否则 S6 直接 `invalid_state` 中止 | 运行 C/D 的 `s6-suspend.json`（14:26:40） |
| 数据面探测粒度 1s | 「无中间半配置」只证明终态与单行，不证明零窗口 | §3 S4 |
| preview 端点无 E2E | §13.3.3 要求 preview 与 update 同源；`POST /api/forwards/:id/preview`（`backend/src/routes/forwards.ts:228`）本轮零断言 | 全脚本无 preview 调用 |
| mode/RELAY 换 Egress/Ingress 迁移无真实 E2E | S7–S10 全缺 | §7 |
| `resumeRollouts`（worker 侧断点续跑）无真实 E2E | §13.3.5「Backend 重启后可继续清理」无数据面证据；仅单测 `forward-rollout-ledger.test.ts:704` | 全脚本无中断注入 |

---

## 6. 两次「脚本自身缺陷」造成的 FAIL（非产品缺陷，脚本代理已修）

1. **S5.12（运行 A，实得 3 期望 4）**：恢复编辑只改 `target_port: 3030`，与当前值相同
   ⇒ `isMetadataOnlyPatch` 为 true（`forward-revision.ts:246-253`）⇒ `patchForward` 走
   metadataOnly 分支：只更新 name、不写 snapshot、不 bump revision，仍返回 200
   （`forward-service.ts:579-589`）。这是 §13.3.2 的幂等语义。当前工作区脚本已改为
   「改 `target_host` 回 target-a」以构成真实变化。
2. **S6.5/S6.11（运行 B，5→5；snapshot 增量 1 期望 2）**：同根——suspend 前的 S5 恢复把
   target 设成了 target-a，而第一次 suspended 编辑的目标仍是 target-a ⇒ 无真实变化 ⇒
   不写 snapshot、revision 不前进。当前工作区脚本已把两次编辑的目标对调，并从 **suspend
   响应体**读 revision（因为 suspend 只 bump 投影列，`cur_rev()` 会早一个号）。

---

## 7. S7–S10 及其它遗漏场景的拓扑需求

以下均为**未验证**（无真实数据面证据）；每条给出代码里已实现、只差拓扑的 rollout 路径。

| 场景 | 需要 harness 增加的东西 | 对应已实现的计划路径（未跑过） |
| --- | --- | --- |
| **S7 RELAY 换 Egress** | 第二台 EGRESS Agent（独立 node_id/credential，如 WP14-OUT-B，`--egress-range 22100-22199`）+ 该 egress 接入 `wp14-egress-data`；`_bootstrap.py` provision 阶段创建该 Node 并写 state；ingress 能经数据网访问新 egress 的 runtime 端口 | `egress_node_change` ⇒ `prepare:ensure_binding + acquire_port(egress) + prepare_egress` → `cutover:cutover_egress` → `drain:drain_egress` → `cleanup:drop_old_egress + release_old_lease`（`forward-rollout.ts:493-521, 528-534, 578-586, 600-615`） |
| **S8 DIRECT ↔ RELAY** | 可创建/切换 mode 的入口：`_bootstrap.py` 的 `create_v4_forward` 目前**只建 DIRECT 且断言 `mode == direct`**（`_bootstrap.py:243-272`，请求体不含 `mode`/`egress_node_id`）；为 V4 Forward 增加 relay 形态（ingress+egress pair、egress pool `forward-<id>`）；与 v3 RELAY(21002) 共用唯一 egress 节点时的端口区间规划 | `mode_change` ⇒ `strategy=mode_switch`（`forward-rollout.ts:325`）+ `listener_replacement=true`（`forward-revision.ts:515-516`）⇒ `acquire_port(ingress) + acquire_port(egress) + prepare_egress` → `cutover_egress + cutover_ingress` → `drain_*` → `drop_old_egress + release_old_lease` |
| **S9 Ingress migration** | 第二台 INGRESS Agent（WP14-IN-B，`--ingress-range 21100-21199`，独立 data 网或同网第二 IP）+ client 侧第二视角（新 ingress IP 的探测容器）+ preview 对外地址断言 | `ingress_node_change` ⇒ `strategy=node_migration`（`forward-rollout.ts:327`）；`acquire_port` 在新节点 → `cutover_ingress` → `drain_ingress(旧节点)` → `release_old_lease(旧节点/端口)`（`:566-575, 591-598`）；`nodes.ingress_previous`（`forward-rollout-exec.ts:457-472`）；`predictExternalAddress`/`changes_external_address`（`forward-revision.ts:462-472, 518`） |
| **S10 重启恢复** | 对 panel/worker/ingress-agent 做受控重启并保留 `wp14_mysql_data` 卷的编排能力（compose 已有 `restart: unless-stopped` 与命名卷，缺「何时重启、在哪两步之间重启、如何断言在途 rollout 续跑」的 harness）；在途 rollout 需被 `resumeRollouts` 接管（`forward-rollout-recovery.ts`，目前仅单测） | §13.3.5「Backend 重启后可继续清理，不得永久泄漏 NodePortLease / Egress runtime」 |
| 其它遗漏：preview | `POST /api/forwards/:id/preview` 的 E2E 断言（§13.3.3「preview 与真实 update 不得各写一份规则」） | `previewForwardUpdate` 与 `patchForward` 共用 `resolveForwardCandidate`（`forward-service.ts:572-573, 718-730`） |
| 其它遗漏：CUTOVER 后失败补偿 | 真实（非单测）的补偿注入 | `forward-rollout-exec.ts:1116, 1277-1294` |
| 其它遗漏：name-only 不触发重建 | §13.3.2「不得为改名触发无意义的 listener 重建」的 E2E 证明（rename 后 lease/rollout 不变） | `isMetadataOnlyPatch` + `patchForward` metadataOnly 分支 |

---

## 8. 复跑前置条件（交接给脚本代理）

1. 必须先重建环境：`bash scripts/v3-e2e/teardown.sh && bash scripts/v3-e2e/setup.sh`。
   当前 `tunnel=3` 处于 `config_revision=15 / applied_revision=9 / suspended`（14:37 读数），
   且 `forward_revision`/`forward_rollout` 已累积 15/9 行，基线断言与端口租约都不再干净。
2. 结果文件只认最后一次完整运行的 `scripts/v3-e2e/evidence/v4-gate-rest-result.txt`；
   目录内其它 JSON 可能与它不同轮次（14:05/14:14/14:23 三批 mtime 混存），引用时按 mtime 取。
3. 若要推动 D1 结案，需要后端侧改动（创建路径写首个 snapshot 或 `applied===null` 合成
   baseline）后重跑 S3，并预期 `S3.13/S3.14/S3.16` 转 PASS。
