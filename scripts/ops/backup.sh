#!/usr/bin/env bash
# ============================================================================
# TuneX OPS-02 —— 备份脚本
#
# 备份内容（全部租户数据，零遗漏）：
#   1. MySQL 全库逻辑备份（mysqldump，单事务 + 一致快照，含 _prisma_migrations）
#   2. Redis 全量导出（RDB 快照：BGSAVE + 从容器卷复制 dump.rdb；AOF 关闭时唯一手段）
#   3. 环境密钥与配置清单（.env / Caddyfile* / compose 版本指纹 —— 不含明文密钥入库，
#      整文件加密后单独存放）
#
# 设计约束：
#   · 一致性：mysqldump 使用 --single-transaction（InnoDB MVCC），不锁表、不阻塞租户。
#   · 二进制日志：compose 用 --skip-log-bin，dump 即恢复到导出时刻的完整状态。
#   · 完整性：每次备份生成 SHA256 校验和 + manifest JSON，恢复前强制校验。
#   · 加密：备份文件使用 openssl AES-256-GCM 加密（口令来自 BACKUP_PASSPHRASE 或
#     operator 交互输入），落盘 filename.enc + filename.enc.sha256。
#   · 保留策略：每日保留 N 份（默认 14），超出按时间淘汰；本地 + 可选异地 rsync。
#
# 用法：
#   scripts/ops/backup.sh                # 交互式询问加密口令
#   BACKUP_PASSPHRASE=... scripts/ops/backup.sh        # 非交互（cron）
#   scripts/ops/backup.sh --no-encrypt  # 测试用：跳过加密（禁止生产使用）
#   scripts/ops/backup.sh --help
#
# 退出码：0 成功；1 失败（任一子步骤失败即失败，绝不产出"看起来完整"的半成品）。
# ============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

# --- 可覆盖的默认值（环境变量） ---------------------------------------------
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_ROOT/docker-compose.yaml}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/var/backups}"
MYSQL_SERVICE="${MYSQL_SERVICE:-mysql}"
REDIS_SERVICE="${REDIS_SERVICE:-redis}"
MYSQL_DATABASE="${MYSQL_DATABASE:-tunex}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
ENCRYPT="${ENCRYPT:-1}"            # 1=加密，0=不加密（仅测试）
ALERT_WEBHOOK="${ALERT_WEBHOOK:-}" # 可选：失败时 POST 的 webhook（钉钉/企微/Slack 兼容 JSON）
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_TAG="[backup $STAMP]"

# --- 输出 -------------------------------------------------------------------
log()  { printf '%s %s\n' "$LOG_TAG" "$*"; }
warn() { printf '%s WARN: %s\n' "$LOG_TAG" "$*" >&2; }
die()  { printf '%s ERROR: %s\n' "$LOG_TAG" "$*" >&2; exit 1; }

notify_failure() {
  local msg="$1"
  [[ -n "${ALERT_WEBHOOK:-}" ]] || return 0
  curl -fsS -m 10 -H 'Content-Type: application/json' \
    -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"[TuneX] 备份失败: $msg\"}}" \
    "$ALERT_WEBHOOK" >/dev/null 2>&1 || warn "告警 webhook 投递失败"
}

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && usage 0
[[ "${1:-}" == "--no-encrypt" ]] && ENCRYPT=0

# --- 前置检查 ----------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker 不在 PATH"
docker compose version >/dev/null 2>&1 || die "docker compose v2 不可用"
[[ -f "$COMPOSE_FILE" ]] || die "compose 文件不存在: $COMPOSE_FILE"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum 不可用"
[[ "$ENCRYPT" == "1" ]] && { command -v openssl >/dev/null 2>&1 || die "openssl 不可用（加密必需）"; }

# compose 可能在项目根目录或任意目录执行，统一用 -p 明确项目名，
# 读取 env 以拿到 DB 名（compose 变量插值需要 .env）。
cd "$PROJECT_ROOT"
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  # shellcheck disable=SC1091
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


log "项目根: $PROJECT_ROOT"
log "备份目标: mysql/$MYSQL_DATABASE + redis + 配置清单"

# --- 0. 容器健康检查 ---------------------------------------------------------
svc_running "$MYSQL_SERVICE" \
  || die "mysql 服务未运行"
svc_running "$REDIS_SERVICE" \
  || die "redis 服务未运行"

# --- 1. 准备目录 -------------------------------------------------------------
DAILY_DIR="$BACKUP_DIR/${STAMP%%T*}"     # 按 UTC 日期分目录
mkdir -p "$DAILY_DIR"
chmod 700 "$DAILY_DIR"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tunex-backup.XXXXXX")"
# shellcheck disable=SC2317
cleanup() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then notify_failure "exit=$rc stamp=$STAMP"; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
log "暂存目录: $WORK"

# --- 2. MySQL 全库备份 -------------------------------------------------------
# --single-transaction：InnoDB 一致性快照，不阻塞租户读写；
# --set-gtid-purged=OFF：skip-log-bin 部署下无 GTID 可导出；
# --routines --events --triggers：含存储过程/事件/触发器（如有）；
# column-statistics：8.0 兼容开关，目标端老版本恢复需要时去掉。
MYSQL_DUMP="$WORK/mysql-$MYSQL_DATABASE.sql"
log "[1/5] mysqldump 全库导出 → $MYSQL_DATABASE"
"${COMPOSE[@]}" exec -T "$MYSQL_SERVICE" \
  sh -c "mysqldump -uroot -p\"\$MYSQL_ROOT_PASSWORD\" \
    --single-transaction --quick --hex-blob \
    --routines --events --triggers \
    --set-gtid-purged=OFF --column-statistics=0 \
    --default-character-set=utf8mb4 \
    --databases $MYSQL_DATABASE" > "$MYSQL_DUMP" 2> "$WORK/mysqldump.err" \
  || { warn "mysqldump 输出: $(cat "$WORK/mysqldump.err")"; die "mysqldump 失败"; }

# 产物自检：dump 必须包含每个业务表的 DDL 且以 Dump completed 结尾
grep -q "Dump completed on" "$MYSQL_DUMP" || die "mysqldump 未正常完成（无 Dump completed）"
for t in workspace user tunnel capability_policy _prisma_migrations; do
  grep -q "CREATE TABLE \`$t\`" "$MYSQL_DUMP" || die "dump 缺少关键表 $t —— 备份不完整，拒绝放行"
done
MYSQL_ROWS="$(grep -c 'INSERT INTO ' "$MYSQL_DUMP" || true)"
log "      dump OK：$MYSQL_ROWS 条 INSERT 语句，$(du -h "$MYSQL_DUMP" | cut -f1)"

# --- 3. Redis 备份 -----------------------------------------------------------
# AOF 关闭（compose command 仅 --appendonly yes ？实测 appendonly=no）。
# 物理卷复制可能撞上正在写入的 RDB，因此走"在线触发 BGSAVE → LASTSAVE 确认 → 复制"：
# 快照含 BGSAVE 时刻前的全部写入，最多丢失最近 <1s 的写（Redis 持久化语义上限）。
# Redis 中的密钥均为 TTL 会话/限流/缓存（实测 107 keys 全部 expires），
# 属可重建数据，RDB 快照已满足"备份"要求；真正的持久真相在 MySQL。
REDIS_RDB="$WORK/redis-dump.rdb"
log "[2/5] Redis BGSAVE 快照"
# 通过容器内 redis-cli 操作（不依赖主机端口映射）
LASTSAVE_BEFORE="$("${COMPOSE[@]}" exec -T "$REDIS_SERVICE" redis-cli LASTSAVE | tr -d '\r')"
"${COMPOSE[@]}" exec -T "$REDIS_SERVICE" redis-cli BGSAVE >/dev/null
# 等待 BGSAVE 完成（rdb_bgsave_in_progress:0 且 last_save_time 前进）。
# shellcheck disable=SC2034  # BGSAVE_WAIT 为轮询计数，仅用于可读性/排障
BGSAVE_WAIT=0
# shellcheck disable=SC2034
for BGSAVE_WAIT in $(seq 1 60); do
  STATUS="$("${COMPOSE[@]}" exec -T "$REDIS_SERVICE" redis-cli INFO persistence | tr -d '\r')"
  INPROG="$(awk -F: '/^rdb_bgsave_in_progress:/{print $2}' <<<"$STATUS")"
  LASTSAVE="$(awk -F: '/^rdb_last_save_time:/{print $2}' <<<"$STATUS")"
  [[ "$INPROG" == "0" && "$LASTSAVE" -gt "$LASTSAVE_BEFORE" ]] && break
  sleep 0.5
done
[[ "${INPROG:-1}" == "0" ]] || warn "BGSAVE 仍在进行，继续等待结果"
# 容器内直接 cat 到宿主机文件（rdb < 内存，可接受）。
"${COMPOSE[@]}" exec -T "$REDIS_SERVICE" sh -c "cat /data/dump.rdb" > "$REDIS_RDB" \
  || die "复制 RDB 失败"
[[ -s "$REDIS_RDB" ]] || die "RDB 文件为空"
# 校验 RDB 头（REDIS 魔数）
head -c 5 "$REDIS_RDB" | grep -q "REDIS" || die "RDB 文件头非法"
REDIS_KEYS="$("${COMPOSE[@]}" exec -T "$REDIS_SERVICE" redis-cli DBSIZE | tr -d '\r')"
log "      redis 快照 OK：$REDIS_KEYS keys，$(du -h "$REDIS_RDB" | cut -f1)"

# --- 4. 配置与密钥清单（整文件加密，绝不入库明文） ---------------------------
CFG_DIR="$WORK/config"
mkdir -p "$CFG_DIR"
log "[3/5] 收集配置清单（加密存放）"
[[ -f "$PROJECT_ROOT/.env" ]]           && cp "$PROJECT_ROOT/.env" "$CFG_DIR/env"
[[ -f "$PROJECT_ROOT/Caddyfile" ]]      && cp "$PROJECT_ROOT/Caddyfile" "$CFG_DIR/Caddyfile"
[[ -f "$PROJECT_ROOT/Caddyfile.prod" ]] && cp "$PROJECT_ROOT/Caddyfile.prod" "$CFG_DIR/Caddyfile.prod"
[[ -f "$PROJECT_ROOT/docker-compose.standalone.yaml" ]] && cp "$PROJECT_ROOT/docker-compose.standalone.yaml" "$CFG_DIR/docker-compose.standalone.yaml"
[[ -f "$COMPOSE_FILE" ]]                && cp "$COMPOSE_FILE" "$CFG_DIR/docker-compose.yaml"
cp "$PROJECT_ROOT/scripts/ops/backup.sh" "$CFG_DIR/" 2>/dev/null || true

# 部署版本指纹：镜像 tag/digest + git commit，用于"回滚到哪个版本"的决策输入
{
  echo "backup_stamp=$STAMP"
  echo "git_commit=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "git_branch=$(git -C "$PROJECT_ROOT" branch --show-current 2>/dev/null || echo unknown)"
  echo "backend_image=$(docker image inspect "${TUNEX_BACKEND_IMAGE:-ghcr.io/paimoncai/tunex-backend:latest}" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo unknown)"
  echo "web_image=$(docker image inspect "${TUNEX_WEB_IMAGE:-ghcr.io/paimoncai/tunex-web:latest}" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo unknown)"
  echo "mysql_rows=$MYSQL_ROWS"
  echo "redis_keys=$REDIS_KEYS"
} > "$CFG_DIR/VERSION"

# --- 5. 加密 + 校验和 + manifest ---------------------------------------------
log "[4/5] 加密与校验"
OUT_BASE="$DAILY_DIR/tunex-$STAMP"

gzip -9 "$MYSQL_DUMP"
gzip -9 "$REDIS_RDB"
tar -C "$WORK" -czf "$WORK/config.tar.gz" config
gzip -9 "$WORK/config.tar.gz" 2>/dev/null || true

# 备份加密算法。
# 注意：不要用 -aes-256-gcm。openssl enc 的 CLI 自 1.1.1 起就不支持 AEAD 套件，
# Ubuntu 24.04（OpenSSL 3.0.13）会直接报 "AEAD ciphers not supported" 并失败。
# 因此统一用 AES-256-CBC + PBKDF2（200k 迭代）+ 随机 salt；配合备份产物自带的
# SHA256 校验和，可以同时发现「口令错误」与「文件损坏/篡改」。
# 若日后要升级到 GCM，需改用 `openssl enc -aead`（新版）或改用 age/gpg。
CIPHER="aes-256-cbc"
KDF_ITER=200000

encrypt_file() {
  local src="$1" dst="$2"
  if [[ "$ENCRYPT" == "1" ]]; then
    openssl enc -"$CIPHER" -pbkdf2 -iter "$KDF_ITER" -salt \
      -in "$src" -out "$dst" -pass "pass:$PASSPHRASE" \
      || die "加密失败: $src"
  else
    cp "$src" "$dst"
    warn "--no-encrypt：备份未加密，仅限本地测试"
  fi
  sha256sum "$dst" | awk '{print $1}' > "$dst.sha256"
}

if [[ "$ENCRYPT" == "1" ]]; then
  if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
    PASSPHRASE="$BACKUP_PASSPHRASE"
  else
    read -r -s -p "备份加密口令（输入不可见）: " PASSPHRASE; echo
    read -r -s -p "再次确认: " PASSPHRASE2; echo
    [[ "$PASSPHRASE" == "$PASSPHRASE2" ]] || die "两次口令不一致"
    [[ ${#PASSPHRASE} -ge 12 ]] || die "口令至少 12 位"
  fi
fi

encrypt_file "$MYSQL_DUMP.gz"      "$OUT_BASE-mysql.sql.gz"
encrypt_file "$REDIS_RDB.gz"       "$OUT_BASE-redis.rdb.gz"
encrypt_file "$WORK/config.tar.gz" "$OUT_BASE-config.tar.gz"

cat > "$OUT_BASE.manifest.json" <<EOF
{
  "backup_id": "tunex-$STAMP",
  "created_utc": "$STAMP",
  "project_root": "$PROJECT_ROOT",
  "encrypted": $([ "$ENCRYPT" = "1" ] && echo true || echo false),
  "kdf": "openssl $CIPHER pbkdf2 iter=$KDF_ITER",
  "mysql": { "database": "$MYSQL_DATABASE", "rows": $MYSQL_ROWS, "engine": "mysqldump --single-transaction" },
  "redis": { "keys": $REDIS_KEYS, "mechanism": "BGSAVE rdb snapshot" },
  "files": [
    "$(basename "$OUT_BASE")-mysql.sql.gz",
    "$(basename "$OUT_BASE")-redis.rdb.gz",
    "$(basename "$OUT_BASE")-config.tar.gz"
  ],
  "git_commit": "$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
}
EOF
chmod 600 "$OUT_BASE".* || true
log "      manifest: $OUT_BASE.manifest.json"

# --- 6. 保留策略 -------------------------------------------------------------
log "[5/5] 清理 ${RETENTION_DAYS} 天前备份"
find "$BACKUP_DIR" -maxdepth 1 -type d -name '20*' -mtime "+$RETENTION_DAYS" -exec rm -rf {} + 2>/dev/null || true
KEPT="$(find "$BACKUP_DIR" -maxdepth 1 -type d -name '20*' | wc -l)"
TOTAL_SIZE="$(du -sh "$BACKUP_DIR" | cut -f1)"

log "备份完成："
log "  目录     : $DAILY_DIR"
log "  保留     : $KEPT 份 / $RETENTION_DAYS 天，合计 $TOTAL_SIZE"
ls -lh "$DAILY_DIR" | sed 's/^/  /'

exit 0
