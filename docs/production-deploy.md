# TuneX 生产部署运维手册（OPS-02）

> 对象：单机 Docker Compose 生产栈（`docker-compose.prod.yaml`）。
> 覆盖：首次部署、升级、监控告警、备份、恢复、回滚、容量基线与演练清单。
> 相关文件：`docker-compose.prod.yaml`、`docker-compose.standalone.yaml`、`Caddyfile.internal`、`Caddyfile.prod`、`.env.production.example`、`scripts/ops/{alert,backup,restore,rollback,capacity}.sh`。

---

## 1. 与开发栈的边界（先读这条）

| 维度 | 开发 `docker-compose.yaml` | 生产 `docker-compose.prod.yaml` |
|---|---|---|
| MySQL/Redis 端口 | 映射主机（3307/6380） | **不映射**，仅 compose 内网 |
| backend/web | 映射主机（8787/8788/9091/9445） | 仅映射到 `127.0.0.1`：API 13001 / WS 13002 / Web 13003 |
| 对外入口 | Caddy `:80` 纯 HTTP | 默认宿主机 Nginx/宝塔/1Panel 直接代理 loopback；Caddy 可选 |
| 可选 Caddy | 默认启用 | `--profile caddy` 后聚合为 `127.0.0.1:13000` 单入口 |
| standalone | 不适用 | 可叠加 `docker-compose.standalone.yaml`，由 Caddy 直接占 80/443 + ACME |
| 镜像来源 | 本地 `build:` | CI 预构建 GHCR，sha 钉版本 |
| 数据卷 | `tunex-mysql-data` 等 | `tunex-mysql-data-prod` 等 |
| WebSocket | 无（仅 HTTP 反代） | `/socket.io/* → backend:3001` |
| 资源限额 | 无 | 每容器 CPU/内存上限 + 日志轮转 |

两套栈 compose **项目名都是 `tunex`**（prod 文件顶层 `name: tunex`），不能同时
`up`：`docker compose -p tunex` 是 `scripts/ops/*.sh` 的固定视角，端口/容器名
（`tunex-mysql`、`tunex-backend`…）会互相抢占。同机共存请把其中一套改名或分机部署。

### 1.1 名字是**写死**的：`-p` 不能隔离（实测）

两个 compose 文件都把资源名写死了，`docker compose -p <另一个名字>` **只改默认前缀，
改不动显式名字**：

| 文件 | 写死的东西 |
|---|---|
| `docker-compose.yaml`（开发栈） | `container_name: tunex-*`（:14 起各处）、卷 `name: tunex-mysql-data` / `tunex-redis-data` / `tunex-caddy-*`（:162-170）、网络 `name: tunex`（:172-175） |
| `docker-compose.prod.yaml` | `container_name: tunex-*`；容器名写死，卷是 `-prod` 后缀（不与开发栈撞） |

后果（**在同机部署第二套之前务必阅读**）：

- 直接 `up` 开发栈会**复用**本机已有的 `tunex-mysql-data` / `tunex-redis-data` / 网络 `tunex`
  —— 你得到的不是一次全新部署，而是接着别人的旧库跑（迁移/种子都不会重新发生）；
- 反过来 `docker compose down -v` 会**删掉这些卷**（即"别人的数据"），而且没有任何确认；
- 想真正隔离，只能**改文件里的这些名字**（或在生产路径上只改容器名——卷已带 `-prod`），
  没有"只加一个 `-p` 参数"的用法。

**新装请先确认这些名字不存在**：

```bash
docker ps -a --format '{{.Names}}' | grep -E '^tunex-' || echo "无同名容器"
docker volume ls --format '{{.Name}}' | grep -E '^tunex-(mysql|redis|caddy)' || echo "无同名卷"
docker network ls --format '{{.Name}}' | grep -x tunex || echo "无同名网络"
```

**所有 ops 脚本默认读 `docker-compose.yaml`**。对生产栈执行时必须显式给
`COMPOSE_FILE`：

```bash
export COMPOSE_FILE=/opt/TuneX/docker-compose.prod.yaml   # 建议写进部署用户的 ~/.bashrc 或 cron 头部
scripts/ops/alert.sh
```

---

## 2. 首次部署

### 2.0 一键安装（默认路径）

> **默认路径是这一节。** 下面 `2.1`–`2.5` 是**手动 fallback**：只在安装器前置不满足、或需要逐步审计时走。
> 手动步骤的内容不在这里复制 —— 语义权威仍是本节的 §2.1–§2.5 与
> 安装器行为以本手册与 `scripts/ops/install.sh` 的当前实现为准；两者必须同步更新。

```bash
# 0) 前置：root、git、Docker Engine ≥ 24 + Compose v2。
#    安装器**不会**替你装 Docker：缺 Docker 时它只打印官方安装文档与各发行版包管理器路径
#    （见 2.1 的版本要求），然后非零退出 —— 这是刻意的 fail-closed。
# 1) 引导段：把仓库按**明确版本**检出到部署目录，断言 HEAD 就是该版本，再交给安装器。
#    版本是裸 sha ⇒ 完整克隆 + 分离检出；版本是 tag ⇒ ls-remote 解析出 sha 后浅克隆。
sudo -E scripts/ops/bootstrap.sh --repo <git-url> --version <git-sha 或 tag> --dir /opt/TuneX

# 2) 只想先看计划 / 只做前置检查（两者都不改机器状态）：
sudo scripts/ops/install.sh --dry-run install --version <git-sha>
sudo scripts/ops/install.sh --check   install --version <git-sha>
```

`install.sh` 的动作集是封闭的 4 个（没有第二个入口）：

| 动作 | 做什么 |
|---|---|
| `install --version <sha>` | 首次部署：生成/校验 `.env`（`chmod 600`）→ `docker pull` → `up -d` → 等 `db-migrate` 退出码 0 → `/healthz` + `/readyz` 验收 |
| `upgrade --version <sha>` | 升级：先 pull → **先备份**（`scripts/ops/backup.sh`，失败即拒绝）→ 切 `TUNEX_IMAGE` → `up -d backend worker web` → 健康；失败自动 `scripts/ops/rollback.sh --to previous --yes`（**只回退镜像**，数据层退回必须人工 `restore.sh`） |
| `uninstall` | 停容器；**默认保留数据卷**（删卷必须 `--purge-data --yes`，非交互缺 `--yes` 直接拒绝） |
| `status` | 只读：容器 / 镜像与 digest / 健康 / `db-migrate` 退出码 / 最近备份 / 部署历史 |

口径与 §1 一致（都是踩过的坑）：

- 安装器**显式**带 `-p tunex -f docker-compose.prod.yaml --env-file .env`，不依赖调用者 shell 的隐式默认值
  （§1 那条"ops 脚本默认读开发栈 `docker-compose.yaml`"）。
- `.env` **已存在即永不覆盖**；缺必需键 / 仍是 `change-me`·`replace-with` 占位 / 权限不是 600 ⇒ 拒绝，
  且**只报键名、不回显值**。若上次安装只跑到写 `.env` 就被打断（有 `.env`、无容器），用
  `sudo scripts/ops/install.sh install --reuse-env --version <sha>` 显式复用 —— 它要求 `.env` 校验通过
  **且** `TUNEX_IMAGE` 与请求版本一致，任一不满足仍然拒绝。
- 升级的备份口令**只经环境变量**传递（不进 argv、不进日志、不进文件）：
  `sudo -E env BACKUP_PASSPHRASE=… scripts/ops/install.sh upgrade --version <sha>`。
- 备份 / 恢复 / 回滚 / 告警 / 容量仍归 `scripts/ops/{backup,restore,rollback,alert,capacity}.sh`（§4–§8）；
  面板主机升级**不包含**节点 Agent —— 节点安装/升级走面板生成的命令
  （`POST /api/nodes/:id/enrollment`、`POST /api/nodes/:id/upgrade-command`），安装器结束时也会再提示一次。
- 一键安装**不写 crontab**：装完后按 §4/§5 自己加监控与备份节律；随时用 `scripts/ops/install.sh status` 巡检。

### 2.1 前置

> **fallback（手动路径）**：以下 2.1–2.5 是手动步骤；默认走 §2.0 的一键安装。

- Docker Engine ≥ 24 + Compose v2（standalone overlay 使用 `!override`，需要 Compose ≥ 2.24.4）。
- 推荐宿主机已有 Nginx / 宝塔 / 1Panel：公网域名 A/AAAA 指向宿主机，由宿主机统一处理 80/443 与证书。
- 如果宿主机没有现成反代，可使用 standalone overlay，让 TuneX Caddy 直接占 80/443 并自动 ACME。
- 主机磁盘预留：备份默认保留 14 份（见 `RETENTION_DAYS`），库 + 备份合计预留 ≥ 50GB。

### 2.2 生成密钥与 .env

```bash
cd /opt/TuneX
cp .env.production.example .env
chmod 600 .env

# 每套部署独立生成（示例输出为随机值，直接粘贴到 .env）
openssl rand -base64 32 | tr '+/' '-_'   # → AUTH_SECRET
openssl rand -base64 32 | tr '+/' '-_'   # → LICENSE_SECRET（见下表）
```

必改项（有默认占位值的都不算改完）：

| 变量 | 说明 |
|---|---|
| `SITE_URL` | 对外唯一地址，如 `https://tunex.example.com`；应用生成回调/Agent 安装地址使用 |
| `TUNEX_API_PORT` / `TUNEX_WS_PORT` / `TUNEX_WEB_PORT` | 默认 13001 / 13002 / 13003；都只绑定 `127.0.0.1` |
| `TUNEX_HTTP_PORT` | 默认 13000；仅启用可选 Caddy profile 时使用 |
| `ACME_EMAIL` | 仅 standalone 模式必需；Caddy ACME 账号邮箱 |
| `MYSQL_ROOT_PASSWORD` | 必须同时改 `DATABASE_URL` 里的口令（两边一致） |
| `AUTH_SECRET` | ≥32 随机字节，禁止跨环境复用 |
| `LICENSE_SECRET` | ≥32 随机字节；许可/授权签名密钥。**已发布的 Panel 镜像把它列为必填** —— 缺失时 `db-migrate` 退出码 1、`up -d` 整体失败（实测：`LICENSE_SECRET is required and has no default`）。当前源码已不再读取它，但请一并生成：镜像与源码版本不一致时，这一项就是"能不能启动"的分界。 |
| `TUNEX_IMAGE` | 统一 Panel 应用镜像，钉到具体 git sha（见下） |
| `TUNEX_AGENT_IMAGE` | 节点一键安装使用的多架构 Agent 镜像；生产建议与 Panel 使用同一 git sha |
| `SMTP_*` | 公网服务必须配，否则验证/重置邮件只进日志 |
| `BACKUP_PASSPHRASE` | cron 回滚前备份必需，否则备份脚本交互读取失败并终止回滚 |

可选的**主动出站能力默认全部关闭**：`LOOKING_GLASS_ENABLED=false`、`TUNEX_NOTIFICATION_WEBHOOK_ENABLED=false`、`TUNEX_NOTIFICATION_TELEGRAM_ENABLED=false`。其中 Looking Glass 只做有界 TCP connect 公网探测；开启前应确认审计与目标网络策略符合部署要求。

**通知渠道的凭据与目标在管理端配置**：`/admin/notification-channels`（Admin Console → 运维 → 通知渠道），需要资源键 `notification_channels`（未登记前缀 fail-closed：只有超管可用；登记后按读/写分级授权）。

- **Telegram**：写入 bot token。**只写不读** —— 保存后服务端只回"已配置 / 未配置"与 `secret_state`（`unset` / `sealed` / `unreadable`），**不回显密文，也不回显明文**；密文用通知专用的 HKDF 域（`tunex-notification-v1`）封装，与联邦 / DDNS 的密钥域分离。
- **Webhook**：写入接收方 URL（**URL 本身就是凭据**）。页面只显示服务端脱敏后的 `origin/***摘要`；同一 URL 再次提交是"更新"，新 URL 是"新增"（表没有唯一索引，同一渠道多行是**真实状态**，页面按行展示并给出告警）。
- **配凭据与开部署开关是两件事**：上面三个开关默认关闭 ⇒ 渠道不参与投递（投递账本会留一条 `not_configured`，不是静默丢弃）。配置页同时显示**服务端推导**的投递状态（注册表支持 / 本安装已开启 / 公告实际会用的渠道）与告警，所以**"保存成功"≠"会被投递"**。用户的推送偏好（免打扰）在 `/settings` 的「通知偏好」，是**用户级、跨工作空间**的；投递失败记录在 `/settings` 的「投递记录」（严格本工作空间作用域，平台行不下发租户）。
- **email 渠道的凭据不在管理端**：它读取部署级 `SMTP_*` 环境变量（见上表）。`/admin/settings` **不再提供** SMTP 写入项 —— 写进数据库不会生效，因此后端会明确拒绝这类写入（`code: deployment_level_config`），页面上也写清了应当设置哪些环境变量。

可选但**建议显式设置**：`TUNEX_PUBLIC_PANEL_URL`（面板对外可达地址，供节点 Agent 升级脚本做身份校验；不配则回落到节点自己记录的地址，取不到时升级脚本会明确打印"未校验"）。见 §3.1。

`ALLOW_REGISTER_FALLBACK=false`（邀请制 Beta）+ `PAYMENTS_ENABLED=false` 是
PLAN.md 的既定默认，**不要**在生产环境打开以"图方便"。

### 2.3 选定镜像版本

CI 发布两类镜像：

```text
ghcr.io/paimoncai/tunex:<git-sha>         # Panel / Worker / Web / migrate
ghcr.io/paimoncai/tunex-agent:<git-sha>   # Linux amd64/arm64 Agent
```

Panel 镜像仍由 Compose 以独立容器运行各角色。生产同时钉住同一个 git sha：

```bash
SHA=$(git rev-parse HEAD)

# 先**验证**这个 sha 的镜像真的发布了，再写进 .env —— 不要静默回退 :latest。
# 未发布的 sha 直接钉进 .env，会在 `docker compose pull` 时报 `manifest unknown`，
# 而"悄悄改用 :latest"更糟：它可能与当前源码**不是同一个版本**
# （实测：`:latest` 早于 D3 的 409 修复，且不认 `SEED_DEMO_DATA=false`）。
docker manifest inspect ghcr.io/paimoncai/tunex:$SHA >/dev/null 2>&1 || {
  echo "❌ ghcr.io/paimoncai/tunex:$SHA 未发布（CI 还没为这个 commit 出镜像）。二选一："
  echo "   ① 本地构建（源码部署）：docker build -t tunex-local:$SHA . && \"
  echo "        sed -i \"s#^TUNEX_IMAGE=.*#TUNEX_IMAGE=tunex-local:$SHA#\" .env"
  echo "   ② 改用**已发布**的 tag：docker manifest inspect ghcr.io/paimoncai/tunex:<tag> 确认后再钉。"
  exit 1
}

sed -i "s#^TUNEX_IMAGE=.*#TUNEX_IMAGE=ghcr.io/paimoncai/tunex:$SHA#" .env
sed -i "s#^TUNEX_AGENT_IMAGE=.*#TUNEX_AGENT_IMAGE=ghcr.io/paimoncai/tunex-agent:$SHA#" .env
```

> **本地构建**（`TUNEX_IMAGE=tunex-local:$SHA`）时，Agent 镜像也请用本地可用的那一份
> （`TUNEX_AGENT_IMAGE=tunex-agent-local:$SHA`），否则节点一键安装命令会去拉一个不存在的 tag。

Panel 主机若拉 private GHCR 包可先 `docker login ghcr.io`。但 **Agent 镜像必须允许节点匿名拉取**，否则控制台生成的一键安装命令无法做到无额外 registry 登录；使用 GHCR 时应将 `tunex-agent` package 设为 public，或把 `TUNEX_AGENT_IMAGE` 指向节点可访问的公开镜像仓库。

### 2.4 启动（默认：宿主机反代直连）

```bash
export COMPOSE_FILE=$PWD/docker-compose.prod.yaml
docker compose -f "$COMPOSE_FILE" pull
docker compose -f "$COMPOSE_FILE" up -d
```

启动顺序由 compose 保证：`mysql` healthy → `db-migrate` 执行
`prisma migrate deploy && seed`（**退出码 0 才算成功**）→ `backend/worker/web`。
默认**不会启动 Caddy**。

生产栈提供三个只绑定 loopback 的宿主机端口：

```text
127.0.0.1:13001 -> backend:3000   # API / healthz / readyz
127.0.0.1:13002 -> backend:3001   # Socket.IO / Agent WebSocket
127.0.0.1:13003 -> web:3000       # Next.js Web
```

MySQL/Redis 仍不映射任何主机端口。上述三个端口也只监听 `127.0.0.1`，不会直接暴露公网。

宿主机 Nginx 示例：

```nginx
server {
    listen 80;
    server_name tunex.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name tunex.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location /socket.io/ {
        proxy_pass http://127.0.0.1:13002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:13001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /healthz {
        proxy_pass http://127.0.0.1:13001;
    }

    location = /readyz {
        proxy_pass http://127.0.0.1:13001;
    }

    location / {
        proxy_pass http://127.0.0.1:13003;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

宝塔/1Panel 同理按路径配置三个 loopback 目标，并给 `/socket.io/` 开启 WebSocket/Upgrade 透传。

#### 2.4.1 可选：Docker 内 Caddy 单入口

如果希望宿主机只维护一个反代目标：

```bash
docker compose -f docker-compose.prod.yaml --profile caddy --env-file .env up -d
```

此时额外启动 `tunex-caddy`，聚合为：

```text
127.0.0.1:13000 -> tunex-caddy:80
                      ├── /api/*       -> backend:3000
                      ├── /socket.io/* -> backend:3001
                      └── /*           -> web:3000
```

宿主机 Nginx 便可以只反代到 `http://127.0.0.1:13000`。Caddy 仍是独立官方镜像和独立容器，不进入 TuneX 主应用镜像。

#### 2.4.2 无宿主机反代：standalone Caddy

如果这台机器没有 Nginx/Apache/Traefik，可让 Caddy 直接接管公网入口：

```bash
docker compose \
  -f docker-compose.prod.yaml \
  -f docker-compose.standalone.yaml \
  --env-file .env pull

docker compose \
  -f docker-compose.prod.yaml \
  -f docker-compose.standalone.yaml \
  --env-file .env up -d
```

此模式会用 `Caddyfile.prod` 替换内部 HTTP 配置，直接绑定宿主机 80/443（含 443/udp），并从 `.env` 读取 `SITE_URL` / `ACME_EMAIL` 自动申请证书。**已有 Nginx 占用 80/443 时不要启用 standalone。**

standalone 模式下 Backend 的 loopback 健康端口仍保留，因此 `rollback.sh` / `restore.sh` 不依赖 Caddy 存活即可完成本机健康检查。

首启管理员凭据落在**项目根** `.admin-credentials`（`db-migrate` 把
`ADMIN_CREDENTIALS_PATH=/host/.admin-credentials` 挂到仓库根）：

```bash
sudo cat /opt/TuneX/.admin-credentials     # 改完密码后请删除此文件
```

### 2.5 验收（首次部署的"上线门槛"）

```bash
# 1) 容器与健康
docker compose -f "$COMPOSE_FILE" ps        # 全部 running；backend healthcheck 通过

# 2) 默认 loopback 服务入口
curl -fsS http://127.0.0.1:13001/healthz
curl -fsSI http://127.0.0.1:13003/
docker port tunex-backend                   # 期望仅 127.0.0.1:13001/13002
docker port tunex-web                       # 期望仅 127.0.0.1:13003

# 3) 迁移与管理员账号（都在 `db-migrate` 里发生，退出码 0 才算成功）
docker compose -f "$COMPOSE_FILE" logs db-migrate | tail -20
#   · 迁移：容器执行 `bunx prisma migrate deploy && bun prisma/seed.ts`
#   · 管理员：种子创建 SEED_ADMIN_EMAIL 那个账号；未设 SEED_ADMIN_PASSWORD 时随机生成，
#     并把 `邮箱:口令` 写到**部署目录**的 `.admin-credentials`（`ADMIN_CREDENTIALS_PATH`）。
sudo cat /opt/TuneX/.admin-credentials      # 首次登录用；改完密码请删除此文件

# 4) 第一台真实节点（"部署成功"的硬判据：节点 **online**，不是容器起来了）
#    前置 A：目标节点组必须有端口区间（`node_group.port_range`，如 `30000-30099`）。
#            没有区间时 provision 会被拒（409 `PORT_RANGE_REQUIRED`）；缺失的区间要先补。
#    前置 B：确认节点额度没被示例数据占满（个人/免费空间默认 1 节点）。
#            `SEED_DEMO_DATA=false` 时种子不插演示节点；若你的空间里已有演示节点，请先删除。
#    然后在管理界面：创建 Node → 复制它的一键安装命令 → 在节点主机上执行 → 回到列表确认 online。

# 可选 Caddy profile 启用时再检查：
# curl -fsS http://127.0.0.1:13000/healthz
# docker port tunex-caddy

# 3) 公网入口由宿主机反代提供
curl -fsS https://$DOMAIN/healthz
curl -fsSI https://$DOMAIN/

# 4) 数据面确实内网隔离
nc -vz <公网IP> 3306                        # 期望 connection refused / 超时
nc -vz <公网IP> 6379                        # 同上
nc -vz <公网IP> 13001                       # 期望不可达（只绑定 127.0.0.1）
nc -vz <公网IP> 13002                       # 同上
nc -vz <公网IP> 13003                       # 同上
nc -vz <公网IP> 13000                       # 启用 Caddy profile 时也应不可达

# 5) 一键巡检
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
sed -i "s#^TUNEX_IMAGE=.*#TUNEX_IMAGE=ghcr.io/paimoncai/tunex:$SHA#" .env

docker compose -f "$COMPOSE_FILE" pull
docker compose -f "$COMPOSE_FILE" up -d backend worker web
# mysql/redis 不会被 up -d 重建（image/配置未变），数据安全
scripts/ops/alert.sh
```

`db-migrate` 的 `restart: "no"` + `service_completed_successfully` 依赖意味着
**每次 `up -d` 都会重跑 `migrate deploy`（幂等）+ seed（upsert，不重置已存在
账号）**。提示：seed 不覆盖已存在的用户，也不会重置管理员口令。

### 3.1 节点 Agent 升级与身份校验（`TUNEX_PUBLIC_PANEL_URL`）

上面的升级**不包含**节点 Agent。节点上的 Agent 由面板生成的命令升级：
`POST /api/nodes/:id/upgrade-command` 渲染一段脚本，操作者在节点上执行。脚本在
拉取新镜像、优雅排空、用同一份宿主身份重建容器之后，会做一次**身份校验**：在容器内
用它已有的长期凭据请求 `<面板地址>/api/internal/node/snapshot`，确认新进程仍然是
同一个 `node_id` / `agent_id`。凭据只留在节点容器内，脚本只打印 HTTP 状态码。

面板地址的取用顺序：

1. 后端环境变量 `TUNEX_PUBLIC_PANEL_URL`（写在部署根目录的 `.env`，见
   `.env.production.example`）。必须是**从节点**能访问到的地址；通常就是 `SITE_URL`，
   节点走内网入口时填内网地址。`SITE_URL` 不会自动被这条校验复用。
2. 该变量留空时，回落到节点 `agent.env` 里记录的 `TUNEX_PANEL_HTTP_URL`（标准安装脚本
   写入，等于安装时的 `SITE_URL`）。

结论的三种可能，注意后两种**都不等于升级失败**：

| 脚本输出 | 含义 |
|---|---|
| `身份校验通过（HTTP 200）` / 结尾 `（身份校验：通过）` | 面板确认同一个节点已重新连上 |
| `身份校验失败（HTTP 401/403）` | 凭据不再被接受：脚本自动回退到旧镜像并以非零码退出 |
| `身份校验：未校验 —— <原因>` | 没校验成功：没配地址、超时/网络不可达、镜像里既没有 curl 也没有 wget、其它状态码等。容器照常运行，但**操作者必须在面板确认该节点重新上报后才能放回业务** |

历史上这段校验在标准 Agent 镜像上**不可能通过**（Alpine 里没有 `curl`；且
`docker exec` 看不到 entrypoint 现场 source 的 `agent.env`，凭据为空）。现在改为：在容器内
source `agent.env` 取凭据、优先用 `curl`、没有就用 busybox 自带的 `wget`，并且**只把
HTTP 200 当成通过**，其余一律明确打印"未校验"。如果你看到"未校验"，先按原因排查
（最常见的是没配 `TUNEX_PUBLIC_PANEL_URL`、或节点访问不到面板地址）。

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
| CERT | 仅 standalone Caddy：证书 <14 天 / <7 天 | warning / critical |
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
3. 配置清单 tar（`.env` / `Caddyfile*` / compose 文件 / standalone overlay / 备份脚本 / VERSION
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
# config 目录只解包到临时目录，.env/Caddyfile* 需人工 diff 后才覆盖（见脚本日志）
```

---

## 7. 回滚

```bash
# 列出可回滚目标（部署历史 + 本地镜像）
scripts/ops/rollback.sh --list

# 预演：只校验目标镜像可拉取/存在，不做任何变更
COMPOSE_FILE=$PWD/docker-compose.prod.yaml BACKUP_PASSPHRASE='<口令>' \
  scripts/ops/rollback.sh --verify ghcr.io/paimoncai/tunex:<sha> 

# 执行：先备份现状 → 切镜像 → 健康检查 → 失败自动回退
COMPOSE_FILE=$PWD/docker-compose.prod.yaml BACKUP_PASSPHRASE='<口令>' \
  scripts/ops/rollback.sh --to ghcr.io/paimoncai/tunex:<sha> --yes
```

语义要点：

- **版本回滚只动 `backend/worker/web`**，`mysql/redis/caddy` 不动；
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
| 宿主机 Nginx 502 | 先分别检查 `curl http://127.0.0.1:13001/healthz` 与 `curl -I http://127.0.0.1:13003/`；再检查路径路由 |
| Agent 反复重连 | `/socket.io/*` 是否代理到 `127.0.0.1:13002`；是否透传 Upgrade/Connection |
| 可选 Caddy 起不来 | 是否带了 `--profile caddy`；`127.0.0.1:13000` 是否被占用；查看 `docker logs tunex-caddy` |
| standalone 证书没签下来 | 是否叠加 `docker-compose.standalone.yaml`；80/443 是否放行；SITE_URL/ACME_EMAIL 是否正确；域名是否已解析 |
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
- [ ] 用 `restore.sh` 的 config 目录做过 `diff -u`，确认 .env/Caddyfile* 覆盖策略
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
| 生产 compose（MySQL/Redis 不外泄；Web/API/WS 仅 loopback；资源限额） | ✅ 本仓库交付 |
| 宿主机反代模式（Nginx/宝塔/1Panel → 13001/13002/13003） | ✅ 默认生产路径 |
| 可选 Caddy profile（统一为 `127.0.0.1:13000`） | ✅ 可选路径 |
| standalone overlay（Caddy 80/443 + ACME） | ✅ 可选兼容路径 |
| `.env.production.example`（含全部密钥占位与开关说明） | ✅ 本仓库交付 |
| `Caddyfile.internal` / `Caddyfile.prod`（内部 HTTP / standalone TLS） | ✅ 本仓库交付 |
| ops 脚本集（alert/backup/restore/rollback/capacity） | ✅ 已就位 |
| 真实生产机部署与恢复/回滚演练 | ⏳ 待部署环境执行（见第 10 节） |
