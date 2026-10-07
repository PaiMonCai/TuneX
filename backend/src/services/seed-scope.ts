/**
 * 种子数据的**作用域判定**（纯函数，无 IO）。
 *
 * 为什么把它单独抽出来：`prisma/seed.ts` 是一个**脚本**（末尾无条件 `main()` + `process.exit`），
 * 没法在测试里 import —— 而"生产首启时该不该塞演示数据"这条判定恰恰是本次真实部署演练
 * 撞到的产品缺陷所在，必须能被**行为测试**钉住，而不是只能靠读脚本。
 *
 * ── 语义（与 `prisma/seed.ts` 原实现逐字一致，只是搬了个位置）──
 *
 *   显式 `SEED_DEMO_DATA=true`  ⇒ 插入（无论 NODE_ENV）
 *   显式 `SEED_DEMO_DATA=false` ⇒ **不插**（这句话是本函数的全部意义：`.env.example` 承诺
 *                                "生产绝不因为照抄模板就获得示例套餐/节点"）
 *   未设置 + production        ⇒ **不插**（缺省 fail-closed：生产不该凭空多出演示数据）
 *   未设置 + 其它（开发/测试）  ⇒ 插入（本地栈开箱即有数据可看）
 *
 * 注意判定的**比较方式是字符串**（`=== "true"`）：`SEED_DEMO_DATA=0` / `=no` 之类都不是 true，
 * 于是落到"显式给了值但不是我认得的值" —— 这里按**不插**处理（fail-closed），
 * 与"未设置"分支的区别只在 NODE_ENV 上：显式给了奇怪的值时，生产与开发都不插。
 * 下面 truth table 用例把这条也钉住。
 */
export function shouldSeedDemoData(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  const raw = env.SEED_DEMO_DATA;
  if (raw === "true") return true;
  if (raw !== undefined) return false; // 显式给了值（含 "false"/""/其它）⇒ 不插
  return (env.NODE_ENV ?? "development") !== "production";
}

/**
 * 人类可读的原因（日志/排障用）。与 {@link shouldSeedDemoData} 同源，
 * 让"为什么没插"在一行里说清，而不是让运维去猜。
 */
export function describeSeedDemoDecision(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  const raw = env.SEED_DEMO_DATA;
  if (raw === "true") return "demo data enabled by SEED_DEMO_DATA=true";
  if (raw !== undefined) return `demo data skipped (SEED_DEMO_DATA=${JSON.stringify(raw)})`;
  if ((env.NODE_ENV ?? "development") === "production") {
    return "demo data skipped (NODE_ENV=production and SEED_DEMO_DATA unset)";
  }
  return "demo data enabled (default outside production)";
}
