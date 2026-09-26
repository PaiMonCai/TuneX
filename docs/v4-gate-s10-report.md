# V4-F1 Gate — S10 真实 E2E 切片实施报告

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

## 3. 实测状态（由脚本在本会话内回填）

> 本节由 `v4-gate-s10.sh` 运行后写入。若脚本因环境阻塞未跑完，这里只会有
> 阻塞原因与已完成的阶段号，不会有任何 `PASS` 字样。

（待回填）

---

## 4. 已知限制与诚实标注

1. **first-edit baseline**：GHCR exact-SHA 镜像含 D1 自愈修复，因此本切片
   预期不复现 rest 报告 §4 的 D1（旧 lease 未释放）。脚本对
   `release_old_lease` 与 active-lease 唯一性仍**如实断言**，不复用 rest
   的特殊分支——这能验证修复在真实 exact-SHA 构建上成立。
2. **S10-B 中间相捕获**：wp14 的 rollout 通常在亚秒级完成，轮询可能错过
   中间相。脚本以「至少一次非终态」为目标，但**绝不因没捕获到就把场景判过**：
   未捕获时该断言记为 `LIMITED` 并附轮询窗口证据， PASS 只在真实捕获时才成立。
3. **不读取 secrets**：脚本只读 `state.json` 的非凭据字段与 `.env.wp14` 的
   `MYSQL_ROOT_PASSWORD`/`MYSQL_DATABASE`（仅用于 `mysql -N -e` 登录，对应
   rest 脚本既有做法），**不打印**这些值；报告与证据文件同样不含凭据。
4. **生产栈零接触**：所有 `docker` 写操作限定 `wp14-*` 容器名白名单，
   误匹配时脚本拒绝执行而非继续。
