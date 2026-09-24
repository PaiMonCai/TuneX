# TuneX 生产部署运维手册（OPS-02）

> 对象：单机 Docker Compose 生产栈（`docker-compose.prod.yaml`）。
> 覆盖：首次部署、升级、监控告警、备份、恢复、回滚、容量基线与演练清单。
> 相关文件：`docker-compose.prod.yaml`、`Caddyfile.prod`、`.env.production.example`、
> `scripts/ops/{alert,backup,restore,rollback,capacity}.sh`。

---

## 1. 与开发栈的边界（先读这条）

| 维度 | 开发 `docker-compose.yaml` | 生产 `docker-compose.prod.yaml` |
|---|---|---|
| MySQL/Redis 端口 | 映射主机（3307/6380） | **不映射**，仅 compose 内网 |
| backend/web | 映射主机（8787/8788/9091/9445） | **不映射**，只走 Caddy |
| 对外入口 | Caddy `:80` 纯 HTTP | Caddy `80/443` + ACME 自动 TLS |
| 镜像来源 | 本地 `build:` | CI 预构建 GHCR，sha 钉版本 |
| 数据卷 | `tunex-mysql-data` 等 | `tunex-mysql-data-prod` 等 |
| WebSocket | 无（仅 HTTP 反代） | `/socket.io/* → backend:3001` |
| 资源限额 | 无 | 每容器 CPU/内存上限 + 日志轮转 |

两套栈 compose **项目名都是 `tunex`**（prod 文件顶层 `name: tunex`），不能同时
`up`：`docker compose -p tunex` 是 `scripts/ops/*.sh` 的固定视角，端口/容器名
（`tunex-mysql`、`tunex-backend`…）会互相抢占。同机共存请把其中一套改名或分机部署。

**所有 ops 脚本默认读 `docker-compose.yaml`**。对生产栈执行时必须显式给
`COMPOSE_FILE`：

```bash
export COMPOSE_FILE=/opt/TuneX/docker-compose.prod.yaml   # 建议写进部署用户的 ~/.bashrc 或 cron 头部
scripts/ops/alert.sh
```

---

## 2. 首次部署

### 2.1 前置

- Docker Engine ≥ 24 + Compose v2（脚本强依赖 `docker compose` v2 子命令）。
- 公网域名 A/AAAA 记录指向本机，且 **80 与 443 可 inbound**（ACME HTTP-01 与 TLS）。
- 主机磁盘预留：备份默认保留 14 份（见 `RETENTION_DAYS`），库 + 备份合计预留 ≥ 50GB。

### 2.2 生成密钥与 .env

```bash
cd /opt/TuneX
cp .env.production.example .env
chmod 600 .env

# 每套部署独立生成（示例输出为随机值，直接粘贴到 .env）
openssl rand -base64 32 | tr '+/' '-_'   # → AUTH_SECRET
openssl rand -base64 32 | tr '+/' '-_'   # → LICENSE_SECRET
openssl rand -base64 32 | tr '+/' '-_'   # → TUNEX_CONFIG_KEY
openssl rand -base64 32 | tr '+/' '-_'   # → TUNEX_LICENSE_KEY
```

必改项（有默认占位值的都不算改完）：

| 变量 | 说明 |
|---|---|
| `SITE_URL` | 对外唯一地址，如 `https://tunex.example.com`；`Caddyfile.prod` 直接作为站点地址 |
| `ACME_EMAIL` | ACME 账号邮箱，证书到期通知送达这里 |
| `MYSQL_ROOT_PASSWORD` | 必须同时改 `DATABASE_URL` 里的口令（两边一致） |
| `AUTH_SECRET` / `LICENSE_SECRET` | ≥32 随机字节，禁止跨环境复用 |
| `TUNEX_CONFIG_KEY` / `TUNEX_LICENSE_KEY` | 32 字节 base64url Fernet 密钥，两把必须不同 |
| `TUNEX_BACKEND_IMAGE` / `TUNEX_WEB_IMAGE` | 钉到具体 git sha（见下） |
| `SMTP_*` | 公网服务必须配，否则验证/重置邮件只进日志 |
| `BACKUP_PASSPHRASE` | cron 回滚前备份必需，否则备份脚本交互读取失败并终止回滚 |

`ALLOW_REGISTER_FALLBACK=false`（邀请制 Beta）+ `PAYMENTS_ENABLED=false` 是
PLAN.md 的既定默认，**不要**在生产环境打开以"图方便"。

### 2.3 选定镜像版本

CI 每个 push 到 `main` / `feature/**` 都会推送：

```text
ghcr.io/paimoncai/tunex-backend:<git-sha>   ghcr.io/paimoncai/tunex-backend:latest
ghcr.io/paimoncai/tunex-web:<git-sha>       ghcr.io/paimoncai/tunex-web:latest
```

生产钉 sha，不钉 `latest`——回滚的前提是能明确指回某个版本：

```bash
SHA=$(git rev-parse HEAD)
sed -i "s#^TUNEX_BACKEND_IMAGE=.*#TUNEX_BACKEND_IMAGE=ghcr.io/paimoncai/tunex-backend:$SHA#" .env
sed -i "s#^TUNEX_WEB_IMAGE=.*#TUNEX_WEB_IMAGE=ghcr.io/paimoncai/tunex-web:$SHA#" .env
```

GHCR 包若为 private 需先 `docker login ghcr.io`。

### 2.4 启动

```bash
export COMPOSE_FILE=$PWD/docker-compose.prod.yaml
docker compose -f "$COMPOSE_FILE" pull          # 预拉镜像，避免 up 中途卡下载
docker compose -f "$COMPOSE_FILE" up -d
```

启动顺序由 compose 保证：`mysql` healthy → `db-migrate` 跑
`prisma migrate deploy && seed`（**退出码 0 才算成功**）→ `backend/worker` 拉起 →
`caddy` 最后接管 80/443。

首启管理员凭据落在**项目根** `.admin-credentials`（`db-migrate` 把
`ADMIN_CREDENTIALS_PATH=/host/.admin-credentials` 挂到仓库根）：

```bash
sudo cat /opt/TuneX/.admin-credentials     # 改完密码后请删除此文件
```

### 2.5 验收（首次部署的"上线门槛"）

```bash
# 1) 容器与健康
docker compose -f "$COMPOSE_FILE" ps        # 全部 running；backend healthcheck 通过

# 2) 入口与 TLS
curl -fsS https://$DOMAIN/healthz           # 期望 {"status":"ok",...}
curl -fsSI https://$DOMAIN/                # HTTP/2 + 安全响应头

# 3) 数据面确实内网隔离
nc -vz <公网IP> 3306                        # 期望 connection refused / 超时
nc -vz <公网IP> 6379                        # 同上
docker port tunex-backend                   # 期望无输出（无主机端口映射）

# 4) 一键巡检
scripts/ops/alert.sh                        # 期望退出码 0、全部 ok
scripts/ops/capacity.sh                     # 建立容量基线第一份采样
```

**任一不通即不得对外宣布可用**——尤其是第 3 项（这是生产栈最容易被误配成
开发默认值的地方）。

---

## 3. 日常升级

```bash
cd /opt/TuneX
git fetch origin && git checkout <target-commit>

export COMPOSE_FILE=$PWD/docker-compose.prod.yaml
SHA=$(git rev-parse HEAD)
sed -i "s#^TUNEX_BACKEND_IMAGE=.*#TUNEX_BACKEND_IMAGE=ghcr.io/paimoncai/tunex-backend:$SHA#" .env
sed -i "s#^TUNEX_WEB_IMAGE=.*#TUNEX_WEB_IMAGE=ghcr.io/paimoncai/tunex-web:$SHA#" .env

docker compose -f "$COMPOSE_FILE" pull
docker compose -f "$COMPOSE_FILE" up -d backend worker web caddy
# mysql/redis 不会被 up -d 重建（image/配置未变），数据安全
scripts/ops/alert.sh
```

`db-migrate` 的 `restart: "no"` + `service_completed_successfully` 依赖意味着
**每次 `up -d` 都会重跑 `migrate deploy`（幂等）+ seed（upsert，不重置已存在
账号）**。提示：seed 不覆盖已存在的用户，也不会重置管理员口令。

---

## 4. 监控与告警

```bash
# crontab -e（部署用户）
*/5 * * * * cd /opt/TuneX && COMPOSE_FILE=/opt/TuneX/docker-compose.prod.yaml scripts/ops/alert.sh >> var/alerts/cron.log 2>&1
30 3 * * *  cd /opt/TuneX && COMPOSE_FILE=/opt/TuneX/docker-compose.prod.yaml scripts/ops/capacity.sh >> var/ops/cron.log 2>&1
```

`alert.sh` 检查项（默认阈值，均可环境变量覆盖）：

| 检查 | 默认阈值 | 级别 |
|---|---|---|
| DISK | 根分区 ≥85% | warning |
| DISK | 根分区 ≥92% | critical |
| MEM / SWAP | 可用 <10% / swap >50% | warning |
| MYSQL_CONN | 连接使用 ≥70% / ≥90% | warning / critical |
| MYSQL_QPS | ≥500 q/s | warning |
| MYSQL_BUFFER | 命中率 <95% | warning |
| MYSQL_SIZE | 库 >50GB | warning |
| REDIS_MEM | ≥85% maxmemory | warning |
| REDIS_KEYS | ≥10 万 | warning |
| REDIS_EVICT | 逐出 >0 | critical |
| CONTAINER | compose 服务未全 running | critical |
| CERT | 证书 <14 天 / <7 天 | warning / critical |
| BACKUP | 最新备份 >26h | warning |

通知渠道优先级：`ALERT_WEBHOOK`（钉钉/企微/Slack）→ 宝塔通知通道（检测到 bt
panel 时）→ 本地 `var/alerts/alerts.log`（始终写，作为审计轨迹）。去重窗口
`ALERT_DEDUPE_SECONDS` 默认 3600s，`critical` 不受去重限制。

只看指标不发告警：`scripts/ops/alert.sh --status`。

---

## 5. 备份

```bash
# crontab -e
15 2 * * * cd /opt/TuneX && COMPOSE_FILE=/opt/TuneX/docker-compose.prod.yaml \
  BACKUP_PASSPHRASE='<口令>' scripts/ops/backup.sh >> var/backups/cron.log 2>&1
```

内容三件套（缺一即失败，不会产出"看起来完整"的半成品）：

1. MySQL 全库 `mysqldump --single-transaction`（不锁表；含 `_prisma_migrations`），
   并强制校验 `workspace/user/tunnel/capability_policy/_prisma_migrations` 五张表的
   DDL 都在 dump 里；
2. Redis BGSAVE RDB 快照（生产栈不开 AOF，见下方"Redis 持久化口径"警示）；
3. 配置清单 tar（`.env` / `Caddyfile.prod` / compose 文件 / 备份脚本 / VERSION
   指纹：git commit + 镜像 digest + 行数）。

> **Redis 持久化口径（重要）**：生产与开发栈都**不开 AOF**
> （`command: ["redis-server"]`）。原因是 Redis 7 一旦启用 `appendonly`，数据从
> 卷内 `appendonlydir/*.aof` 加载，**直接替换 `dump.rdb` 会被完全忽略**——恢复
> 脚本会显示"成功"而 key 一个都没变（假恢复，已实测复现）。AOF 换来的收益只是
> 最多 1s 的写入保护，而 Redis 里全部是 TTL 会话/限流/缓存（可重建），持久真相在
> MySQL。若日后有人把 AOF 打开，`restore.sh` 会检测到 `appendonlydir` 并**拒绝**
> 假恢复，提示改用 `FLUSHALL + AOF 重建` 或临时 `--appendonly no` 启动后再恢复。

产物落 `var/backups/<UTC日期>/tunex-<stamp>.*`，全部 **AES-256-CBC + PBKDF2
200k** 加密（`--no-encrypt` 仅限本地测试），附 SHA256 校验与 `manifest.json`，
本地保留 `RETENTION_DAYS` 天。

> **异地备份**：脚本只负责本地落盘。生产请自行加一层 rsync/rclone 到对象存储
> 或另一台机，本地+异地双份才算"备份"（PLAN.md 第 7 节发布门槛明确要求）。

```bash
find var/backups -name '*.manifest.json' | wc -l      # 应有按天数递增的份数
```

---

## 6. 恢复

```bash
# 先看清有什么可恢复（不改任何数据）
scripts/ops/restore.sh --dry-run tunex-20260925T020000Z

# 真实恢复：会 DROP 重建数据库 + FLUSHALL + 载入 RDB，必须输入 RESTORE 确认
COMPOSE_FILE=$PWD/docker-compose.prod.yaml BACKUP_PASSPHRASE='<口令>' \
  scripts/ops/restore.sh tunex-20260925T020000Z --yes
```

支持三种 `backup-id`：完整 `tunex-<stamp>`、`manifest.json` 路径、裸日期目录
（取当日最新）。每个文件单独做 SHA256 校验，解密后再校验 gzip 魔术头
——**口令错误在这一层被拦住**（CBC 无认证标签，只靠 openssl 退出码会漏）。

恢复后自检清单：

```bash
scripts/ops/alert.sh                                        # 全 ok
curl -fsS https://$DOMAIN/healthz
# 登录后台抽 1 个 workspace 核对 tunnel 数据与主备份一致
# config 目录只解包到临时目录，.env/Caddyfile 需人工 diff 后才覆盖（见脚本日志）
```

---

## 7. 回滚

```bash
# 列出可回滚目标（部署历史 + 本地镜像）
scripts/ops/rollback.sh --list

# 预演：只校验目标镜像可拉取/存在，不做任何变更
COMPOSE_FILE=$PWD/docker-compose.prod.yaml BACKUP_PASSPHRASE='<口令>' \
  scripts/ops/rollback.sh --verify ghcr.io/paimoncai/tunex-backend:<sha> 

# 执行：先备份现状 → 切镜像 → 健康检查 → 失败自动回退
COMPOSE_FILE=$PWD/docker-compose.prod.yaml BACKUP_PASSPHRASE='<口令>' \
  scripts/ops/rollback.sh --to ghcr.io/paimoncai/tunex-backend:<sha> --yes
```

语义要点：

- **版本回滚只动 `backend/worker/web/caddy`**，`mysql/redis` 数据不动；
- 回滚前**强制先备份**（失败即拒绝回滚，不留无保护窗口）。确认已另有备份时
  才允许 `--no-backup`；
- 健康检查窗口内 `/healthz` 非 200 或三服务未 running → 自动恢复到切换前 env；
- 需要连数据一起退回去，加 `--data`（会调 `restore.sh`，二次确认）；
- `previous` 关键字自动取部署历史里上一个成功版本：`--to previous`；
- 留痕：`var/ops/deploy-history.jsonl`、`var/ops/rollback-up.log`、
  `var/ops/.env.before-rollback`。

**PLAN.md 的灰度要求**：先内部/邀请制 Beta，按 workspace 控制新功能开关；
发布保留上一版本镜像与数据库备份；出问题先回退服务再做有状态迁移，不自动删
用户数据。`--to` 的目标镜像因此**至少要预留一个已知良好 sha**，可用
`ROLLBACK_KNOWN_GOOD_IMAGE` 固化。

---

## 8. 容量基线

```bash
scripts/ops/capacity.sh            # 采集 → var/ops/capacity.json（+ history.jsonl）
scripts/ops/capacity.sh --baseline # 与历史对比
```

采集 MySQL 库体积/行数/每 workspace 摊算、Redis key 与内存、容器 CPU/内存实测、
增长斜率（30/90 天外推）与扩容触发线。默认阈值口径：**2000 workspace /
20000 tunnel / MySQL 20GB / Redis 50 万 key**（4C8G 容器主机）。超过 70% 即
"⚠️ 接近阈值，启动扩容评估"。建议每日 cron 采样，两周后才有可靠斜率。

---

## 9. 排障速查

| 现象 | 先看 |
|---|---|
| `caddy` 起不来 / 站点 404 | `docker logs tunex-caddy`；SITE_URL/ACME_EMAIL 是否设置（该两项缺失 Caddy fail-fast） |
| 证书没签下来 | 80/443 是否放行；域名是否已解析；`docker exec tunex-caddy caddy list-modules` 与卷内 `/data/caddy/pki` |
| Agent 反复重连 | `/socket.io/*` 是否被路由到 `backend:3001`；上游是否有代理把 Upgrade 头吃掉 |
| backend 起不来 | `docker logs tunex-backend`；缺失某密钥时 `env.ts` fail-fast 会直报 `X is required and has no default` |
| 登录后秒退 | `COOKIE_SECURE` 与访问协议是否一致：HTTPS 站点必须是 `true` |
| 邮件收不到 | `SMTP_*` 是否配置；`docker logs tunex-backend \| grep -i mail` |
| 备份报"从未成功备份" | cron 是否真跑：`var/backups/` 是否存在当日目录；脚本日志 |
| 回滚提示无 BACKUP_PASSPHRASE | cron/管道无 tty，必须预设该变量或显式 `--no-backup` |
| ops 脚本指向空栈 | `COMPOSE_FILE` 是否显式指向 `docker-compose.prod.yaml` |

日志：`docker compose -f "$COMPOSE_FILE" logs -f --tail=200 <service>`，单容器
日志已限制 `20m × 5` 份轮转。

---

## 10. 上线前演练清单（每季度 / 每次重大变更前跑一遍）

- [ ] 在**隔离环境**完整执行一次：deploy → backup → restore → rollback 全链路
- [ ] 恢复演练后核对 `_prisma_migrations` 行数与关键表行数和 manifest 一致
- [ ] 用 `restore.sh` 的 config 目录做过 `diff -u`，确认 .env/Caddyfile 覆盖策略
- [ ] 通知渠道实测：ALERT_WEBHOOK 送达，宝塔通道（如使用）收到测试消息
- [ ] `alert.sh` 各项阈值与主机实际容量匹配（如内存 16G 机应放宽 MEM 阈值）
- [ ] 本地 + 异地各有一份可用的近期备份，且能在另一台机解密校验
- [ ] 已知良好镜像 sha 已填写到 `ROLLBACK_KNOWN_GOOD_IMAGE`
- [ ] `PAYMENTS_ENABLED=false` / `ALLOW_REGISTER_FALLBACK=false` 复核
- [ ] 3306/6379 从公网不可达复核
- [ ] 抽 1 个真实 workspace 走通"建隧道 → agent 上报 → 访问"端到端

---

## 11. 验收记录（OPS-02）

| 项 | 状态 |
|---|---|
| 生产 compose（无数据端口外泄、TLS 入口、`/socket.io` 路由、资源限额） | ✅ 本仓库交付 |
| `.env.production.example`（含全部密钥占位与开关说明） | ✅ 本仓库交付 |
| `Caddyfile.prod`（域名 + ACME + 安全头 + 跳转） | ✅ 本仓库交付，`caddy validate` 通过 |
| ops 脚本集（alert/backup/restore/rollback/capacity） | ✅ 已就位 |
| 真实生产机部署与恢复/回滚演练 | ⏳ 待部署环境执行（见第 10 节） |
