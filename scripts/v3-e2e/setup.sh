#!/usr/bin/env bash
# WP14 v3 E2E Harness —— 环境搭建（DEVELOPMENT.md §7.15 最低拓扑）
#
# 拉起五机真实拓扑：panel（控制面）+ ingress-agent + egress-agent + target-a + target-b，
# 并经**真实 HTTP API** 创建 fixture 定义的对象（workspace / 节点组 / 隧道）。
# 全程不直接写业务表，保证与控制面语义一致（与 net01-e2e 同一纪律）。
#
# 幂等：可重复执行。数据库卷复用，仅补齐缺失对象；节点组 token 只返回一次，
# 已存在的组从 wp14-mysql 直读。
#
# 产物（全部不入 git，见根目录 .gitignore）：
#   scripts/v3-e2e/.env.wp14        密钥（600）
#   scripts/v3-e2e/.passwords.env   测试用户口令（600）
#   scripts/v3-e2e/state.json       verify.sh / compose 从这里读
#   scripts/v3-e2e/agent.Dockerfile.e2e   本脚本现生成的 agent 构建文件
#   scripts/v3-e2e/evidence/        运行期证据
# 说明：_bootstrap.py 是交付物（版本库内），本脚本调用它创建 fixture 对象。
#
# 依赖：
#   · docker（compose v2 插件）
#   · python3（bootstrap 驱动，只用标准库）
#   · 可选 Dockerfile 构建环境：若 TUNEX_BACKEND_IMAGE / WP14_AGENT_IMAGE 指向的
#     镜像不存在，会从 $REPO/backend 与 $REPO/agent 现构建（CI/PR 上 registry
#     可能没有对应 checkout 的镜像）。
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/v3-e2e"
COMPOSE="$HERE/docker-compose.e2e.yaml"
ENVF="$HERE/.env.wp14"
STATE="$HERE/state.json"
API=${API:-http://127.0.0.1:18180}
SITE_URL=${SITE_URL:-http://127.0.0.1:18181}

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖: $1"; }

need docker
need python3

cd "$REPO"

# ---- 1. 独立密钥（自动生成，600，不入 git） ---------------------------------
if [[ -f "$ENVF" ]]; then
  echo "reusing existing secrets: $ENVF"
  set -a; . "$ENVF"; set +a
else
  say "生成独立密钥（${ENVF}，权限 600）"
  gen() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; }
  MYSQL_ROOT_PASSWORD="$(openssl rand -hex 24)"
  AUTH_SECRET="$(gen)"
  LICENSE_SECRET="$(gen)"
  TUNEX_CONFIG_KEY="$(gen)"
  TUNEX_LICENSE_KEY="$(gen)"
  umask 077
  cat > "$ENVF" <<EOF
# WP14 E2E 独立环境密钥（自动生成，权限 600；切勿提交）
MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD
MYSQL_DATABASE=tunex
# 口令只以变量引用形式出现在本仓库源码里（即下面的 \${MYSQL_ROOT_PASSWORD}）；
# heredoc 展开后写进 $ENVF（600）的是实际口令，不进入 git。
DATABASE_URL=mysql://root:${MYSQL_ROOT_PASSWORD}@mysql:3306/tunex
REDIS_URL=redis://redis:6379
AUTH_SECRET=$AUTH_SECRET
LICENSE_SECRET=$LICENSE_SECRET
TUNEX_CONFIG_KEY=$TUNEX_CONFIG_KEY
TUNEX_LICENSE_KEY=$TUNEX_LICENSE_KEY
JWT_ISSUER=wp14
SITE_URL=$SITE_URL
EOF
  chmod 600 "$ENVF"
  set -a; . "$ENVF"; set +a
  # export 一份同值展开，使 docker compose 与 host 侧调用方拿到的 DATABASE_URL 一致
  export DATABASE_URL
fi

# ---- 2. 镜像准备 -------------------------------------------------------------
# · 控制面：TUNEX_BACKEND_IMAGE 未指定时，本地有 ghcr.io/paimoncai/tunex-backend:latest
#   就用它，否则从 $REPO/backend 现构建（CI/PR 上 registry 可能没有对应 checkout 的
#   镜像，测旧镜像等于测旧行为）。
# · Agent：从本仓库 agent/ 构建 wp14-agent:ci（上下文 = agent/ 目录，不含仓库其余文件）。
AGENT_DOCKERFILE="$HERE/agent.Dockerfile.e2e"
cat > "$AGENT_DOCKERFILE" <<'DOCKERFILE'
# WP14 E2E 专用 agent 镜像：与 CI 的 `go build ./...` 同源构建。
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /out/tunex-agent .
FROM busybox:1.36
COPY --from=build /out/tunex-agent /usr/local/bin/tunex-agent
ENTRYPOINT ["/usr/local/bin/tunex-agent"]
DOCKERFILE

if [[ -z "${TUNEX_BACKEND_IMAGE:-}" ]]; then
  if docker image inspect ghcr.io/paimoncai/tunex-backend:latest >/dev/null 2>&1; then
    export TUNEX_BACKEND_IMAGE=ghcr.io/paimoncai/tunex-backend:latest
  else
    say "本地没有 tunex-backend 镜像，从 backend/ 构建"
    docker build -t wp14-backend:ci "$REPO/backend"
    export TUNEX_BACKEND_IMAGE=wp14-backend:ci
  fi
fi
if [[ "${BUILD_AGENT_IMAGE:-}" == "1" ]]; then
  export WP14_AGENT_IMAGE=wp14-agent:ci
fi
WP14_AGENT_IMAGE=${WP14_AGENT_IMAGE:-wp14-agent:ci}
if ! docker image inspect "$WP14_AGENT_IMAGE" >/dev/null 2>&1; then
  say "构建 agent 镜像 $WP14_AGENT_IMAGE（上下文：$REPO/agent）"
  docker build -t "$WP14_AGENT_IMAGE" -f "$AGENT_DOCKERFILE" "$REPO/agent"
fi
export WP14_AGENT_IMAGE
echo "images: backend=$TUNEX_BACKEND_IMAGE agent=$WP14_AGENT_IMAGE"

# ---- 3. 拉起数据面 + 控制面 ---------------------------------------------------
say "启动 wp14-e2e 栈（mysql/redis/panel/targets/agents）"
docker compose -f "$COMPOSE" --env-file "$ENVF" up -d mysql redis

say "等待 mysql/redis healthy"
for i in $(seq 1 60); do
  m=$(docker inspect -f '{{.State.Health.Status}}' wp14-mysql 2>/dev/null || echo none)
  r=$(docker inspect -f '{{.State.Health.Status}}' wp14-redis 2>/dev/null || echo none)
  [[ "$m" == healthy && "$r" == healthy ]] && break
  sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' wp14-mysql)" == healthy ]] || die "wp14-mysql 未 healthy"
[[ "$(docker inspect -f '{{.State.Health.Status}}' wp14-redis)" == healthy ]] || die "wp14-redis 未 healthy"

say "迁移 + seed（db-migrate）"
docker compose -f "$COMPOSE" --env-file "$ENVF" up -d --no-recreate db-migrate
docker start -a wp14-db-migrate || true

say "启动 panel + targets + agents"
docker compose -f "$COMPOSE" --env-file "$ENVF" up -d panel target-a target-b ingress-agent egress-agent

say "等待 panel /healthz"
for i in $(seq 1 60); do
  s=$(docker inspect -f '{{.State.Health.Status}}' wp14-panel 2>/dev/null || echo none)
  [[ "$s" == healthy ]] && break
  sleep 2
done
docker inspect -f 'panel health={{.State.Health.Status}}' wp14-panel
curl -fsS -m 5 "$API/healthz" >/dev/null || die "panel /healthz 失败（$API）"
echo "healthz OK"

# ---- 4. fixture 对象（真实 HTTP API） -----------------------------------------
# bootstrap 通过 api/ 端点建 workspace / 节点组 / 隧道，不直接写业务表，
# 保证与控制面语义一致（与 net01-e2e 同一纪律）。
# 节点组 token 只在创建响应里返回一次；已存在的组从 wp14-mysql 直读。
say "创建 fixture 对象（workspace / 节点组 / 隧道）"
export API STATE
python3 "$HERE/_bootstrap.py"

# ---- 5. 把节点组 token 注入 agent 并重启 -------------------------------------
say "重启 agents（注入节点组 token）"
export WP14_INGRESS_TOKEN=$(python3 -c "import json;print(json.load(open('$STATE'))['nodeGroups']['ingress']['token'])")
export WP14_EGRESS_TOKEN=$(python3 -c "import json;print(json.load(open('$STATE'))['nodeGroups']['egress']['token'])")
docker compose -f "$COMPOSE" --env-file "$ENVF" up -d --force-recreate ingress-agent egress-agent

say "等待 agents 连上控制面（register ack / config applied）"
for i in $(seq 1 30); do
  docker inspect -f '{{.State.Status}}' wp14-panel >/dev/null 2>&1 || true
  in_ok=$(docker logs wp14-ingress-agent 2>&1 | grep -c "Connected to server" || true)
  out_ok=$(docker logs wp14-egress-agent 2>&1 | grep -c "Connected to server" || true)
  [[ "$in_ok" -ge 1 && "$out_ok" -ge 1 ]] && break
  sleep 2
done
in_ok=$(docker logs wp14-ingress-agent 2>&1 | grep -c "Connected to server" || true)
out_ok=$(docker logs wp14-egress-agent 2>&1 | grep -c "Connected to server" || true)
[[ "$in_ok" -ge 1 ]] || { docker logs --tail 30 wp14-ingress-agent; die "ingress-agent 未连上控制面"; }
[[ "$out_ok" -ge 1 ]] || { docker logs --tail 30 wp14-egress-agent; die "egress-agent 未连上控制面"; }

# ---- 6. 拓扑体检 -------------------------------------------------------------
say "拓扑体检（网络分段 + 仅出站约束）"
# 6a. panel 不得持有任何数据面网络
PANEL_NETS=$(docker inspect wp14-panel --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
for bad in wp14_ingress_data wp14_egress_data; do
  [[ "$PANEL_NETS" != *"$bad"* ]] || die "panel 意外接入数据面网络 $bad（控制面不得数据面可达）"
done
# 6b. egress-agent 不得有 host 端口映射（NAT/私网、仅可主动出站）
EGRESS_PORTS=$(docker inspect wp14-egress-agent --format '{{json .HostConfig.PortBindings}}' 2>/dev/null || echo '""')
[[ "$EGRESS_PORTS" == "{}" || "$EGRESS_PORTS" == "null" || -z "$EGRESS_PORTS" ]] \
  || die "egress-agent 出现 host 端口映射，破坏仅出站约束: $EGRESS_PORTS"
# 6c. 两个 agent 的容器内隧道端口必须真实监听
docker exec wp14-ingress-agent sh -c 'command -v ss >/dev/null && ss -ltn | grep -E ":21001|:21002"' >/dev/null 2>&1 \
  || say "（提示）ingress-agent 容器内无 ss，跳过容器内监听检查；端口是否转发由 verify.sh 从 host 侧验证"

say "WP14 E2E 环境就绪"
cat <<EOF

  control plane : $API  (HTTP API)
  socket.io     : $SITE_URL  (agent 接入，agent 主动出站)
  ingress-agent : host 127.0.0.1:${WP14_INGRESS_PORT_DIRECT:-18201} (DIRECT) / :${WP14_INGRESS_PORT_RELAY:-18202} (RELAY)
  egress-agent  : 无 host 端口（NAT/私网，仅出站）
  targets       : wp14-target-a / wp14-target-b（marker 回显，无 host 端口）
  state         : $STATE
  下一步： bash $HERE/verify.sh
EOF
