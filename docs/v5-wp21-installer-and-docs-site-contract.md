# V5-WP21 — 一键安装器 / 用户文档站 / 下载加速 契约（DRAFT-CONTRACT）

> **状态：DRAFT-CONTRACT（2026-10-05，工作树 `.worktrees/v5-1b-udp-relay`，分支 `feature/v5-1b-udp-relay`）。**
> **冻结项：FROZEN-1 … FROZEN-7** —— 本文是这三件事的**唯一语义来源**：动作集、幂等口径、
> 升级/回滚路径、信任边界、下载加速红线、文档真相归属、安装器与 OPS-02 的边界。
> 实现（脚本 / CI / 文档）若与本文冲突，以本文为准并回来改契约，不允许实现悄悄改写语义。
> **未决项：OPEN-1 … OPEN-5** —— 明确**不猜**，需 Lead 拍板后才进入实现（每条含候选与代价）。
> 关联阅读：`DEVELOPMENT.md` §0.1（文档索引）、§1.1（禁止第二份真相）；
> `docs/production-deploy.md`（OPS-02 生产运维手册，本 WP **不夺其真相权**，只在其前加一个入口）。

---

## 0. 一句话定位

~~~text
安装器   = 首次部署（init）的**编排器**：只编排既有产物（compose / .env / 既有 ops 脚本），
           不新增状态机、不新增第二套部署流程、不复刻 backup/restore/rollback 的任何一行逻辑。
文档     = 维持仓库 docs/ 单一真相；本期**不做**独立站点（FROZEN-5），只冻结"未来若做"的形态。
下载加速 = 本期**不做**任何第三方代理；只冻结"未来若做"的形态与红线（FROZEN-4）。
~~~

### 0.1 三块职责的归属（先读这条，后文不再重复）

| 领域 | 唯一负责人 | 唯一入口 |
|---|---|---|
| **本机首次部署**（Panel 主机） | 本 WP 新增的安装器 | `scripts/ops/install.sh`（新增文件，WP21B/C 交付） |
| **本机日常运维** | 既有 OPS-02 脚本（不改） | `scripts/ops/{alert,backup,restore,rollback,capacity}.sh` |
| **Agent 节点安装/升级** | 既有控制面（不改） | 面板生成的 `install.sh` / `upgrade-command`（`node-enrollment.ts` / `node-upgrade.ts`） |

**推论（可执行断言）**：安装器**不得**处理 Agent 节点的生命周期（那是面板 `POST /api/nodes/:id/enrollment`
与 `POST /api/nodes/:id/upgrade-command` 的职责），也不得实现备份/恢复/回滚/告警/容量（那是 OPS-02 的职责）。
凡是"安装器想自己写一遍"的地方，答案都是"调用既有脚本 + 把 `COMPOSE_FILE` / env 显式传下去"。

---

## 1. 仓库现状事实（逐条证据：文件 / 符号）

### 1.1 部署产物与版本口径

| 事实 | 证据 |
|---|---|
| 生产栈是单机 Compose，顶层项目名固定 `tunex`；MySQL/Redis 不映射主机端口；backend/web 只绑 `127.0.0.1`（13001/13002/13003） | `docker-compose.prod.yaml`：`name: tunex`、各服务无 `ports`（mysql/redis）、`127.0.0.1:${TUNEX_API_PORT:-13001}:3000` |
| 迁移由 compose 自带的 `db-migrate` 一次性容器完成：`bunx prisma migrate deploy && bun prisma/seed.ts`，`restart: "no"`，backend/worker 依赖 `service_completed_successfully` | `docker-compose.prod.yaml`：服务 `db-migrate`（`command`、`restart`）、`backend.depends_on.db-migrate.condition` |
| 面板应用镜像必须显式给出：`${TUNEX_IMAGE:?TUNEX_IMAGE is required}`；Agent 镜像单独一枚多架构镜像 | `docker-compose.prod.yaml`（4 处 `TUNEX_IMAGE`）、`.env.production.example`：`TUNEX_IMAGE` / `TUNEX_AGENT_IMAGE` |
| 版本口径是 **git sha 打的镜像 tag**（`ghcr.io/paimoncai/tunex:<git-sha>`），发布由 Release 流水线 push `latest` + `<sha>` | `.github/workflows/release.yml`：`tags: latest / ${{ github.event.workflow_run.head_sha }}`；`docs/production-deploy.md` §2.3 |
| 面板侧"建议升级到的 Agent 版本"是**部署方给的基线**（`TUNEX_AGENT_LATEST_VERSION`，空=不判落后），仓库里没有权威版本常量 | `backend/src/env.ts`：`agentLatestVersion`（含"为什么不从代码里推断"的批注）；该键**不在** `.env.production.example` 中 |
| 一键安装命令由面板拼装：`curl -fsSL '<SITE_URL>/api/internal/node/install.sh' \| sudo sh -s -- --panel … --enroll-token … --agent-image …` | `backend/src/services/node-enrollment.ts`：`buildInstallCommand()`、`renderNodeInstallScript()`、`normalizedPanelUrl()` |

### 1.2 既有运维脚本（按"唯一入口，不重写"对待）

| 事实 | 证据 |
|---|---|
| 脚本用 `-p tunex` 固定项目名，`COMPOSE_FILE` **默认是开发栈** `docker-compose.yaml`，对生产必须显式覆盖 | `scripts/ops/backup.sh`：`COMPOSE_PROJECT_NAME:-tunex` + `COMPOSE_BASE=(docker compose -p … -f "$COMPOSE_FILE")`；`scripts/ops/alert.sh`：`COMPOSE=(docker compose -p tunex -f "$COMPOSE_FILE")` |
| 备份三件套（MySQL dump / Redis RDB / 配置清单）、AES + PBKDF2、SHA256 + manifest、`RETENTION_DAYS` 保留 | `scripts/ops/backup.sh` 头部契约 |
| 口令双名：内部 `TUNEX_BACKUP_PASSPHRASE`（`-pass env:`，**不进 argv**），对外接受 `BACKUP_PASSPHRASE` | `backup.sh:228-245`；`restore.sh:164-187`（批注明说"两个变量名"） |
| 回滚**只切面板镜像**（`TUNEX_IMAGE`），强制"先备份→切镜像→健康检查→失败自动回退"，要求 `/readyz`（不只 `/healthz`），并做 `prisma migrate status` 兼容性自检；留痕 `var/ops/deploy-history.jsonl`；支持 `--to previous` | `rollback.sh`：`ROLLBACK_READY_URL`、`MIG_OUT`、"5.5/6 迁移兼容性自检"、`:58` 历史文件 |
| 回滚**不负责** Agent 镜像回退，脚本自己提示"在节点上重新执行带目标镜像的安装命令" | `rollback.sh` 第 7 节末尾日志文案 |

### 1.3 现有 CI / Gate（动它们=破坏冻结基线）

| 事实 | 证据 |
|---|---|
| 三条流水线：CI → Integration → Release；Release 只在 main 上由 Integration 成功后触发 | `release.yml`（`workflow_run: ["Integration"]`）、`integration.yml`（`workflow_run: ["CI"]`） |
| Integration 的 `unified-image` 会 **`cp .env.production.example .env` 后对两套 compose 做 `config -q`** | `.github/workflows/integration.yml:157-162` |
| F5.8 是"ops 脚本重写回归门"：断言三脚本的具体字符串（`TUNEX_BACKUP_PASSPHRASE`、`LOADING`、`resume_services`、`/readyz`…）与 `bash -n`；F5.13 是**真实** backup→mutate→restore 演练 | `scripts/v3-e2e/v4-gate-f5.py`：`f5_8_ops_scripts()`、`f5_13_backup_restore_drill()` |
| 真实拓扑 Gate 由 `scripts/v3-e2e/{setup,verify,teardown}.sh` 拉起，占用端口 18180/18181 | `scripts/v3-e2e/README.md`；`integration.yml:103-112` |
| 仓库**没有**任何安装脚本、没有根 `package.json`（无 JS monorepo 根工具链）、无 VitePress 文件 | `scripts/**/install*.sh` 无命中；根目录无 `package.json`；`grep -i vitepress DEVELOPMENT.md` 无命中 |

### 1.4 信任模型现状（读代码后的结论，不是猜测）

| 事实 | 证据 |
|---|---|
| 面板下发的安装脚本**不含任何凭据**，凭据由一次性 token 换取；脚本以 `cache-control: no-store` 提供 | `backend/src/routes/internal-node.ts:56`（`GET /node/install.sh`）、`node-enrollment.ts:229`（`renderNodeInstallScript()`） |
| 一次性 enrollment token：32 随机字节 base64url、**TTL 600s**、只存 `sha256`、原子单次消费（`updateMany` 守卫，并发只能有一个成功）、越权/过期/撤销三重判定 | `node-enrollment.ts`：`NODE_ENROLLMENT_TTL_SECONDS`、`NODE_ENROLLMENT_BYTES`、`hashNodeEnrollmentToken()`、`consumeNodeEnrollment()` |
| 重放/存量遏制：**重发新的 enrollment 会撤销该节点所有未使用的旧 token**；一次成功消费还会撤销其它未使用的同级 token | `node-enrollment.ts:115-127`（`updateMany` 置 `revoked_at`）、`:196-206`（"Defense in depth"） |
| 长期节点凭据：32 字节 base64url、只存 `sha256`、issue/rotate/revoke 三态；**撤销优先级高于哈希比对**；rotate 后旧 token 立即失效 | `backend/src/services/node-credential.ts`：`generateNodeCredential()`、`decideNodeAuth()`、`issueNodeCredential()`、`rotateNodeCredential()`、`revokeNodeCredential()` |
| 防爆破：同指纹 60s 内 10 次失败 → 封禁 300s（键是指纹哈希，Redis 里不留可用凭据） | `node-credential.ts`：`NODE_AUTH_MAX_FAILURES`、`NODE_AUTH_WINDOW_SECONDS`、`NODE_AUTH_BLOCK_SECONDS`、`noteRejection()` |
| DB 不可用 → `db_unavailable` → **503 而不是放行**（认证不 fail-open） | `node-credential.ts:272-308`；`internal-node.ts:96-108`（`authedNode`） |
| 匿名机器端点有专属 IP 限流：`/api/internal/node/enroll` 20 次/分钟/IP；install.sh 走全局规则 | `backend/src/middlewares/rate-limit.ts`：`name: "node-enrollment"`；`auth.ts:58-88`（`NO_AUTH_PATTERNS` 含 `^\/api\/internal\/.*`） |
| 凭据不进日志/审计：`redaction.ts` 命中 `enrollmenttoken`；`/node/enroll` 的明文只回响应体 | `backend/src/services/redaction.ts:22`；`internal-node.ts:71-93` |
| **已知残余**：安装命令里的 `--enroll-token` 是 shell 参数（节点上 `ps`/history 在 10 分钟窗口内可见）；token 不再绑定请求 IP（`observedIp` 只用于补 `connect_ip`） | `node-enrollment.ts:85`（命令拼接）、`:185-194`（`connect_ip` 赋值条件） |
| **已知残余**：Agent 节点侧安装脚本在缺 Docker 时会 `curl -fsSL https://get.docker.com -o tmp && sh tmp`（**无校验和/签名**） | `node-enrollment.ts:267-275` |
| Agent 升级脚本由面板渲染、操作者执行：先拉取后停机、SIGTERM 排空、身份不变、失败回退；**脚本内绝不出现凭据**（用容器内已有 `agent.env` 做身份校验，只打印 HTTP 码） | `backend/src/services/node-upgrade.ts`：`renderNodeUpgradeScript()`、`assertNoSecretShapes()`、`checkUpgradePrecondition()` |
| 镜像引用在面板侧有形状白名单（防 shell 注入） | `node-upgrade.ts:45-61`：`IMAGE_REF_RE`、`validateAgentImageRef()` |

---

## 2. Forwardx 先例与取舍（只参考语义，不复制代码；AGPL-3.0）

| 维度 | Forwardx 做法（证据） | TuneX 取舍 |
|---|---|---|
| 动作集 | `install\|upgrade\|uninstall\|reset-admin\|reset-password`（`install-panel-docker.sh` 的 `parse_args`/`usage`）；Agent 侧 `install\|upgrade\|uninstall`（`install-agent.sh:291-309`） | **只取 4 个动词**：`install/upgrade/uninstall/status`；`reset-admin` 归面板（`.admin-credentials` + seed），`rollback` 归 `scripts/ops/rollback.sh`（FROZEN-1） |
| 版本选择 | 从 GitHub Releases API 取 `tag_name`，镜像 `:v<semver>`，并用镜像内 `package.json` + OCI label 自证版本（`resolve_release_version`、`assert_target_image_ready`） | TuneX 无 semver/Releases，只有 sha tag → **sha 为唯一版本源 + digest 留痕**，不复刻"问 GitHub 要 latest"（FROZEN-2） |
| 升级前置 | `upgrade_panel()` **没有任何备份**，直接写 compose/env → 换镜像 → 起容器；迁移由容器启动隐式完成 | **拒绝**该模式：升级必须先 `backup.sh` 成功，否则拒绝（FROZEN-2） |
| 卸载 | 一次 `y/N` 确认后 `rm -rf $APP_DIR` + 删数据卷（`uninstall_panel`） | **默认保数据**，删卷必须 `--purge-data`（非交互再加 `--yes`）（FROZEN-1） |
| 半途失败/旧部署 | 遇到既有卷只**告警并复用**（`ensure_data_volume`）；非 install 动作跳过数据库选择 | **fail-closed**：由既存事实推导后**拒绝或显式引导**，不做静默复用（FROZEN-1） |
| 前置依赖 | 多包管理器自动装 Docker（apt/dnf/yum/zypper/apk/pacman，`install_docker()`），即 `curl get.docker.com \| sh` 语义 | **默认不自动装 Docker**，缺则拒绝并给三条路径（OPEN-2）（FROZEN-1） |
| 校验/签名 | 全脚本**无任何** sha256/签名校验（`grep sha256\|gpg\|cosign` 仅命中把 `sha256sum` 当随机数兜底）；唯一"完整性"是镜像内版本自证 | 不照搬；安装器**不引入无法验证的下载**，引导段用 **git sha 内容寻址**（OPEN-1）（FROZEN-3） |
| 下载加速 | `githubAccelerator.ts`：把 `github.com`/`*.githubusercontent.com` 前缀换成配置的加速地址（`applyGithubAccelerator`）；`install-agent.sh` 在开关打开时**硬编码回退 `https://git.poouo.com`**；加速查询失败会回落官方源 | 真实问题是"大陆到 GitHub raw/release 慢"，但 TuneX 分发面不同：Agent 镜像走 GHCR（部署方自建 registry mirror 即可），一键命令只依赖自己的 `SITE_URL` → **本期不做**，只冻结红线（FROZEN-4） |
| 文档站 | `docs/` 即 VitePress 源（`docs/.vitepress/config.mts`），独立 `docs.yml` 建站发布 GitHub Pages（`upload-pages-artifact`+`deploy-pages`），`VITEPRESS_BASE` 可覆盖 | **本期不做**：会新增第三套前端工具链 + 第四条流水线，并与"docs/ 单一真相"冲突（FROZEN-5） |
| 运维/安装边界 | 面板安装器**同时是**日常运维工具（upgrade/uninstall/reset-admin 都在其中） | 边界钉死：**首次部署=安装器，日常运维=OPS-02**，两套入口零重叠（FROZEN-6） |

**必须明确不照搬的三件事**（对应硬约束）：① 用 shell 起一堆外部引擎当主数据面（`install-agent.sh` 的 nginx/realm/gost/udp2raw/socat 进程与 systemd 单元矩阵）——TuneX 的数据面是 Go Agent + 受控 runtime，安装器**只碰 Docker**；
② 容忍型自动动作默认打开（自动装 Docker、自动复用旧卷、`upgrade` 无备份直接换镜像）——全部**默认关 + fail-closed**；
③ 面板下发整份配置（Forwardx 的 Agent 通过面板拿安装脚本与配置）——TuneX 只写**封闭的 9 个 env 键**，Forward 期望状态仍走既有 outbound desired/ACK 通道（FROZEN-3/FROZEN-6）。

---

## 3. 冻结决策

### FROZEN-1 —— 动作集、幂等性与前置条件（fail-closed）

**结论**

~~~text
scripts/ops/install.sh <action> [options]
  install    首次部署（唯一允许创建部署的动作）
  upgrade    版本升级（编排：备份 → 切镜像 → up -d → 健康 → 失败回退）
  uninstall  停容器；默认**保留**数据卷
  status     只读：打印部署事实（容器/镜像/健康/最近备份/迁移状态），不改任何东西
~~~

- **动作集封闭**：只有上述 4 个动词；`rollback` / `restore` / `backup` / `alert` / `capacity` **不是**它的动作，
  需要时由安装器**调用既有脚本**或打印既有命令（FROZEN-6）。
- **幂等口径 = "重复执行不产生第二次副作用"**，具体判定：
  1. `install` 先探测三态：**无部署** / **同版本已部署** / **异版本已部署**（探测源：`.env` 是否存在、`docker compose -p tunex ps` 的服务集合、`.env` 里的 `TUNEX_IMAGE`）。
  2. 无部署 → 继续；**同版本已部署 → 非零退出**，提示 `install.sh status`（要刷新部署用 `upgrade`）；
     **异版本已部署 → 非零退出**，提示"保留数据升级用 `upgrade --version <sha>`，彻底重来用 `uninstall --purge-data`"。
  3. **`.env` 已存在时永不覆盖**：只做"键存在性 + 占位值 + 权限"校验；缺键 → 拒绝并**打印缺失键名**（不打印任何值）；
     含占位值（`change-me…` / `replace-with…`）→ 拒绝；权限不是 `600` → 拒绝并给出 `chmod 600` 提示。
  4. **半途失败不自动清理、不自动重试**：打印"失败发生在哪一步 + 该步对应的既有命令"。
     由于不引入安装器状态文件（FROZEN-6），重跑 `install` 的判定完全由第 1 条的事实推导（不依赖"上次跑到哪"的记录）。
- **前置条件矩阵（任一不满足即拒绝，退出码 2–9，附可执行提示）**

| 前置 | 判据 | 拒绝后的提示 |
|---|---|---|
| root | `id -u != 0` | `sudo scripts/ops/install.sh …` |
| Linux + Docker Compose v2 | `uname -s` = Linux 且 `docker compose version` 可用 | 给出 Docker 官方安装文档路径（**不自动安装**） |
| standalone overlay 需要 Compose ≥ 2.24.4 | `--standalone` 时校验版本（`!override` 依赖） | 提示升级 compose 或改用宿主机反代模式 |
| 必需命令 | `curl` / `openssl` / `sha256sum` / `jq`（`rollback.sh` 依赖 jq） | 逐条列出缺失命令与安装命令 |
| 同机项目名冲突 | `docker ps -a --filter label=com.docker.compose.project=tunex` 非空且不属于本部署目录 | 明确说明"生产/开发栈项目名都是 `tunex`，不能同时 up"（`docs/production-deploy.md` §1） |
| 迁移/健康前置 | `mysql`/`redis` healthy；`db-migrate` 退出码必须为 0 | 非 0 即失败退出，提示 `docker logs tunex-db-migrate` 与人工 `restore.sh` |

**依据**：`docker-compose.prod.yaml` 的 `db-migrate` 语义（退出码 0 才算成功）、`docs/production-deploy.md` §1/§2.5/§9、
`scripts/ops/rollback.sh` 的"先备份、/readyz、迁移自检"三态。

**影响面**：新增 1 个文件 `scripts/ops/install.sh`；`.env.production.example` 与 `docs/production-deploy.md` 各增补一节（WP21D）；
**既有脚本零改动**（F5.8 的字符串断言必须继续成立）。

**明确不做**：不做 `--force` 覆盖 `.env`；不做"检测到旧部署就自动复用/自动迁移"；不做安装器自己的状态文件；
不把 `docker-compose.yaml`（开发栈）当作安装目标。

---

### FROZEN-2 —— 升级路径（sha 版本 + Prisma migrate + 备份前置 + 失败回退）

**结论**

~~~text
install.sh upgrade --version <git-sha>            # 必需；不接受省略
  0. 前置：部署存在 + .env 可读 + 备份口令可非交互获得 + 目标镜像可拉取（先 pull，后变更）
  1. scripts/ops/backup.sh                          # 必须成功；失败=拒绝升级（不留无保护窗口）
  2. 写 .env：TUNEX_IMAGE=ghcr.io/paimoncai/tunex:<sha>
              TUNEX_AGENT_IMAGE=ghcr.io/paimoncai/tunex-agent:<sha>
              TUNEX_AGENT_LATEST_VERSION=<sha>      # 面板"版本落后"基线（env.ts: agentLatestVersion）
  3. docker compose -p tunex -f docker-compose.prod.yaml up -d backend worker web
  4. 等待 db-migrate 退出码 0（迁移由它执行，安装器**不**自己跑 prisma）
  5. 健康：/healthz=200 且 /readyz=200 且 backend/worker/web 全 running
  6. 失败 → scripts/ops/rollback.sh --to previous --yes（**只回退镜像**）
~~~

- **版本选择**：`--version <sha>` 是唯一权威输入。`--version latest` **必须**同时给 `--allow-floating`，
  否则拒绝；即使用浮动 tag，也要在 `status`/`deploy-history` 里记录**解析出的 digest**（复用 `rollback.sh` 的留痕口径）。
- **备份前置**：口令只从 `BACKUP_PASSPHRASE` 读（`docs/production-deploy.md` 口径；`restore.sh:172-187` 同时接受
  `TUNEX_BACKUP_PASSPHRASE`）。非交互环境取不到口令 → **拒绝**，提示 `BACKUP_PASSPHRASE=… install.sh upgrade …`。
  口令只经 env 前缀传递，**不进 argv、不进日志、不进任何文件**（F5.8 同款纪律）。
- **migrate**：安装器**不执行** `prisma migrate deploy`——那是 `db-migrate` 服务的职责。安装器只等待其退出码。
  这样迁移状态机仍然只有一份（Prisma），不会出现"安装器以为迁移过了"。
- **失败回滚**：默认调用既有 `rollback.sh --to previous`（它内部已经"先备份→切镜像→/healthz+/readyz→失败自动回退"）。
  **数据层绝不自动回退**：需要连数据一起退回，由人工执行 `scripts/ops/restore.sh <backup-id> --yes`（二次确认）。
  理由：自动 DROP/恢复数据库是不可逆的破坏性动作，不符合 fail-closed 的"不确定就停"。
- **Agent 镜像**：面板主机升级**不包含**节点上的 Agent。安装器在结束时**必须**打印：
  "节点 Agent 升级请在面板生成 upgrade-command 执行"（引用 `nodes.ts` 的 `POST /api/nodes/:id/upgrade-command`），
  避免操作者误以为节点也跟着升级了。

**依据**：`release.yml`（sha tag）、`docker-compose.prod.yaml`（db-migrate）、`scripts/ops/backup.sh|rollback.sh|restore.sh`、
`backend/src/routes/nodes.ts`（upgrade-command）、`backend/src/services/node-upgrade.ts`。

**影响面**：只在安装器内新增"编排顺序"；既有两个脚本的行为一个字都不改。

**明确不做**：不解析 GitHub Releases/latest 语义；不实现镜像"版本自证"（TuneX 的锚是 digest，不是 semver）；
不自动做数据层回退；不新增 `prisma` 调用点。

---

### FROZEN-3 —— 信任模型（脚本、镜像、一次性凭据）

**结论（三段信任边界，逐段给校验手段）**

1. **引导段（`curl | bash` 不可避免的那一段）**：只做一件事——把仓库按指定 sha 检出到部署目录，然后用**检出后的脚本**继续（有副作用的动作永远发生在"已被内容寻址校验过的代码"上）。`git rev-parse HEAD` 必须等于请求的 sha，否则 `rm -rf` 临时目录并非零退出。**禁止**引导脚本含凭据、写 `.env`、pull 镜像或 `up -d`。
2. **安装器主体段**：只从**本地已检出的仓库**读取（`scripts/ops/*.sh`、compose、`.env.*.example`），**运行期不下载任何脚本或二进制**；镜像只经 `docker pull <image>:<sha|digest>` 获取，升级后把实际 digest 记入 `var/ops/deploy-history.jsonl`（复用 `rollback.sh` 字段口径）。镜像引用必须通过**与 `node-upgrade.ts:IMAGE_REF_RE` 同形**的窄校验；语义权威是 `node-upgrade.ts`，shell 侧是**登记在案的派生副本**（DoD 16 要求两者结论一致）。
3. **面板 ↔ Agent 段（现状，不改）**：一次性 enrollment token 的过期与重放结论由代码给出：32B 熵 / **TTL 600s** / 只存 sha256 / 原子单次消费 / **重发即撤销同节点所有未用 token** / 消费成功再撤销同级未用 token / 过期与撤销在读与写两处判定 / 认证失败 10 次 60s 即封 300s / DB 不可用回 503 不放行。**没有任何"面板下发整份配置"的通道**：安装脚本只写封闭的 **7 个必需 + 2 个可选** env 键（`TUNEX_PANEL_HTTP_URL`、`TUNEX_AGENT_ID`、`TUNEX_NODE_ID`、`TUNEX_NODE_CREDENTIAL`、`TUNEX_ROLE`、`TUNEX_AGENT_ADMIN_PORT=0`、`TUNEX_STATE_DIR`；可选 `TUNEX_INGRESS_RANGE` / `TUNEX_EGRESS_RANGE`），Forward 期望状态仍走既有 outbound desired/ACK。

**新增的硬性要求（对 WP21 自身）**

- 安装器**不得**回显/记录/落盘任何 token、口令、`TUNEX_CONFIG_KEY`；日志中只允许出现变量名。
- 生成 `.env` 时用 `openssl rand -base64 32 | tr '+/' '-_'` 生成 `AUTH_SECRET` / `LICENSE_SECRET` / `TUNEX_CONFIG_KEY` / `TUNEX_LICENSE_KEY` / `MYSQL_ROOT_PASSWORD`，文件 `chmod 600`；**只打印 `.admin-credentials` 的路径**（首启凭据仍由 `db-migrate` 写出）。
- 残余风险原样登记、不掩盖：①`--enroll-token` 在节点 `ps`/history 的 10 分钟窗口内可见；②节点侧缺 Docker 时既有脚本会执行未校验的 `get.docker.com`（OPEN-5）。

**明确不做**：不引入自签名/自建 PKI；不承诺"安装器能验证镜像签名"（CI 目前不产出 cosign 签名，见 §9 风险）；
不复制 Forwardx 的"加速器 + 裸 `curl | bash`"组合。

---

### FROZEN-4 —— 下载加速（本期不做；形态与红线先冻结）

**结论：WP21 不实现下载加速，不引入任何第三方代理地址，不写死任何镜像地址。**

- **Forwardx 解决的真实问题**：中国大陆访问 `github.com` / `raw.githubusercontent.com` 慢或不可达，
  而它把 Agent 二进制/脚本放在 GitHub（`agentAssets.ts` 的 `githubAssetUrl()`），安装与升级都依赖 GitHub。
- **TuneX 的问题面不同**：一键安装命令只依赖**自己的** `SITE_URL`；Agent 镜像来自 GHCR（可用 Docker
  **registry mirror** / 自建 registry 解决，属于宿主机 Docker 配置，**不由面板代管**）；引导段只取自己的仓库。
  因此"面板内置第三方下载代理"在 TuneX 缺少必须性。
- **若未来立项，形态冻结如下（可断言）**：
  1. 配置：`TUNEX_GITHUB_ACCELERATOR_URL`（默认**空 = 关**）与 `TUNEX_GITHUB_ACCELERATOR_ENABLED`（默认 `false`），
     **两者同时满足**才生效（`effectiveGithubAccelerator` 同款语义：有 URL 没开关 = 关）。
  2. 作用域：仅限 GitHub 下载类 URL（host 白名单形如 `github.com` / `*.githubusercontent.com`），
     命中才改写；**必须保留"失败回落官方源"**。
  3. **禁止**：把加速地址写进任何仓库内文件/镜像/`.env.*.example`；对 `/api/internal/node/install.sh` 与
     Agent 镜像拉取使用加速器（**节点侧信任面最小化**）；对非 GitHub 域名生效；`http://`（只允许 https）。
  4. **安全影响明说**：加速器 = 下载链路上的 MITM 位置（可替换内容），所以它只能与**内容校验**同时使用
     （git sha / 镜像 digest / sha256），且必须默认关、必须由部署方显式承担信任。

**明确不做**：本期不加加速器代码、不加配置项、不改 `node-enrollment.ts` 生成的命令。

---

### FROZEN-5 —— 文档站（本期不做独立站点；单一真相在 `docs/`）

**结论：不做独立站点。** 面向终端用户的文档以 `docs/` 内的 Markdown 为唯一真相。

**依据**：
- 仓库**没有根 `package.json`**、没有 workspace/锁文件、没有任何 VitePress 配置——建站=新增第三套前端工具链与锁文件；
- 会有**第四条流水线**（Forwardx 的 `docs.yml` 是独立 Pages 工作流），与"不破坏既有 CI 三条流水线"的成本不对称；
- TuneX 已有单一真相入口：`docs/production-deploy.md` 被 `README.md:105/124` 与 `DEVELOPMENT.md:35` 双向引用，
  `DEVELOPMENT.md` §0.1 就是文档索引；再建一份站点内容=违反 §1.1「禁止第二份真相」。

**替代方案（冻结）**：
1. 用户向文档一律落在 `docs/`（建议新目录 `docs/user-guide/`，与运维手册同真相、同仓库、同评审）；
2. 若将来确需站点，站点**只能是 `docs/` 的渲染产物**：内容不复制、不手写第二份，构建输入必须指向 `docs/`；
   CI 只允许"从 main 构建 → 校验产物非空（`index.html` 存在、文件数 > 0）→ 上传产物"，
   发布目标与 `base` 路径必须显式配置（不引入隐式默认）；
3. 站点不得引入"只在站点里存在"的事实（版本号、端口、环境变量、命令），发现即视为缺陷。

**明确不做**：本期不新增站点目录、不新增依赖、不新增 workflow；不把 `production-deploy.md` 的内容抄成教程。

---

### FROZEN-6 —— 运维脚本与安装器的边界（两套入口，零重叠）

| 关注点 | 归属 | 依据 |
|---|---|---|
| 生成/校验 `.env`、拉镜像、`up -d`、等待 `db-migrate`、健康验收 | **安装器**（首次部署） | 本契约 |
| backup / restore / rollback / alert / capacity | **OPS-02 脚本**（不改） | `scripts/ops/*.sh` |
| 迁移执行 | **compose `db-migrate`** | `docker-compose.prod.yaml` |
| Agent 节点安装/升级 | **控制面**（面板渲染脚本） | `node-enrollment.ts` / `node-upgrade.ts` |
| cron（告警/容量/备份节律） | **部署方**（安装器只打印现成 cron 行） | `docs/production-deploy.md` §4/§5 |

- 安装器调用 ops 脚本时**必须显式传环境**：`COMPOSE_FILE=<root>/docker-compose.prod.yaml`、
  `COMPOSE_PROJECT_NAME=tunex`、`TUNEX_ENV_FILE=<root>/.env`、备份口令经 env。**禁止**依赖调用者 shell 的隐式默认值
  （否则会打到开发栈 `docker-compose.yaml` —— 这是 `docs/production-deploy.md` §9 已登记的坑）。
- 安装器**不得**写 `crontab`、**不得**改 `scripts/ops/*.sh`、**不得**引入 `var/` 之外的持久状态文件
  （`var/ops/*` 的账本由既有脚本写；安装器只读）。

**明确不做**：不做第二套备份/回滚实现；不做安装器自带的状态机（"step 3 done" 之类的进度文件）；
不做"安装器也会帮你日常巡检"。

---

### FROZEN-7 —— 与既有控制面/数据面的隔离

**结论**：安装器只操作 `docker-compose.prod.yaml` 的容器与卷；不接触 Forward/RoutePlan/租约/Agent 运行时；
不引入任何 UDP/多引擎 shell-out 数据面（这是 Forwardx 的反面教材）。

**依据**：硬约束"不照搬 shell-out 多引擎当主数据面"；TuneX 数据面 = Go Agent 的 runtime（`agent/internal/…`）。

**明确不做**：不安装 nginx/realm/gost/udp2raw/socat 之类外部引擎；不为节点写 systemd 单元矩阵；
不改 Agent 的控制协议。

---

## 4. 开放决策（不猜；列出候选与代价）

| ID | 问题 | 候选 | 代价 |
|---|---|---|---|
| **OPEN-1** | 引导方式（"第一段"怎么把代码拿到机器上） | (a) `git clone --depth 1 --branch <sha>` + `rev-parse` 断言（**推荐**，内容可验证、无 raw 依赖）；(b) `curl -fsSL <repo>/install.sh \| sudo sh`（Forwardx 式，最顺滑但内容不可验证）；(c) 两者都给（新手用 b、审计场景用 a） | (a) 需要 git 与可达的 git 远端（国内 git 托管/镜像可由部署方自选）；(b) 需要额外信任"能改 raw 响应的一切"；(c) 维护两条入口、文档要写清差异 |
| **OPEN-2** | 是否允许安装器自动装 Docker | (a) 永不（**推荐**，缺 Docker 即拒绝并给三条手工路径）；(b) 显式开关 `--install-docker --docker-script-sha256 <hex>`（必须 pin 校验和，拒绝裸 `curl\|sh`）；(c) 默认自动（Forwardx 语义） | (a) 全新机器多一步人工；(b) 需要人工维护/更新 sha256 并防"sha 过期导致安装失败"；(c) 把未校验的 root 代码执行写进产品路径，违背 fail-closed |
| **OPEN-3** | 是否需要面向终端用户的独立文档站 | (a) 不做站点，只在 `docs/` 写用户指南（**本期结论**）；(b) 做站点但只从 `docs/` 渲染（VitePress，需新增根工具链 + 第四条流水线）；(c) 用现有 README 摘要承担用户文档 | (a) 用户需在 GitHub 阅读 md；(b) 新增依赖/锁文件/CI 与"第二份真相"风险；(c) README 会膨胀，且与 `docs/` 交叉引用变多 |
| **OPEN-4** | 下载加速是否立项（形态已由 FROZEN-4 冻结） | (a) 不做（本期结论）；(b) 做，但仅作用于"部署方自选的镜像源/仓库镜像"，**不进产品代码**；(c) 做，按 FROZEN-4 的开关形态进产品 | (a) 国内拉 GHCR 仍需部署方自建 mirror；(b) 需要文档教部署方改 Docker daemon；(c) 把 MITM 位置引入分发链路，必须默认关 + 显式信任 |
| **OPEN-5** | 是否收紧**既有** Agent 节点安装脚本里"缺 Docker 时执行未校验 `get.docker.com`" | (a) 保持现状（属 V4 冻结范围，WP21 不动）；(b) 单独立 WP 收紧：改为拒绝 + 提示，或要求 `--docker-script-sha256`；(c) 改为使用发行版包管理器并校验包签名 | (a) 保留一个未校验的 root 代码执行点（已登记为残余风险）；(b) 影响"一条命令装好节点"的体验；(c) 各发行版差异大、实现成本高 |

> **需要 Lead 拍板的取舍（≤3）**：**OPEN-1**（引导方式，决定"信任边界能讲到多硬"）、
> **OPEN-2**（是否允许带校验和的自动装 Docker，决定全新机器的体验下限）、
> **OPEN-3**（文档站是否立项，决定是否新增第四条流水线）。OPEN-4/OPEN-5 可以后置。

---

## 5. WP 拆分

| WP | 交付 | 触碰的文件 | 依赖 |
|---|---|---|---|
| **WP21A** | 本契约冻结（边界、信任模型、失败语义、开放项） | 仅本文 | 无 |
| **WP21B** | `install.sh` 的 `install` + `status`：preflight 矩阵、`.env` 生成/校验、`pull`+`up -d`、等 `db-migrate`、健康验收、打印 OPS-02 交接命令 | 新增 `scripts/ops/install.sh` | 21A；OPEN-1/OPEN-2 需先定 |
| **WP21C** | `upgrade` + `uninstall`：编排 `backup.sh` → 切 `TUNEX_IMAGE`/`TUNEX_AGENT_IMAGE` → `up -d` → 健康 → 失败调 `rollback.sh --to previous`；卸载默认保卷、`--purge-data` 双确认 | 同上（同文件） | 21B |
| **WP21D** | 文档与静态门：`docs/production-deploy.md` 增"一键安装（自动化入口）"一节并把它标为**默认路径**、手动步骤降级为 fallback；`.env.production.example` 增 `TUNEX_AGENT_LATEST_VERSION`；`ci.yml` **仅新增** `installer-static` 作业 | `docs/production-deploy.md`、`.env.production.example`、`.github/workflows/ci.yml` | 21B/21C |
| **WP21E（可选，需 Lead 批）** | 真实环境门禁 `scripts/v3-e2e/v5-g6-installer.sh`（见 §7） | 新增脚本 + （可选）一个 `workflow_dispatch` 工作流 | 21C |
| 未立项 | 文档站（OPEN-3）、下载加速（OPEN-4） | — | — |

**拆分原则**：一个 WP 只动一个关注点；21B/21C 不修改任何既有脚本；21D 对 `ci.yml` 只做**新增作业**，
不修改既有作业的触发条件、步骤与环境（回归风险最小化）。

---

## 6. DoD（可断言检查）

**安装/幂等**
1. 干净机器（有 Docker、无部署）：`sudo scripts/ops/install.sh install --version <sha>` 退出码 0；`curl -fsS http://127.0.0.1:13001/healthz` = 200 且 `/readyz` = 200；`docker compose -p tunex ps` 服务集合 = `{mysql, redis, backend, worker, web}` 全 running，`db-migrate` 退出码 0。
2. **重复执行不产生第二套容器**：紧接着再跑同一条命令 → **非零退出**，且 `docker ps -a --filter label=com.docker.compose.project=tunex --format '{{.Names}}' | wc -l` **与第一次相同**。
3. 干净机器（**无 Docker**）：同上命令 → **非零退出**，stderr 含可执行提示（Docker 文档 + 发行版包管理器路径），且**未创建** `<部署目录>/.env`、未拉取任何镜像。
4. 非 root：普通用户执行 → 非零退出且提示中出现 `sudo`；未写入任何 root 路径。
5. `.env` 已存在但缺 `AUTH_SECRET` → 非零退出，提示含 `AUTH_SECRET` 且**不打印**其它键的值；权限 644 → 非零退出并提示 `chmod 600 .env`；含 `change-me-` 占位值 → 非零退出。
6. 同机已有 `tunex` 项目的旧栈（模拟：先 `docker compose -p tunex up -d mysql`）→ `install` 拒绝，提示项目名冲突。

**升级/回滚**
7. `upgrade --version <sha2>`：日志顺序为 `backup.sh` → `docker pull` → `up -d backend worker web` → 健康；`var/backups/<UTC日期>/` 新增 1 个 `*.manifest.json`；`var/ops/deploy-history.jsonl` 新增 1 条含 digest 的记录；`docker inspect tunex-backend --format '{{.Config.Image}}'` = `ghcr.io/paimoncai/tunex:<sha2>`。
8. **失败注入**：`upgrade --version ghcr.io/paimoncai/tunex:does-not-exist` → 非零退出；镜像**未变**；`/healthz` 仍 200。
9. 备份失败注入（令 `backup.sh` 非 0）→ `upgrade` **拒绝**且**没有**发生镜像切换（`docker inspect` 不变）。
10. 非交互且未给 `BACKUP_PASSPHRASE` → `upgrade` 非零退出，提示含 `BACKUP_PASSPHRASE` 与"非交互"字样。
11. `uninstall`（默认）→ 容器消失、卷 `tunex-mysql-data-prod` **仍存在**；`uninstall --purge-data` 非交互且无 `--yes` → 拒绝；`--purge-data --yes` → 卷消失。

**边界与硬约束**
12. 静态：`sh -n` 与 `bash -n` 均通过；脚本中无 `eval`、无明文口令赋值、无 `--passphrase` 形式 argv 传参。
13. 无第三方域名：`grep -REn "poouo|ghproxy|gh-proxy|fastgit" scripts/ops/install.sh` 为空；安装器写出的任何文件不含第三方加速地址。
14. 零改动既有脚本：本 WP diff 中 `scripts/ops/{alert,backup,restore,rollback,capacity}.sh` **无改动**，且复跑 F5.8 的字符串断言仍全绿。
15. 不新增状态机：安装器**不创建**任何"进度/状态"文件；`find var -newer` 只见既有脚本产物（`var/backups/*`、`var/ops/*`）。
16. 镜像引用校验一致性：对固定样例集，`install.sh` 的结论与 `node-upgrade.ts:validateAgentImageRef` 逐条一致（合法：`ghcr.io/paimoncai/tunex-agent:<sha>`、`…@sha256:<64hex>`；非法：含空格/`;`/`$(`/超 255 字符）。
17. CI 不回归：增补 `TUNEX_AGENT_LATEST_VERSION` 后，`cp .env.production.example .env && TUNEX_IMAGE=x docker compose -f docker-compose.prod.yaml config -q` 仍 0（对齐 `integration.yml:157-162`）；`ci.yml` 既有作业的 `name`/`steps`/触发条件**零变化**。

**文档**
18. `docs/production-deploy.md` 新增小节中：一键安装是**默认路径**、手动步骤标为 fallback，且**不复制**既有 §2 的操作细节（只链接）；命令口径与既有文档一致（端口、`COMPOSE_FILE`、脚本名）。

---

## 7. Gate 映射（是否需要真实环境门禁；与 `scripts/v3-e2e/` 及 CI 的接法）

| 层 | 接法 | 为什么 |
|---|---|---|
| **CI（`ci.yml`，仅新增作业 `installer-static`）** | `sh -n` / `bash -n`；禁止串断言（无第三方域名、无 `eval`、无明文口令）；`--dry-run --no-docker` 全流程自检（PATH 注入 `docker`/`compose` stub，断言**不产生**任何真实副作用）；`shellcheck`（若采用，则作为新增步骤，不修改既有作业） | 纯静态+桩化，零 Docker 依赖，不碰既有作业；能在每次 PR 上拦住"写死加速地址/偷偷改 ops 脚本" |
| **Integration（`integration.yml`，零改动）** | **不接入** | ① 生产栈与 e2e 栈会抢同一 compose 项目名（生产顶层 `name: tunex`，ops 固定 `-p tunex`），同机同时 `up` 会互相踩（`docs/production-deploy.md` §1）；② `v3-integration` 已被 F5.13 的真实备份/恢复演练与 18180/18181 端口占用，新增会引入非确定性；③ F5.8 已断言 ops 脚本内容——本 WP 必须让它们"零改动"，改动即 Integration 红 |
| **Release（`release.yml`，零改动）** | 不涉及 | 安装器消费 Release 产物（sha tag），不改变发布语义 |
| **真实环境门禁 Gate V5-G6（WP21E，`scripts/v3-e2e/v5-g6-installer.sh`）** | 在**干净、可丢弃**的机器（非 CI runner）上按 DoD §6 的 1–11 步逐条断言并留证据到 `scripts/v3-e2e/evidence/`；不进 PR 路径，建议以 `workflow_dispatch` 或 Lead 指定机器执行 | 安装器会改机器状态（docker、`/opt`、端口 13001–13003、卷），这与"CI 每次可重复"冲突；参照 `scripts/perf/README.md` 的"真实测量由人在确定环境跑"的既有先例（`ci.yml` 只跑自检：`perf-harness`） |

**门禁的失败语义**：G6 任一断言失败 = WP21 未完成，不得合并到 main；`installer-static` 失败 = 阻断 PR。

---

## 8. 明确不做（本 WP 的负边界）

1. 不做第二套部署流程/状态机（安装器不写进度文件、不实现自己的迁移/回滚/备份）。
2. 不改 `scripts/ops/*.sh`、不改 `docker-compose*.yaml`、`Caddyfile*`、`Dockerfile`、`agent/Dockerfile`。
3. 不改 `node-enrollment.ts` / `node-credential.ts` / `node-upgrade.ts` / `nodes.ts` 的任何行为（Agent 侧不动）。
4. 不做 `reset-admin` 这类面板内动作的安装器版本（已有 `.admin-credentials` + seed）。
5. 不做文档站、不做下载加速（OPEN-3/OPEN-4 决定是否另立 WP）。
6. 不自动装 Docker、不自动删数据卷、不自动恢复数据、不自动改 `crontab`。
7. 不引入 semver / GitHub Releases 版本语义；不引入 cosign/签名（CI 目前不产出，见 §9）。
8. 不把 `TUNEX_AGENT_IMAGE` 指向不可匿名拉取的仓库（节点侧拉取必须无 registry 登录，`docs/production-deploy.md` §2.3）。

---

## 9. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 安装器需要 root 且改动机器状态，难以在 CI 反复验证 | "只在文档里正确" | DoD 的桩化 dry-run 进 CI + 真实 G6 门禁由人/专用机器执行并留证据 |
| 生产栈与开发栈共用项目名 `tunex`、`scripts/ops/*` 默认读 `docker-compose.yaml` | 安装器打错栈（备份空栈/改错容器） | preflight 显式传 `COMPOSE_FILE`/`COMPOSE_PROJECT_NAME`，并做冲突检测（FROZEN-6） |
| 备份口令非交互缺失导致升级中断 | 运维误判"升级失败" | 升级前置即拒绝并给可复制的命令；错误信息必须指明变量名（FROZEN-2） |
| 回滚只退镜像、schema 可能已前移 | 旧代码对新 schema | 复用 `rollback.sh` 的 `prisma migrate status` 自检；数据层回退必须人工 `restore.sh`（FROZEN-2） |
| 面板主机升级 ≠ 节点升级 | 操作者以为全链路已升级 | 安装器结束时强制打印节点升级指引（FROZEN-2） |
| 既有残余：`--enroll-token` 在节点进程表/历史里 10 分钟可见；节点侧缺 Docker 时会执行未校验的 `get.docker.com` | 窗口内被窃取 / 未校验的 root 代码执行 | 既有缓解：32B 熵 + 600s TTL + 单次消费 + 重发即撤销 + 20/min/IP 限流；本 WP 要求安装器与日志**永不回显** token；节点侧问题登记为 OPEN-5，WP21 不复制也不扩大其作用面 |
| 将来站点/加速器被"顺手"加回来 | 第二份真相 / MITM 位置 | FROZEN-4/FROZEN-5 已冻结形态与红线；`installer-static` 断言禁止串 |
| 新增 `ci.yml` 作业带来的时长/维护成本 | 流水线变慢 | 该作业纯静态+桩化，目标 ≤1 分钟；不修改既有作业 |

---

## 10. 冻结声明与落点

- 本文冻结 **FROZEN-1 … FROZEN-7**；**OPEN-1 … OPEN-5** 在 Lead 拍板前**不得**进入实现（实现方不得"先做一版再说"）。
- 交付物落点：契约 = 本文；实现 = `scripts/ops/install.sh`（新增）+ WP21D 的三处增补；验证 = DoD §6 的 18 条 + Gate §7 的三层接法。
- 与既有文档的关系：`docs/production-deploy.md` 仍是**手动路径与日常运维的唯一真相**；本文只新增"自动化入口"的语义，不复制其内容，不改变其结论。
