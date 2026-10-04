/**
 * 单测的**环境基线**（bunfig.toml 的 [test].preload）。
 *
 * 为什么需要：`src/env.ts` 在 import 期就 `requireSecret`，因此任何 import 到它的模块
 * （`db.ts` / 服务层 / 中间件）在没有环境变量的进程里会**直接抛错**。结果是
 * `bun test <单个文件>` 会因为"另一个文件恰好先跑并设过 env"而变绿 ——
 * 测试结果依赖文件顺序，这正是"偶然通过"的典型形态。
 *
 * 这里只补**缺省值**（`??=`）：CI 已经设置了真实值，不会被覆盖；本地单跑不再依赖顺序。
 * 值刻意是明显的测试占位，不会连上任何真实数据库（纯逻辑用例本来就不该碰 DB）。
 */
process.env.DATABASE_URL ??= "mysql://tunex-test:tunex-test@127.0.0.1:3306/tunex_test_unused";
process.env.REDIS_URL ??= "redis://127.0.0.1:6379/15";
process.env.AUTH_SECRET ??= "tunex-unit-test-auth-secret-not-a-real-secret";
process.env.LICENSE_SECRET ??= "tunex-unit-test-license-secret-not-a-real-secret";
process.env.PAYMENTS_ENABLED ??= "false";
