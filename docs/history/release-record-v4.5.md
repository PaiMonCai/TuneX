# TuneX V4.5 发布记录（发布窗口演练）

本文件记录 **V4.5 发布窗口**实际执行的动作与证据。它是 `docs/release-notes-v4.md` 的
配套：发布说明写「这次发布包含什么、边界在哪」，本文件写「这次发布是怎么被验证并放行
的」。两者都只记录**实际跑过**的事。

## 发布身份

```text
发布名            TuneX V4.5（V4 稳定化：WP10 权限模型 + WP11 耐久性/运维/诊断）
发布窗口基线      14305c8  （分支 feat/v4-wp10-wp11-closure）
最终收口提交      dd95713  （CI/Gate 可移植性修复后重新全链验证）
上一提交          0f1acb7  （chore/project-pause-cleanup 的合并点）
演练镜像（14305c8，本地构建）
  Panel/Worker    ghcr.io/paimoncai/tunex:14305c8          image id c0d99e9379ad
  Agent           ghcr.io/paimoncai/tunex-agent:14305c8    image id cd4d3da7c2eb
最终自动发布镜像（dd95713，Release #30 已推送）
  Panel/Worker    ghcr.io/paimoncai/tunex:dd957131204ee6a7c34c5b3aa101cc64cd28b23f
                  digest sha256:384c90ce03d8a44e06f0204074737059e2f7f25be732b4fcd4c7767365e3bcb0
  Agent           ghcr.io/paimoncai/tunex-agent:dd957131204ee6a7c34c5b3aa101cc64cd28b23f
                  digest sha256:89d8ff23131a7448dcd1dd869d487dedeabb9a1b25118e67d8b7f08d2a28b3ea

  （演练与最终 tag 是同一批字节：在 14305c8 上重建后 image id 与演练时完全一致。）
Schema            prisma migrate status → 22 migrations found / Database schema is up to date!
```

镜像按仓库既有约定以 **git sha 为 tag**（见 `docs/production-deploy.md`），没有另造
语义化 tag。构建命令与文档一致：

```bash
docker build -t ghcr.io/paimoncai/tunex:$SHA ./backend
docker build -t ghcr.io/paimoncai/tunex-agent:$SHA -f agent/Dockerfile .
```

> **自动发布已完成**：最终 `dd95713` 在 CI #493 / Integration #139 全绿后触发 Release #30，
> 使用仓库 `GITHUB_TOKEN` 成功把 Panel/Worker 与 multi-arch Agent 的 `latest` + 完整 SHA 标签
> 推到 GHCR。若部署要求节点**匿名**拉取 Agent，package visibility 仍需按
> `docs/production-deploy.md` 单独配置；这不是 CI 能证明的属性。

## 演练结果（真实四节点拓扑）

### 1. Panel 升级到发布镜像

`docker compose up -d --force-recreate panel worker`（`TUNEX_IMAGE` 指向 `:14305c8`）：

```text
/readyz                        200
prisma migrate status          22 migrations found / Database schema is up to date!
/api/nodes/:id/diagnostics     200  reachability=online，agent_facts 存在
/api/nodes/:id/support-bundle  200  schema_version=1，agent_facts 存在
/api/nodes/:id/upgrade-command 409  code=node_not_in_maintenance（节点未在维护态，规则生效）
   + allow_active=true         200  98 行脚本；先 pull 后 stop；不含凭据字面量；四项不变量均为 true
```

### 2. 回滚演练（双向，走 `scripts/ops/rollback.sh`）

| 方向 | 结果 |
|---|---|
| `:14305c8` → 上一镜像 | 成功：healthz=200 / readyz=200、应用服务全部 running、写入 deploy-history |
| 上一镜像 → `:14305c8` | 成功：同上，且**迁移兼容性检查通过**（22 migrations / schema up to date） |

回滚脚本的语义边界也已确认：它只回退**面板镜像**；Agent 镜像由节点侧安装命令固定，
需要回退时在节点上重跑一次带目标镜像的安装命令（脚本自身会在输出里提示这一点）。

失败的路径也真实出现过并观察到了正确行为：一次演练中 compose 切换失败，脚本**自动
回退 env 并重启**，然后以非零退出码结束并提示可执行 `restore.sh` —— 不是静默半成品。

### 3. Agent 升级演练（发布镜像 + 安装布局）

在 `WP14-OUT-B-NODE`（无活跃转发的备用节点）上，按**安装脚本产出的布局**运行发布镜像：
env 文件挂到 `/run/tunex-agent/agent.env`、状态目录挂到 `/var/lib/tunex-agent`。

```text
启动            v3 restore done role=EGRESS source=panel；control 与 heartbeat 已排程
身份            node 行未变：node_id=WP14-OUT-B-NODE，agent_id=e360c58a-0893-456a-b5a1-8dfaf85827ab
上报            版本 0.13.22，12 秒前；capabilities = apply/remove/suspend + diagnose_tunnel + collect_diagnostics
恢复            演练后容器重建回 compose 管理（wp14-agent:ci），节点继续正常上报
```

即：**换镜像不换身份**——没有重新 enrollment，也没有产生新的 agent_id。

## 发布窗口查出的缺陷（已修复并补测）

发布演练的价值在这里：下面三项都不是静态检查能发现的。

```text
1. 整数型环境变量被静默忽略（agent/internal/agentconfig，真实缺陷）
   envInt 的判据写反：`if err != nil { *dst = n }`。
   · 合法值一律不生效 —— 安装脚本写 TUNEX_AGENT_ADMIN_PORT=0，Agent 却继续用默认
     9090，于是每次以 env 文件启动都会打出「AGENT_ADMIN_TOKEN is required…」；
   · 写错的值静默变成 0 —— 一个拼错的管理端口会让管理面悄悄关掉。
   env 文件是文档化的安装路径，两个方向都不能接受。现在解析成功才赋值、非法值让
   Parse 报错，并覆盖「0 / 非 0 / 非法 / 未设置 / 命令行覆盖」五种情形。

2. rollback.sh 把三处「部署属性」写死，导致任何非默认栈都无法演练
   应用服务名固定 backend worker web（e2e 栈叫 panel，会被静默跳过）；环境文件固定
   $PROJECT_ROOT/.env（演练必须写进代码库）；迁移兼容性检查固定 exec backend，在别的
   命名下**静默降级为警告**——而那正是回滚的安全闸门。现在分别由 TUNEX_APP_SERVICES /
   TUNEX_ENV_FILE / TUNEX_MIGRATE_SERVICE 覆盖。
   另修两处：回滚目标只接受带 registry 前缀或 digest 的引用（本地 name:tag 无法作为
   目标，而演练与隔离部署都需要它）；以及 ENCRYPT=0 时仍强制要求备份口令，使未加密
   部署永远无法回滚。

3. e2e 栈与生产变量不一致（测试基建）
   e2e 的 compose 只认 TUNEX_BACKEND_IMAGE，而运维脚本编辑的是生产变量 TUNEX_IMAGE，
   于是回滚演练根本切换不到镜像。现在两者都接受，演练才能真的切换并验证。
```

另外确认了两个「不是缺陷」的行为，避免以后误判：升级命令对非维护态节点返回 409 是
**设计规则**（可用 `allow_active=true` 显式覆盖）；`node_facts` 那一段永远标注
`verified=false` 也是设计（探测它会打到出口节点的业务监听端口，产生真实业务连接）。

## 放行结论

```text
V4-F4 authorization       PASS=58  / FAIL=0
V4-F5 durability/ops      PASS=133 / FAIL=0   （含 F5.13 真实备份/恢复演练）
v4-gate 30/0 · REST 67/0 · S10 58/0 · topology 32/0 · verify 51/0 · F2 37/0 · F3 21/0
backend 1329/0 + tsc · agent go vet + go test -race 全部包 · web 350/0 + tsc + build
```

发布身份下的 F5 结果见 `scripts/v3-e2e/evidence/v4-gate-f5-result.txt`。

最终自动化复验（`dd95713`）：
```text
CI #493           success
Integration #139  success
Release #30       success
F5.13             backup / manifest / canary / restore / row counts / migrations / panel / agents 全部 PASS
```

**结论：V4.5 的代码、Gate、文档、发布演练与镜像推送均已完成，V4 技术范围正式关闭。**
若未来要做对外开源/再分发，仓库自身 `LICENSE` / `NOTICE` / third-party attribution
仍需单独定稿；若节点需要匿名拉取 Agent，则还需确认 GHCR package visibility。

## 回滚指引（发布后如需回退）

```bash
# 面板：切回上一个已知良好镜像（脚本自己会先备份、健康检查、失败自动回退）
scripts/ops/rollback.sh --list
scripts/ops/rollback.sh --to <上一个 sha 或 previous> --yes

# 数据：从备份恢复（详见 release-notes-v4.md 的演练章节）
scripts/ops/restore.sh <backup-id> --yes

# Agent：在节点上重跑安装命令并指定旧镜像
#   Node → 一键安装（把 --agent-image 换成旧 sha）
```

回滚前后的健康判据：`/readyz` 必须 200（进程活着但 MySQL/Redis 不可用不算成功），
并由 `prisma migrate status` 确认镜像与 schema 兼容。
