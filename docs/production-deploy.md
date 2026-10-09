# 生产部署与转发功能发布

更新：2026-10-10。说明按当前仓库 Compose 和脚本整理，本次文档工作没有执行生产部署。PR #75 已合并不等于发行；F5 预览仍在未合并草稿 PR #76，源码验收状态见 [文档入口](README.md)。使用已构建并发布的版本；开发分支与 CI 绿色结果不自动构成可用的发行镜像。

## 生产栈与入口

使用 [docker-compose.prod.yaml](../docker-compose.prod.yaml) 和 [.env.production.example](../.env.production.example)。Panel/Worker/Web/migrate 共用固定 `TUNEX_IMAGE`，Agent 使用独立镜像/安装流程。固定发布 SHA 或 digest，保留已知良好版本。

```bash
cp .env.production.example .env
chmod 600 .env
```

填写数据库密码、匹配的 DATABASE_URL、独立安全密钥、SITE_URL、镜像版本及管理员/邮件配置。按部署需要设置 SMTP，避免用户的验证与重置邮件仅留在日志。首次随机管理员口令写入部署目录 `.admin-credentials`，首次登录后更改并移除该文件。

| 服务入口 | 默认 loopback 端口 | 反代路径 |
| --- | --- | --- |
| API | 13001 | `/api/*`、`/healthz`；需要外部 readiness 时显式代理 `/readyz`。 |
| 控制 WebSocket | 13002 | `/socket.io/*`，保持 Upgrade 和长连接。 |
| Web | 13003 | 其余页面。 |
| 可选内部 Caddy | 13000 | 开启 caddy profile 后聚合以上入口，宿主反代负责 TLS。 |

已有 Nginx/宝塔/1Panel 时，同一 HTTPS 域名代理三类路径，或使用内部 Caddy 聚合：

```bash
docker compose -f docker-compose.prod.yaml --env-file .env --profile caddy up -d
```

宿主无反代时使用 standalone overlay，需支持 `!override` 的 Compose（文件要求 >= 2.24.4）、真实 SITE_URL/ACME_EMAIL、可用 80/443 和匹配 DNS：

```bash
docker compose -f docker-compose.prod.yaml -f docker-compose.standalone.yaml --env-file .env up -d
```

API 与控制 WebSocket 是不同进程端口，不能全部代理到 13001。MySQL/Redis 仅内部网络可达。容器名、网络名和卷名有固定值，`-p` 不会完全隔离第二套实例；多套部署必须显式处理命名冲突。不要用开发栈的 down -v 管理生产数据。

## 安装、升级与验证

一键安装器仅编排 Panel 栈；先审查当前文件和计划，再执行对应发布版本：

```bash
bash scripts/ops/install.sh --dry-run install --version <released-40-char-sha>
sudo bash scripts/ops/install.sh install --version <released-40-char-sha>
```

升级使用 `upgrade --version <released-40-char-sha>`；安装器调用既有备份/回退脚本。`--standalone` 选择独立 Caddy；`--agent-version <semver>` 是单独的 Agent 版本基线，镜像 SHA 不能代替 Agent 上报版本。完整选项和检查以 [install.sh](../scripts/ops/install.sh) 为准。

迁移容器必须退出码 0，Panel/Worker 依赖其成功；不要跳过迁移直接启动应用。检查实际数据库 readiness、Worker、WebSocket 和业务转发：

```bash
docker compose -f docker-compose.prod.yaml --env-file .env ps -a
curl -fsS http://127.0.0.1:13001/healthz
curl -fsS http://127.0.0.1:13001/readyz
```

这些 HTTP 检查不替代真实流量。至少创建/检查一条规则，验证 TCP/UDP 实际 payload、正确目标、重启恢复与运行报告；只有新鲜匹配观测才能判断 runtime Ready。

Agent 先在 Panel 创建 Node，使用该节点生成的安装/enrollment 和 upgrade 命令。主动连接 Panel，正常使用不向公网开放 Agent 管理端口；业务监听和载体端口按具体拓扑开放。Agent 镜像同时提供固定的 `/usr/local/bin/tunex-fxp`，版本与能力必须来自实际运行程序。

## 共享 FXP 的实验启用顺序

`TUNEX_FXP_LINKS_ENABLED` 默认 false，公共支持矩阵仍 planned。正式开放条件由 [开发方案 F0/F1](DEVELOPMENT_PLAN.md) 和 [验收说明](testing.md) 控制。测试开启需要：

1. 备份数据库、配置与节点私有状态；先执行当前完整迁移，包含 `20261101005000_link_traffic_checkpoints`、`20261101006000_link_target_sets` 和 `20261101007000_link_client_sources`，部署兼容的 Panel/Worker 接收端。
2. Panel 和 Worker 设置一致、独立生成的 32 字节/64 位 hex `TUNEX_LINK_SEAL_KEY`，并开启 FXP 实验开关；不使用 AUTH_SECRET 代替，不在运行中随意更换封存密钥。
3. 升级兼容 Agent 与实际 FXP，开启同名开关。Agent state 目录持久且只允许服务账户访问；Linux 目录/文件模式 0700/0600。当前验收与发布范围限定 Linux，Windows 适配暂停；已有 Windows 文件处理代码或 ACL 要求不构成完整平台支持承诺。
4. 先在有限节点创建双节点 Link，验证零规则 passive、单条 TCP/UDP/both、限制、流量回执、共享 A/B 更新、失败补偿及删除端口复用；核对真实镜像与最小能力。

先升级接收端，再启用新 Agent，避免未提交统计获得错误确认。关闭开关不等于所有监听瞬时停止，必须结合移除/租约到期和实际报告验证。当前有引用资源的在线端点修改和密钥轮换尚未开放，按 [运行边界](forwarding-runtime.md) 操作。

F5 预览首切片没有新增数据库迁移或 Agent 协议，仅提供 `POST /api/links/:id/maintenance/preview` 和只读页面。`execution.supported=false`；预览不会预留端口、生成密钥或修改部署，结果 60 秒过期。它不是生产维护工具，也不放开已部署端点修改或有引用密钥轮换；后续执行器须另行验收发布，不能据预览手工改库、清租约或重启 carrier。

F1 Agent 只有探测到实际程序的统计分段能力才传递新协议参数并上报 `forward.traffic.rotation.v1`；旧 FXP 沿用有界 v1 模式。可在 Agent 服务环境设置 `TUNEX_FXP_TRAFFIC_EPOCH_SECONDS`（30–86400，默认 86400），较短段龄会增加数据库身份行及离线段数。产生 v2 manifest 后旧 Agent 会拒绝读取，回退必须排空或保留统计、核对兼容性，不能删除水位/私有文件绕过错误。

F2 多目标绑定要求两端实际报告 `forward.targets.fxp.v1`；Agent 探测对应 runner 并显式启用参数，旧程序不能恢复多目标配置。升级后先用有限规则验证完整目标集、辅助 TCP 探测、主备切换及 B 长连接。回退到单目标需提交只有一项的完整目标集修订，并保留兼容 runner；不能降级程序后忽略配置字段、直接删 JSON 列或清缓存。目标集变更会关闭受影响规则的旧会话，选择/探测边界见运行说明。

F3 来源绑定额外要求双方实际 `forward.client-source.fxp.v1`；先升级数据库/Panel/Worker，再升级 Agent/FXP。首版仅共享 TCP，受信 CIDR 应限实际代理；先在支持 PROXY 的测试目标核对 v1/v2、来源和限额，再启用业务规则。回退先创建显式关闭接收/发送的修订（IP_HASH 改为已有策略），仍保留来源配置及兼容 runner；旧程序不得忽略字段继续传输。不能直接删除来源列/缓存或把双向节点地址当客户端。

F4 原生 both 仍默认 `FORWARD_NATIVE_BOTH_ENABLED=false`。先执行 legacy 协议投影可空的数据库迁移、更新 Panel/Worker，再升级参与节点，确认新鲜 `forward.protocol.both.native.v1`，候选自身门禁通过后才在有限 Workspace opt-in。首版限定 plain DIRECT/自有单跳 RELAY，禁止中间/联邦/来源/TLS/WS 组合；不是新增加密载体。关闭开关只禁止新建/切入 both，已存在配置仍须兼容恢复。回滚旧二进制前须通过正常修订迁移或完整停止两协议并确认端口回收，不能让旧程序把 null legacy 类型猜成 TCP；不可回滚持久 epoch 或删除缓存规避失败。

`FORWARD_BATCH_DELETE_ENABLED` 也是独立默认关闭功能，开启前完成原生/远端适用范围的真实清理验收。支付开关与上述转发能力无关，当前不作为核心发布前置；不能因 FXP 验收通过就开启未审查的支付流程。

## 备份、回退与节点状态

ops 脚本默认指向开发 Compose；生产调用必须显式设置目标。以下从实际部署目录执行：

```bash
export COMPOSE_FILE="$PWD/docker-compose.prod.yaml"
export COMPOSE_PROJECT_NAME=tunex
export COMPOSE_ENV_FILE="$PWD/.env"
export TUNEX_ENV_FILE="$PWD/.env"
bash scripts/ops/backup.sh
bash scripts/ops/rollback.sh --list
bash scripts/ops/rollback.sh --verify previous
```

backup 默认交互获取加密口令；自动任务通过受保护的配置提供 BACKUP_PASSPHRASE，避免在命令行/日志暴露。保留 manifest、校验和和异地副本，并在独立环境实际恢复。

版本回退使用 `rollback.sh --to previous`，实际目标、确认和备份条件由脚本检查；只退镜像不撤销数据库迁移。数据恢复 `restore.sh <backup-id-or-path>` 会覆盖数据库，按已审查的恢复点及维护窗口操作。standalone 部署还需保留相应 overlay 与 Caddy 持久卷。

Panel 备份不能自动备份各 Agent 的 machine.key、加密缓存/墓碑和 traffic spool。节点升级与灾难恢复必须单独保留这些文件的对应身份，不能把另一节点缓存复制过来。保留 LinkTrafficCheckpoint 与日事实；禁止清水位或删未确认 spool，以免重复入账或遗失用量。

原生 Agent LKG 是既有失联/重启恢复缓存，不是可按性能收益随意删除的临时文件。本轮保持其恢复行为，Windows 并发文件读取问题及性能优化均暂停，边界见 [平台问题记录](testing.md#windows-deferred)。

跨版本回退前核对 runner/config/cache/traffic 协议兼容性；不兼容时先受控停止再按恢复方案处理。升级后继续核对真实 payload、统计重投不重复、旧 owner 租约失效及删除清理，保留对应版本的脱敏证据。
