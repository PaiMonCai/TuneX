# V4-F1 Gate — S10 真实 E2E 切片实施报告

> **2026-09-26 结案更新 — S10.47 已关闭（PR #20 / head `0008dca`）**
>
> 下方原报告保留首次实跑时的历史缺陷现场；其中“PASS=55 / LIMITED=1 /
> DEFECT=1”与 S10.47 degraded 结论已经**过期**。修复后的当前事实：
>
> - outbound command 的“已入队但同步窗口未收到 ACK”使用独立
>   `ack_timeout`，不再与真正的 `agent_unreachable` 混用；
> - PREPARE/CUTOVER 的 `ack_timeout` 进入可恢复 `waiting`，不会立即发
>   compensation 与迟到的原命令竞态；
> - `resumeRollouts` 从第一个未完成步骤按**同 revision**幂等续跑；
> - 崩溃停在 `compensating` 时会继续补偿，不再错误跳回 PREPARE；
> - Forward PATCH 对 `waiting` 按“desired 已保存、后台继续收敛”处理，
>   同时修正了原先会把 revision conflict 的 409 折叠成 502 的分支顺序；
> - S10 已正式接入 `.github/workflows/integration.yml`，并直接测试当前
>   checkout 由 `setup.sh` 构建的 `wp14-backend:ci / wp14-agent:ci`。
>
> **自动验证：**
>
> - CI #371：backend / web / agent / secret-scan 全部 success；
> - Integration #79：outbound-only gate、`v4-gate.sh`、`v4-gate-rest.sh`、
>   **`v4-gate-s10.sh`**、统一镜像 build/smoke/Compose 全部 success；
> - S10 总账：**PASS=57 / FAIL=0 / LIMITED=0 / DEFECT=0**；
> - S10.47：Agent pause 期间 `applied=3 / config=4` 且无假 `done`；
>   unpause 后约 15 秒自行收敛到 revision 4，终态 `done`；
> - S10.48：收敛后 rollout phase = `done`；
> - S10.49：最终端口 21011 真实 TCP 数据面仍读到 `WP14-TARGET-A`。
>
> 因此 S10.47 已成为正式、可重复的 PR/main 回归门。以下内容仅作为首次发现
> 缺陷时的历史取证保留。

分支：`feature/v4-gate-forward-rollout-s10`（worktree `/opt/TuneX-v4-gate-s10`，基线
`main` @ `ed23e550e3584eccca58068f22643ae8acb90997`）。交付物：独立脚本
`scripts/v3-e2e/v4-gate-s10.sh` + fixture `scripts/v3-e2e/fixtures/v4-gate-s10.json`
+ 本报告。脚本**不修改** `v4-gate.sh` / `v4-gate-rest.sh` / `setup.sh` /
`_bootstrap.py` / `integration.yml`，也不复用它们作为自身断言；它只复用同一套
wp14 隔离拓扑（MySQL/Redis/Panel/Worker/双 Agent/双 Target/client）与同一份
`state.json` 里的 Forward 实体。

---

## 0. 会话起源：为什么这个切片改用预构建镜像

前置调查报告记录了前任代理的阻塞：拓扑里的 `wp14-backend:ci` 镜像构建于
`2026-09-26T07:04:30Z`，早于 `main` 头 `ed23e55`（`07:56:26Z` push），因此
**缺 first-edit baseline 自愈**（`forward_revision` baseline snapshot / D1 修复）。

本会话重查 **release workflow 的证据面**后确认该阻塞可解除：

| 镜像 | Exact-SHA tag 在 GHCR 的状态 | 用途 |
| --- | --- | --- |
| `ghcr.io/paimoncai/tunex:ed23e550…` | HTTP 200（manifest 可解析） | Panel / Worker / db-migrate |
| `ghcr.io/paimoncai/tunex-agent:ed23e550…` | HTTP 200（manifest 可解析） | ingress / egress Agent |

Release workflow 对 `Integration` 成功的 head SHA 同时打 `latest` 与
`<head_sha>` 两个 tag（`.github/workflows/release.yml` 的 `images` job），
main 上 `ed23e55` 的 Integration run（`36228384093`）conclusion=success、Release
run（`36228566537`）conclusion=success，因此 exact-SHA 镜像存在且与 `main` 头一致。

因此本切片**不做任何本地 build**（任务约束），改为把 `TUNEX_BACKEND_IMAGE` /
`WP14_AGENT_IMAGE` 指向上述 exact-SHA GHCR 镜像重建 wp14 栈，再从零 provisioning。
这同时满足「不得直接复用旧 `wp14-backend:ci` 作 Gate 证据」。

统一镜像的目录布局与 e2e 拓扑期望不完全相同（web 是独立目录），因此：
- `db-migrate` / `panel` / `worker` 必须显式 `command` 与 `working_dir`（统一镜像
  默认 `WORKDIR /app/backend`，见根 `Dockerfile` 尾部），脚本通过 compose
  `-f` 的自带 override 覆盖，**不改** `docker-compose.e2e.yaml`。
- `wp14-agent:ci` 是 **alpine** 运行槽（`agent/Dockerfile` 末段），而
  `scripts/v3-e2e/setup.sh` 生成的 `agent.Dockerfile.e2e` 是 **busybox** 运行槽。
  两者二进制与 `--help` 入口兼容（`tunex-agent --help` 与
  `tunex-agent-entrypoint` 均存在，agent 的 docker-entrypoint 只是 exec 转发），
  脚本复用 `setup.sh` 的启动参数集，因此改用 exact-SHA agent 镜像不影响 Agent
  侧行为。实测确认见 §3。

---

## 1. 环境事实（会话内实测）

| 项 | 实测值 |
| --- | --- |
| 工作树 | `/opt/TuneX` = `main` @ `ed23e55`，有 2 个他人未跟踪文件（`.caddy-probe.Caddyfile`、`docker-compose.override.yaml`），本会话未触碰 |
| 隔离 worktree | `/opt/TuneX-v4-gate-s10`，新分支 `feature/v4-gate-forward-rollout-s10`，创建时确认 origin 无同名分支、本地无同名分支 |
| 旧 wp14 栈 | 曾运行 `wp14-backend:ci`（Panel/Worker/db-migrate），2 小时前由 rest worktree 的 setup 建立 |
| 旧 Agent 镜像 | `wp14-agent:ci`（4 小时前构建） |
| GHCR exact-SHA 镜像 | 上述两个 tag 均 HTTP 200；`docker pull` 已在本会话执行 |
| 环境 shell | 会话 shell 的 `PROMPT_COMMAND` 含失效 `cd /opt/TuneX-wp12/web`，导致裸 `cd` 失败 ⇒ 全程使用 `git -C` / `workdir` 显式路径规避，未改任何全局配置 |
| 生产容器 | `tunex-*` / `relayx-*` / `txboard-*` / `airbuddy-*` / `tunexpay-*` 全程未触碰，S10 脚本只匹配 `wp14-*` |
| 预构建产物使用 | 未执行任何 `docker build`、`bun run build`、`tsc`、`prisma migrate`（后两者只在容器内由 compose `db-migrate` 执行，属镜像内运行） |
| `.github/workflows/integration.yml` | 未修改（本切片独立运行，与 rest 切片同性质） |

---

## 2. S10 场景定义

承接 `v4-gate.sh`（S1 hot target / S2 stale 409）与 `v4-gate-rest.sh`
（S3 listen_port / S4 multi-field / S5 failure / S6 suspend-resume），S10 覆盖
§13.7 Wave 2 Gate V4-F1 里**尚未被任何已有切片真实执行过**的四组需求，全部
通过真实 HTTP API + 真实 MySQL 账本 + 真实 TCP 数据面断言：

| # | 场景 | 对应规格 |
| --- | --- | --- |
| S10-A | **in-flight 非终态 → done**：观察 rollout 从 `validate/prepare/cutover/drain/cleanup` 推进到 `done` 的**真实中间相** | §13.3.5 五阶段；`RolloutStatus` 契约（`forward-rollout-exec.ts`） |
| S10-B | **阶段推进的真实可见性**：一次 `listener_replace` 期间轮询 `forward_rollout.phase`，捕获到至少一个**非终态**（`prepare`/`cutover`/`drain`），且终态为 `done` | 同上 |
| S10-C | **applied == config 且快照 == rollout 行唯一**：编辑后 `applied_revision == config_revision`，`forward_revision`/`forward_rollout` 各恰 +1，且 `node_port_lease` active 唯一 | §13.3.2 / §13.3.4 |
| S10-D | **新旧真实 TCP marker 迁移**：旧端口读到旧 target marker、新端口读到新 target marker，旧端口随后不可建连 | §13.3.4 数据面证据 |
| S10-E | **agent 重启后数据面存活**：重启 `wp14-ingress-agent` 容器后，同一端口的 marker **不变**、`applied_revision` 不变 | §13.7「Backend/Agent 重启后 rollout/reconcile 可恢复」 |
| S10-F | **唯一 active lease**（跨 agent 重启复检） | §13.3.5 CLEANUP |

范围外（明确不做，避免伪造 PASS）：真实后端子系统的可控中断实验
（`docker pause ingress agent + API PATCH + restart worker/panel + unpause`）。
窗口内先做 **pause 语义前置验证**（能否 pause/unpause、暂停期间 API 行为、
恢复后 runtime 是否恢复），其结果如实写入 §3；若 pause 时序无法稳定复现
「暂停期间 rollout 停在非终态、恢复后自然续跑」，则脚本中该实验标记为
`LIMITED/UNVERIFIED` 并给出证据，**不以 claim 代替 PASS**。

---

## 3. 实测状态（脚本在本会话内回填）

运行：2026-09-26 10:20–10:31（`bash scripts/v3-e2e/v4-gate-s10.sh`，完整跑完）。
栈：`scripts/v3-e2e/s10-stack-up.sh` 用 exact-SHA GHCR 镜像从零重建的 wp14 拓扑
（含 migrate/seed/provision/创建 v3 DIRECT、RELAY 与 V4 Forward，全部走真实 HTTP API）。
镜像（本会话从 GHCR manifest 取回 digest 并与本地 pull 结果比对一致）：

| 镜像 | digest |
| --- | --- |
| `ghcr.io/paimoncai/tunex@ed23e55…` | `sha256:524c500eb77bd8326d142f5f72c07ce102c9fc14adca75de53d71ffe26e1b9c8` |
| `ghcr.io/paimoncai/tunex-agent@ed23e55…` | `sha256:949da5cf10f8cd00e7c75685937404aa450b275acfb19dc49db5d760375e0c04` |

**总账：PASS=55，LIMITED=1，DEFECT=1（FAIL 计数含该 DEFECT），脚本自身失败 0。**
证据文件：`scripts/v3-e2e/evidence/v4-gate-s10-result.txt`（含逐条结果与
rollout phase 时间线，未含任何凭据）。

逐组结果：

| 组 | 场景 | 结果 | 关键实测证据 |
| --- | --- | --- | --- |
| A0 | 栈与镜像前置 | **PASS** | 九个 wp14 容器运行中；两个 exact-SHA 镜像 digest 与 GHCR 取回值相等 |
| S10-A | in-flight 非终态 phase | **PASS** | phase 时间线 4 个采样点：`cutover ×3 -> done`，sampler 在 PATCH 之前启动 |
| S10-B | applied == config | **PASS** | `target_hot_swap` 与 `listener_replace` 后 applied_revision 均等于 config_revision（API 响应与 DB 双查） |
| S10-C | 单 revision 记账 | **PASS** | 两次编辑各只新增 1 行 `forward_revision` + 1 行 `forward_rollout` |
| S10-D | 新旧端口真实 marker | **PASS** | 新端口 21011 读到 `WP14-TARGET-B`；旧端口 21010 `wait_dead` 20 次 + 复查均无响应 |
| S10-C/F | 唯一 active lease | **PASS** | 21011 active；21010 released；`acquire_port` + `release_old_lease` 均在 plan 中 |
| S10-E | agent 重启数据面 | **PASS** | `State.StartedAt` 前进；重启后 10s 内新鲜 state report；同端口/同 revision/同 marker；仍 1 条 active lease；未产生额外 snapshot |
| S10-G.1 | 暂停期间无假 done | **PASS** | 暂停期间 PATCH 后 70 个采样点只见 `cutover/compensating`，无任何行到 `done`；applied 不超前 config |
| S10-G.2 | trap unpause | **PASS** | `docker unpause` 后 `State.Paused=false`；trap 保证中断也恢复 |
| S10.47 | 中断后自行收敛 | **LIMITED + DEFECT** | 见下 |
| S10.49 | 数据面最终可读 | **PASS** | 端口 21011 最终读到最后一次真实编辑的目标 `WP14-TARGET-A` |

### S10.47 真实缺陷（DEFECT，如实上报不判过）

暂停 ingress agent 期间发起一次真实 PATCH（target-a）。unpause 后实测：

- Agent 日志：`10:09:16 tunnel upstream hot-swapped id=tunex-12-direct … upstream=target-a:3030 revision=4`
  ⇒ **运行时确实按 revision 4 生效**。
- 但 DB ledger：`forward_rollout.revision=4` 停在 `degraded`，`applied_revision=3`
  落后 `config_revision=4`，且 180s 轮询窗口内未自行收敛到 `applied == config`。

即 **ledger 与 runtime 不一致**：`resumeRollouts` 的补偿路径把一个 Agent 已经
ACK 并生效的 revision 判为 `degraded`，导致 `applied_revision` 永久落后。脚本把两侧
证据都写进证据文件，按 DEFECT 计入非零退出，没有把它改判为 LIMITED。

后续如果该缺陷修复，重跑本脚本应看到 `S10.47` 由 LIMITED+DEFECT 变为
`PASS`（终态 `done`、`applied == config`）。

### 脚本自身在本轮修掉的测量性问题（均为测试问题，非产品问题）

| 问题 | 症状 | 修正 |
| --- | --- | --- |
| `mysqlc` 的 docker exec 引号嵌套错误 | 所有 ledger 查询返回空串，断言空 vs 空被记成 PASS | 改用 `v4-gate-rest.sh` 已证明可用的 argv 传参形式 |
| `assert_eq` / `assert_ne` 空 vs 空判 PASS | 环境失败被静默放过 | 显式判 `FAIL [实得与期望均为空——查询失败，不是相等]` |
| `createForward` 期望 200 | 实际返回 201 | 改为 201；端点改为 node-scoped `POST /api/nodes/{id}/forwards` |
| 用容器 Id 证明重启 | `docker restart` 不换 Id（设计如此），断言恒 FAIL | 改用 `State.StartedAt` + 新鲜 state report |
| 基线读取失败仍继续 | 产生一整屏由空值算术造成的假 FAIL | 基线为空即 fail-fast 退出并说明是环境阻塞 |
| 上一轮遗留 Forward | 端口冲突/幂等噪声 | 通过真实 API `DELETE` 清理，不手写 DB |

### 环境限制（如实记录）

1. **中断实验覆盖有限**：只做了「pause ingress agent → PATCH → unpause」一条
   恢复路径；未覆盖 worker/panel 重启叠加 agent 暂停的组合。未跑到的分支没有任何
   PASS 字样。
2. **phase 采样竞态**：rollout 常在一个轮询间隔内完成。脚本已把 sampler 提前到
   PATCH 之前启动，本轮 4 次与 70 次采样都捕获到了非终态，但这依赖时序；若某轮
   只采到终态，脚本会记 `LIMITED` 而不是 PASS。

---

## 4. 如何复跑（无本地 build）

```bash
# 1) 建隔离 worktree（若不存在）
git -C /opt/TuneX worktree add /opt/TuneX-v4-gate-s10 -b feature/v4-gate-forward-rollout-s10 main
cd /opt/TuneX-v4-gate-s10

# 2) 复制 harness 的运行时状态（这些文件被 .gitignore，不含凭据入库）
cp /opt/TuneX-v4-gate-rest/scripts/v3-e2e/{.env.wp14,.passwords.env,state.json} scripts/v3-e2e/

# 3) 确认 exact-SHA 预构建镜像在本地
docker pull ghcr.io/paimoncai/tunex:ed23e550e3584eccca58068f22643ae8acb90997
docker pull ghcr.io/paimoncai/tunex-agent:ed23e550e3584eccca58068f22643ae8acb90997

# 4) 用 exact-SHA 镜像重建 wp14 栈（只动 wp14-*；会 run db-migrate 与 provisioning）
bash scripts/v3-e2e/s10-stack-up.sh

# 5) 跑 gate
bash scripts/v3-e2e/v4-gate-s10.sh
echo "exit=$?"   # 非 0 即存在 FAIL 或 DEFECT；LIMITED 不单独决定退出码
```

`s10-stack-up.sh` 是 setup.sh 的「零 build」等价物：不执行任何 `docker build` /
`bun run build` / `tsc`；`prisma migrate deploy` 与 seed 在镜像内由 compose
`db-migrate` 角色执行，与 CI/生产同一路径。

### 退出码语义

| 退出码 | 含义 |
| --- | --- |
| 0 | 无 FAIL 且无 DEFECT（LIMITED 允许存在，但会打印在总账里） |
| 3 | 环境阻塞（基线查询为空 / 缺少镜像 / 栈未就绪），无任何 PASS 结论被伪造 |
| 9 | 白名单之外的容器被请求操作（安全闸门，脚本拒绝执行） |
| 其它非 0 | 存在 FAIL 或 DEFECT，见 `evidence/v4-gate-s10-result.txt` 逐条明细 |

---

## 5. 已知限制与诚实标注（超出本轮实测的部分）

1. **first-edit baseline**：GHCR exact-SHA 镜像含 D1 自愈修复，因此本切片
   预期不复现 rest 报告 §4 的 D1（旧 lease 未释放）。脚本对
   `release_old_lease` 与 active-lease 唯一性仍**如实断言**，本轮实测确认
   在同一条 Forward 的第二次编辑上 `release_old_lease` 正常出现（S10.26/
   S10.27/S10.28/S10.29/S10.30 全 PASS）。
2. **first-edit 的 D1 分支未复测**：本切片创建 Forward 时 `applied_revision`
   即非 null（S10.4 PASS），所以「首次编辑无 applied 快照」这条历史缺陷路径
   本切片没有单独造出来复测；该路径仍以 rest 报告的历史结论为准。
3. **不读取 secrets**：脚本只读 `state.json` 的非凭据字段与 `.env.wp14` 的
   `MYSQL_ROOT_PASSWORD`/`MYSQL_DATABASE`（仅用于 `mysql -N -e` 登录，对应
   rest 脚本既有做法），**不打印**这些值；报告与证据文件同样不含凭据。
4. **生产栈零接触**：所有 `docker` 写操作限定 `wp14-*` 容器名白名单，
   误匹配时脚本拒绝执行（退出码 9）而非继续。
