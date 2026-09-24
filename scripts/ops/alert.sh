#!/usr/bin/env bash
# ============================================================================
# TuneX OPS-02 —— 健康巡检与告警脚本
#
# 检查项（每项独立阈值，任意一项超阈值 → 告警）：
#   DISK   ：分区使用率（默认 85% 告警、92% 严重）
#   MEMORY ：系统可用内存占比（可用 < 10% 告警）+ Swap 使用率（> 50% 告警）
#   MYSQL_CONN：数据库连接使用率（Threads_connected / max_connections）
#   MYSQL_QPS：近 1 秒查询量绝对值（异常突发检测，默认 500）
#   MYSQL_BUFFER：InnoDB buffer pool 命中率（< 95% 告警，预示内存不足）
#   MYSQL_SIZE：业务库体积增长基线（单库 > 50GB 提示评估分库/归档）
#   REDIS_MEM：Redis 内存使用率（used_memory / maxmemory；未设上限时用系统内存占比）
#   REDIS_KEYS：key 数量突增（> 10万 提示检查 TTL/缓存击穿）
#   REDIS_EVICT：有 key 被逐出（maxmemory-policy 触发）→ 严重
#   CONTAINER：compose 服务全部 running 且（如定义了 healthcheck）healthy
#   CERT   ：Caddy HTTPS 证书剩余有效期（< 14 天告警；未启用 TLS 时跳过）
#   BACKUP ：最新备份距今小时数（> 25h 告警 —— 说明 cron 没跑）
#
# 通知渠道（按优先级）：
#   1. ALERT_WEBHOOK（钉钉/企微/Slack 兼容 JSON：{"text": ...}）
#   2. 宝塔通知通道（若检测到 bt panel）
#   3. 本地告警日志 var/alerts/alerts.log（始终写入，作为审计轨迹）
#
# 去重：同一 check + 同一级别在 ALERT_DEDUPE_SECONDS（默认 3600）内不重复告警，
#       状态文件 var/alerts/state.json。
#
# 用法：
#   scripts/ops/alert.sh              # 巡检一次
#   scripts/ops/alert.sh --status     # 只看当前指标，不发告警
#   ALERT_WEBHOOK=https://... scripts/ops/alert.sh
# crontab: */5 * * * * cd /opt/TuneX-email-auth && scripts/ops/alert.sh
#
# 退出码：0 全部正常；1 有告警；2 环境错误。
# ============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_ROOT/docker-compose.yaml}"
ALERT_DIR="${ALERT_DIR:-$PROJECT_ROOT/var/alerts}"
MYSQL_SERVICE="${MYSQL_SERVICE:-mysql}"
REDIS_SERVICE="${REDIS_SERVICE:-redis}"
MYSQL_DATABASE="${MYSQL_DATABASE:-tunex}"

# --- 阈值（环境变量可覆盖） --------------------------------------------------
DISK_WARN="${DISK_WARN:-85}";                DISK_CRIT="${DISK_CRIT:-92}"
MEM_AVAIL_WARN="${MEM_AVAIL_WARN:-10}"       # 可用内存 %
SWAP_WARN="${SWAP_WARN:-50}"                 # swap 使用 %
MYSQL_CONN_WARN="${MYSQL_CONN_WARN:-70}"     # 连接使用率 %
MYSQL_CONN_CRIT="${MYSQL_CONN_CRIT:-90}"
MYSQL_QPS_WARN="${MYSQL_QPS_WARN:-500}"
MYSQL_BUFFER_WARN="${MYSQL_BUFFER_WARN:-95}" # 命中率 %
MYSQL_DB_SIZE_WARN_GB="${MYSQL_DB_SIZE_WARN_GB:-50}"
REDIS_MEM_WARN="${REDIS_MEM_WARN:-85}"       # 相对 maxmemory %
REDIS_KEYS_WARN="${REDIS_KEYS_WARN:-100000}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"
ALERT_DEDUPE_SECONDS="${ALERT_DEDUPE_SECONDS:-3600}"
STATUS_ONLY=0
[[ "${1:-}" == "--status" ]] && STATUS_ONLY=1
[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && { sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

mkdir -p "$ALERT_DIR"
STATE_FILE="$ALERT_DIR/state.json"
LOG_FILE="$ALERT_DIR/alerts.log"
[[ -f "$STATE_FILE" ]] || echo '{}' > "$STATE_FILE"

log()  { printf '[alert] %s\n' "$*"; }
die()  { printf '[alert] ERROR: %s\n' "$*" >&2; exit 2; }

command -v docker >/dev/null 2>&1 || die "docker 不在 PATH"
docker compose version >/dev/null 2>&1 || die "docker compose v2 不可用"
[[ -f "$COMPOSE_FILE" ]] || die "compose 不存在: $COMPOSE_FILE"

# --- 通知 --------------------------------------------------------------------
NOW_S="$(date +%s)"
send_alert() {  # $1=severity $2=check $3=message
  local sev="$1" check="$2" msg="$3"
  local key="${check}:${sev}"
  # 去重
  if [[ -f "$STATE_FILE" ]] && command -v jq >/dev/null 2>&1; then
    local last; last="$(jq -r --arg k "$key" '.[$k] // 0' "$STATE_FILE")"
    if [[ $((NOW_S - last)) -lt $ALERT_DEDUPE_SECONDS && "$sev" != "critical" ]]; then
      log "去重跳过（${ALERT_DEDUPE_SECONDS}s 内已告警）: $key"
      return 0
    fi
    jq --arg k "$key" --argjson t "$NOW_S" '.[$k]=$t' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
  fi
  local line="[$(date -Iseconds)] [$sev] [$check] $msg"
  echo "$line" >> "$LOG_FILE"
  [[ $STATUS_ONLY -eq 1 ]] && { log "$line"; return 0; }
  if [[ -n "$ALERT_WEBHOOK" ]]; then
    curl -fsS -m 10 -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg m "[TuneX][$sev][$check] $msg" '{msgtype:"text",text:{content:$m}}')" \
      "$ALERT_WEBHOOK" >/dev/null 2>&1 || log "webhook 投递失败"
  fi
  ALERTS_FIRED=$((ALERTS_FIRED+1))
}
ALERTS_FIRED=0

# --- 结果记录 ----------------------------------------------------------------
declare -a RESULTS=()
record() { RESULTS+=("$1|$2|$3"); printf '  %-14s %-8s %s\n' "$1" "$2" "$3"; }

# ============================================================================
# 1. 磁盘
# ============================================================================
log "== 磁盘 =="
df -P / | awk 'NR==2{gsub("%","",$5); print $5}' | while read -r pct; do
  if   [[ "$pct" -ge $DISK_CRIT ]]; then send_alert critical DISK "根分区使用率 ${pct}% ≥ ${DISK_CRIT}%"
  elif [[ "$pct" -ge $DISK_WARN  ]]; then send_alert warning  DISK "根分区使用率 ${pct}% ≥ ${DISK_WARN}%"
  else record DISK ok "${pct}% used"
  fi
done
# docker 卷单独看（备份 + 数据都在这里）
DOCKER_PCT="$(df -P /var/lib/docker 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $5}' || echo 0)"
[[ "$DOCKER_PCT" -ge $DISK_WARN ]] && send_alert warning DISK "/var/lib/docker 使用率 ${DOCKER_PCT}% (数据+备份卷)" || record DISK-docker ok "${DOCKER_PCT}% used"

# ============================================================================
# 2. 内存 / Swap
# ============================================================================
log "== 内存 =="
read -r MEM_TOTAL MEM_AVAIL SWAP_TOTAL SWAP_FREE < <(free -b | awk '/^Mem:/{t=$2;a=$7} /^Swap:/{st=$2;sf=$4} END{print t,a,st,sf+0}')
MEM_AVAIL_PCT=$(( MEM_AVAIL * 100 / MEM_TOTAL ))
SWAP_USED_PCT=0; [[ "$SWAP_TOTAL" -gt 0 ]] && SWAP_USED_PCT=$(( (SWAP_TOTAL - SWAP_FREE) * 100 / SWAP_TOTAL ))
if   [[ "$MEM_AVAIL_PCT" -le 5  ]]; then send_alert critical MEM "可用内存 ${MEM_AVAIL_PCT}%（总 ${MEM_TOTAL}B 仅剩 ${MEM_AVAIL}B）"
elif [[ "$MEM_AVAIL_PCT" -le $MEM_AVAIL_WARN ]]; then send_alert warning MEM "可用内存 ${MEM_AVAIL_PCT}% ≤ ${MEM_AVAIL_WARN}%"
else record MEMORY ok "avail ${MEM_AVAIL_PCT}%"
fi
[[ "$SWAP_USED_PCT" -ge $SWAP_WARN ]] && send_alert warning SWAP "Swap 使用 ${SWAP_USED_PCT}%（内存压力信号）" || record SWAP ok "used ${SWAP_USED_PCT}%"

# ============================================================================
# 3. MySQL
# ============================================================================
log "== MySQL =="
cd "$PROJECT_ROOT" 2>/dev/null || true
if [[ -f "$PROJECT_ROOT/.env" ]]; then set -a; . "$PROJECT_ROOT/.env"; set +a; fi
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


if svc_running "$MYSQL_SERVICE"; then
  MYSQLQ() { "${COMPOSE[@]}" exec -T "$MYSQL_SERVICE" sh -c \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -N -e \"$1\"" 2>/dev/null | tr -d '\r'; }

  # 连接数
  MAXCONN="$(MYSQLQ 'SHOW VARIABLES LIKE "max_connections"' | awk '{print $2}')"
  CONNS="$(MYSQLQ 'SHOW GLOBAL STATUS LIKE "Threads_connected"' | awk '{print $2}')"
  if [[ -n "$MAXCONN" && -n "$CONNS" && "$MAXCONN" -gt 0 ]]; then
    CONN_PCT=$(( CONNS * 100 / MAXCONN ))
    if   [[ "$CONN_PCT" -ge $MYSQL_CONN_CRIT ]]; then send_alert critical MYSQL_CONN "连接 ${CONNS}/${MAXCONN}（${CONN_PCT}%）—— 新连接将被拒绝"
    elif [[ "$CONN_PCT" -ge $MYSQL_CONN_WARN ]]; then send_alert warning  MYSQL_CONN "连接 ${CONNS}/${MAXCONN}（${CONN_PCT}%）"
    else record MYSQL_CONN ok "${CONNS}/${MAXCONN} (${CONN_PCT}%)"
    fi
  fi
  # QPS
  Q1="$(MYSQLQ 'SHOW GLOBAL STATUS LIKE "Questions"' | awk '{print $2}')"; sleep 1
  Q2="$(MYSQLQ 'SHOW GLOBAL STATUS LIKE "Questions"' | awk '{print $2}')"
  if [[ -n "$Q1" && -n "$Q2" && "$Q2" -gt "$Q1" ]]; then
    QPS=$((Q2-Q1))
    [[ "$QPS" -ge $MYSQL_QPS_WARN ]] && send_alert warning MYSQL_QPS "QPS=${QPS} ≥ ${MYSQL_QPS_WARN}（疑似突发流量/慢查询风暴）" || record MYSQL_QPS ok "$QPS q/s"
  fi
  # Buffer pool 命中率
  READ_REQ="$(MYSQLQ 'SHOW GLOBAL STATUS LIKE "Innodb_buffer_pool_read_requests"' | awk '{print $2}')"
  READ_DISK="$(MYSQLQ 'SHOW GLOBAL STATUS LIKE "Innodb_buffer_pool_reads"' | awk '{print $2}')"
  if [[ -n "$READ_REQ" && "$READ_REQ" -gt 1000 && -n "$READ_DISK" ]]; then
    HIT=$(( (READ_REQ - READ_DISK) * 100 / READ_REQ ))
    [[ "$HIT" -lt $MYSQL_BUFFER_WARN ]] && send_alert warning MYSQL_BUFFER "Buffer pool 命中率 ${HIT}% < ${MYSQL_BUFFER_WARN}%（考虑增大 innodb_buffer_pool_size）" || record MYSQL_BUFFER ok "${HIT}% hit"
  else record MYSQL_BUFFER ok "采样不足" ; fi
  # 库体积
  DB_MB="$(MYSQLQ "SELECT ROUND(SUM(data_length+index_length)/1024/1024) FROM information_schema.tables WHERE table_schema='$MYSQL_DATABASE'" | awk '{print int($1)}')"
  if [[ -n "$DB_MB" && "$DB_MB" -gt $((MYSQL_DB_SIZE_WARN_GB * 1024)) ]]; then
    send_alert warning MYSQL_SIZE "库体积 ${DB_MB}MB > ${MYSQL_DB_SIZE_WARN_GB}GB —— 评估归档/分库"
  else record MYSQL_SIZE ok "${DB_MB}MB"; fi
else
  send_alert critical MYSQL "mysql 服务未运行"
fi

# ============================================================================
# 4. Redis
# ============================================================================
log "== Redis =="
if svc_running "$REDIS_SERVICE"; then
  RINFO() { "${COMPOSE[@]}" exec -T "$REDIS_SERVICE" redis-cli INFO "$1" 2>/dev/null | tr -d '\r'; }
  RCFG()  { "${COMPOSE[@]}" exec -T "$REDIS_SERVICE" redis-cli CONFIG GET "$1" 2>/dev/null | tr -d '\r' | tail -1; }

  MAXMEM="$(RCFG maxmemory)"
  USEDMEM="$(awk -F: '/^used_memory:/{print $2}' <<<"$(RINFO memory)")"
  if [[ "$MAXMEM" =~ ^[0-9]+$ && "$MAXMEM" -gt 0 && -n "$USEDMEM" ]]; then
    MEM_PCT=$(( USEDMEM * 100 / MAXMEM ))
    [[ "$MEM_PCT" -ge $REDIS_MEM_WARN ]] && send_alert warning REDIS_MEM "内存 ${MEM_PCT}% of maxmemory —— 将开始逐出 key" || record REDIS_MEM ok "${MEM_PCT}% of maxmemory"
  else record REDIS_MEM ok "$(( USEDMEM / 1024 / 1024 ))MB (无 maxmemory 上限)"; fi

  KEYS="$(RINFO keyspace | awk -F'keys=' '/^db0:/{print $2}' | awk -F, '{print $1}')"
  [[ -z "$KEYS" ]] && KEYS=0
  [[ "$KEYS" -ge $REDIS_KEYS_WARN ]] && send_alert warning REDIS_KEYS "key 数 ${KEYS} ≥ ${REDIS_KEYS_WARN}（检查 TTL/缓存）" || record REDIS_KEYS ok "$KEYS keys"

  EVICTED="$(awk -F: '/^evicted_keys:/{print $2}' <<<"$(RINFO stats)")"
  [[ "${EVICTED:-0}" -gt 0 ]] && send_alert critical REDIS_EVICT "已有 ${EVICTED} 个 key 被逐出（maxmemory-policy 生效，会话/缓存丢失）" || record REDIS_EVICT ok "0 evicted"
else
  send_alert critical REDIS "redis 服务未运行"
fi

# ============================================================================
# 5. 容器状态 + 备份新鲜度 + 证书
# ============================================================================
log "== 服务 / 备份 / 证书 =="
if [[ -f "$COMPOSE_FILE" ]]; then
  EXPECTED="$("${COMPOSE[@]}" config --services 2>/dev/null | tr '\n' ' ')"
  RUNNING="$("${COMPOSE[@]}" ps --status running --format '{{.Service}}' 2>/dev/null | tr '\n' ' ')"
  MISSING=""
  for s in $EXPECTED; do
    case " $RUNNING " in *" $s "*) ;; *) MISSING="$MISSING $s" ;; esac
  done
  if [[ -n "$MISSING" ]]; then
    send_alert critical CONTAINER "服务未运行:$MISSING"
  else record CONTAINER ok "$(echo $RUNNING | wc -w) services running"; fi

  # 备份新鲜度：找最新 manifest
  LATEST="$(find "$PROJECT_ROOT/var/backups" -name '*.manifest.json' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | awk '{print $2}')"
  if [[ -z "$LATEST" ]]; then
    [[ $STATUS_ONLY -eq 1 ]] || send_alert warning BACKUP "从未成功备份过（var/backups 为空）—— cron 是否配置？"
    record BACKUP warn "无备份记录"
  else
    AGE_H=$(( (NOW_S - $(stat -c %Y "$LATEST")) / 3600 ))
    [[ "$AGE_H" -ge $BACKUP_MAX_AGE_HOURS ]] && send_alert warning BACKUP "最新备份已 ${AGE_H}h 前（> ${BACKUP_MAX_AGE_HOURS}h）—— 检查 cron" || record BACKUP ok "${AGE_H}h 前"
  fi
fi

# 证书：若 Caddy 用 443 且有站点域名，尝试读 caddy 卷内证书到期（best-effort）
CADDY_DIR="$(find /var/lib/docker/volumes -maxdepth 1 -name 'tunex-caddy-data*' 2>/dev/null | head -1)"
if [[ -n "${CADDY_DIR:-}" && -d "$CADDY_DIR/_data" ]]; then
  DAYS_MIN=9999
  while IFS= read -r crt; do
    d="$(openssl x509 -enddate -noout -in "$crt" 2>/dev/null | cut -d= -f2)" || continue
    exp="$(date -d "$d" +%s 2>/dev/null)" || continue
    days=$(( (exp - NOW_S) / 86400 ))
    [[ "$days" -lt "$DAYS_MIN" ]] && DAYS_MIN="$days"
  done < <(find "$CADDY_DIR/_data" -name '*.crt' 2>/dev/null)
  [[ "$DAYS_MIN" -lt 9999 ]] && {
    if [[ "$DAYS_MIN" -lt 7 ]]; then
      send_alert critical CERT "证书仅剩 ${DAYS_MIN} 天到期"
    elif [[ "$DAYS_MIN" -lt 14 ]]; then
      send_alert warning CERT "证书剩 ${DAYS_MIN} 天到期"
    else
      record CERT ok "${DAYS_MIN} 天"
    fi
  }
fi

# ============================================================================
# 汇总
# ============================================================================
echo
if [[ $STATUS_ONLY -eq 1 ]]; then
  log "（--status 模式：未发送告警）巡检完成"
  exit 0
fi
if [[ $ALERTS_FIRED -gt 0 ]]; then
  log "⚠️  本次触发 $ALERTS_FIRED 条告警，详见 $LOG_FILE"
  exit 1
fi
log "✅ 全部指标正常"
exit 0
