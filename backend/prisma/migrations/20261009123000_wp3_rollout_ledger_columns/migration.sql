-- V4-WP3 合并前阻塞项修复（DEVELOPMENT.md §13.3.5 / §3.4 / 报告 §5 C4 缺口）。
--
-- 本文件**不重写** `20261009120000_v4_wp3_forward_rollout`。已 push（CI 36212503757
-- 通过）的迁移保持逐字不动，本文件是它之后的纯增量：
--
--   · 只 ADD COLUMN，不 DROP / 不 MODIFY 旧列；
--   · 三个新列全部可空或缺省 → 存量行零回填，`migrate deploy` 在带数据的库上成功；
--   · 回滚代码即整体回滚，**不需要逆迁移本文件**（三列留成 nullable/默认值对新代码
--     无意义、对旧代码不存在，与主迁移同口径）。
--
-- 为什么这四个列必须在库里（而不是在代码层删掉）：
--   `strategy`        计划分类，register 时随 rollout 行落库，用于排障与续跑。
--                      `RolloutPlan.strategy` 是 WP1 `computeForwardImpact` 的
--                      直接投影，删字段等于删 §13.3.4 分类的可观测面。
--   `notes`           逐 step 的人类可读流水账（追加式 `notes.push`）。§13.3.5
--                      要求「哪一次 rollout 卡在哪一步要能查出来」。
--   `compensated`     CUTOVER 失败是否已回退。§13.3.5 第三张表的判据就是这一位。
--   `compensation_error`
--                      compensation 失败的原因（补偿失败 ⇒ `phase=degraded`，
--                      由 Reconciler/人工 Retry 修复，没有这一列就无从判断）。
--
-- 类型选择与既有 schema 一致：`JSON` 用于追加式数组列（同 `prepared`/`cleaned`），
-- `BOOLEAN` 用于布尔判据（同其它 model 的有缺省布尔列），`VARCHAR(500)` 同
-- `last_error` 的宽度与用途。

-- AlterTable
ALTER TABLE `forward_rollout` ADD COLUMN `strategy` VARCHAR(30) NULL;

ALTER TABLE `forward_rollout` ADD COLUMN `notes` JSON NULL;

ALTER TABLE `forward_rollout` ADD COLUMN `compensated` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `forward_rollout` ADD COLUMN `compensation_error` VARCHAR(500) NULL;
