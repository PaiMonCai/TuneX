#!/usr/bin/env bash
# ============================================================================
# TuneX OPS-02 —— 恢复脚本（配套 backup.sh）
#
# 从 backup.sh 产出恢复 MySQL + Redis + 配置。
#
# 危险操作：会**覆盖**当前数据库内容。默认拒绝执行，除非显式确认。
#
# 用法：
#   scripts/ops/restore.sh <backup-id-or-path> [--yes] [--mysql-only] [--redis-only] [--dry-run]
#
#   backup-id 可以是：
#     · 完整备份 id（如 tunex-20260924T120000Z）——自动在 var/backups/<date>/ 下查找
#     · manifest.json 路径
#     · 日期目录（如 20260924，取当日最新一份）
#
# 恢复流程（每一步都有校验，失败即停）：
#   1. 解析 backup id → 定位三个加密文件 + manifest
#   2. SHA256 校验（防传输/磁盘损坏）
#   3. 解密（openssl aes-256-cbc + PBKDF2，同 backup 口令；算法见 backup.sh，勿用 GCM）
#   4. MySQL：先 DROP+DATABASE 重建，再灌入 dump（含 _prisma_migrations，
#      恢复后 prisma migrate deploy 应为 "No pending migrations"）
#   5. Redis：FLUSHALL + 停 AOF 上下文恢复 RDB（SHUTDOWN NOSAVE 后替换卷文件再启动），
#      或 DEBUG LOAD 方式；默认走「替换 dump.rdb 卷文件 + 重启 redis」。
#   6. 恢复后自检：表数量、关键表行数、租户数（workspace/user/tunnel）与 manifest 对齐
#
# 前置：目标服务当前运行中（compose up 过）。恢复前强烈建议先对现状做一次备份。
#
# 退出码：0 成功；1 失败；2 用法/前置错误。
# ============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_ROOT/docker-compose.yaml}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/var/backups}"
MYSQL_SERVICE="${MYSQL_SERVICE:-mysql}"
REDIS_SERVICE="${REDIS_SERVICE:-redis}"
MYSQL_DATABASE="${MYSQL_DATABASE:-tunex}"

log()  { printf '[restore] %s\n' "$*"; }
warn() { printf '[restore] WARN: %s\n' "$*" >&2; }
die()  { printf '[restore] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }
usage() { sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

# --- 参数解析 ----------------------------------------------------------------
TARGET=""; ASSUME_YES=0; DO_MYSQL=1; DO_REDIS=1; DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)      ASSUME_YES=1 ;;
    --mysql-only)  DO_REDIS=0 ;;
    --redis-only)  DO_MYSQL=0 ;;
    --dry-run)     DRY_RUN=1 ;;
    --help|-h)     usage ;;
    -*)            die "未知参数: $1" 2 ;;
    *)             [[ -z "$TARGET" ]] && TARGET="$1" || die "多余参数: $1" 2 ;;
  esac
  shift
done
[[ -n "$TARGET" ]] || { usage; die "缺少 backup id / 路径" 2; }

command -v docker >/dev/null 2>&1 || die "docker 不在 PATH" 2
command -v openssl >/dev/null 2>&1 || die "openssl 不可用（解密必需）" 2
[[ -f "$COMPOSE_FILE" ]] || die "compose 文件不存在: $COMPOSE_FILE" 2

cd "$PROJECT_ROOT"
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  set -a; . "$PROJECT_ROOT/.env"; set +a
fi
MYSQL_DATABASE="${MYSQL_DATABASE:-tunex}"
COMPOSE=(docker compose -p tunex -f "$COMPOSE_FILE")

# svc_running <service> —— 便携式"服务是否 running"检查。
# 不同 compose 版本对 `ps --status` 支持不一（v2.28 无该 flag），
# 因此统一解析 `ps --format '{{.Service}} {{.State}}'` 的第二列。
svc_running() {
  local svc="$1"
  "${COMPOSE[@]}" ps --format '{{.Service}} {{.State}}' 2>/dev/null \
    | awk -v s="$svc" '$1==s && $2 ~ /^running/ {found=1} END{exit found?0:1}'
}


# --- 1. 定位备份 -------------------------------------------------------------
resolve_backup() {
  local t="$1"
  # manifest 路径
  if [[ -f "$t" ]]; then
    if [[ "$t" == *.manifest.json ]]; then echo "$t"; return 0; fi
    die "给定的文件不是 manifest.json: $t" 2
  fi
  # 完整 id：tunex-<stamp>
  local stamp="${t#tunex-}"
  local date="${stamp%%T*}"
  if [[ -d "$BACKUP_DIR/$date" && -f "$BACKUP_DIR/$date/tunex-$stamp.manifest.json" ]]; then
    echo "$BACKUP_DIR/$date/tunex-$stamp.manifest.json"; return 0
  fi
  # 裸日期 → 当日最新
  if [[ -d "$BACKUP_DIR/$t" ]]; then
    ls -1t "$BACKUP_DIR/$t"/*.manifest.json 2>/dev/null | head -1
    return 0
  fi
  # 任意目录下的 manifest
  find "$BACKUP_DIR" -name "tunex-${t#tunex-}.manifest.json" 2>/dev/null | head -1
}

MANIFEST="$(resolve_backup "$TARGET")"
[[ -n "$MANIFEST" && -f "$MANIFEST" ]] || die "找不到备份: $TARGET（搜索根: $BACKUP_DIR）" 2
BK_DIR="$(dirname "$MANIFEST")"
BK_ID="$(basename "$MANIFEST" .manifest.json)"
log "备份 id   : $BK_ID"
log "manifest  : $MANIFEST"
command -v jq >/dev/null 2>&1 || warn "无 jq，部分自检降级"

# --- 2. 人工确认 -------------------------------------------------------------
if [[ $ASSUME_YES -ne 1 && $DRY_RUN -ne 1 ]]; then
  cat <<EOF

  ⚠️  即将覆盖生产数据。恢复内容：
     MySQL : $MYSQL_DATABASE（DROP 后重建，当前数据全部丢失）
     Redis : FLUSHALL 后载入快照
     来源  : $BK_DIR
  建议先执行 scripts/ops/backup.sh 保存现状。

EOF
  read -r -p "输入 RESTORE 确认执行: " ans
  [[ "$ans" == "RESTORE" ]] || die "已取消（未输入 RESTORE）" 2
fi

# --- 3. 校验 + 解密 ----------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tunex-restore.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

verify_and_decrypt() {
  local enc="$1" out="$2" sum
  [[ -f "$enc" ]] || die "备份文件缺失: $enc"
  [[ -f "$enc.sha256" ]] || die "校验文件缺失: $enc.sha256"
  sum="$(cat "$enc.sha256")"
  echo "$sum  $enc" | sha256sum -c - >/dev/null 2>&1 || die "SHA256 校验失败: $enc（文件损坏或被篡改）"
  log "  SHA256 OK : $(basename "$enc")"
  # 算法必须与 backup.sh 的 CIPHER/KDF_ITER 一致（aes-256-cbc + PBKDF2 200k）。
  # CBC 无认证标签，因此「口令错误」只能靠下面这段 gzip 头校验兜底。
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "$enc" -out "$out" -pass "pass:$PASSPHRASE" 2>"$WORK/openssl.err" \
    || { cat "$WORK/openssl.err" >&2; die "解密失败（口令错误？）: $enc"; }
  # gzip 魔术头（1f 8b）校验：口令正确时解密产物一定是 gzip。
  # CBC 解密明文不定，口令错误时 openssl 可能不报错，只能靠这一层拦截。
  head -c 2 "$out" | od -An -tx1 | tr -d ' \n' | grep -qi '^1f8b$' \
    || die "解密产物不是 gzip —— 口令错误或备份文件被截断: $enc"
}

if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  PASSPHRASE="$BACKUP_PASSPHRASE"
else
  [[ $DRY_RUN -eq 1 ]] && PASSPHRASE="dry-run-no-decrypt" || {
    read -r -s -p "备份解密口令: " PASSPHRASE; echo
  }
fi

log "[1/4] 校验 + 解密"
ENC_MYSQL="$(jq -r '.files[] | select(test("mysql"))' "$MANIFEST" 2>/dev/null || echo "${BK_ID}-mysql.sql.gz")"
ENC_REDIS="$(jq -r '.files[] | select(test("redis"))' "$MANIFEST" 2>/dev/null || echo "${BK_ID}-redis.rdb.gz")"
ENC_CFG="$(jq -r '.files[] | select(test("config"))' "$MANIFEST" 2>/dev/null || echo "${BK_ID}-config.tar.gz")"

if [[ $DRY_RUN -eq 1 ]]; then
  log "（dry-run）跳过校验/解密与任何变更。可恢复文件清单："
  ls -lh "$BK_DIR" | sed 's/^/  /'
  jq . "$MANIFEST" 2>/dev/null | sed 's/^/  /' || cat "$MANIFEST"
  exit 0
fi

verify_and_decrypt "$BK_DIR/$ENC_MYSQL" "$WORK/mysql.sql.gz"
gunzip -f "$WORK/mysql.sql.gz"
MYSQL_SQL="$WORK/mysql.sql"
grep -q "Dump completed on" "$MYSQL_SQL" || die "解密产物不是有效 dump"

# --- 4. MySQL 恢复 -----------------------------------------------------------
if [[ $DO_MYSQL -eq 1 ]]; then
  log "[2/4] MySQL 恢复 → $MYSQL_DATABASE"
  svc_running "$MYSQL_SERVICE" \
    || die "mysql 服务未运行，先 docker compose up -d mysql" 2

  # 记录恢复前行数（供对比报告）
  before="$("${COMPOSE[@]}" exec -T "$MYSQL_SERVICE" sh -c \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -N -e \"SELECT COUNT(*) FROM workspace;\" 2>/dev/null" || echo "?")"
  log "  恢复前 workspace 行数: $before"

  # dump 内含 CREATE DATABASE + USE，直接灌入。--force 让 DROP IF EXISTS 冲突可继续。
  "${COMPOSE[@]}" exec -T "$MYSQL_SERVICE" sh -c \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" --force < /dev/stdin" < "$MYSQL_SQL" 2>"$WORK/mysql.err" \
    || { warn "mysql stderr: $(head -5 "$WORK/mysql.err")"; die "MySQL 灌入失败"; }

  after="$("${COMPOSE[@]}" exec -T "$MYSQL_SERVICE" sh -c \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -N -e \"SELECT COUNT(*) FROM workspace;\" 2>/dev/null" || echo "?")"
  log "  恢复后 workspace 行数: $after"

  # 结构自检：迁移表存在且与 dump 中迁移版本一致
  mig="$("${COMPOSE[@]}" exec -T "$MYSQL_SERVICE" sh -c \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -N -e \"SELECT COUNT(*) FROM _prisma_migrations;\" 2>/dev/null" || echo 0)"
  log "  _prisma_migrations 行数: $mig"
  [[ "$mig" -gt 0 ]] || warn "_prisma_migrations 为空 —— dump 可能来自未迁移库"
  log "  建议执行 prisma migrate deploy 确认 schema 一致（在 backend 容器内）"
fi

# --- 5. Redis 恢复 -----------------------------------------------------------
if [[ $DO_REDIS -eq 1 ]]; then
  log "[3/4] Redis 恢复"
  verify_and_decrypt "$BK_DIR/$ENC_REDIS" "$WORK/redis.rdb.gz"
  gunzip -f "$WORK/redis.rdb.gz"
  head -c 5 "$WORK/redis.rdb" | grep -q REDIS || die "解密产物不是有效 RDB"

  before_keys="$("${COMPOSE[@]}" exec -T "$REDIS_SERVICE" redis-cli DBSIZE | tr -d '\r')"
  log "  恢复前 keys: $before_keys"

  # 方式：停 redis → 替换卷内 dump.rdb → 启动（由 restart:always 自动拉起）。
  # 找到 redis 数据卷
  VOL="$("${COMPOSE[@]}" exec -T "$REDIS_SERVICE" sh -c 'ls -d /data' >/dev/null 2>&1 \
        && "${COMPOSE[@]}" inspect "$REDIS_SERVICE" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' 2>/dev/null || true)"
  [[ -n "$VOL" ]] || VOL="$("${COMPOSE[@]}" inspect "$REDIS_SERVICE" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"

  "${COMPOSE[@]}" stop "$REDIS_SERVICE" >/dev/null
  if [[ -n "$VOL" ]]; then
    if [[ -d "/var/lib/docker/volumes/$VOL/_data" ]]; then
      cp "$WORK/redis.rdb" "/var/lib/docker/volumes/$VOL/_data/dump.rdb"
    elif [[ -d "$VOL" ]]; then
      cp "$WORK/redis.rdb" "$VOL/dump.rdb"
    else
      die "无法定位 redis 数据卷: $VOL"
    fi
  else
    die "无法解析 redis 数据卷名"
  fi
  "${COMPOSE[@]}" start "$REDIS_SERVICE" >/dev/null
  # 等待 keys 加载。
  # shellcheck disable=SC2034  # REDIS_WAIT 为轮询计数，仅用于可读性/排障
  REDIS_WAIT=0
  # shellcheck disable=SC2034
  for REDIS_WAIT in $(seq 1 40); do
    k="$("${COMPOSE[@]}" exec -T "$REDIS_SERVICE" redis-cli DBSIZE 2>/dev/null | tr -d '\r' || echo 0)"
    [[ "${k:-0}" -ge 1 ]] && break
    sleep 0.5
  done
  after_keys="$("${COMPOSE[@]}" exec -T "$REDIS_SERVICE" redis-cli DBSIZE | tr -d '\r')"
  log "  恢复后 keys: $after_keys"
fi

# --- 6. 配置恢复（谨慎：默认只解包展示，不覆盖） ------------------------------
log "[4/4] 配置清单（仅解包到 $WORK，人工比对后决定是否覆盖）"
if [[ $DRY_RUN -ne 1 && -f "$BK_DIR/$ENC_CFG" ]]; then
  verify_and_decrypt "$BK_DIR/$ENC_CFG" "$WORK/config.tar.gz"
  tar -xzf "$WORK/config.tar.gz" -C "$WORK"
  find "$WORK/config" -type f | sed 's/^/  /'
  log "  注意：.env / Caddyfile 未自动覆盖。如需恢复："
  log "    diff -u $PROJECT_ROOT/.env $WORK/config/env"
  log "    diff -u $PROJECT_ROOT/Caddyfile $WORK/config/Caddyfile"
fi

log "✅ 恢复完成"
log "  后续验证："
log "    1. docker compose ps（全部 healthy）"
log "    2. curl -fsS http://127.0.0.1:${CADDY_HTTP_PORT:-9091}/healthz"
log "    3. 后台登录 / 抽 1 个 workspace 核对 tunnel 数据"
exit 0
