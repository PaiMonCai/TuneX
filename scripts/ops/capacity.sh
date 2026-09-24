#!/usr/bin/env bash
# ============================================================================
# TuneX OPS-02 —— 容量基线采集与测算
#
# 目的：把"单 workspace / 单节点 / 单租户"的资源消耗变成可量化数字，
#       为扩容决策、套餐限额、报价模型提供依据。采集结果写入 var/ops/capacity.json。
#
# 用法：
#   scripts/ops/capacity.sh            # 采集当前实例指标 + 输出单 workspace 摊算
#   scripts/ops/capacity.sh --baseline # 与历史基线对比（如有）
#
# 采集维度：
#   1. MySQL：库体积 / 行数 / 每 workspace 均值 / buffer pool 与内存占用
#   2. Redis：key 数、内存、TTL 命中（会话缓存 vs 限流计数）
#   3. 容器：CPU / 内存实测（docker stats）
#   4. 增长斜率：对比上次采集，估算 30/90 天后的体积与行数
#   5. 容量阈值建议：输出每 workspace 的资源账，给出扩容触发线
#
# 阈值口径（与 alert.sh 对齐；本脚本只做测算与建议，不发告警）。
# ============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_ROOT/docker-compose.yaml}"
OPS_DIR="${OPS_DIR:-$PROJECT_ROOT/var/ops}"
CAP_FILE="$OPS_DIR/capacity.json"
CAP_HIST="$OPS_DIR/capacity-history.jsonl"
MYSQL_SERVICE="${MYSQL_SERVICE:-mysql}"
REDIS_SERVICE="${REDIS_SERVICE:-redis}"
MYSQL_DATABASE="${MYSQL_DATABASE:-tunex}"

log()  { printf '[capacity] %s\n' "$*"; }
die()  { printf '[capacity] ERROR: %s\n' "$*" >&2; exit 2; }

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && { sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }
command -v docker >/dev/null 2>&1 || die "docker 不在 PATH"
mkdir -p "$OPS_DIR"

cd "$PROJECT_ROOT"
if [[ -f "$PROJECT_ROOT/.env" ]]; then set -a; . "$PROJECT_ROOT/.env"; set +a; fi
COMPOSE=(docker compose -p tunex -f "$COMPOSE_FILE")

# svc_running <service> —— 便携式"服务是否 running"检查。
# 不同 compose 版本对 `ps --status` 支持不一（v2.28 无该 flag），
# 因此统一解析 `ps --format '{{.Service}} {{.State}}'` 的第二列。
svc_running() {
  local svc="$1"
  "${COMPOSE[@]}" ps --format '{{.Service}} {{.State}}' 2>/dev/null \
    | awk -v s="$svc" '$1==s && $2 ~ /^running/ {found=1} END{exit found?0:1}'
}


# --- MySQL 采样 --------------------------------------------------------------
log "== MySQL =="
MYSQLQ() { "${COMPOSE[@]}" exec -T "$MYSQL_SERVICE" sh -c \
  "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -N -e \"$1\"" 2>/dev/null | tr -d '\r'; }

if svc_running "$MYSQL_SERVICE"; then
  DB_MB="$(MYSQLQ "SELECT ROUND(SUM(data_length+index_length)/1024/1024,1) FROM information_schema.tables WHERE table_schema='$MYSQL_DATABASE'")"
  WS="$(MYSQLQ 'SELECT COUNT(*) FROM workspace')"
  USERS="$(MYSQLQ 'SELECT COUNT(*) FROM user')"
  TUNNELS="$(MYSQLQ 'SELECT COUNT(*) FROM tunnel')"
  TRAFFIC_ROWS="$(MYSQLQ 'SELECT COUNT(*) FROM tunnel_traffic')"
  AUDIT_ROWS="$(MYSQLQ 'SELECT COUNT(*) FROM audit_log')"
  BPOOL_MB="$(MYSQLQ "SELECT ROUND(@@innodb_buffer_pool_size/1024/1024)")"
  log "  库体积 ${DB_MB}MB | workspace $WS | user $USERS | tunnel $TUNNELS"
  log "  流量记录 $TRAFFIC_ROWS | 审计 $AUDIT_ROWS | buffer pool ${BPOOL_MB}MB"

  # 每 workspace 均值（为 0 时给 1，避免除零）
  local_ws="$WS"; [[ "$local_ws" -gt 0 ]] || local_ws=1
  MB_PER_WS="$(awk -v a="$DB_MB" -v w="$local_ws" 'BEGIN{printf "%.2f", a/w}')"
  ROWS_PER_WS="$(awk -v a="$TRAFFIC_ROWS" -v w="$local_ws" 'BEGIN{printf "%.0f", a/w}')"
  log "  单 workspace 均值：${MB_PER_WS}MB，流量行 ${ROWS_PER_WS}/ws"
else
  die "mysql 未运行" 2
fi

# --- Redis 采样 --------------------------------------------------------------
log "== Redis =="
if svc_running "$REDIS_SERVICE"; then
  RINFO() { "${COMPOSE[@]}" exec -T "$REDIS_SERVICE" redis-cli INFO "$1" 2>/dev/null | tr -d '\r'; }
  RKEYS="$(RINFO keyspace | awk -F'keys=' '/^db0:/{print $2}' | awk -F, '{print $1}')"; [[ -n "$RKEYS" ]] || RKEYS=0
  RMEM_MB="$(awk -F: '/^used_memory:/{printf "%.1f", $2/1024/1024}' <<<"$(RINFO memory)")"
  TTL_KEYS="$(RINFO keyspace | awk -F'expires=' '/^db0:/{print $2}' | awk -F, '{print $1}')"; [[ -n "$TTL_KEYS" ]] || TTL_KEYS=0
  log "  keys $RKEYS（其中带 TTL $TTL_KEYS）| 内存 ${RMEM_MB}MB"
  [[ "$RKEYS" -gt 0 ]] && KB_PER_WS_R="$(awk -v k="$RKEYS" -v w="$local_ws" 'BEGIN{printf "%.1f", k/w}')" \
                       || KB_PER_WS_R="0"
  log "  单 workspace 摊算：${KB_PER_WS_R} keys"
fi

# --- 容器资源 ----------------------------------------------------------------
log "== 容器（docker stats 实测）=="
declare -A CPU_PCT=() MEM_MIB=()
for c in $("${COMPOSE[@]}" ps --status running -q 2>/dev/null); do
  name="$(docker inspect "$c" --format '{{.Name}}' | sed 's#^/##')"
  line="$(docker stats --no-stream --format '{{.CPUPerc}}\t{{.MemUsage}}' "$c" 2>/dev/null)"
  cpu="${line%%$'\t'*}"; mem="${line##*$'\t'}"
  mem_mib="$(awk '{gsub(/MiB|GiB/," "); print $1}' <<<"$mem")"
  unit="$(awk '{print $2}' <<<"$mem")"
  [[ "$unit" == "GiB" ]] && mem_mib="$(awk -v m="$mem_mib" 'BEGIN{printf "%.0f", m*1024}')"
  CPU_PCT[$name]="${cpu%\%}"; MEM_MIB[$name]="$mem_mib"
  printf '  %-18s cpu=%-7s mem=%s\n' "$name" "$cpu" "$mem"
done

TOTAL_CPU_PCT=0; TOTAL_MEM=0
for n in "${!CPU_PCT[@]}"; do TOTAL_CPU_PCT=$(( TOTAL_CPU_PCT + ${CPU_PCT[$n]%%.*} )); TOTAL_MEM=$(( TOTAL_MEM + ${MEM_MIB[$n]} )); done
log "  合计（粗略）：CPU ${TOTAL_CPU_PCT}%（4 核机器）| 内存 ${TOTAL_MEM}MiB"

# --- 增长斜率（需历史） ------------------------------------------------------
PREV_DB_MB=""; DAYS=0
if [[ -s "$CAP_HIST" ]]; then
  PREV="$(tail -1 "$CAP_HIST")"
  PREV_DB_MB="$(jq -r '.mysql.db_mb' <<<"$PREV")"
  PREV_AT="$(jq -r '.at_epoch' <<<"$PREV")"
  NOW_EPOCH="$(date +%s)"
  DAYS=$(( (NOW_EPOCH - PREV_AT) / 86400 ))
fi
MB_PER_DAY=""; PROJ30=""; PROJ90=""
if [[ -n "$PREV_DB_MB" && "$DAYS" -ge 1 ]]; then
  MB_PER_DAY="$(awk -v a="$DB_MB" -v b="$PREV_DB_MB" -v d="$DAYS" 'BEGIN{printf "%.2f", (a-b)/d}')"
  PROJ30="$(awk -v a="$DB_MB" -v r="$MB_PER_DAY" 'BEGIN{printf "%.0f", a + r*30}')"
  PROJ90="$(awk -v a="$DB_MB" -v r="$MB_PER_DAY" 'BEGIN{printf "%.0f", a + r*90}')"
  log "  增长斜率：${MB_PER_DAY}MB/天（对比 $DAYS 天前）→ 30 天 ${PROJ30}MB / 90 天 ${PROJ90}MB"
else
  log "  增长斜率：样本不足（需至少跨 1 天的两次采集；cron 每日跑即可积累）"
fi

# --- 阈值建议（单机容量上限） -------------------------------------------------
# 依据：4C8G 容器主机；MySQL 128MB buffer pool 起步；磁盘告警线 85%。
log "== 容量阈值建议 =="
cat <<EOF
  单 workspace 资源账（基于当前实测摊算）：
    MySQL 行数据      : ~${MB_PER_WS} MB/workspace（含流量与审计历史）
    Redis key         : ~${KB_PER_WS_R:-0} keys/workspace（全部带 TTL，可自然回收）
    MySQL 内存        : buffer pool ${BPOOL_MB}MB 起步，每 1GB 数据建议 +256MB
    CPU               : 当前 ${TOTAL_CPU_PCT}%/4 核，单 workspace 活动态 < 0.1 核
  扩容触发线（单机，超过即考虑分库/迁机）：
    workspace 数      : 2000（对应 MySQL ~${MB_PER_WS}MB×2000）
    tunnel 数         : 20000
    MySQL 体积        : 20GB（>50GB 强制告警，见 alert.sh）
    Redis key         : 500000（evicted_keys>0 立刻处理）
    CPU 持续          : >70% 持续 15 分钟
  结论（当前 $WS workspaces / $TUNNELS tunnels）：
EOF
awk -v ws="$WS" -v t="$TUNNELS" -v db="$DB_MB" 'BEGIN{
  printf "    距 workspace 上限 %.1f%%，距 tunnel 上限 %.1f%%，磁盘占用 %.1f%% —— ", ws/2000*100, t/20000*100, db/500*100;
  if (ws/2000 > 0.7 || t/20000 > 0.7) print "⚠️ 接近阈值，启动扩容评估"; else print "余量充足";
}'

# --- 落盘 --------------------------------------------------------------------
jq -nc \
  --arg at "$(date -Iseconds)" --argjson ae "$(date +%s)" \
  --argjson db_mb "${DB_MB:-0}" --argjson ws "$WS" --argjson users "$USERS" \
  --argjson tunnels "$TUNNELS" --argjson traffic "$TRAFFIC_ROWS" \
  --argjson audit "$AUDIT_ROWS" --argjson bpool "$BPOOL_MB" \
  --argjson rkeys "${RKEYS:-0}" --argjson rmem "${RMEM_MB:-0}" \
  --argjson mb_per_ws "${MB_PER_WS:-0}" --argjson keys_per_ws "${KB_PER_WS_R:-0}" \
  --argjson cpu "${TOTAL_CPU_PCT:-0}" --argjson mem "${TOTAL_MEM:-0}" \
  --arg mb_per_day "${MB_PER_DAY:-}" --arg proj30 "${PROJ30:-}" --arg proj90 "${PROJ90:-}" \
  '{at:$at, at_epoch:$ae,
    mysql:{db_mb:$db_mb, buffer_pool_mb:$bpool, workspaces:$ws, users:$users,
           tunnels:$tunnels, traffic_rows:$traffic, audit_rows:$audit,
           mb_per_workspace:$mb_per_ws},
    redis:{keys:$rkeys, mem_mb:$rmem, keys_per_workspace:$keys_per_ws},
    host:{cpu_pct:$cpu, mem_mib:$mem, cores:4, mem_total_mib:3915},
    growth:{days_sample:'$DAYS', mb_per_day:(if $mb_per_day=="" then null else ($mb_per_day|tonumber) end),
            proj_30d_mb:(if $proj30=="" then null else ($proj30|tonumber) end),
            proj_90d_mb:(if $proj90=="" then null else ($proj90|tonumber) end)},
    limits:{workspaces:2000, tunnels:20000, mysql_gb:20, redis_keys:500000}}' > "$CAP_FILE"
cp "$CAP_FILE" "$CAP_HIST.tmp" 2>/dev/null || true
cat "$CAP_FILE" >> "$CAP_HIST"
log "已写入 $CAP_FILE"
[[ "${1:-}" == "--baseline" && -s "$CAP_HIST" ]] && { echo; log "历史采样点：$(wc -l < "$CAP_HIST") 条"; }
log "✅ 完成"
