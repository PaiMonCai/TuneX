-- WP7 — Node Credential / Session / State Report（DEVELOPMENT.md §7.10）
--
-- 本迁移与 WP1（20260926040000）同一纪律：纯 expand-and-contract：
--   · 只新增可空列、新表、新索引；
--   · 不 DROP / 不 MODIFY 任何旧列，不改旧列类型与可空性；
--   · 存量节点（从未签发节点凭据）与新表（从未上报过状态）全部为 NULL/空，
--     因此回滚代码时**不需要逆迁移本文件**（生产回滚策略见 §6：保留新增 schema）。
--
-- 为什么不回填、不给默认凭据：
--   回填需要为存量节点各生成一个可用凭据并投递给运维，那是 WP10 管理端
--   「一键签发」的动作，不是迁移该做的事。`node_credential_hash IS NULL` 的
--   语义明确：该节点尚未签发节点凭据，免认证机器端点一律 fail-closed 拒绝，
--   管理员签发后方可接入（见 services/node-credential.ts）。

-- AlterTable
ALTER TABLE `node`
    ADD COLUMN `node_credential_hash` CHAR(64) NULL,
    ADD COLUMN `credential_rotated_at` DATETIME(3) NULL,
    ADD COLUMN `credential_revoked` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `credential_last_rejected_at` DATETIME(3) NULL;

-- CreateIndex
-- 唯一索引同时服务两个目的：等值查找（认证路径）+ 防止两行撞同一哈希。
CREATE UNIQUE INDEX `node_node_credential_hash_key` ON `node`(`node_credential_hash`);
CREATE INDEX `node_credential_revoked_idx` ON `node`(`credential_revoked`);

-- CreateTable
-- WP7 state report：每节点一行的最新状态快照（Agent 上报，见 services/node-state.ts）。
CREATE TABLE `node_state_report` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `node_id` INTEGER NOT NULL,
    `version` VARCHAR(255) NULL,
    `role` VARCHAR(32) NULL,
    `reported_revision` INTEGER NULL,
    `tunnels` JSON NULL,
    `egress_pools` JSON NULL,
    `used_ports` JSON NULL,
    `last_error` VARCHAR(500) NULL,
    `reported_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `node_state_report_node_id_key`(`node_id`),
    INDEX `node_state_report_reported_at_idx`(`reported_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `node_state_report`
    ADD CONSTRAINT `node_state_report_node_id_fkey`
    FOREIGN KEY (`node_id`) REFERENCES `node`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
