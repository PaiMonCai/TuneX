/**
 * QA-01：仓库秘密扫描（零依赖，Node 标准库即可运行）。
 *
 * 目标：在 CI 与本地都能复现「提交前不泄漏密钥/弱默认口令」的检查。只扫描
 * **git 跟踪的文件**（与 CI `git ls-files` 语义一致），因此本地未跟踪的 `.env`
 * 不会被误报，而一旦有人 `git add .env` 就会被拦下。
 *
 * 严重度：
 *   · error（使 CI 失败）：私钥块、真实密钥/连接串赋值、被误跟踪的 `.env`；
 *   · warn（仅提示，不失败）：已知弱默认口令/演示字符串（多出现在文档与 mock
 *     夹具中，属卫生问题而非“秘密泄漏”，作为待清理信号持续可见）。
 *
 * 退出码：0 = 无 error；1 = 有 error；2 = 环境错误。
 * 行内豁免：行尾 `# secret-scan:allow` 或 `# gitleaks:allow`（仅对 error 生效）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const ALLOW = /(secret-scan:allow|gitleaks:allow)/;

/** 占位符/模板值：出现这些字样视为“不是真密钥”。 */
const PLACEHOLDER = /(replace-with|change-me|changeme|placeholder|example|<[^>]+>|\$\{|xxx+|your[-_]?|\.\.\.)/i;

/** 二进制/体积过大的文件直接跳过。 */
const MAX_BYTES = 512 * 1024;

const RULES = [
  {
    id: "private-key",
    severity: "error",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    id: "assigned-secret",
    severity: "error",
    // 形如  KEY = "字面量"（值不含占位符、不是纯变量引用、不是空串）
    re: /^\s*(AUTH_SECRET|LICENSE_SECRET|TUNEX_CONFIG_KEY|TUNEX_LICENSE_KEY|JWT_SECRET|DATABASE_URL)\s*[:=]\s*["']?([^\s"'#]+)/,
    valueGroup: 2,
  },
  {
    id: "weak-default-password",
    severity: "warn",
    re: /\b(demo1234|relayxroot|password123|admin123)\b/,
  },
];

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function main() {
  let files;
  try {
    files = trackedFiles();
  } catch (e) {
    console.error(`secret-scan: 无法列出 git 文件（是否在仓库内？）：${e.message}`);
    process.exit(2);
  }

  const errors = [];
  const warnings = [];
  for (const file of files) {
    // 被误跟踪的真实 .env（允许 *.example / *.sample）。
    if (/(^|\/)\.env(\.(local|production|prod|dev|development))?$/.test(file)) {
      if (!/\.(example|sample|template)$/.test(file)) {
        errors.push({ file, line: 0, rule: "tracked-env", text: "真实 .env 不应被跟踪" });
        continue;
      }
    }
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_BYTES) continue;

    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue; // 二进制/不可读
    }
    if (content.includes("\u0000")) continue; // 二进制

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const allowed = ALLOW.test(line);
      for (const rule of RULES) {
        const m = line.match(rule.re);
        if (!m) continue;
        if (rule.severity === "error" && allowed) continue;
        if (rule.valueGroup) {
          const value = (m[rule.valueGroup] ?? "").trim();
          if (!value || PLACEHOLDER.test(value)) continue;
        }
        const rec = { file, line: i + 1, rule: rule.id, text: line.trim().slice(0, 160) };
        (rule.severity === "error" ? errors : warnings).push(rec);
      }
    }
  }

  if (warnings.length) {
    console.warn(`secret-scan(warn): ${warnings.length} 处弱默认口令/演示字符串（不阻断 CI）：`);
    for (const f of warnings) console.warn(`  [${f.rule}] ${f.file}:${f.line}  ${f.text}`);
  }

  if (errors.length === 0) {
    console.log(`secret-scan: OK —— 已扫描 ${files.length} 个跟踪文件，无硬编码密钥/误跟踪 .env。`);
    process.exit(0);
  }

  console.error(`secret-scan: 发现 ${errors.length} 处疑似秘密（CI 失败）：`);
  for (const f of errors) {
    console.error(`  [${f.rule}] ${f.file}${f.line ? `:${f.line}` : ""}  ${f.text}`);
  }
  console.error("\n如为误报，在行尾添加 `# secret-scan:allow`。");
  process.exit(1);
}

main();
