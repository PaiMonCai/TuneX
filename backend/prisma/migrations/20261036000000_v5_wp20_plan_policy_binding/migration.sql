-- V5-WP20-4 —— 套餐 → 能力策略的**显式**绑定（契约 §3.5.3）。
--
-- 契约：docs/v5-wp20-subscription-billing-runtime-contract.md §3.5.3（「不做套餐 → 策略的隐式推导」
-- ——发放必须是一条显式的 `WorkspacePolicyAssignment`，套餐上需显式绑定 `policy_id`）、
-- WP20-4 行（支付 → 策略发放接线）。
--
-- 纯 additive：一个**可空**列 + 一个外键。零回填、零既有列改动、零数据变更。
--
-- 为什么可空、且 NULL 不是错误：
--   · 存量套餐全部没有策略绑定（这一列今天才存在），`NULL` = 「没绑」；
--   · 购买路径遇到 NULL 时**不发放** `purchase` 发放，也不拒绝购买 —— 扣款/订单/订阅照常，
--     准入继续由既有 `system_default` 发放决定（= 今天的行为逐字节不变）；
--   · 反例：若 NULL 就拒绝购买，存量商品当场不可售；若 NULL 就随便挑一条模板发放，
--     就是契约禁止的隐式推导（用户会拿到一条他没买过的策略）。
--
-- 为什么删除语义用 SET NULL：策略模板是平台资产，删模板不该让商品行跟着消失（那是商品目录的
-- 数据丢失）。`plan.policy_id` 归零表示「这个商品暂时没有绑定」，与上面的 NULL 语义一致。
--
-- 为什么加外键而不是裸整数列：同一侧（本机）的强关系，与 `user_plan.plan_id` 同取向；
-- 悬空引用会同时污染购买与展示两条读路径。
--
-- 注：时间戳刻意避开同批其它 WP 已占用的 20261033/20261034/20261035（同一时刻两个目录名会让
-- 「谁先应用」变得只能靠名字猜）。

ALTER TABLE `plan` ADD COLUMN `policy_id` INTEGER NULL;

ALTER TABLE `plan` ADD CONSTRAINT `plan_policy_id_fkey` FOREIGN KEY (`policy_id`) REFERENCES `capability_policy`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
