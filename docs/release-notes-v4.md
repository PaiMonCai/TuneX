# TuneX V4.5 发布说明（WP10 / WP11 收口）

> **状态：V4.5 Stable 已完成技术发布闭环。** 发布窗口基线为 `14305c8`；最终收口提交
> `dd95713` 已通过 CI #493 → Integration #139 → Release #30，并完成 GHCR 镜像推送。
> 发布窗口的实际动作与最终证据见 [V4.5 发布记录](release-record-v4.5.md)。

适用范围：V4 稳定化（Node-first + Forward 产品对象、权限模型、Agent 耐久性/运维/诊断）。
本文只记录**已由真实 Gate 验证**的能力与**明确的已知边界**；未验证的事不写在这里。

## 已验证的 Gate 结果（真实四节点拓扑）

```text
v3 baseline verify        PASS=51  / FAIL=0
V4-F1 rollout             PASS=30  / FAIL=0
V4-F1 rollout REST        PASS=67  / FAIL=0 / DEFECT=0
V4-F1 S10 中断/恢复        PASS=58  / FAIL=0 / LIMITED=0 / DEFECT=0
V4-F1 topology            PASS=32  / FAIL=0
V4-F2 managed node        PASS=37  / FAIL=0
V4-F3 product closure     PASS=21  / FAIL=0
V4-F4 authorization       PASS=58  / FAIL=0
V4-F5 durability/ops      PASS=133 / FAIL=0
```

证据文件：`scripts/v3-e2e/evidence/`（Gate 运行时写出，含逐条断言与失败详情）。
F5 含一次**真实的备份→改数据→恢复→校验**演练（F5.13），不是只检查脚本内容。
单元/类型检查：backend（bun test + tsc）、agent（go vet + go test -race）、web（bun test + tsc + build）。

### 最终 GitHub Actions 发布闭环（2026-10-03）

```text
CI #493           success
Integration #139  success
Release #30       success

F5.13              backup → canary mutate → restore → verify 全部 PASS
Panel image        ghcr.io/paimoncai/tunex:dd957131204ee6a7c34c5b3aa101cc64cd28b23f
Panel digest       sha256:384c90ce03d8a44e06f0204074737059e2f7f25be732b4fcd4c7767365e3bcb0
Agent image        ghcr.io/paimoncai/tunex-agent:dd957131204ee6a7c34c5b3aa101cc64cd28b23f
Agent digest       sha256:89d8ff23131a7448dcd1dd869d487dedeabb9a1b25118e67d8b7f08d2a28b3ea
```

Release 同时更新两个镜像的 `latest` 标签。V4 功能范围自此冻结；新的协议、HA、multi-hop
与 federation 等能力进入 V5。仓库自身 LICENSE / NOTICE / third-party attribution 尚未
定稿，因此这里的 “Stable” 是技术发布状态，不代表对外开源或再分发授权。

## 新增用户可见能力

### 权限模型（V4-WP10）

- 规范权限键 `forward:*`；旧 `tunnel:*` 按键兼容读取；显式 `false` 优先。
- 自定义角色**替换**基础角色；owner 是固定 break-glass 身份。
- 拒绝响应带 `error_layer`（authentication / rbac / resource_scope / capability / quota /
  runtime_admission），越界 ID 返回 404、权限拒绝 403。
- 工作空间设置页可管理角色与成员角色绑定（会话态，仅登录用户）。

### Agent 耐久性与关机（V4-WP11A）

- **本地已知良好状态（LKG）**：原子写入、0600、绑定 agent_id、不存凭据；面板不可达时
  可从缓存恢复监听；面板恢复后以面板为准并**剪除**缓存里多出的转发。
- "最后一个转发被删除/暂停"会写入**空墓碑**，因此面板停机重启不会复活它。
- 优雅关机：先关监听（新连接立刻被拒）→ 有界排空 → 最终上报；全程一个绝对 deadline，
  超期强制关闭连接对的**两端**。

### 控制协议能力协商（V4-WP11B）

- Agent 上报 `control_protocol_version` 与 `capabilities`（只列**真实实现**的动作）。
- 面板只下发已广告的动作；未上报/未实现 → 结构化 `upgrade_required`，不靠"未知命令失败"猜。
- 重装或凭据轮换会让旧上报失效（那个进程已经不在了）。

### Agent 升级闭环（V4-WP11B）

`POST /api/nodes/:id/upgrade-command` 生成一段**在节点主机上执行**的升级脚本：

1. 记录当前镜像作为回退锚点；
2. **先拉取**新镜像（拉不动就原样离开，节点继续跑旧版本）；
3. SIGTERM + 容器 stop-timeout 优雅排空；
4. 复用宿主机 `/etc/tunex-agent/agent.env` 与 `/var/lib/tunex-agent` 重建 → **身份不变**
   （node_id / agent_id / Forward 关系保持，无需重新 enrollment）；
5. 校验新进程仍以同一身份通过认证，失败自动回退到旧镜像。

控制面**不会**远程替换节点上的 Agent（Agent 无 Docker 权限，面板不主动连节点）。

### 诊断（V4-WP11C）

- **Forward 诊断**：`POST /api/forwards/:id/diagnose`。探针目标由服务端从该转发的
  已授权期望状态推导（请求体不携带 host/port）。
  - DIRECT：直探「入口节点 → 目标」；
  - RELAY：「入口↔出口」一段**不做 TCP 探测**——那段指向出口节点的业务监听端口，
    拨它会真的产生业务连接；改为核对两端上报的运行态事实并标注 `verified: false`；
    「出口→目标」一段仍直探。
- **Node 诊断**：`GET /api/nodes/:id/diagnostics`。只读动作 `collect_diagnostics`，
  Agent 按白名单自述版本/进程/运行中 runtime/LKG 状态；面板**先判活**（上报过期即
  `offline`，不下发命令、不等超时）。
- 结论区分 `reachable / refused / timeout / dns_error / unsupported / unknown`，
  并给出可执行 `next_step`；结果必须**完整覆盖**请求目标，否则拒绝采信。

### Support Bundle（V4-WP11C）

`GET /api/nodes/:id/support-bundle`：白名单逐字段投影 + 确定性脱敏（键名/形状/已知密值），
按调用者权限裁剪 forward/audit 段落，条数与字节上限并显式 `truncated`。
离线节点照常生成产物并说明缺失原因。

### 前端入口（V4-WP12 收口）

- Forward 详情页内嵌诊断面板；Node 页面内嵌诊断 / 支持包下载 / 升级命令生成。
- 界面显式标注"未验证连通性"的段、"离线（未下发自检命令）"、以及"控制面不会远程替换
  Agent"。

## 已知边界（明确不在当前白名单内）

- Support Bundle **不含**容器内 service 状态与系统路由表（需要额外探针）；
- 诊断的 RELAY「入口↔出口」一段**永远不做连通性验证**（设计选择，不是缺陷）；
- 不支持跨进程 socket handoff：排空是有界窗口，不是零中断；
- UDP 等无法可靠验证的协议不伪装成"已确认可达"。

## 真实备份/恢复演练（F5.13）与它查出的缺陷

演练流程：在真实栈上备份 → 插入一条备份之后才存在的 canary → 恢复 → 断言 canary 消失、
行数与迁移表与备份时刻一致、面板与 Agent 重新可用。脚本内容检查**查不出**下列问题，
只有真跑一遍才会暴露（已全部修复，并有静态回归守卫）：

```text
1. 备份与恢复用了不同的口令变量名（BACKUP_PASSPHRASE vs TUNEX_BACKUP_PASSPHRASE）
   —— 同一次恢复可能因为「口令明明对」而失败。现在两个名字都接受，优先级明确。
2. 恢复不读 manifest 的 encrypted:false，对 --no-encrypt 备份仍强制解密
   —— 工具自己产出的备份却恢复不了。现在按产物属性决定是否需要口令。
3. 非交互调用（cron/CI/演练）且未提供口令时，脚本在 read 提示符处被 set -e 静默杀死。
   现在：未加密备份不索要口令；需要口令却没给时给出明确错误（exit 2）。
4. 自检 SQL 没选库（dump 自带 CREATE DATABASE，导致 SELECT 无默认 schema 失败）：
   报告里 "workspace 行数 ?"、"_prisma_migrations 0 行 —— dump 可能来自未迁移库"，
   这是一次**假警报**（真实 dump 完整）；而且 "0\n0" 触发 [[: syntax error。
5. docker inspect --format 模板括号不配对（Go 模板 unexpected EOF）
   —— Redis 的 /data 卷**永远解析不出来**，恢复在第 3/4 步必然失败。
6. Redis 就绪轮询把 "LOADING Redis is loading the dataset in memory" 当数字比较
   —— 在恢复**已经成功之后**因 set -u 崩溃，运维看到的是「恢复失败」。
```

演练本身也踩过一次坑并已修正：最初它直接对共享库 `tunex` 做恢复，把其它 Gate 之前
创建的数据回滚掉，导致**后续 F4 因为"拒绝请求却改变了 rollout 历史"而失败**——错的
不是 F4。现在演练在一份**克隆的临时库**上跑（真实 schema、真实数据量），结束即删除，
共享库不再被回滚。

另外两处可用性修复：写入方服务名可配置（`WRITER_SERVICES`，否则换了服务名的栈只会
被停不会被启），以及容器内运行时通过辅助容器**流式**写入卷（`-v <容器内路径>` 会被
docker 解析到宿主上，静默写出一个空卷）。

## 兼容与回滚

- 兼容端点保留：旧 `tunnel:*` 权限键、`/api/tunnels/*` 路由、`forward_id` → `tunnel_id`
  字段兼容；**不删除**旧 API。
- 备份/恢复：`scripts/ops/backup.sh` / `restore.sh` 已在真实栈上完成端到端演练（F5.13）；
  两者都接受 `BACKUP_PASSPHRASE` / `TUNEX_BACKUP_PASSPHRASE`；`COMPOSE_PROJECT_NAME` /
  `COMPOSE_ENV_FILE` / `WRITER_SERVICES` 可覆盖，因此可在非默认栈上演练。
- 回滚：`scripts/ops/rollback.sh` 以 `/readyz` 为闸门，解析各栈健康端口并检查
  `prisma migrate status`；`scripts/ops/backup.sh` / `restore.sh` 已修（不双压缩、
  BGSAVE 超时 fail-closed、凭据走 `env:` 不进 argv、restore 有 EXIT trap 恢复写入方）。
- Schema：V4 迁移全部为**加列**（`node_state_report.control_protocol_version` /
  `capabilities` 等），旧面板回滚前应恢复角色权限备份（旧面板不认识 `forward` 键）。
