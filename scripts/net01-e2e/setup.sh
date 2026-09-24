#!/usr/bin/env bash
# NET-01 双租户 E2E —— 环境搭建（独立、可重复）
#
# 创建 net01_* 独立栈：mysql + redis + backend(含 Socket.IO)，并创建两个
# 互相隔离的租户（workspace / 入口节点组 / 隧道 / GET-ahead 用户），
# 写入 scripts/net01-e2e/.env.net01（权限 600，含密钥，勿提交）。
#
# 幂等：可重复执行。重复执行会复用已有数据卷，仅补齐缺失对象。
set -euo pipefail

REPO=${REPO:-/opt/TuneX-email-auth}
HERE="$REPO/scripts/net01-e2e"
cd "$REPO"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

# ---- 生成/复用独立密钥 ------------------------------------------------------
ENVF="$HERE/.env.net01"
if [[ -f "$ENVF" ]]; then
  echo "reusing existing secrets: $ENVF"
  set -a; . "$ENVF"; set +a
else
  say "生成独立密钥（不进 git）"
  gen() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; }
  MYSQL_ROOT_PASSWORD="$(openssl rand -hex 24)"
  AUTH_SECRET="$(gen)"
  LICENSE_SECRET="$(gen)"
  TUNEX_CONFIG_KEY="$(gen)"
  TUNEX_LICENSE_KEY="$(gen)"
  DATABASE_URL="mysql://root:${MYSQL_ROOT_PASSWORD}@mysql:3306/${MYSQL_DATABASE:-tunex}"
  SITE_URL="http://127.0.0.1:8788"
  umask 077
  cat > "$ENVF" <<EOF
# NET-01 双租户 E2E 独立环境密钥（自动生成，权限 600；切勿提交）
MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD
MYSQL_DATABASE=${MYSQL_DATABASE:-tunex}
DATABASE_URL=$DATABASE_URL
REDIS_URL=redis://redis:6379
AUTH_SECRET=$AUTH_SECRET
LICENSE_SECRET=$LICENSE_SECRET
TUNEX_CONFIG_KEY=$TUNEX_CONFIG_KEY
TUNEX_LICENSE_KEY=$TUNEX_LICENSE_KEY
JWT_ISSUER=net01
SITE_URL=$SITE_URL
EOF
  chmod 600 "$ENVF"
fi

# ---- 拉起数据服务 ----------------------------------------------------------
say "启动 net01 数据面（mysql/redis）"
docker compose -f "$HERE/docker-compose.yaml" --env-file "$ENVF" up -d mysql redis

say "等待 mysql/redis healthy"
for i in $(seq 1 60); do
  m=$(docker inspect -f '{{.State.Health.Status}}' net01-mysql 2>/dev/null || echo none)
  r=$(docker inspect -f '{{.State.Health.Status}}' net01-redis 2>/dev/null || echo none)
  [[ "$m" == "healthy" && "$r" == "healthy" ]] && break
  sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' net01-mysql)" == "healthy" ]] || die "net01-mysql 未 healthy"
[[ "$(docker inspect -f '{{.State.Health.Status}}' net01-redis)" == "healthy" ]] || die "net01-redis 未 healthy"

# ---- 迁移 + seed + 控制面 ---------------------------------------------------
say "迁移 + seed（db-migrate）"
docker compose -f "$HERE/docker-compose.yaml" --env-file "$ENVF" up -d --no-recreate db-migrate
docker start -a net01-db-migrate || true

say "启动 net01-backend（HTTP 8787 / Socket.IO 8788）"
docker compose -f "$HERE/docker-compose.yaml" --env-file "$ENVF" up -d backend
for i in $(seq 1 60); do
  s=$(docker inspect -f '{{.State.Health.Status}}' net01-backend 2>/dev/null || echo none)
  [[ "$s" == "healthy" ]] && break
  sleep 2
done
docker inspect -f 'health={{.State.Health.Status}}' net01-backend
curl -fsS -m 5 "http://127.0.0.1:8787/healthz" >/dev/null && echo "healthz OK" || die "backend /healthz 失败"
curl -fsS -m 5 -o /dev/null -w 'GET /api/node-groups -> %{http_code}\n' "http://127.0.0.1:8787/api/node-groups"

say "完成。现在执行租户 scaffolding"
bash "$HERE/bootstrap-tenants.sh"

say "NET-01 E2E 环境就绪"
cat <<EOF

  control plane : http://127.0.0.1:8787  (HTTP API)
  socket.io     : http://127.0.0.1:8788  (agent 接入)
  isolate       : 独立网络 $(docker network inspect net01_net --format '{{.Id}}')
  下一步： bash $HERE/verify.sh
EOF
