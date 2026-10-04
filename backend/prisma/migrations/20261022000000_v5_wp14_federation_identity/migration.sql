-- V5.5 WP14/WP15/WP16 —— Panel ↔ Panel 联邦的地基。
--
-- 契约：docs/v5-wp14-16-federation-contract.md（FROZEN）。
--
-- 三条与仓库既有取向一致的决定：
--   1. `status` / `state` / `direction` 用 VARCHAR + 应用层校验，**不用** MySQL enum：
--      federation 的状态集合还会长，而 enum 加值会让旧二进制读到未知值时直接失败（§3.4）。
--   2. 跨面板引用本机资源（tunnel / node / workspace）**不加外键**：与 forward_revision、
--      node_port_lease 同一取向 —— 删除一条 Forward 不得抹掉"当时联邦把哪条链路租给了谁"
--      的历史。悬空引用的校验属于读取方。
--   3. 这张迁移是纯 additive：新表 + 新索引，不动任何既有列，旧二进制可以安全忽略它们。

CREATE TABLE `federation_setting` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `panel_id` VARCHAR(64) NOT NULL,
    `key_id` VARCHAR(64) NOT NULL,
    `private_key_enc` TEXT NOT NULL,
    `public_key` JSON NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `federation_setting_panel_id_key`(`panel_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `federation_peer` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `peer_panel_id` VARCHAR(64) NOT NULL,
    `display_name` VARCHAR(120) NOT NULL,
    `endpoint_url` VARCHAR(255) NOT NULL,
    `public_keys` JSON NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
    `trust_scope` JSON NULL,
    `last_seen_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `federation_peer_peer_panel_id_key`(`peer_panel_id`),
    INDEX `federation_peer_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `federation_credential` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `peer_id` INTEGER NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `purpose` VARCHAR(32) NOT NULL DEFAULT 'bootstrap',
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `federation_credential_token_hash_key`(`token_hash`),
    INDEX `federation_credential_peer_id_expires_at_idx`(`peer_id`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `federation_message_receipt` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `message_key` VARCHAR(191) NOT NULL,
    `peer_panel_id` VARCHAR(64) NOT NULL,
    `direction` VARCHAR(16) NOT NULL,
    `path` VARCHAR(191) NOT NULL,
    `status` INTEGER NOT NULL,
    `response_body` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `federation_message_receipt_message_key_key`(`message_key`),
    INDEX `federation_message_receipt_created_at_idx`(`created_at`),
    INDEX `federation_message_receipt_peer_panel_id_created_at_idx`(`peer_panel_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `federation_grant` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `peer_id` INTEGER NOT NULL,
    `grant_ref` VARCHAR(64) NOT NULL,
    `workspace_id` INTEGER NULL,
    `grant_epoch` INTEGER NOT NULL DEFAULT 1,
    `status` VARCHAR(32) NOT NULL DEFAULT 'active',
    `scope` JSON NOT NULL,
    `capacity` JSON NOT NULL,
    `quota_reserved` BOOLEAN NOT NULL DEFAULT false,
    `expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_by_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `federation_grant_grant_ref_key`(`grant_ref`),
    INDEX `federation_grant_peer_id_status_idx`(`peer_id`, `status`),
    INDEX `federation_grant_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `federation_lease` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `lease_ref` VARCHAR(64) NOT NULL,
    `grant_id` INTEGER NOT NULL,
    `peer_panel_id` VARCHAR(64) NOT NULL,
    `forward_ref` VARCHAR(191) NOT NULL,
    `intent_id` VARCHAR(64) NOT NULL,
    `state` VARCHAR(32) NOT NULL DEFAULT 'reserved',
    `lease_epoch` INTEGER NOT NULL DEFAULT 1,
    `hop_role` VARCHAR(16) NOT NULL,
    `node_id` INTEGER NULL,
    `listen_port` INTEGER NULL,
    `requested_revision` INTEGER NOT NULL DEFAULT 0,
    `applied_revision` INTEGER NULL,
    `last_error_code` VARCHAR(64) NULL,
    `last_error` TEXT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `applied_at` DATETIME(3) NULL,
    `released_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `federation_lease_lease_ref_key`(`lease_ref`),
    INDEX `federation_lease_peer_panel_id_state_idx`(`peer_panel_id`, `state`),
    INDEX `federation_lease_expires_at_idx`(`expires_at`),
    INDEX `federation_lease_node_id_idx`(`node_id`),
    INDEX `federation_lease_grant_id_state_idx`(`grant_id`, `state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `federation_intent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `intent_id` VARCHAR(64) NOT NULL,
    `peer_panel_id` VARCHAR(64) NOT NULL,
    `lease_id` INTEGER NULL,
    `revision` INTEGER NOT NULL,
    `action` VARCHAR(32) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `error_code` VARCHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `federation_intent_intent_id_revision_action_key`(`intent_id`, `revision`, `action`),
    INDEX `federation_intent_peer_panel_id_created_at_idx`(`peer_panel_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `federation_placement` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `peer_panel_id` VARCHAR(64) NOT NULL,
    `forward_ref` VARCHAR(191) NOT NULL,
    `tunnel_id` INTEGER NULL,
    `intent_id` VARCHAR(64) NOT NULL,
    `lease_ref` VARCHAR(64) NULL,
    `lease_epoch` INTEGER NOT NULL DEFAULT 0,
    `hop_role` VARCHAR(16) NOT NULL,
    `desired_revision` INTEGER NOT NULL DEFAULT 0,
    `applied_revision` INTEGER NULL,
    `state` VARCHAR(32) NOT NULL DEFAULT 'pending',
    `peer_node_ref` VARCHAR(64) NULL,
    `peer_port` INTEGER NULL,
    `last_error_code` VARCHAR(64) NULL,
    `last_error` TEXT NULL,
    `expires_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `federation_placement_peer_panel_id_intent_id_key`(`peer_panel_id`, `intent_id`),
    INDEX `federation_placement_tunnel_id_idx`(`tunnel_id`),
    INDEX `federation_placement_state_idx`(`state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `federation_usage_record` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `usage_id` VARCHAR(96) NOT NULL,
    `peer_panel_id` VARCHAR(64) NOT NULL,
    `lease_ref` VARCHAR(64) NOT NULL,
    `forward_ref` VARCHAR(191) NULL,
    `tunnel_id` INTEGER NULL,
    `window_start` DATETIME(3) NOT NULL,
    `window_end` DATETIME(3) NOT NULL,
    `bytes_in` BIGINT NOT NULL DEFAULT 0,
    `bytes_out` BIGINT NOT NULL DEFAULT 0,
    `connections` INTEGER NOT NULL DEFAULT 0,
    `attribution` VARCHAR(32) NOT NULL DEFAULT 'unattributed',
    `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `federation_usage_record_usage_id_key`(`usage_id`),
    INDEX `federation_usage_record_lease_ref_window_start_idx`(`lease_ref`, `window_start`),
    INDEX `federation_usage_record_tunnel_id_window_start_idx`(`tunnel_id`, `window_start`),
    INDEX `federation_usage_record_peer_panel_id_window_start_idx`(`peer_panel_id`, `window_start`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- grant → lease 与 lease → intent 的外键：这两组是**同一侧**的强关系（grant 被删掉时
-- 它的租约没有存在意义），与"跨面板引用本机资源"是两类不同的事，所以这里保留 FK。
ALTER TABLE `federation_credential`
  ADD CONSTRAINT `federation_credential_peer_id_fkey`
  FOREIGN KEY (`peer_id`) REFERENCES `federation_peer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `federation_grant`
  ADD CONSTRAINT `federation_grant_peer_id_fkey`
  FOREIGN KEY (`peer_id`) REFERENCES `federation_peer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `federation_lease`
  ADD CONSTRAINT `federation_lease_grant_id_fkey`
  FOREIGN KEY (`grant_id`) REFERENCES `federation_grant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `federation_intent`
  ADD CONSTRAINT `federation_intent_lease_id_fkey`
  FOREIGN KEY (`lease_id`) REFERENCES `federation_lease`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
