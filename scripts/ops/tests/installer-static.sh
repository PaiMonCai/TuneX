#!/usr/bin/env bash
# =============================================================================
# TuneX WP21 —— 安装器的可断言自检门（对应契约 §7 的 CI 作业 `installer-static`）
#
# 零 Docker 依赖、零网络依赖、不改机器状态：所有场景都在 mktemp 沙箱里跑，
# docker 侧的事实由 `--dry-run` 夹具（key=value 文件）回答。
#
# 覆盖（与契约 §6 DoD 的对应见每条用例名）：
#   A. 语法：bash -n / sh -n（DoD 12）
#   B. 静态红线：无 eval、无第三方加速域名、无 get.docker.com / curl|sh、无明文口令 argv、
#      不自建备份/迁移/回滚（DoD 12/13/14 的静态半边）
#   C. 纯函数单测：镜像引用校验（与 node-upgrade.ts 逐条 parity，DoD 16）、
#      .env 校验（DoD 5）、幂等三态（DoD 2/6）、Docker 指引（DoD 3）、备份口令非交互拒绝（DoD 10）
#   D. dry-run 全流程：install/upgrade/uninstall/status 的顺序、退出码与「零副作用」（DoD 1–3、7–11）
#   E. bootstrap 真克隆：tag 形态（浅克隆）与裸 SHA 形态（完整克隆 + 分离检出）+ 断言失败自清
#
# 用法： scripts/ops/tests/installer-static.sh [--verbose]
# 退出码：0 全绿；1 有用例失败。
# =============================================================================
set -Eeuo pipefail

TX_TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TX_ROOT="$(cd -- "$TX_TEST_DIR/../.." && pwd)"
TX_ROOT="$(cd -- "$TX_ROOT/.." && pwd)"
INSTALL="$TX_ROOT/scripts/ops/install.sh"
BOOTSTRAP="$TX_ROOT/scripts/ops/bootstrap.sh"
TS_NODE_UPGRADE="$TX_ROOT/backend/src/services/node-upgrade.ts"
BACKUP="$TX_ROOT/scripts/ops/backup.sh"
RESTORE="$TX_ROOT/scripts/ops/restore.sh"
ROOT_DOCKERFILE="$TX_ROOT/Dockerfile"
PROD_COMPOSE="$TX_ROOT/docker-compose.prod.yaml"
DEV_COMPOSE="$TX_ROOT/docker-compose.yaml"
VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

PASS=0
FAIL=0
LAST_OUT=""
LAST_RC=0

ok()   { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }
skip() { printf '  \033[33m-\033[0m %s\n' "$*"; }
group() { printf '\n== %s ==\n' "$*"; }

has() { # <子串> <描述>
  case "$LAST_OUT" in *"$1"*) ok "$2" ;; *) bad "$2（输出里没有 '$1'）"; dump ;; esac
}
hasnt() {
  case "$LAST_OUT" in *"$1"*) bad "$2（输出里不该出现 '$1'）"; dump ;; *) ok "$2" ;; esac
}
dump() { if [ "$VERBOSE" -eq 1 ]; then printf '%s\n' "$LAST_OUT" | sed 's/^/      | /'; fi; }
expect_rc() { # <期望> <描述>
  if [ "$LAST_RC" = "$1" ]; then ok "$2（exit=$LAST_RC）"; else bad "$2：期望 exit=$1，实际 $LAST_RC"; dump; fi
}

line_of() { printf '%s\n' "$LAST_OUT" | grep -n -F -- "$1" | head -1 | cut -d: -f1; }
before() { # <A> <B> <描述>：A 必须出现在 B 之前
  local a b
  a="$(line_of "$1")"; b="$(line_of "$2")"
  if [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; then ok "$3"; else bad "$3（'$1'@${a:-缺} vs '$2'@${b:-缺}）"; dump; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

# --- 沙箱：一个"像生产部署目录"的最小副本（真实 compose + 真实 .env 模板 + 真实 ops 脚本） ----
mk_sandbox() { # <目录>
  mkdir -p "$1/scripts/ops"
  cp "$TX_ROOT/docker-compose.prod.yaml" "$TX_ROOT/.env.production.example" "$1/"
  cp "$TX_ROOT/scripts/ops/backup.sh" "$TX_ROOT/scripts/ops/rollback.sh" "$1/scripts/ops/"
  chmod +x "$1/scripts/ops/"*.sh
}
SB="$TMP/sandbox"
mk_sandbox "$SB"
FIX="$TMP/fixtures"
mkdir -p "$FIX"
: > "$FIX/empty.env"

mkfix() { # <名字> <key=value...> → 打印夹具文件路径
  local name="$1"; shift
  local f="$FIX/$name.env"
  : > "$f"
  local kv
  for kv in "$@"; do printf '%s\n' "$kv" >> "$f"; done
  printf '%s' "$f"
}

run_install() { # <夹具文件|-> <沙箱> <参数...>
  local fx="$1" sb="$2"; shift 2
  LAST_RC=0
  LAST_OUT="$(env TUNEX_PROJECT_ROOT="$sb" TUNEX_DRYRUN_FIXTURES="$fx" bash "$INSTALL" "$@" 2>&1)" || LAST_RC=$?
  return 0
}

SHA_FAKE="0123456789abcdef0123456789abcdef01234567"

# =============================================================================
group "A. 语法（DoD 12：sh -n 与 bash -n 都过）"
# =============================================================================
for f in "$INSTALL" "$BOOTSTRAP"; do
  if bash -n "$f" 2>"$TMP/syn.err"; then ok "bash -n $(basename "$f")"; else bad "bash -n $(basename "$f")"; cat "$TMP/syn.err"; fi
  if sh -n "$f" 2>"$TMP/syn.err"; then ok "sh -n $(basename "$f")"; else bad "sh -n $(basename "$f")"; cat "$TMP/syn.err"; fi
  if [ -x "$f" ]; then ok "$(basename "$f") 可执行位"; else bad "$(basename "$f") 缺可执行位"; fi
done

# =============================================================================
group "B. 静态红线"
# 只看**可执行代码**：注释里可以讨论被禁的做法（例如解释"为什么不用 curl|sh"）。
code_lines() { grep -Ev '^[[:space:]]*#' "$1"; }
check_absent() { # <正则> <文件> <描述>
  local hits
  hits="$(code_lines "$2" | grep -En -- "$1" || true)"
  if [ -n "$hits" ]; then bad "$3"; printf '%s\n' "$hits" | head -3; else ok "$3"; fi
}
check_present() {
  # 用 grep -c（读完整个输入）而不是 -q：-q 提前退出会让上游 grep 拿到 SIGPIPE，
  # 配合 set -o pipefail 会把"匹配成功"误判成失败。
  local n
  n="$(code_lines "$2" | grep -Ec -- "$1" || true)"
  if [ "${n:-0}" -gt 0 ]; then ok "$3"; else bad "$3"; fi
}
for f in "$INSTALL" "$BOOTSTRAP"; do
  b="$(basename "$f")"
  check_absent 'eval[[:space:]]' "$f" "$b: 无 eval"
  check_absent 'poouo|ghproxy|gh-proxy|fastgit' "$f" "$b: 无第三方加速域名（FROZEN-4）"
  check_absent 'get\.docker\.com' "$f" "$b: 无 get.docker.com"
  check_absent 'curl[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(sh|bash)' "$f" "$b: 无 curl|sh"
  check_absent '--passphrase|-pass[[:space:]]+pass:' "$f" "$b: 口令不经 argv"
  check_absent '^[[:space:]]*(export[[:space:]]+)?(TUNEX_)?BACKUP_PASSPHRASE=' "$f" "$b: 无明文口令赋值"
  check_absent 'mysqldump|FLUSHALL|redis-cli|prisma[[:space:]]+migrate' "$f" "$b: 不自建备份/迁移（FROZEN-6）"
  check_absent 'crontab[[:space:]]+-' "$f" "$b: 不写 crontab"
  check_absent 'docker-compose\.yaml' "$f" "$b: 不把开发栈当安装目标"
done
check_absent 'tx_run[^\n]*restore\.sh|\$TX_PROJECT_ROOT/scripts/ops/restore\.sh' "$INSTALL" "install.sh: 不调用 restore.sh（数据层恢复是人工动作）"
check_present 'git[[:space:]]+-C[[:space:]]+"\$dir"[[:space:]]+rev-parse[[:space:]]+HEAD' "$BOOTSTRAP" "bootstrap: 以 rev-parse HEAD 断言收尾"
check_present 'clone[[:space:]]+--depth[[:space:]]+1[[:space:]]+--single-branch[[:space:]]+--branch' "$BOOTSTRAP" "bootstrap: ref 形态用浅克隆（--depth 1 --single-branch --branch）"
check_present 'checkout[[:space:]]+--detach' "$BOOTSTRAP" "bootstrap: 裸 SHA 形态用分离检出"
check_absent 'fetch[[:space:]]+--depth[[:space:]]+1[[:space:]]+origin' "$BOOTSTRAP" "bootstrap: 不依赖 fetch --depth 1 origin <sha>（服务器配置依赖，§4.0 裁决 4）"
check_present 'scripts/ops/backup\.sh' "$INSTALL" "install.sh: 备份调用既有 backup.sh（FROZEN-2/6）"
check_present 'scripts/ops/rollback\.sh' "$INSTALL" "install.sh: 失败回退调用既有 rollback.sh（FROZEN-2/6）"

# 恢复/镜像的生产不变量：这些错误通常只在真正事故恢复或容器逃逸面上暴露，
# 所以用静态 gate 钉死，不能只靠“脚本能解析”。
check_present 'STOPPED_WRITER_SERVICES=\(\)' "$RESTORE" "restore: 精确记录本次实际停止的 writer"
check_present 'start[[:space:]]+"\$\{STOPPED_WRITER_SERVICES\[@\]\}"' "$RESTORE" "restore: 只恢复本次实际停止的 writer"
check_present 'trap[[:space:]]+cleanup_restore[[:space:]]+EXIT' "$RESTORE" "restore: EXIT trap 使用组合 cleanup"
check_present 'rm[[:space:]]+-rf[[:space:]]+--[[:space:]]+"\$WORK"' "$RESTORE" "restore: EXIT cleanup 删除解密临时目录"
check_absent 'web_image=' "$BACKUP" "backup: VERSION 不记录已退役的独立 web 镜像"
check_present '^USER[[:space:]]+bun$' "$ROOT_DOCKERFILE" "unified image: 长期运行角色默认非 root"
check_present 'user:[[:space:]]+"0:0"' "$PROD_COMPOSE" "prod compose: db-migrate 显式提权"
check_present 'user:[[:space:]]+"0:0"' "$DEV_COMPOSE" "dev compose: db-migrate 显式提权"

# =============================================================================
group "C. 纯函数单测"
# =============================================================================
# shellcheck disable=SC1090
. "$INSTALL"

# C1 镜像引用校验（DoD 16：与 node-upgrade.ts 的结论逐条一致）
CASES="$TMP/cases.txt"
LONG300="$(printf 'a%.0s' $(seq 1 300))"
{
  printf '%s\n' \
    'ghcr.io/paimoncai/tunex-agent:abc123' \
    'ghcr.io/paimoncai/tunex:1.2.3' \
    'ghcr.io/paimoncai/tunex-agent@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    'ghcr.io/paimoncai/tunex-agent:abc@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
    'localhost:5000/tunex:dev' \
    'has space' \
    'evil;rm -rf /' \
    'evil$(id)' \
    'evil`id`' \
    'UPPER/Name:tag' \
    '' \
    "$LONG300"
} > "$CASES"
PARITY_OK=1
if command -v node >/dev/null 2>&1 && [ -f "$TS_NODE_UPGRADE" ]; then
  node -e '
    const fs=require("fs");
    const src=fs.readFileSync(process.argv[1],"utf8");
    const m=src.match(/const IMAGE_REF_RE\s*=\s*\n?\s*\/([\s\S]*?)\/;/);
    if(!m){console.error("IMAGE_REF_RE not found");process.exit(2)}
    const re=new RegExp(m[1]);
    const cases=fs.readFileSync(process.argv[2],"utf8").split("\n");
    const out=[];
    for(const c of cases){
      const t=c.trim();
      out.push((t!=="" && t.length<=255 && re.test(t))?"1":"0");
    }
    process.stdout.write(out.join("\n"));
  ' "$TS_NODE_UPGRADE" "$CASES" > "$TMP/ts-parity.txt" || PARITY_OK=0
  if [ "$PARITY_OK" -eq 1 ]; then
    n=0
    while IFS= read -r c; do
      n=$((n + 1))
      if tx_image_ref_valid "$c"; then shell_verdict=1; else shell_verdict=0; fi
      ts_verdict="$(sed -n "${n}p" "$TMP/ts-parity.txt")"
      if [ "$shell_verdict" = "$ts_verdict" ]; then
        ok "parity[$n] shell=$shell_verdict == node-upgrade.ts（案例：${c:0:48}）"
      else
        bad "parity[$n] shell=$shell_verdict != node-upgrade.ts=$ts_verdict（案例：${c:0:48}）"
      fi
    done < "$CASES"
  else
    bad "无法从 node-upgrade.ts 提取 IMAGE_REF_RE（parity 未执行）"
  fi
else
  skip "node 或 node-upgrade.ts 不可用：镜像引用 parity 未执行（静态断言仍覆盖形状）"
fi

# C2 幂等三态（DoD 2/6）
state_case() { # <has_env> <env_image> <count> <want> <期望>
  local got
  got="$(tx_classify_deploy_state "$1" "$2" "$3" "$4")"
  if [ "$got" = "$5" ]; then ok "三态：has_env=$1 image=${2:-空} 容器=$3 → $got"; else bad "三态：期望 $5，实际 $got"; fi
}
state_case 0 "" 0 "ghcr.io/paimoncai/tunex:$SHA_FAKE" none
state_case 1 "ghcr.io/paimoncai/tunex:$SHA_FAKE" 6 "ghcr.io/paimoncai/tunex:$SHA_FAKE" same
state_case 1 "ghcr.io/paimoncai/tunex:old" 6 "ghcr.io/paimoncai/tunex:new" different
state_case 1 "ghcr.io/paimoncai/tunex:$SHA_FAKE" 0 "ghcr.io/paimoncai/tunex:$SHA_FAKE" partial
state_case 0 "" 2 "ghcr.io/paimoncai/tunex:$SHA_FAKE" different

# C3 .env 校验（DoD 5）
ENV_GOOD="$TMP/env.good"
cat > "$ENV_GOOD" <<EOF
AUTH_SECRET=AbCdEf0123456789-_AbCdEf0123456789 # secret-scan:allow — deterministic installer test fixture
LICENSE_SECRET=AbCdEf0123456789-_AbCdEf0123456789 # secret-scan:allow — deterministic installer test fixture
TUNEX_CONFIG_KEY=AbCdEf0123456789-_AbCdEf0123456789 # secret-scan:allow — deterministic installer test fixture
TUNEX_LICENSE_KEY=AbCdEf0123456789-_AbCdEf0123456789 # secret-scan:allow — deterministic installer test fixture
MYSQL_ROOT_PASSWORD=AbCdEf0123456789-_AbCdEf0123456789
DATABASE_URL=mysql://root:AbCdEf0123456789-_AbCdEf0123456789@mysql:3306/tunex # secret-scan:allow — deterministic installer test fixture
SITE_URL=https://tunex.example.com
TUNEX_IMAGE=ghcr.io/paimoncai/tunex:$SHA_FAKE
TUNEX_AGENT_IMAGE=ghcr.io/paimoncai/tunex-agent:$SHA_FAKE
EOF
chmod 600 "$ENV_GOOD"
if findings="$(tx_env_validate "$ENV_GOOD")"; then ok "合法 .env 通过校验"; else bad "合法 .env 被判失败：$findings"; fi

ENV_MISSING="$TMP/env.missing"
grep -v '^AUTH_SECRET=' "$ENV_GOOD" > "$ENV_MISSING"; chmod 600 "$ENV_MISSING"
LAST_OUT="$(tx_env_validate "$ENV_MISSING" || true)"
has "missing:AUTH_SECRET" ".env 缺 AUTH_SECRET 被识别（只报键名）"
hasnt "AbCdEf" "缺失报告不含任何键值"

ENV_PLACEHOLDER="$TMP/env.placeholder"
sed 's/^TUNEX_IMAGE=.*/TUNEX_IMAGE=ghcr.io\/paimoncai\/tunex:replace-with-git-sha/' "$ENV_GOOD" > "$ENV_PLACEHOLDER"
chmod 600 "$ENV_PLACEHOLDER"
LAST_OUT="$(tx_env_validate "$ENV_PLACEHOLDER" || true)"
has "placeholder:TUNEX_IMAGE" ".env 的 replace-with 占位值被识别"

ENV_PERM="$TMP/env.perm"
cp "$ENV_GOOD" "$ENV_PERM"; chmod 644 "$ENV_PERM"
LAST_OUT="$(tx_env_validate "$ENV_PERM" || true)"
has "perms:644" ".env 权限非 600 被识别"

# C4 备份口令（DoD 10）
LAST_RC=0
LAST_OUT="$(unset BACKUP_PASSPHRASE; tx_check_backup_passphrase 0 2>&1)" || LAST_RC=$?
expect_rc 1 "非交互且无 BACKUP_PASSPHRASE：拒绝"
has "BACKUP_PASSPHRASE" "拒绝信息指明变量名"
has "非交互" "拒绝信息含『非交互』"
LAST_RC=0
LAST_OUT="$(BACKUP_PASSPHRASE=secret tx_check_backup_passphrase 0 2>&1)" || LAST_RC=$?
expect_rc 0 "给了 BACKUP_PASSPHRASE：放行"
LAST_OUT="$(BACKUP_PASSPHRASE=secret tx_check_backup_passphrase 1 2>&1)"
hasnt "非交互" "交互 TTY 时不打印拒绝文案"

# C5 Docker 指引（DoD 3：清晰指引、不代装）
LAST_OUT="$(tx_docker_guidance /etc/os-release 2>&1)"
has "https://docs.docker.com/engine/install/" "Docker 指引含官方文档"
has "不会替你安装 Docker" "Docker 指引明确不代装"
hasnt "get.docker.com" "Docker 指引不含 get.docker.com"
hasnt "curl" "Docker 指引不含 curl（不引导管道安装）"
DEB="$TMP/os-release.deb"; printf 'ID=ubuntu\n' > "$DEB"
LAST_OUT="$(tx_docker_guidance "$DEB" 2>&1)"
has "apt" "Ubuntu → apt 路径"
has "docker-compose-plugin" "Ubuntu → 指出 Compose v2 插件包"
RPM="$TMP/os-release.rpm"; printf 'ID=rocky\n' > "$RPM"
LAST_OUT="$(tx_docker_guidance "$RPM" 2>&1)"
has "dnf" "RHEL 系 → dnf 路径"

# C6 版本形态（bootstrap）
. "$BOOTSTRAP"
shape_case() { local got; got="$(tx_version_shape "$1")"; if [ "$got" = "$2" ]; then ok "形态：$1 → $got"; else bad "形态：$1 期望 $2 实际 $got"; fi; }
shape_case "$SHA_FAKE" sha
shape_case "0123456" sha
shape_case "v1.5.0" ref
shape_case "main" ref
shape_case "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01" ref
if tx_sha_matches "$SHA_FAKE" "$SHA_FAKE"; then ok "sha 断言：完整相等"; else bad "sha 断言：完整相等"; fi
if tx_sha_matches "$SHA_FAKE" "0123456"; then ok "sha 断言：短 sha 前缀匹配"; else bad "sha 断言：短 sha 前缀匹配"; fi
if tx_sha_matches "$SHA_FAKE" "fffffff"; then bad "sha 断言：不匹配必须为假"; else ok "sha 断言：不匹配为假"; fi

# C7 .env 真实生成路径（这是安装器里唯一会写密钥的代码）：权限 600、必需键齐全、
#     DATABASE_URL 内嵌同一口令、且与 compose 插值兼容（DoD 17 的安装器半边）。
SB_GEN="$TMP/gen"
mkdir -p "$SB_GEN"
cp "$TX_ROOT/docker-compose.prod.yaml" "$TX_ROOT/.env.production.example" "$SB_GEN/"
( TX_ENV_FILE="$SB_GEN/.env" TX_ENV_TEMPLATE="$SB_GEN/.env.production.example" \
  TX_PANEL_IMAGE="ghcr.io/paimoncai/tunex:$SHA_FAKE" \
  TX_AGENT_IMAGE_RESOLVED="ghcr.io/paimoncai/tunex-agent:$SHA_FAKE" \
  TX_AGENT_LATEST_VERSION_VALUE="$SHA_FAKE" \
  tx_env_generate >/dev/null 2>&1 )
if [ -f "$SB_GEN/.env" ]; then ok "真实生成 .env：产出文件"; else bad "真实生成 .env：没有文件"; fi
if [ "$(tx_env_perm_mode "$SB_GEN/.env")" = "600" ]; then ok "真实生成 .env：权限 600"; else bad "真实生成 .env：权限 $(tx_env_perm_mode "$SB_GEN/.env")"; fi
GEN_FINDINGS="$(tx_env_validate "$SB_GEN/.env" || true)"
if [ -z "$GEN_FINDINGS" ]; then ok "真实生成 .env：立刻通过安装器自己的校验"; else bad "真实生成 .env 未通过校验：$GEN_FINDINGS"; fi
GEN_PW="$(tx_env_get "$SB_GEN/.env" MYSQL_ROOT_PASSWORD)"
case "$(tx_env_get "$SB_GEN/.env" DATABASE_URL)" in
  *"$GEN_PW"*) ok "真实生成 .env：DATABASE_URL 内嵌同一个 root 口令（不回显值）" ;;
  *) bad "真实生成 .env：DATABASE_URL 与 MYSQL_ROOT_PASSWORD 不一致" ;;
esac
case "$(tx_env_get "$SB_GEN/.env" AUTH_SECRET)" in
  change-me*|replace-with*) bad "真实生成 .env：AUTH_SECRET 还是模板占位值" ;;
  "") bad "真实生成 .env：AUTH_SECRET 为空" ;;
  *) ok "真实生成 .env：AUTH_SECRET 已随机化（不打印值）" ;;
esac
if [ "$(tx_env_get "$SB_GEN/.env" TUNEX_IMAGE)" = "ghcr.io/paimoncai/tunex:$SHA_FAKE" ]; then
  ok "真实生成 .env：TUNEX_IMAGE 锚定到请求的 sha"
else
  bad "真实生成 .env：TUNEX_IMAGE 不对"
fi
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if ( cd "$SB_GEN" && docker compose -p tunex -f docker-compose.prod.yaml config -q ) 2>"$TMP/cfg.err"; then
    ok "真实生成 .env：docker compose config -q 通过（compose 插值兼容，DoD 17 的安装器半边）"
  else
    bad "真实生成 .env 与 compose 插值不兼容"; cat "$TMP/cfg.err"
  fi
else
  skip "docker compose 不可用：config -q 兼容性未执行"
fi

# C8 .env 写入器对特殊字符的健壮性（值经 ENVIRON 传入，不做 sed 替换）
SB_SET="$TMP/envset"
mkdir -p "$SB_SET"
printf 'B=old\n' > "$SB_SET/f"
tx_env_set "$SB_SET/f" B 'a=b&c/d+e_f-g'
if [ "$(tx_env_get "$SB_SET/f" B)" = 'a=b&c/d+e_f-g' ]; then ok "tx_env_set：含 = & / + 的值原样写入"; else bad "tx_env_set 改写了值：$(tx_env_get "$SB_SET/f" B)"; fi
tx_env_set "$SB_SET/f" NEWKEY 'plain'
if [ "$(tx_env_get "$SB_SET/f" NEWKEY)" = 'plain' ]; then ok "tx_env_set：缺键追加"; else bad "tx_env_set：缺键未追加"; fi
if [ "$(wc -l < "$SB_SET/f")" = "2" ]; then ok "tx_env_set：只改一行，不重复插入"; else bad "tx_env_set：行数异常（$(wc -l < "$SB_SET/f")）"; fi

# =============================================================================
group "D. dry-run 全流程（顺序 / 退出码 / 零副作用）"
# =============================================================================
FX_NONE="$FIX/empty.env"

# D1 干净机器 install 计划（DoD 1 的计划面）
run_install "$FX_NONE" "$SB" install --dry-run --version "$SHA_FAKE"
expect_rc 0 "干净机器 install --dry-run"
has "docker pull ghcr.io/paimoncai/tunex:$SHA_FAKE" "计划里先 pull 目标镜像"
has "docker compose -p tunex" "compose 显式带项目名"
has "-f $SB/docker-compose.prod.yaml" "compose 显式指向生产栈文件"
has "up -d" "计划里有 up -d"
has "db-migrate" "计划里等待 db-migrate"
has "健康验收" "计划里有健康验收"
has "chmod 600" "计划里 .env 权限 600"
hasnt "BACKUP_PASSPHRASE=" "install 计划不回显任何口令"

# D2 未 --version / latest 未 --allow-floating
run_install "$FX_NONE" "$SB" install --dry-run
expect_rc 2 "install 缺 --version → 用法错误"
run_install "$FX_NONE" "$SB" install --dry-run --version latest
expect_rc 2 "latest 未加 --allow-floating → 拒绝"
has "allow-floating" "拒绝信息点名 --allow-floating"
run_install "$FX_NONE" "$SB" install --dry-run --version latest --allow-floating
expect_rc 0 "latest + --allow-floating → 计划可生成"

# D3 零副作用（DoD 3 的"未创建 .env"）
if [ ! -e "$SB/.env" ] && [ ! -e "$SB/var" ]; then ok "dry-run 全流程零副作用：无 .env、无 var/"; else bad "dry-run 产生了副作用"; fi

# D4 脏机器：已有 .env（合法、600）+ 已有容器同版本 → install 拒绝（DoD 2）
SB_SAME="$TMP/sandbox-same"; mk_sandbox "$SB_SAME"
sed "s#^TUNEX_IMAGE=.*#TUNEX_IMAGE=ghcr.io/paimoncai/tunex:$SHA_FAKE#" "$ENV_GOOD" > "$SB_SAME/.env"
chmod 600 "$SB_SAME/.env"
FX_SAME="$(mkfix same project_container_count=6 project_working_dirs="$SB_SAME")"
run_install "$FX_SAME" "$SB_SAME" install --dry-run --version "$SHA_FAKE"
expect_rc 8 "同版本已部署 → install 拒绝（不产生第二套容器）"
has "status" "拒绝信息指向 status"
has "upgrade" "拒绝信息指向 upgrade"
hasnt "docker pull" "拒绝时没有发生 pull 计划"

# D4b 拒绝信息里的"当前版本"必须非空（`state="$(...)"` 是子 shell，早期实现这里恒为空）
run_install "$FX_SAME" "$SB_SAME" install --dry-run --version "$SHA_FAKE"
has "TUNEX_IMAGE=ghcr.io/paimoncai/tunex:$SHA_FAKE" "同版本拒绝信息带出当前 TUNEX_IMAGE（不是空值）"

# D5 异版本已部署 → 拒绝并指向 upgrade / uninstall
FX_DIFF="$(mkfix diff project_container_count=6 project_working_dirs="$SB_SAME" project_image=old)"
run_install "$FX_DIFF" "$SB_SAME" install --dry-run --version "1111111111111111111111111111111111111111"
expect_rc 8 "异版本已部署 → install 拒绝"
has "upgrade --version" "拒绝信息给出 upgrade 命令"

# D6 .env 在但无容器（半途失败）→ 拒绝且不自动清理
FX_PARTIAL="$(mkfix partial project_container_count=0)"
run_install "$FX_PARTIAL" "$SB_SAME" install --dry-run --version "$SHA_FAKE"
expect_rc 8 "有 .env 无容器（半途失败）→ install 拒绝"
has "不自动复用" "拒绝信息说明不自动复用/清理"

# D6b --reuse-env：显式复位开关（仅在 .env 校验通过 + 版本一致时放行；缺一仍 fail-closed）
FX_PARTIAL0="$(mkfix partial0 project_container_count=0)"
run_install "$FX_PARTIAL0" "$SB_SAME" install --dry-run --version "$SHA_FAKE" --reuse-env
expect_rc 0 "--reuse-env + .env 校验通过 + 版本一致 → 允许继续"
has "复用既有 .env" "复用路径明确打印『复用既有 .env』"
hasnt "cp $SB_SAME/.env.production.example" "复用时不再复制模板生成 .env"
has "docker pull ghcr.io/paimoncai/tunex:$SHA_FAKE" "复用后照常走 pull/up/健康"

run_install "$FX_PARTIAL0" "$SB_SAME" install --dry-run --version "1111111111111111111111111111111111111111" --reuse-env
expect_rc 8 "--reuse-env 但版本不一致 → 仍然拒绝（exit 8）"
has "--reuse-env 拒绝" "拒绝信息点明 --reuse-env"
has "upgrade --version" "拒绝信息给出 upgrade 出路"
hasnt "docker pull" "版本不一致时没有 pull 计划"

FX_SAME_CONTAINERS="$(mkfix same_containers project_container_count=6 project_working_dirs="$SB_SAME")"
run_install "$FX_SAME_CONTAINERS" "$SB_SAME" install --dry-run --version "$SHA_FAKE" --reuse-env
expect_rc 8 "--reuse-env 不适用于『真的有部署在跑』（同版本）"
SB_REUSE_BAD="$TMP/sandbox-reuse-bad"; mk_sandbox "$SB_REUSE_BAD"
grep -v '^AUTH_SECRET=' "$ENV_GOOD" > "$SB_REUSE_BAD/.env"; chmod 600 "$SB_REUSE_BAD/.env"
run_install "$FX_PARTIAL0" "$SB_REUSE_BAD" install --dry-run --version "$SHA_FAKE" --reuse-env
expect_rc 7 "--reuse-env 但 .env 校验不过（缺 AUTH_SECRET）→ 仍然 7（校验优先于复用）"
run_install "$FX_NONE" "$SB" uninstall --dry-run --reuse-env
expect_rc 2 "--reuse-env 用在非 install 动作 → 用法错误"

# D7 非 root（DoD 4）
FX_NONROOT="$(mkfix nonroot uid=1000)"
run_install "$FX_NONROOT" "$SB" install --dry-run --version "$SHA_FAKE"
expect_rc 3 "非 root → 退出码 3"
has "sudo" "非 root 提示含 sudo"
if [ ! -e "$SB/.env" ]; then ok "非 root 未写入任何东西"; else bad "非 root 竟写了 .env"; fi

# D8 缺 Docker（DoD 3）
FX_NODOCKER="$(mkfix nodocker docker_present=0 compose_ok=0)"
run_install "$FX_NODOCKER" "$SB" install --dry-run --version "$SHA_FAKE"
expect_rc 4 "缺 Docker → 退出码 4"
has "https://docs.docker.com/engine/install/" "stderr 含 Docker 官方文档"
has "包管理器" "stderr 含发行版包管理器路径"
hasnt "docker pull" "缺 Docker 时没有 pull 计划"
if [ ! -e "$SB/.env" ]; then ok "缺 Docker 时未创建 .env"; else bad "缺 Docker 竟创建了 .env"; fi

# D9 缺必需命令（DoD 的 5）
FX_MISSING="$(mkfix missingtools missing_commands='jq')"
run_install "$FX_MISSING" "$SB" install --dry-run --version "$SHA_FAKE"
expect_rc 5 "缺 jq → 退出码 5"

# D10 同机项目名冲突（DoD 6）
FX_CONFLICT="$(mkfix conflict project_container_count=3 project_working_dirs='/opt/other/TuneX')"
run_install "$FX_CONFLICT" "$SB" install --dry-run --version "$SHA_FAKE"
expect_rc 6 "同机 tunex 项目属于别的目录 → 冲突拒绝"
has "冲突" "冲突提示明确"

# D11 .env 校验失败的端到端（DoD 5）
SB_BAD="$TMP/sandbox-bad"; mk_sandbox "$SB_BAD"
grep -v '^AUTH_SECRET=' "$ENV_GOOD" > "$SB_BAD/.env"; chmod 600 "$SB_BAD/.env"
run_install "$FX_NONE" "$SB_BAD" install --dry-run --version "$SHA_FAKE"
expect_rc 7 "既有 .env 缺 AUTH_SECRET → 退出码 7"
has "AUTH_SECRET" "提示含缺失键名"
hasnt "AbCdEf" "提示不打印任何键值"
chmod 644 "$SB_BAD/.env"
run_install "$FX_NONE" "$SB_BAD" install --dry-run --version "$SHA_FAKE"
expect_rc 7 "权限 644 → 退出码 7"
has "chmod 600" "提示给出 chmod 600"

# D11b --standalone：overlay 存在性 + Compose 版本门（FROZEN-1 的前置矩阵）
FX_STANDALONE="$(mkfix standalone compose_version=2.24.4)"
run_install "$FX_STANDALONE" "$SB" install --dry-run --standalone --version "$SHA_FAKE"
expect_rc 5 "--standalone 缺 overlay 文件 → 退出码 5"
cp "$TX_ROOT/docker-compose.standalone.yaml" "$SB/"
run_install "$FX_STANDALONE" "$SB" install --dry-run --standalone --version "$SHA_FAKE"
expect_rc 0 "--standalone + overlay 就位 → 计划可生成"
has "-f $SB/docker-compose.standalone.yaml" "计划里带上 standalone overlay"
FX_OLDCOMPOSE="$(mkfix oldcompose compose_version=2.20.0)"
run_install "$FX_OLDCOMPOSE" "$SB" install --dry-run --standalone --version "$SHA_FAKE"
expect_rc 4 "standalone 且 Compose < 2.24.4 → 退出码 4"

# D12 upgrade：先备份、后切镜像、再 up -d（DoD 7 的顺序面）
SB_UP="$TMP/sandbox-up"; mk_sandbox "$SB_UP"
sed "s#^TUNEX_IMAGE=.*#TUNEX_IMAGE=ghcr.io/paimoncai/tunex:0000000000000000000000000000000000000000#" "$ENV_GOOD" > "$SB_UP/.env"
chmod 600 "$SB_UP/.env"
FX_UP="$(mkfix up project_container_count=6 project_working_dirs="$SB_UP" backup_manifest_count=3 image_digest='sha256:new')"
run_install "$FX_UP" "$SB_UP" upgrade --dry-run --version "$SHA_FAKE"
expect_rc 0 "upgrade --dry-run 成功"
has "scripts/ops/backup.sh" "upgrade 调用既有 backup.sh"
has "docker pull ghcr.io/paimoncai/tunex:$SHA_FAKE" "upgrade 先 pull 目标镜像"
has "up -d backend worker web" "upgrade 只切应用服务"
has "TUNEX_AGENT_LATEST_VERSION" "upgrade 写面板侧 Agent 版本基线"
has "deploy-history.jsonl" "upgrade 追加带 digest 的部署历史"
before "docker pull" "scripts/ops/backup.sh" "顺序：先 pull 后备份（拉不到就不动任何东西）"
before "scripts/ops/backup.sh" "up -d backend worker web" "顺序：备份在切镜像之前（FROZEN-2）"
has "节点 Agent" "结束时提醒节点不随面板升级"
ENV_BEFORE="$(cat "$SB_UP/.env")"
if [ "$(cat "$SB_UP/.env")" = "$ENV_BEFORE" ]; then ok "dry-run 未改写 .env"; else bad "dry-run 改写了 .env"; fi

# D13 upgrade 镜像不存在（DoD 8）
FX_PULLFAIL="$(mkfix pullfail project_container_count=6 project_working_dirs="$SB_UP" pull_result=fail)"
run_install "$FX_PULLFAIL" "$SB_UP" upgrade --dry-run --version "ghcr.io/paimoncai/tunex:does-not-exist"
expect_rc 9 "目标镜像拉不到 → 退出码 9"
hasnt "scripts/ops/backup.sh" "拉不到镜像时不做备份（无需保护窗口）"
hasnt "up -d backend worker web" "拉不到镜像时没有切镜像"

# D14 upgrade 备份失败 → 拒绝（DoD 9）
FX_BACKUPFAIL="$(mkfix backupfail project_container_count=6 project_working_dirs="$SB_UP" backup_manifest_count=0 backup_result=fail)"
run_install "$FX_BACKUPFAIL" "$SB_UP" upgrade --dry-run --version "$SHA_FAKE"
expect_rc 9 "备份失败（backup.sh 非 0 / 无新 manifest）→ 拒绝升级（DoD 9）"
has "备份失败" "拒绝信息点明备份失败"
hasnt "up -d backend worker web" "备份失败时没有切镜像"

# D15 upgrade 迁移失败 → 调既有 rollback.sh 回退（DoD 7 的失败半边）
FX_MIGFAIL="$(mkfix migfail project_container_count=6 project_working_dirs="$SB_UP" backup_manifest_count=1 migrate_exit=1)"
run_install "$FX_MIGFAIL" "$SB_UP" upgrade --dry-run --version "$SHA_FAKE"
expect_rc 9 "db-migrate 退出码非 0 → 退出码 9"
has "scripts/ops/rollback.sh --to previous --yes" "失败时调用既有 rollback.sh --to previous"

# D16 健康验收失败 → 同样回退
FX_UNHEALTHY="$(mkfix unhealthy project_container_count=6 project_working_dirs="$SB_UP" backup_manifest_count=1 health_http=500 ready_http=000)"
run_install "$FX_UNHEALTHY" "$SB_UP" upgrade --dry-run --version "$SHA_FAKE"
expect_rc 9 "健康验收失败 → 退出码 9"
has "rollback.sh --to previous --yes" "健康失败也走既有回退路径"

# D17 upgrade 前置：非交互且无口令（DoD 10）
FX_NOPASS="$(mkfix nopass project_container_count=6 project_working_dirs="$SB_UP" backup_manifest_count=1 passphrase_available=0)"
LAST_RC=0
LAST_OUT="$(env TUNEX_PROJECT_ROOT="$SB_UP" TUNEX_DRYRUN_FIXTURES="$FX_NOPASS" bash "$INSTALL" upgrade --dry-run --version "$SHA_FAKE" </dev/null 2>&1)" || LAST_RC=$?
if [ "$LAST_RC" != "0" ]; then ok "非交互无口令 → 拒绝（exit=$LAST_RC）"; else bad "非交互无口令竟被放行"; fi
has "BACKUP_PASSPHRASE" "提示含 BACKUP_PASSPHRASE"
has "非交互" "提示含『非交互』"
hasnt "up -d backend worker web" "未发生切镜像"

# D18 upgrade 无部署 → 拒绝
FX_EMPTYDEPLOY="$(mkfix nodeployd project_container_count=0)"
run_install "$FX_EMPTYDEPLOY" "$SB" upgrade --dry-run --version "$SHA_FAKE"
expect_rc 8 "没有可升级的部署 → 退出码 8"

# D19 uninstall（DoD 11）
run_install "$FX_UP" "$SB_UP" uninstall --dry-run
expect_rc 0 "uninstall --dry-run 默认保数据"
has "compose -p tunex" "uninstall 用显式项目名"
has " down" "uninstall 执行 down"
has "数据卷保留" "默认明确保留数据卷"
hasnt " down -v" "默认不删卷"

run_install "$FX_UP" "$SB_UP" uninstall --dry-run --purge-data
expect_rc 2 "--purge-data 非交互且无 --yes → 拒绝"
has "--yes" "拒绝信息要求 --yes"

run_install "$FX_UP" "$SB_UP" uninstall --dry-run --purge-data --yes
expect_rc 0 "--purge-data --yes → 允许"
has " down -v" "确认后才删卷"

# D20 status 只读
SB_STATUS="$TMP/sandbox-status"; mk_sandbox "$SB_STATUS"
cp "$ENV_GOOD" "$SB_STATUS/.env"; chmod 600 "$SB_STATUS/.env"
run_install "$FX_UP" "$SB_STATUS" status --dry-run
expect_rc 0 "status --dry-run"
has "TUNEX_IMAGE" "status 打印当前镜像"
has "健康" "status 打印健康事实"
if [ ! -e "$SB_STATUS/var" ]; then ok "status 没有创建任何持久状态目录"; else bad "status 创建了 var/"; fi

# D20b 真实 status（本机 docker 可用时）：健康码必须是 3 位整数、digest 行不能有裸换行/unknown 噪声
if command -v docker >/dev/null 2>&1; then
  LAST_RC=0
  LAST_OUT="$(env TUNEX_PROJECT_ROOT="$SB" bash "$INSTALL" status 2>&1)" || LAST_RC=$?
  expect_rc 0 "真实 status（无 .env、无容器）仍只读成功"
  if printf '%s\n' "$LAST_OUT" | grep -Eq '/healthz=[0-9]{3} /readyz=[0-9]{3}$'; then
    ok "真实 status：健康码是 3 位（不会出现 000000 —— 双份打印已修）"
  else
    bad "真实 status：健康码格式不对"; printf '%s\n' "$LAST_OUT" | grep healthz
  fi
  hasnt "local:unknown" "真实 status：无部署时不打印 local:unknown 噪声"
else
  skip "docker 不可用：真实 status 未执行"
fi

# D21 --no-docker 只允许配 dry-run/check
run_install "$FX_NONE" "$SB" install --no-docker --version "$SHA_FAKE"
expect_rc 2 "--no-docker 单独使用 → 拒绝"

# D22 --check 真探测：做完前置检查就停（绝不落到真实部署动作）
SB_REAL="$TMP/sandbox-real"; mk_sandbox "$SB_REAL"
LAST_RC=0
LAST_OUT="$(env TUNEX_PROJECT_ROOT="$SB_REAL" bash "$INSTALL" --check install --version "$SHA_FAKE" 2>&1)" || LAST_RC=$?
# 这条要在**任何主机形态**下成立（CI runner 是非 root、且可能没有 docker 守护进程）：
# 前置矩阵拦住谁、就以谁的退出码收场；唯一不允许的是"没通过却成功"。
case "$LAST_RC" in
  0) ok "check 真探测（root + Docker 可用）→ 前置全过"
     has "check 全部通过" "check 明确报告未做变更" ;;
  3) ok "check 真探测（非 root，CI runner 的常态）→ 前置矩阵第一条拦住（exit=3）"
     has "sudo" "非 root 的 check 给出 sudo 提示" ;;
  4|5) ok "check 真探测（本机 Docker/命令不满足）→ 前置矩阵拦住（exit=$LAST_RC）" ;;
  *) bad "check 真探测返回了不该出现的退出码：$LAST_RC"; dump ;;
esac
if [ ! -e "$SB_REAL/.env" ]; then ok "--check 未创建 .env（检查模式零副作用）"; else bad "--check 创建了 .env"; fi

# =============================================================================
group "E. bootstrap 真克隆（ref 形态 / 裸 SHA 形态 / 断言失败自清）"
# =============================================================================
UP="$TMP/upstream"
mkdir -p "$UP"
(
  cd "$UP"
  git init -q -b main .
  printf 'c0\n' > README.md
  git add README.md
  git -c user.name=t -c user.email=t@t commit -q -m c0
  # 一个"假的安装器"：bootstrap 的交接目标
  mkdir -p scripts/ops
  cat > scripts/ops/install.sh <<'STUB'
#!/usr/bin/env bash
printf 'STUB-CALLED %s\n' "$*"
STUB
  chmod +x scripts/ops/install.sh
  git add scripts/ops/install.sh
  git -c user.name=t -c user.email=t@t commit -q -m c1
  SHA_OLD="$(git rev-parse HEAD)"
  git -c user.name=t -c user.email=t@t tag v1.5.0
  printf 'c2\n' >> README.md
  git add README.md
  git -c user.name=t -c user.email=t@t commit -q -m c2
  SHA_TIP="$(git rev-parse HEAD)"
  printf '%s\n%s\n' "$SHA_OLD" "$SHA_TIP" > "$TMP/shas.txt"
)
REPO="file://$UP"
SHA_OLD="$(sed -n 1p "$TMP/shas.txt")"
SHA_TIP="$(sed -n 2p "$TMP/shas.txt")"

# E1 dry-run 计划（两种形态，断言不含 --depth 的那条）
LAST_RC=0
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version "$SHA_OLD" --dir "$TMP/dest-plan" --dry-run 2>&1)" || LAST_RC=$?
expect_rc 0 "bootstrap --dry-run（裸 SHA）"
has "git clone" "计划含 git clone"
has "checkout --detach $SHA_OLD" "裸 SHA 用分离检出"
has "rev-parse HEAD" "计划含 rev-parse 断言"
CLONE_LINE="$(printf '%s\n' "$LAST_OUT" | grep -F '[dry-run] git clone' | head -1)"
case "$CLONE_LINE" in
  *"--depth"*) bad "裸 SHA 的 clone 命令里不该出现 --depth：$CLONE_LINE" ;;
  "") bad "计划里没有找到 clone 命令行" ;;
  *) ok "裸 SHA 的 clone 命令是完整克隆（无 --depth）：$CLONE_LINE" ;;
esac
if [ ! -e "$TMP/dest-plan" ]; then ok "bootstrap --dry-run 未创建目录"; else bad "bootstrap --dry-run 竟创建了目录"; fi

LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version v1.5.0 --dir "$TMP/dest-plan-tag" --dry-run 2>&1)" || LAST_RC=$?
expect_rc 0 "bootstrap --dry-run（tag 形态）"
has "--depth 1 --single-branch --branch v1.5.0" "tag 形态用浅克隆"
has "ls-remote" "tag 形态先用 ls-remote 解析 sha"

# E2 裸 SHA 路径：真克隆 + 断言 + 走 stub 安装器
LAST_RC=0
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version "$SHA_OLD" --dir "$TMP/dest-old" 2>&1)" || LAST_RC=$?
expect_rc 0 "裸 SHA 真克隆（非 tip 的老 commit）"
has "STUB-CALLED install --version $SHA_OLD" "交接给安装器时把版本固化成解析出的完整 sha"
if [ "$(git -C "$TMP/dest-old" rev-parse HEAD)" = "$SHA_OLD" ]; then ok "检出 HEAD == 请求 sha"; else bad "检出 HEAD != 请求 sha"; fi
if [ -f "$TMP/dest-old/.git/shallow" ]; then bad "裸 SHA 路径不该是浅克隆"; else ok "裸 SHA 路径是完整克隆（无 .git/shallow）"; fi

# E3 tag 路径：浅克隆 + 解析出的 sha 断言
LAST_RC=0
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version v1.5.0 --dir "$TMP/dest-tag" --action status 2>&1)" || LAST_RC=$?
expect_rc 0 "tag 形态真克隆"
has "STUB-CALLED status --version $SHA_OLD" "tag 被解析成 sha 后交给安装器"
if [ -f "$TMP/dest-tag/.git/shallow" ]; then ok "tag 路径是浅克隆"; else bad "tag 路径应当是浅克隆"; fi
if [ "$(git -C "$TMP/dest-tag" rev-parse HEAD)" = "$SHA_OLD" ]; then ok "tag 检出 HEAD == tag 解析出的 sha"; else bad "tag 检出 HEAD 不符"; fi

# E4 --check：真克隆 + 断言，但不 exec 安装器
LAST_RC=0
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version "$SHA_TIP" --dir "$TMP/dest-check" --check 2>&1)" || LAST_RC=$?
expect_rc 0 "bootstrap --check"
hasnt "STUB-CALLED" "--check 不 exec 安装器"
has "下一步" "--check 打印下一步命令"

# E5 断言失败自清：请求一个不在仓库里的 sha
LAST_RC=0
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version "ffffffffffffffffffffffffffffffffffffffff" --dir "$TMP/dest-bad" 2>&1)" || LAST_RC=$?
if [ "$LAST_RC" != "0" ]; then ok "仓库里没有的 sha → 非零退出（exit=$LAST_RC）"; else bad "不存在的 sha 竟成功"; fi
if [ ! -e "$TMP/dest-bad" ]; then ok "断言/检出失败后目录被清掉"; else bad "失败后残留了目录"; fi

# E6 目标目录已存在且版本不符 → 拒绝，不覆盖
mkdir -p "$TMP/dest-exists"
LAST_RC=0
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version "$SHA_OLD" --dir "$TMP/dest-exists" 2>&1)" || LAST_RC=$?
if [ "$LAST_RC" != "0" ]; then ok "目标目录已存在且非目标版本 → 拒绝"; else bad "目标目录冲突竟通过"; fi
has "移走" "提示人工移走目录（引导段不自动删除既有目录）"

# E7 明确版本：拒绝 latest/分支名
LAST_RC=0
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version main --dir "$TMP/dest-main" 2>&1)" || LAST_RC=$?
expect_rc 2 "版本 main → 用法错误（必须锚定 sha 或 tag）"
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version latest --dir "$TMP/dest-latest" 2>&1)" || LAST_RC=$?
expect_rc 2 "版本 latest → 用法错误"

# =============================================================================
printf '\n=========================================\n'
printf 'installer-static: 通过 %s 项，失败 %s 项\n' "$PASS" "$FAIL"
printf '=========================================\n'
[ "$FAIL" -eq 0 ] || exit 1
exit 0
 "$ROOT_DOCKERFILE" "unified image: 长期运行角色默认非 root"
check_present 'user:[[:space:]]+"0:0"' "$PROD_COMPOSE" "prod compose: 仅 db-migrate 显式提权"
check_present 'user:[[:space:]]+"0:0"' "$DEV_COMPOSE" "dev compose: 仅 db-migrate 显式提权"

# =============================================================================
group "C. 纯函数单测"
# =============================================================================
# shellcheck disable=SC1090
. "$INSTALL"

# C1 镜像引用校验（DoD 16：与 node-upgrade.ts 的结论逐条一致）
CASES="$TMP/cases.txt"
LONG300="$(printf 'a%.0s' $(seq 1 300))"
{
  printf '%s\n' \
    'ghcr.io/paimoncai/tunex-agent:abc123' \
    'ghcr.io/paimoncai/tunex:1.2.3' \
    'ghcr.io/paimoncai/tunex-agent@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    'ghcr.io/paimoncai/tunex-agent:abc@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
    'localhost:5000/tunex:dev' \
    'has space' \
    'evil;rm -rf /' \
    'evil$(id)' \
    'evil`id`' \
    'UPPER/Name:tag' \
    '' \
    "$LONG300"
} > "$CASES"
PARITY_OK=1
if command -v node >/dev/null 2>&1 && [ -f "$TS_NODE_UPGRADE" ]; then
  node -e '
    const fs=require("fs");
    const src=fs.readFileSync(process.argv[1],"utf8");
    const m=src.match(/const IMAGE_REF_RE\s*=\s*\n?\s*\/([\s\S]*?)\/;/);
    if(!m){console.error("IMAGE_REF_RE not found");process.exit(2)}
    const re=new RegExp(m[1]);
    const cases=fs.readFileSync(process.argv[2],"utf8").split("\n");
    const out=[];
    for(const c of cases){
      const t=c.trim();
      out.push((t!=="" && t.length<=255 && re.test(t))?"1":"0");
    }
    process.stdout.write(out.join("\n"));
  ' "$TS_NODE_UPGRADE" "$CASES" > "$TMP/ts-parity.txt" || PARITY_OK=0
  if [ "$PARITY_OK" -eq 1 ]; then
    n=0
    while IFS= read -r c; do
      n=$((n + 1))
      if tx_image_ref_valid "$c"; then shell_verdict=1; else shell_verdict=0; fi
      ts_verdict="$(sed -n "${n}p" "$TMP/ts-parity.txt")"
      if [ "$shell_verdict" = "$ts_verdict" ]; then
        ok "parity[$n] shell=$shell_verdict == node-upgrade.ts（案例：${c:0:48}）"
      else
        bad "parity[$n] shell=$shell_verdict != node-upgrade.ts=$ts_verdict（案例：${c:0:48}）"
      fi
    done < "$CASES"
  else
    bad "无法从 node-upgrade.ts 提取 IMAGE_REF_RE（parity 未执行）"
  fi
else
  skip "node 或 node-upgrade.ts 不可用：镜像引用 parity 未执行（静态断言仍覆盖形状）"
fi

# C2 幂等三态（DoD 2/6）
state_case() { # <has_env> <env_image> <count> <want> <期望>
  local got
  got="$(tx_classify_deploy_state "$1" "$2" "$3" "$4")"
  if [ "$got" = "$5" ]; then ok "三态：has_env=$1 image=${2:-空} 容器=$3 → $got"; else bad "三态：期望 $5，实际 $got"; fi
}
state_case 0 "" 0 "ghcr.io/paimoncai/tunex:$SHA_FAKE" none
state_case 1 "ghcr.io/paimoncai/tunex:$SHA_FAKE" 6 "ghcr.io/paimoncai/tunex:$SHA_FAKE" same
state_case 1 "ghcr.io/paimoncai/tunex:old" 6 "ghcr.io/paimoncai/tunex:new" different
state_case 1 "ghcr.io/paimoncai/tunex:$SHA_FAKE" 0 "ghcr.io/paimoncai/tunex:$SHA_FAKE" partial
state_case 0 "" 2 "ghcr.io/paimoncai/tunex:$SHA_FAKE" different

# C3 .env 校验（DoD 5）
ENV_GOOD="$TMP/env.good"
cat > "$ENV_GOOD" <<EOF
AUTH_SECRET=AbCdEf0123456789-_AbCdEf0123456789 # secret-scan:allow — deterministic installer test fixture
LICENSE_SECRET=AbCdEf0123456789-_AbCdEf0123456789 # secret-scan:allow — deterministic installer test fixture
TUNEX_CONFIG_KEY=AbCdEf0123456789-_AbCdEf0123456789 # secret-scan:allow — deterministic installer test fixture
TUNEX_LICENSE_KEY=AbCdEf0123456789-_AbCdEf0123456789 # secret-scan:allow — deterministic installer test fixture
MYSQL_ROOT_PASSWORD=AbCdEf0123456789-_AbCdEf0123456789
DATABASE_URL=mysql://root:AbCdEf0123456789-_AbCdEf0123456789@mysql:3306/tunex # secret-scan:allow — deterministic installer test fixture
SITE_URL=https://tunex.example.com
TUNEX_IMAGE=ghcr.io/paimoncai/tunex:$SHA_FAKE
TUNEX_AGENT_IMAGE=ghcr.io/paimoncai/tunex-agent:$SHA_FAKE
EOF
chmod 600 "$ENV_GOOD"
if findings="$(tx_env_validate "$ENV_GOOD")"; then ok "合法 .env 通过校验"; else bad "合法 .env 被判失败：$findings"; fi

ENV_MISSING="$TMP/env.missing"
grep -v '^AUTH_SECRET=' "$ENV_GOOD" > "$ENV_MISSING"; chmod 600 "$ENV_MISSING"
LAST_OUT="$(tx_env_validate "$ENV_MISSING" || true)"
has "missing:AUTH_SECRET" ".env 缺 AUTH_SECRET 被识别（只报键名）"
hasnt "AbCdEf" "缺失报告不含任何键值"

ENV_PLACEHOLDER="$TMP/env.placeholder"
sed 's/^TUNEX_IMAGE=.*/TUNEX_IMAGE=ghcr.io\/paimoncai\/tunex:replace-with-git-sha/' "$ENV_GOOD" > "$ENV_PLACEHOLDER"
chmod 600 "$ENV_PLACEHOLDER"
LAST_OUT="$(tx_env_validate "$ENV_PLACEHOLDER" || true)"
has "placeholder:TUNEX_IMAGE" ".env 的 replace-with 占位值被识别"

ENV_PERM="$TMP/env.perm"
cp "$ENV_GOOD" "$ENV_PERM"; chmod 644 "$ENV_PERM"
LAST_OUT="$(tx_env_validate "$ENV_PERM" || true)"
has "perms:644" ".env 权限非 600 被识别"

# C4 备份口令（DoD 10）
LAST_RC=0
LAST_OUT="$(unset BACKUP_PASSPHRASE; tx_check_backup_passphrase 0 2>&1)" || LAST_RC=$?
expect_rc 1 "非交互且无 BACKUP_PASSPHRASE：拒绝"
has "BACKUP_PASSPHRASE" "拒绝信息指明变量名"
has "非交互" "拒绝信息含『非交互』"
LAST_RC=0
LAST_OUT="$(BACKUP_PASSPHRASE=secret tx_check_backup_passphrase 0 2>&1)" || LAST_RC=$?
expect_rc 0 "给了 BACKUP_PASSPHRASE：放行"
LAST_OUT="$(BACKUP_PASSPHRASE=secret tx_check_backup_passphrase 1 2>&1)"
hasnt "非交互" "交互 TTY 时不打印拒绝文案"

# C5 Docker 指引（DoD 3：清晰指引、不代装）
LAST_OUT="$(tx_docker_guidance /etc/os-release 2>&1)"
has "https://docs.docker.com/engine/install/" "Docker 指引含官方文档"
has "不会替你安装 Docker" "Docker 指引明确不代装"
hasnt "get.docker.com" "Docker 指引不含 get.docker.com"
hasnt "curl" "Docker 指引不含 curl（不引导管道安装）"
DEB="$TMP/os-release.deb"; printf 'ID=ubuntu\n' > "$DEB"
LAST_OUT="$(tx_docker_guidance "$DEB" 2>&1)"
has "apt" "Ubuntu → apt 路径"
has "docker-compose-plugin" "Ubuntu → 指出 Compose v2 插件包"
RPM="$TMP/os-release.rpm"; printf 'ID=rocky\n' > "$RPM"
LAST_OUT="$(tx_docker_guidance "$RPM" 2>&1)"
has "dnf" "RHEL 系 → dnf 路径"

# C6 版本形态（bootstrap）
. "$BOOTSTRAP"
shape_case() { local got; got="$(tx_version_shape "$1")"; if [ "$got" = "$2" ]; then ok "形态：$1 → $got"; else bad "形态：$1 期望 $2 实际 $got"; fi; }
shape_case "$SHA_FAKE" sha
shape_case "0123456" sha
shape_case "v1.5.0" ref
shape_case "main" ref
shape_case "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01" ref
if tx_sha_matches "$SHA_FAKE" "$SHA_FAKE"; then ok "sha 断言：完整相等"; else bad "sha 断言：完整相等"; fi
if tx_sha_matches "$SHA_FAKE" "0123456"; then ok "sha 断言：短 sha 前缀匹配"; else bad "sha 断言：短 sha 前缀匹配"; fi
if tx_sha_matches "$SHA_FAKE" "fffffff"; then bad "sha 断言：不匹配必须为假"; else ok "sha 断言：不匹配为假"; fi

# C7 .env 真实生成路径（这是安装器里唯一会写密钥的代码）：权限 600、必需键齐全、
#     DATABASE_URL 内嵌同一口令、且与 compose 插值兼容（DoD 17 的安装器半边）。
SB_GEN="$TMP/gen"
mkdir -p "$SB_GEN"
cp "$TX_ROOT/docker-compose.prod.yaml" "$TX_ROOT/.env.production.example" "$SB_GEN/"
( TX_ENV_FILE="$SB_GEN/.env" TX_ENV_TEMPLATE="$SB_GEN/.env.production.example" \
  TX_PANEL_IMAGE="ghcr.io/paimoncai/tunex:$SHA_FAKE" \
  TX_AGENT_IMAGE_RESOLVED="ghcr.io/paimoncai/tunex-agent:$SHA_FAKE" \
  TX_AGENT_LATEST_VERSION_VALUE="$SHA_FAKE" \
  tx_env_generate >/dev/null 2>&1 )
if [ -f "$SB_GEN/.env" ]; then ok "真实生成 .env：产出文件"; else bad "真实生成 .env：没有文件"; fi
if [ "$(tx_env_perm_mode "$SB_GEN/.env")" = "600" ]; then ok "真实生成 .env：权限 600"; else bad "真实生成 .env：权限 $(tx_env_perm_mode "$SB_GEN/.env")"; fi
GEN_FINDINGS="$(tx_env_validate "$SB_GEN/.env" || true)"
if [ -z "$GEN_FINDINGS" ]; then ok "真实生成 .env：立刻通过安装器自己的校验"; else bad "真实生成 .env 未通过校验：$GEN_FINDINGS"; fi
GEN_PW="$(tx_env_get "$SB_GEN/.env" MYSQL_ROOT_PASSWORD)"
case "$(tx_env_get "$SB_GEN/.env" DATABASE_URL)" in
  *"$GEN_PW"*) ok "真实生成 .env：DATABASE_URL 内嵌同一个 root 口令（不回显值）" ;;
  *) bad "真实生成 .env：DATABASE_URL 与 MYSQL_ROOT_PASSWORD 不一致" ;;
esac
case "$(tx_env_get "$SB_GEN/.env" AUTH_SECRET)" in
  change-me*|replace-with*) bad "真实生成 .env：AUTH_SECRET 还是模板占位值" ;;
  "") bad "真实生成 .env：AUTH_SECRET 为空" ;;
  *) ok "真实生成 .env：AUTH_SECRET 已随机化（不打印值）" ;;
esac
if [ "$(tx_env_get "$SB_GEN/.env" TUNEX_IMAGE)" = "ghcr.io/paimoncai/tunex:$SHA_FAKE" ]; then
  ok "真实生成 .env：TUNEX_IMAGE 锚定到请求的 sha"
else
  bad "真实生成 .env：TUNEX_IMAGE 不对"
fi
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if ( cd "$SB_GEN" && docker compose -p tunex -f docker-compose.prod.yaml config -q ) 2>"$TMP/cfg.err"; then
    ok "真实生成 .env：docker compose config -q 通过（compose 插值兼容，DoD 17 的安装器半边）"
  else
    bad "真实生成 .env 与 compose 插值不兼容"; cat "$TMP/cfg.err"
  fi
else
  skip "docker compose 不可用：config -q 兼容性未执行"
fi

# C8 .env 写入器对特殊字符的健壮性（值经 ENVIRON 传入，不做 sed 替换）
SB_SET="$TMP/envset"
mkdir -p "$SB_SET"
printf 'B=old\n' > "$SB_SET/f"
tx_env_set "$SB_SET/f" B 'a=b&c/d+e_f-g'
if [ "$(tx_env_get "$SB_SET/f" B)" = 'a=b&c/d+e_f-g' ]; then ok "tx_env_set：含 = & / + 的值原样写入"; else bad "tx_env_set 改写了值：$(tx_env_get "$SB_SET/f" B)"; fi
tx_env_set "$SB_SET/f" NEWKEY 'plain'
if [ "$(tx_env_get "$SB_SET/f" NEWKEY)" = 'plain' ]; then ok "tx_env_set：缺键追加"; else bad "tx_env_set：缺键未追加"; fi
if [ "$(wc -l < "$SB_SET/f")" = "2" ]; then ok "tx_env_set：只改一行，不重复插入"; else bad "tx_env_set：行数异常（$(wc -l < "$SB_SET/f")）"; fi

# =============================================================================
group "D. dry-run 全流程（顺序 / 退出码 / 零副作用）"
# =============================================================================
FX_NONE="$FIX/empty.env"

# D1 干净机器 install 计划（DoD 1 的计划面）
run_install "$FX_NONE" "$SB" install --dry-run --version "$SHA_FAKE"
expect_rc 0 "干净机器 install --dry-run"
has "docker pull ghcr.io/paimoncai/tunex:$SHA_FAKE" "计划里先 pull 目标镜像"
has "docker compose -p tunex" "compose 显式带项目名"
has "-f $SB/docker-compose.prod.yaml" "compose 显式指向生产栈文件"
has "up -d" "计划里有 up -d"
has "db-migrate" "计划里等待 db-migrate"
has "健康验收" "计划里有健康验收"
has "chmod 600" "计划里 .env 权限 600"
hasnt "BACKUP_PASSPHRASE=" "install 计划不回显任何口令"

# D2 未 --version / latest 未 --allow-floating
run_install "$FX_NONE" "$SB" install --dry-run
expect_rc 2 "install 缺 --version → 用法错误"
run_install "$FX_NONE" "$SB" install --dry-run --version latest
expect_rc 2 "latest 未加 --allow-floating → 拒绝"
has "allow-floating" "拒绝信息点名 --allow-floating"
run_install "$FX_NONE" "$SB" install --dry-run --version latest --allow-floating
expect_rc 0 "latest + --allow-floating → 计划可生成"

# D3 零副作用（DoD 3 的"未创建 .env"）
if [ ! -e "$SB/.env" ] && [ ! -e "$SB/var" ]; then ok "dry-run 全流程零副作用：无 .env、无 var/"; else bad "dry-run 产生了副作用"; fi

# D4 脏机器：已有 .env（合法、600）+ 已有容器同版本 → install 拒绝（DoD 2）
SB_SAME="$TMP/sandbox-same"; mk_sandbox "$SB_SAME"
sed "s#^TUNEX_IMAGE=.*#TUNEX_IMAGE=ghcr.io/paimoncai/tunex:$SHA_FAKE#" "$ENV_GOOD" > "$SB_SAME/.env"
chmod 600 "$SB_SAME/.env"
FX_SAME="$(mkfix same project_container_count=6 project_working_dirs="$SB_SAME")"
run_install "$FX_SAME" "$SB_SAME" install --dry-run --version "$SHA_FAKE"
expect_rc 8 "同版本已部署 → install 拒绝（不产生第二套容器）"
has "status" "拒绝信息指向 status"
has "upgrade" "拒绝信息指向 upgrade"
hasnt "docker pull" "拒绝时没有发生 pull 计划"

# D4b 拒绝信息里的"当前版本"必须非空（`state="$(...)"` 是子 shell，早期实现这里恒为空）
run_install "$FX_SAME" "$SB_SAME" install --dry-run --version "$SHA_FAKE"
has "TUNEX_IMAGE=ghcr.io/paimoncai/tunex:$SHA_FAKE" "同版本拒绝信息带出当前 TUNEX_IMAGE（不是空值）"

# D5 异版本已部署 → 拒绝并指向 upgrade / uninstall
FX_DIFF="$(mkfix diff project_container_count=6 project_working_dirs="$SB_SAME" project_image=old)"
run_install "$FX_DIFF" "$SB_SAME" install --dry-run --version "1111111111111111111111111111111111111111"
expect_rc 8 "异版本已部署 → install 拒绝"
has "upgrade --version" "拒绝信息给出 upgrade 命令"

# D6 .env 在但无容器（半途失败）→ 拒绝且不自动清理
FX_PARTIAL="$(mkfix partial project_container_count=0)"
run_install "$FX_PARTIAL" "$SB_SAME" install --dry-run --version "$SHA_FAKE"
expect_rc 8 "有 .env 无容器（半途失败）→ install 拒绝"
has "不自动复用" "拒绝信息说明不自动复用/清理"

# D6b --reuse-env：显式复位开关（仅在 .env 校验通过 + 版本一致时放行；缺一仍 fail-closed）
FX_PARTIAL0="$(mkfix partial0 project_container_count=0)"
run_install "$FX_PARTIAL0" "$SB_SAME" install --dry-run --version "$SHA_FAKE" --reuse-env
expect_rc 0 "--reuse-env + .env 校验通过 + 版本一致 → 允许继续"
has "复用既有 .env" "复用路径明确打印『复用既有 .env』"
hasnt "cp $SB_SAME/.env.production.example" "复用时不再复制模板生成 .env"
has "docker pull ghcr.io/paimoncai/tunex:$SHA_FAKE" "复用后照常走 pull/up/健康"

run_install "$FX_PARTIAL0" "$SB_SAME" install --dry-run --version "1111111111111111111111111111111111111111" --reuse-env
expect_rc 8 "--reuse-env 但版本不一致 → 仍然拒绝（exit 8）"
has "--reuse-env 拒绝" "拒绝信息点明 --reuse-env"
has "upgrade --version" "拒绝信息给出 upgrade 出路"
hasnt "docker pull" "版本不一致时没有 pull 计划"

FX_SAME_CONTAINERS="$(mkfix same_containers project_container_count=6 project_working_dirs="$SB_SAME")"
run_install "$FX_SAME_CONTAINERS" "$SB_SAME" install --dry-run --version "$SHA_FAKE" --reuse-env
expect_rc 8 "--reuse-env 不适用于『真的有部署在跑』（同版本）"
SB_REUSE_BAD="$TMP/sandbox-reuse-bad"; mk_sandbox "$SB_REUSE_BAD"
grep -v '^AUTH_SECRET=' "$ENV_GOOD" > "$SB_REUSE_BAD/.env"; chmod 600 "$SB_REUSE_BAD/.env"
run_install "$FX_PARTIAL0" "$SB_REUSE_BAD" install --dry-run --version "$SHA_FAKE" --reuse-env
expect_rc 7 "--reuse-env 但 .env 校验不过（缺 AUTH_SECRET）→ 仍然 7（校验优先于复用）"
run_install "$FX_NONE" "$SB" uninstall --dry-run --reuse-env
expect_rc 2 "--reuse-env 用在非 install 动作 → 用法错误"

# D7 非 root（DoD 4）
FX_NONROOT="$(mkfix nonroot uid=1000)"
run_install "$FX_NONROOT" "$SB" install --dry-run --version "$SHA_FAKE"
expect_rc 3 "非 root → 退出码 3"
has "sudo" "非 root 提示含 sudo"
if [ ! -e "$SB/.env" ]; then ok "非 root 未写入任何东西"; else bad "非 root 竟写了 .env"; fi

# D8 缺 Docker（DoD 3）
FX_NODOCKER="$(mkfix nodocker docker_present=0 compose_ok=0)"
run_install "$FX_NODOCKER" "$SB" install --dry-run --version "$SHA_FAKE"
expect_rc 4 "缺 Docker → 退出码 4"
has "https://docs.docker.com/engine/install/" "stderr 含 Docker 官方文档"
has "包管理器" "stderr 含发行版包管理器路径"
hasnt "docker pull" "缺 Docker 时没有 pull 计划"
if [ ! -e "$SB/.env" ]; then ok "缺 Docker 时未创建 .env"; else bad "缺 Docker 竟创建了 .env"; fi

# D9 缺必需命令（DoD 的 5）
FX_MISSING="$(mkfix missingtools missing_commands='jq')"
run_install "$FX_MISSING" "$SB" install --dry-run --version "$SHA_FAKE"
expect_rc 5 "缺 jq → 退出码 5"

# D10 同机项目名冲突（DoD 6）
FX_CONFLICT="$(mkfix conflict project_container_count=3 project_working_dirs='/opt/other/TuneX')"
run_install "$FX_CONFLICT" "$SB" install --dry-run --version "$SHA_FAKE"
expect_rc 6 "同机 tunex 项目属于别的目录 → 冲突拒绝"
has "冲突" "冲突提示明确"

# D11 .env 校验失败的端到端（DoD 5）
SB_BAD="$TMP/sandbox-bad"; mk_sandbox "$SB_BAD"
grep -v '^AUTH_SECRET=' "$ENV_GOOD" > "$SB_BAD/.env"; chmod 600 "$SB_BAD/.env"
run_install "$FX_NONE" "$SB_BAD" install --dry-run --version "$SHA_FAKE"
expect_rc 7 "既有 .env 缺 AUTH_SECRET → 退出码 7"
has "AUTH_SECRET" "提示含缺失键名"
hasnt "AbCdEf" "提示不打印任何键值"
chmod 644 "$SB_BAD/.env"
run_install "$FX_NONE" "$SB_BAD" install --dry-run --version "$SHA_FAKE"
expect_rc 7 "权限 644 → 退出码 7"
has "chmod 600" "提示给出 chmod 600"

# D11b --standalone：overlay 存在性 + Compose 版本门（FROZEN-1 的前置矩阵）
FX_STANDALONE="$(mkfix standalone compose_version=2.24.4)"
run_install "$FX_STANDALONE" "$SB" install --dry-run --standalone --version "$SHA_FAKE"
expect_rc 5 "--standalone 缺 overlay 文件 → 退出码 5"
cp "$TX_ROOT/docker-compose.standalone.yaml" "$SB/"
run_install "$FX_STANDALONE" "$SB" install --dry-run --standalone --version "$SHA_FAKE"
expect_rc 0 "--standalone + overlay 就位 → 计划可生成"
has "-f $SB/docker-compose.standalone.yaml" "计划里带上 standalone overlay"
FX_OLDCOMPOSE="$(mkfix oldcompose compose_version=2.20.0)"
run_install "$FX_OLDCOMPOSE" "$SB" install --dry-run --standalone --version "$SHA_FAKE"
expect_rc 4 "standalone 且 Compose < 2.24.4 → 退出码 4"

# D12 upgrade：先备份、后切镜像、再 up -d（DoD 7 的顺序面）
SB_UP="$TMP/sandbox-up"; mk_sandbox "$SB_UP"
sed "s#^TUNEX_IMAGE=.*#TUNEX_IMAGE=ghcr.io/paimoncai/tunex:0000000000000000000000000000000000000000#" "$ENV_GOOD" > "$SB_UP/.env"
chmod 600 "$SB_UP/.env"
FX_UP="$(mkfix up project_container_count=6 project_working_dirs="$SB_UP" backup_manifest_count=3 image_digest='sha256:new')"
run_install "$FX_UP" "$SB_UP" upgrade --dry-run --version "$SHA_FAKE"
expect_rc 0 "upgrade --dry-run 成功"
has "scripts/ops/backup.sh" "upgrade 调用既有 backup.sh"
has "docker pull ghcr.io/paimoncai/tunex:$SHA_FAKE" "upgrade 先 pull 目标镜像"
has "up -d backend worker web" "upgrade 只切应用服务"
has "TUNEX_AGENT_LATEST_VERSION" "upgrade 写面板侧 Agent 版本基线"
has "deploy-history.jsonl" "upgrade 追加带 digest 的部署历史"
before "docker pull" "scripts/ops/backup.sh" "顺序：先 pull 后备份（拉不到就不动任何东西）"
before "scripts/ops/backup.sh" "up -d backend worker web" "顺序：备份在切镜像之前（FROZEN-2）"
has "节点 Agent" "结束时提醒节点不随面板升级"
ENV_BEFORE="$(cat "$SB_UP/.env")"
if [ "$(cat "$SB_UP/.env")" = "$ENV_BEFORE" ]; then ok "dry-run 未改写 .env"; else bad "dry-run 改写了 .env"; fi

# D13 upgrade 镜像不存在（DoD 8）
FX_PULLFAIL="$(mkfix pullfail project_container_count=6 project_working_dirs="$SB_UP" pull_result=fail)"
run_install "$FX_PULLFAIL" "$SB_UP" upgrade --dry-run --version "ghcr.io/paimoncai/tunex:does-not-exist"
expect_rc 9 "目标镜像拉不到 → 退出码 9"
hasnt "scripts/ops/backup.sh" "拉不到镜像时不做备份（无需保护窗口）"
hasnt "up -d backend worker web" "拉不到镜像时没有切镜像"

# D14 upgrade 备份失败 → 拒绝（DoD 9）
FX_BACKUPFAIL="$(mkfix backupfail project_container_count=6 project_working_dirs="$SB_UP" backup_manifest_count=0 backup_result=fail)"
run_install "$FX_BACKUPFAIL" "$SB_UP" upgrade --dry-run --version "$SHA_FAKE"
expect_rc 9 "备份失败（backup.sh 非 0 / 无新 manifest）→ 拒绝升级（DoD 9）"
has "备份失败" "拒绝信息点明备份失败"
hasnt "up -d backend worker web" "备份失败时没有切镜像"

# D15 upgrade 迁移失败 → 调既有 rollback.sh 回退（DoD 7 的失败半边）
FX_MIGFAIL="$(mkfix migfail project_container_count=6 project_working_dirs="$SB_UP" backup_manifest_count=1 migrate_exit=1)"
run_install "$FX_MIGFAIL" "$SB_UP" upgrade --dry-run --version "$SHA_FAKE"
expect_rc 9 "db-migrate 退出码非 0 → 退出码 9"
has "scripts/ops/rollback.sh --to previous --yes" "失败时调用既有 rollback.sh --to previous"

# D16 健康验收失败 → 同样回退
FX_UNHEALTHY="$(mkfix unhealthy project_container_count=6 project_working_dirs="$SB_UP" backup_manifest_count=1 health_http=500 ready_http=000)"
run_install "$FX_UNHEALTHY" "$SB_UP" upgrade --dry-run --version "$SHA_FAKE"
expect_rc 9 "健康验收失败 → 退出码 9"
has "rollback.sh --to previous --yes" "健康失败也走既有回退路径"

# D17 upgrade 前置：非交互且无口令（DoD 10）
FX_NOPASS="$(mkfix nopass project_container_count=6 project_working_dirs="$SB_UP" backup_manifest_count=1 passphrase_available=0)"
LAST_RC=0
LAST_OUT="$(env TUNEX_PROJECT_ROOT="$SB_UP" TUNEX_DRYRUN_FIXTURES="$FX_NOPASS" bash "$INSTALL" upgrade --dry-run --version "$SHA_FAKE" </dev/null 2>&1)" || LAST_RC=$?
if [ "$LAST_RC" != "0" ]; then ok "非交互无口令 → 拒绝（exit=$LAST_RC）"; else bad "非交互无口令竟被放行"; fi
has "BACKUP_PASSPHRASE" "提示含 BACKUP_PASSPHRASE"
has "非交互" "提示含『非交互』"
hasnt "up -d backend worker web" "未发生切镜像"

# D18 upgrade 无部署 → 拒绝
FX_EMPTYDEPLOY="$(mkfix nodeployd project_container_count=0)"
run_install "$FX_EMPTYDEPLOY" "$SB" upgrade --dry-run --version "$SHA_FAKE"
expect_rc 8 "没有可升级的部署 → 退出码 8"

# D19 uninstall（DoD 11）
run_install "$FX_UP" "$SB_UP" uninstall --dry-run
expect_rc 0 "uninstall --dry-run 默认保数据"
has "compose -p tunex" "uninstall 用显式项目名"
has " down" "uninstall 执行 down"
has "数据卷保留" "默认明确保留数据卷"
hasnt " down -v" "默认不删卷"

run_install "$FX_UP" "$SB_UP" uninstall --dry-run --purge-data
expect_rc 2 "--purge-data 非交互且无 --yes → 拒绝"
has "--yes" "拒绝信息要求 --yes"

run_install "$FX_UP" "$SB_UP" uninstall --dry-run --purge-data --yes
expect_rc 0 "--purge-data --yes → 允许"
has " down -v" "确认后才删卷"

# D20 status 只读
SB_STATUS="$TMP/sandbox-status"; mk_sandbox "$SB_STATUS"
cp "$ENV_GOOD" "$SB_STATUS/.env"; chmod 600 "$SB_STATUS/.env"
run_install "$FX_UP" "$SB_STATUS" status --dry-run
expect_rc 0 "status --dry-run"
has "TUNEX_IMAGE" "status 打印当前镜像"
has "健康" "status 打印健康事实"
if [ ! -e "$SB_STATUS/var" ]; then ok "status 没有创建任何持久状态目录"; else bad "status 创建了 var/"; fi

# D20b 真实 status（本机 docker 可用时）：健康码必须是 3 位整数、digest 行不能有裸换行/unknown 噪声
if command -v docker >/dev/null 2>&1; then
  LAST_RC=0
  LAST_OUT="$(env TUNEX_PROJECT_ROOT="$SB" bash "$INSTALL" status 2>&1)" || LAST_RC=$?
  expect_rc 0 "真实 status（无 .env、无容器）仍只读成功"
  if printf '%s\n' "$LAST_OUT" | grep -Eq '/healthz=[0-9]{3} /readyz=[0-9]{3}$'; then
    ok "真实 status：健康码是 3 位（不会出现 000000 —— 双份打印已修）"
  else
    bad "真实 status：健康码格式不对"; printf '%s\n' "$LAST_OUT" | grep healthz
  fi
  hasnt "local:unknown" "真实 status：无部署时不打印 local:unknown 噪声"
else
  skip "docker 不可用：真实 status 未执行"
fi

# D21 --no-docker 只允许配 dry-run/check
run_install "$FX_NONE" "$SB" install --no-docker --version "$SHA_FAKE"
expect_rc 2 "--no-docker 单独使用 → 拒绝"

# D22 --check 真探测：做完前置检查就停（绝不落到真实部署动作）
SB_REAL="$TMP/sandbox-real"; mk_sandbox "$SB_REAL"
LAST_RC=0
LAST_OUT="$(env TUNEX_PROJECT_ROOT="$SB_REAL" bash "$INSTALL" --check install --version "$SHA_FAKE" 2>&1)" || LAST_RC=$?
# 这条要在**任何主机形态**下成立（CI runner 是非 root、且可能没有 docker 守护进程）：
# 前置矩阵拦住谁、就以谁的退出码收场；唯一不允许的是"没通过却成功"。
case "$LAST_RC" in
  0) ok "check 真探测（root + Docker 可用）→ 前置全过"
     has "check 全部通过" "check 明确报告未做变更" ;;
  3) ok "check 真探测（非 root，CI runner 的常态）→ 前置矩阵第一条拦住（exit=3）"
     has "sudo" "非 root 的 check 给出 sudo 提示" ;;
  4|5) ok "check 真探测（本机 Docker/命令不满足）→ 前置矩阵拦住（exit=$LAST_RC）" ;;
  *) bad "check 真探测返回了不该出现的退出码：$LAST_RC"; dump ;;
esac
if [ ! -e "$SB_REAL/.env" ]; then ok "--check 未创建 .env（检查模式零副作用）"; else bad "--check 创建了 .env"; fi

# =============================================================================
group "E. bootstrap 真克隆（ref 形态 / 裸 SHA 形态 / 断言失败自清）"
# =============================================================================
UP="$TMP/upstream"
mkdir -p "$UP"
(
  cd "$UP"
  git init -q -b main .
  printf 'c0\n' > README.md
  git add README.md
  git -c user.name=t -c user.email=t@t commit -q -m c0
  # 一个"假的安装器"：bootstrap 的交接目标
  mkdir -p scripts/ops
  cat > scripts/ops/install.sh <<'STUB'
#!/usr/bin/env bash
printf 'STUB-CALLED %s\n' "$*"
STUB
  chmod +x scripts/ops/install.sh
  git add scripts/ops/install.sh
  git -c user.name=t -c user.email=t@t commit -q -m c1
  SHA_OLD="$(git rev-parse HEAD)"
  git -c user.name=t -c user.email=t@t tag v1.5.0
  printf 'c2\n' >> README.md
  git add README.md
  git -c user.name=t -c user.email=t@t commit -q -m c2
  SHA_TIP="$(git rev-parse HEAD)"
  printf '%s\n%s\n' "$SHA_OLD" "$SHA_TIP" > "$TMP/shas.txt"
)
REPO="file://$UP"
SHA_OLD="$(sed -n 1p "$TMP/shas.txt")"
SHA_TIP="$(sed -n 2p "$TMP/shas.txt")"

# E1 dry-run 计划（两种形态，断言不含 --depth 的那条）
LAST_RC=0
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version "$SHA_OLD" --dir "$TMP/dest-plan" --dry-run 2>&1)" || LAST_RC=$?
expect_rc 0 "bootstrap --dry-run（裸 SHA）"
has "git clone" "计划含 git clone"
has "checkout --detach $SHA_OLD" "裸 SHA 用分离检出"
has "rev-parse HEAD" "计划含 rev-parse 断言"
CLONE_LINE="$(printf '%s\n' "$LAST_OUT" | grep -F '[dry-run] git clone' | head -1)"
case "$CLONE_LINE" in
  *"--depth"*) bad "裸 SHA 的 clone 命令里不该出现 --depth：$CLONE_LINE" ;;
  "") bad "计划里没有找到 clone 命令行" ;;
  *) ok "裸 SHA 的 clone 命令是完整克隆（无 --depth）：$CLONE_LINE" ;;
esac
if [ ! -e "$TMP/dest-plan" ]; then ok "bootstrap --dry-run 未创建目录"; else bad "bootstrap --dry-run 竟创建了目录"; fi

LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version v1.5.0 --dir "$TMP/dest-plan-tag" --dry-run 2>&1)" || LAST_RC=$?
expect_rc 0 "bootstrap --dry-run（tag 形态）"
has "--depth 1 --single-branch --branch v1.5.0" "tag 形态用浅克隆"
has "ls-remote" "tag 形态先用 ls-remote 解析 sha"

# E2 裸 SHA 路径：真克隆 + 断言 + 走 stub 安装器
LAST_RC=0
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version "$SHA_OLD" --dir "$TMP/dest-old" 2>&1)" || LAST_RC=$?
expect_rc 0 "裸 SHA 真克隆（非 tip 的老 commit）"
has "STUB-CALLED install --version $SHA_OLD" "交接给安装器时把版本固化成解析出的完整 sha"
if [ "$(git -C "$TMP/dest-old" rev-parse HEAD)" = "$SHA_OLD" ]; then ok "检出 HEAD == 请求 sha"; else bad "检出 HEAD != 请求 sha"; fi
if [ -f "$TMP/dest-old/.git/shallow" ]; then bad "裸 SHA 路径不该是浅克隆"; else ok "裸 SHA 路径是完整克隆（无 .git/shallow）"; fi

# E3 tag 路径：浅克隆 + 解析出的 sha 断言
LAST_RC=0
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version v1.5.0 --dir "$TMP/dest-tag" --action status 2>&1)" || LAST_RC=$?
expect_rc 0 "tag 形态真克隆"
has "STUB-CALLED status --version $SHA_OLD" "tag 被解析成 sha 后交给安装器"
if [ -f "$TMP/dest-tag/.git/shallow" ]; then ok "tag 路径是浅克隆"; else bad "tag 路径应当是浅克隆"; fi
if [ "$(git -C "$TMP/dest-tag" rev-parse HEAD)" = "$SHA_OLD" ]; then ok "tag 检出 HEAD == tag 解析出的 sha"; else bad "tag 检出 HEAD 不符"; fi

# E4 --check：真克隆 + 断言，但不 exec 安装器
LAST_RC=0
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version "$SHA_TIP" --dir "$TMP/dest-check" --check 2>&1)" || LAST_RC=$?
expect_rc 0 "bootstrap --check"
hasnt "STUB-CALLED" "--check 不 exec 安装器"
has "下一步" "--check 打印下一步命令"

# E5 断言失败自清：请求一个不在仓库里的 sha
LAST_RC=0
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version "ffffffffffffffffffffffffffffffffffffffff" --dir "$TMP/dest-bad" 2>&1)" || LAST_RC=$?
if [ "$LAST_RC" != "0" ]; then ok "仓库里没有的 sha → 非零退出（exit=$LAST_RC）"; else bad "不存在的 sha 竟成功"; fi
if [ ! -e "$TMP/dest-bad" ]; then ok "断言/检出失败后目录被清掉"; else bad "失败后残留了目录"; fi

# E6 目标目录已存在且版本不符 → 拒绝，不覆盖
mkdir -p "$TMP/dest-exists"
LAST_RC=0
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version "$SHA_OLD" --dir "$TMP/dest-exists" 2>&1)" || LAST_RC=$?
if [ "$LAST_RC" != "0" ]; then ok "目标目录已存在且非目标版本 → 拒绝"; else bad "目标目录冲突竟通过"; fi
has "移走" "提示人工移走目录（引导段不自动删除既有目录）"

# E7 明确版本：拒绝 latest/分支名
LAST_RC=0
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version main --dir "$TMP/dest-main" 2>&1)" || LAST_RC=$?
expect_rc 2 "版本 main → 用法错误（必须锚定 sha 或 tag）"
LAST_OUT="$(bash "$BOOTSTRAP" --repo "$REPO" --version latest --dir "$TMP/dest-latest" 2>&1)" || LAST_RC=$?
expect_rc 2 "版本 latest → 用法错误"

# =============================================================================
printf '\n=========================================\n'
printf 'installer-static: 通过 %s 项，失败 %s 项\n' "$PASS" "$FAIL"
printf '=========================================\n'
[ "$FAIL" -eq 0 ] || exit 1
exit 0
