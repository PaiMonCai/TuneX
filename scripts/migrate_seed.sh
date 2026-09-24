#!/usr/bin/env bash
# 迁移 + seed 脚本（宿主机直接执行，走 127.0.0.1:3307）
set -euo pipefail
cd /opt/TuneX

# 载入 .env（仅导出 MYSQL_ROOT_PASSWORD / MYSQL_DATABASE）
ROOT_PW="$(grep -oP '^MYSQL_ROOT_PASSWORD=\K.*' .env | tr -d '"')"
DB_NAME="$(grep -oP '^MYSQL_DATABASE=\K.*' .env | tr -d '"')"
: "${ROOT_PW:?MYSQL_ROOT_PASSWORD missing}"
: "${DB_NAME:?MYSQL_DATABASE missing}"

export DATABASE_URL="mysql://root:${ROOT_PW}@127.0.0.1:3307/${DB_NAME}"
export ADMIN_CREDENTIALS_PATH="/opt/TuneX/.admin-credentials"
export NODE_ENV=production

cd /opt/TuneX/backend
echo "### prisma migrate deploy"
bunx prisma migrate deploy
echo "### exit=$?"
echo
echo "### seed"
bun prisma/seed.ts
echo "### seed exit=$?"
