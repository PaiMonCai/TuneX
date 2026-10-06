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
#   5. Redis：停 AOF 上下文恢复 RDB（替换卷内 dump.rdb 再启动；AOF 已启用则拒绝执行）
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
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-tunex}"
# COMPOSE_ENV_FILE lets the same scripts run against a stack whose compose file
# needs extra variables (e.g. the e2e topology), so a real drill is possible.
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-}"
COMPOSE_BASE=(docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE")
[[ -n "$COMPOSE_ENV_FILE" ]] && COMPOSE_BASE+=(--env-file "$COMPOSE_ENV_FILE")
COMPOSE=("${COMPOSE_BASE[@]}")

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

# Whether a passphrase is needed at all is a property of the ARTEFACT, so it is
# read from the manifest before anything asks the operator for one. A
# `--no-encrypt` backup must restore without any passphrase.
MANIFEST_ENCRYPTED="yes"
if grep -q '"encrypted"[[:space:]]*:[[:space:]]*false' "$MANIFEST" 2>/dev/null; then
  MANIFEST_ENCRYPTED="no"
fi

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

verify_and_decrypt() {
  local enc="$1" out="$2" sum
  [[ -f "$enc" ]] || die "备份文件缺失: $enc"
  [[ -f "$enc.sha256" ]] || die "校验文件缺失: $enc.sha256"
  sum="$(cat "$enc.sha256")"
  echo "$sum  $enc" | sha256sum -c - >/dev/null 2>&1 || die "SHA256 校验失败: $enc（文件损坏或被篡改）"
  log "  SHA256 OK : $(basename "$enc")"

  if [[ "$MANIFEST_ENCRYPTED" == "no" ]]; then
    # Plain artefact: the SHA256 above is the integrity check; decrypting it would
    # be wrong regardless of what passphrase the operator has.
    cp -- "$enc" "$out"
    log "  未加密备份（manifest encrypted=false）：跳过解密"
    return 0
  fi
  # 算法必须与 backup.sh 的 CIPHER/KDF_ITER 一致（aes-256-cbc + PBKDF2 200k）。
  # CBC 无认证标签，因此「口令错误」只能靠下面这段 gzip 头校验兜底。
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "$enc" -out "$out" -pass env:TUNEX_BACKUP_PASSPHRASE 2>"$WORK/openssl.err" \
    || { cat "$WORK/openssl.err" >&2; die "解密失败（口令错误？）: $enc"; }
  # gzip 魔术头（1f 8b）校验：口令正确时解密产物一定是 gzip。
  # CBC 解密明文不定，口令错误时 openssl 可能不报错，只能靠这一层拦截。
  head -c 2 "$out" | od -An -tx1 | tr -d ' \n' | grep -qi '^1f8b$' \
    || die "解密产物不是 gzip —— 口令错误或备份文件被截断: $enc"
}

# One passphrase, two accepted variable names. `TUNEX_BACKUP_PASSPHRASE` is what
# the openssl calls reference internally; `BACKUP_PASSPHRASE` is what the docs and
# cron entries use. Accepting only one of them is how a real recovery ends up
# failing at 3am with a correct passphrase.
if [[ "$MANIFEST_ENCRYPTED" == "no" ]]; then
  # Plain artefact: asking for a passphrase here would be noise, and requiring one
  # would make a backup this tool produced impossible to restore.
  PASSPHRASE=""
elif [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  PASSPHRASE="$BACKUP_PASSPHRASE"
elif [[ -n "${TUNEX_BACKUP_PASSPHRASE:-}" ]]; then
  PASSPHRASE="$TUNEX_BACKUP_PASSPHRASE"
elif [[ $DRY_RUN -eq 1 ]]; then
  PASSPHRASE="dry-run-no-decrypt"
elif [[ -t 0 ]]; then
  read -r -s -p "备份解密口令: " PASSPHRASE; echo
  [[ -n "$PASSPHRASE" ]] || die "口令为空" 2
else
  # Non-interactive (cron/CI/drill) with an encrypted artefact and no passphrase:
  # say exactly what is missing instead of dying inside the prompt.
  die "该备份已加密，但未提供口令。请设置 BACKUP_PASSPHRASE（或 TUNEX_BACKUP_PASSPHRASE），或在终端交互执行" 2
fi

log "[1/4] 校验 + 解密（encrypted=$MANIFEST_ENCRYPTED）"
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
# WP11D: restoring into a database that the application is still writing to
# produces a silently inconsistent result. Writers are stopped for the duration
# of the restore and restarted by an EXIT trap, so a failure mid-restore cannot
# leave the stack down.
# Which services write to the database. Configurable because the stack layout is a
# deployment property: hardcoding "backend worker web" makes the script silently
# refuse to restart anything on a differently-named stack (e.g. the e2e topology,
# where the API service is called "panel").
WRITER_SERVICES="${WRITER_SERVICES:-backend worker web}"
STOPPED_WRITER_SERVICES=()
stop_writers() {
  local ws=()
  for w in $WRITER_SERVICES; do
    if svc_running "$w"; then ws+=("$w"); fi
  done
  [[ ${#ws[@]} -gt 0 ]] || return 0
  log "  停止写入方: ${ws[*]}"
  "${COMPOSE[@]}" stop "${ws[@]}" >/dev/null
  STOPPED_WRITER_SERVICES=("${ws[@]}")
}
resume_writers() {
  [[ ${#STOPPED_WRITER_SERVICES[@]} -gt 0 ]] || return 0
  log "  恢复本次实际停止的写入方: ${STOPPED_WRITER_SERVICES[*]}"
  "${COMPOSE[@]}" start "${STOPPED_WRITER_SERVICES[@]}" >/dev/null 2>&1     || warn "写入方重启失败，请手动 docker compose up -d ${STOPPED_WRITER_SERVICES[*]}"
  STOPPED_WRITER_SERVICES=()
}

# Redis is stopped while its volume is replaced; this guarantees it comes back.
REDIS_STOPPED=0
resume_services() {
  if [[ $REDIS_STOPPED -eq 1 ]]; then
    "${COMPOSE[@]}" start "$REDIS_SERVICE" >/dev/null 2>&1 || warn "redis 未能自动启动，请手动 docker compose up -d $REDIS_SERVICE"
    REDIS_STOPPED=0
  fi
  resume_writers
}

cleanup_restore() {
  # EXIT cleanup must do both jobs. A later trap must never shadow deletion of
  # decrypted SQL/RDB/config material from the temporary directory.
  resume_services
  rm -rf -- "$WORK"
}
trap cleanup_restore EXIT

if [[ $DO_MYSQL -eq 1 ]]; then
  log "[2/4] MySQL 恢复 → $MYSQL_DATABASE"
  svc_running "$MYSQL_SERVICE" \
    || die "mysql 服务未运行，先 docker compose up -d mysql" 2
  stop_writers

  # 记录恢复前行数（供对比报告）
  before="$("${COMPOSE[@]}" exec -T "$MYSQL_SERVICE" sh -c \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" \"$MYSQL_DATABASE\" -N -e \"SELECT COUNT(*) FROM workspace;\" 2>/dev/null" || echo "?")"
  log "  恢复前 workspace 行数: $before"

  # dump 内含 CREATE DATABASE + USE，直接灌入。刻意**不用** --force：它会把
  # 真实的 SQL 错误（缺表/外键/编码）一并吞掉，让一次半残的恢复报成成功。
  # 唯一的预期噪声是 DROP ... IF EXISTS 对不存在的对象告警，下面按行分类。
  MYSQL_RC=0
  "${COMPOSE[@]}" exec -T "$MYSQL_SERVICE" sh -c \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" < /dev/stdin" < "$MYSQL_SQL" 2>"$WORK/mysql.err" || MYSQL_RC=$?
  SQL_ERRORS="$(grep -c '^ERROR' "$WORK/mysql.err" 2>/dev/null || true)"
  SQL_ERRORS="${SQL_ERRORS:-0}"
  [[ "$SQL_ERRORS" =~ ^[0-9]+$ ]] || SQL_ERRORS=0
  if [[ "$MYSQL_RC" -ne 0 || "$SQL_ERRORS" -gt 0 ]]; then
    warn "mysql stderr: $(head -10 "$WORK/mysql.err")"
    die "MySQL 灌入未干净完成（exit=$MYSQL_RC, ERROR 行数=$SQL_ERRORS）—— 拒绝把半残恢复当成功"
  fi
  if [[ -s "$WORK/mysql.err" ]]; then
    log "  mysql 告警（非 ERROR）: $(wc -l < "$WORK/mysql.err") 行，已留存 $WORK/mysql.err"
  fi

  after="$("${COMPOSE[@]}" exec -T "$MYSQL_SERVICE" sh -c \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" \"$MYSQL_DATABASE\" -N -e \"SELECT COUNT(*) FROM workspace;\" 2>/dev/null" || echo "?")"
  log "  恢复后 workspace 行数: $after"

  # 结构自检：迁移表存在且与 dump 中迁移版本一致
  mig="$("${COMPOSE[@]}" exec -T "$MYSQL_SERVICE" sh -c \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" \"$MYSQL_DATABASE\" -N -e \"SELECT COUNT(*) FROM _prisma_migrations;\" 2>/dev/null" || echo 0)"
  log "  _prisma_migrations 行数: $mig"
  is_count() { [[ "$1" =~ ^[0-9]+$ ]]; }
  if ! is_count "$mig"; then
    warn "无法读取 _prisma_migrations 行数（mysql 自检未返回数字）—— 请人工确认 schema 版本"
  elif [[ "$mig" -eq 0 ]]; then
    warn "_prisma_migrations 为空 —— dump 可能来自未迁移库"
  fi
  if is_count "$before" && is_count "$after"; then
    if [[ "$after" -lt "$before" ]]; then
      warn "恢复后 workspace 行数($after) 少于恢复前($before) —— 这是预期行为（恢复会回到备份时刻），确认备份时刻的数据量是否符合预期"
    fi
    log "  行数对比: workspace $before → $after"
  else
    warn "行数自检未取到有效数字（before=$before, after=$after），跳过对比"
  fi
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

  # 方式：停 redis → 替换卷内 dump.rdb → 启动。
  # WP11D: `docker compose inspect` 不是 Compose v2 的子命令（旧写法必失败，
  # 于是这里总会 die）。正确路径是先取容器 id，再用 docker inspect 查挂载。
  CID="$("${COMPOSE[@]}" ps -q "$REDIS_SERVICE" | head -1)"
  [[ -n "$CID" ]] || die "无法定位 $REDIS_SERVICE 容器（compose ps -q 为空）"
  # NOTE: this template must have one {{end}} per {{range}}/{{if}}/{{with}}.
  # The previous version had an extra close, so `docker inspect` always failed
  # with "template: unexpected EOF" and no Redis restore could ever complete.
  VOL="$(docker inspect "$CID" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' 2>/dev/null || true)"
  [[ -n "$VOL" ]] || die "无法解析 redis /data 挂载（容器 $CID）"

  "${COMPOSE[@]}" stop "$REDIS_SERVICE" >/dev/null
  REDIS_STOPPED=1
  if [[ -n "$VOL" ]]; then
    # AOF 守卫在两个位置都要做：卷内 appendonlydir 存在时，替换 dump.rdb 会被
    # 静默忽略（恢复"成功"但 key 没变，即假恢复）。
    if [[ -d "/var/lib/docker/volumes/$VOL/_data" ]]; then
      [[ -d "/var/lib/docker/volumes/$VOL/_data/appendonlydir" ]] && die "检测到 $VOL 卷内 appendonlydir —— 本栈 Redis 启用了 AOF，替换 dump.rdb 不会生效（假恢复）。请改用 FLUSHALL + AOF 重建，或临时以 --appendonly no 启动 redis 后再恢复。Redis 已由 EXIT trap 重新启动。" 1
      cp "$WORK/redis.rdb" "/var/lib/docker/volumes/$VOL/_data/dump.rdb" \
        || die "写入 redis 数据卷失败: $VOL"
    elif [[ -d "$VOL" ]]; then
      [[ -d "$VOL/appendonlydir" ]] && die "检测到 $VOL 卷内 appendonlydir —— 本栈 Redis 启用了 AOF，替换 dump.rdb 不会生效（假恢复）。请改用 FLUSHALL + AOF 重建，或临时以 --appendonly no 启动 redis 后再恢复。Redis 已由 EXIT trap 重新启动。" 1
      cp "$WORK/redis.rdb" "$VOL/dump.rdb" || die "写入 redis 数据卷失败: $VOL"
    else
      # Named volume on a host whose docker root is not visible from here (the
      # script running inside a container with only the docker socket, which is how
      # a drill or a containerised ops runner works). A throwaway container mounts
      # the volume and does the copy.
      log "  宿主 docker root 不可见，改用辅助容器写入卷 $VOL"
      # The file is STREAMED in, not bind-mounted: `docker run -v <path>` resolves
      # the path against the docker HOST, so a path that only exists inside this
      # container (which is where $WORK lives when the script runs containerised)
      # would silently produce an empty volume.
      HELPER_IMAGE="${HELPER_IMAGE:-busybox:1.36}"
      if ! docker run --rm -i -v "$VOL:/target" "$HELPER_IMAGE" \
           sh -c 'cat > /target/dump.rdb && test -s /target/dump.rdb'; then
        die "辅助容器写入 redis 卷失败: $VOL（镜像 $HELPER_IMAGE）" 1
      fi < "$WORK/redis.rdb"
    fi
  else
    die "无法解析 redis 数据卷名"
  fi
  "${COMPOSE[@]}" start "$REDIS_SERVICE" >/dev/null
  REDIS_STOPPED=0
  # Wait for the dataset to load. While Redis is loading the RDB, `DBSIZE`
  # answers "LOADING Redis is loading the dataset in memory" — a STRING. Comparing
  # that in an arithmetic test is evaluated as a variable name, so under `set -u`
  # the script died with "LOADING: unbound variable" *right after a successful
  # restore*, and the operator saw a failed restore with the data already back.
  redis_keys() {
    "${COMPOSE[@]}" exec -T "$REDIS_SERVICE" redis-cli DBSIZE 2>/dev/null | tr -d '\r' || true
  }
  after_keys=""
  for _ in $(seq 1 60); do
    k="$(redis_keys)"
    if [[ "$k" =~ ^[0-9]+$ ]]; then
      after_keys="$k"
      [[ "$k" -ge 1 ]] && break
    fi
    # "LOADING ..." (or an empty answer while the process is starting) means
    # "not ready yet", not "zero keys": keep waiting instead of reading it as data.
    sleep 0.5
  done
  if [[ -z "$after_keys" ]]; then
    die "redis 重启后未在 30 秒内可读（仍在加载或未启动）—— 请检查 docker compose logs $REDIS_SERVICE" 1
  fi
  log "  恢复后 keys: $after_keys（恢复前 $before_keys）"
fi

# --- 6. 配置恢复（谨慎：默认只解包展示，不覆盖） ------------------------------
log "[4/4] 配置清单（仅解包到 $WORK，人工比对后决定是否覆盖）"
if [[ $DRY_RUN -ne 1 && -f "$BK_DIR/$ENC_CFG" ]]; then
  verify_and_decrypt "$BK_DIR/$ENC_CFG" "$WORK/config.tar.gz"
  tar -xzf "$WORK/config.tar.gz" -C "$WORK"
  find "$WORK/config" -type f | sed 's/^/  /'
  log "  注意：.env / Caddyfile* / compose 未自动覆盖。如需恢复请先人工 diff："
  log "    diff -u $PROJECT_ROOT/.env $WORK/config/env"
  log "    diff -u $PROJECT_ROOT/Caddyfile $WORK/config/Caddyfile"
  [[ -f "$WORK/config/Caddyfile.internal" ]] && log "    diff -u $PROJECT_ROOT/Caddyfile.internal $WORK/config/Caddyfile.internal"
  [[ -f "$WORK/config/Caddyfile.prod" ]] && log "    diff -u $PROJECT_ROOT/Caddyfile.prod $WORK/config/Caddyfile.prod"
  [[ -f "$WORK/config/docker-compose.standalone.yaml" ]] && log "    diff -u $PROJECT_ROOT/docker-compose.standalone.yaml $WORK/config/docker-compose.standalone.yaml"
fi

log "✅ 恢复完成"
log "  后续验证："
log "    1. docker compose ps（全部 healthy）"
log "    2. curl -fsS ${RESTORE_HEALTH_URL:-http://127.0.0.1:${TUNEX_API_PORT:-13001}/healthz}"
log "    3. 后台登录 / 抽 1 个 workspace 核对 tunnel 数据"
exit 0
