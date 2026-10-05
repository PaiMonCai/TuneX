-- V5-WP20-2 —— 订阅结算账本 + 套餐归属（套餐属 **Workspace**，不属 user）。
--
-- 契约：docs/v5-wp20-subscription-billing-runtime-contract.md §3.1（先占位后执行的幂等）、
-- §3.5（归属：分两步落地，第一步不加破坏性约束）、§4.0（Lead 裁决）、R5/R6；DoD 第 7 条。
--
-- **纯 additive**：两张新表 + `plan_order` 一个可空列 + 一个索引。零回填、零既有列改动、
-- 零数据变更 —— 旧二进制可以安全忽略这些对象（与 20261022000000_v5_wp14 同一取向）。
--
-- 为什么 `state` / `source` 用 VARCHAR + 应用层校验，**不用** MySQL enum：
--   1. DoD 第 7 条要求 `enum .*Status` 数量不增加；契约 §8.1 也禁止新增
--      `SubscriptionStatus`/`AssignmentStatus` 这类状态枚举（订阅「有效」= `started_at <= now < expires_at`
--      的时间比较，不是状态列）；
--   2. 状态集合还会长，enum 加值会让旧二进制读到未知值时直接失败（联邦 migration 的同款理由）。
--
-- 为什么 `expires_at` 可空：`BillingCycle` 含 `lifetime`（契约 F25），终身订阅没有到期点；
-- NOT NULL 会逼出一个魔法日期（如 9999-12-31），那就是第二个真相 + 边界 bug。
--
-- 外键取向是**被既有删除流程倒推**出来的，不是偏好（`routes/admin-extended.ts:400-440`
-- 的删用户事务：先 `workspace.deleteMany` 删掉个人 workspace，之后才 `planOrder.deleteMany`）：
--   · `plan_subscription.workspace_id` → `workspace.id` 必须 **CASCADE**：`RESTRICT` 会让
--     「删用户」在存在订阅时直接失败（`workspace.deleteMany` 抛错），即打破既有路径；
--   · `plan_order.workspace_id` → `workspace.id` 用 **SET NULL**：历史行 `NULL` 是合法历史
--     （契约 R5「不猜」），且删 workspace 时不得阻塞；
--   · `subscription_period_settlement.order_id` → `plan_order.id` 用 **SET NULL**：账本行被删
--     不该连带抹掉结算占位（占位是幂等闸门）；
--   · `subscription_period_settlement.plan_subscription_id` 用 **CASCADE**：该行只是订阅的
--     周期占位，订阅随租户消失时它没有独立存在意义。
--
-- 为什么不回填 `user_plan` → `plan_subscription`：契约 §3.5「分两步、第一步不加破坏性约束」
-- 且 R5「不猜历史」——回填必须猜「哪个 workspace、哪些历史行有效、`expired_at` 是否是到期点」，
-- 猜错就是把错误写进唯一真相。归属的写入路径由 WP20-4（购买事务内）建立。

-- AlterTable
ALTER TABLE `plan_order` ADD COLUMN `workspace_id` INTEGER NULL;

-- CreateTable
CREATE TABLE `plan_subscription` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `plan_id` INTEGER NOT NULL,
    `started_at` DATETIME(3) NOT NULL,
    `expires_at` DATETIME(3) NULL,
    `auto_renew` BOOLEAN NOT NULL DEFAULT false,
    `source` VARCHAR(32) NOT NULL DEFAULT 'purchase',
    `plan_name` VARCHAR(255) NOT NULL,
    `billing_cycle` ENUM('month', 'quarter', 'half_year', 'year', 'lifetime') NOT NULL,
    `price` DOUBLE NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `plan_subscription_workspace_id_key`(`workspace_id`),
    INDEX `plan_subscription_plan_id_idx`(`plan_id`),
    INDEX `plan_subscription_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscription_period_settlement` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `plan_subscription_id` INTEGER NOT NULL,
    `period_key` VARCHAR(16) NOT NULL,
    `state` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `order_id` INTEGER NULL,
    `error` TEXT NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `settled_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `subscription_period_settlement_state_started_at_idx`(`state`, `started_at`),
    UNIQUE INDEX `subscription_period_settlement_plan_subscription_id_period_k_key`(`plan_subscription_id`, `period_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `plan_order_workspace_id_idx` ON `plan_order`(`workspace_id`);

-- AddForeignKey
ALTER TABLE `plan_order` ADD CONSTRAINT `plan_order_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plan_subscription` ADD CONSTRAINT `plan_subscription_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plan_subscription` ADD CONSTRAINT `plan_subscription_plan_id_fkey` FOREIGN KEY (`plan_id`) REFERENCES `plan`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscription_period_settlement` ADD CONSTRAINT `subscription_period_settlement_plan_subscription_id_fkey` FOREIGN KEY (`plan_subscription_id`) REFERENCES `plan_subscription`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscription_period_settlement` ADD CONSTRAINT `subscription_period_settlement_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `plan_order`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

