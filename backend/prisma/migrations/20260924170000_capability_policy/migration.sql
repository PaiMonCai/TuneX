-- CapabilityPolicy + WorkspacePolicyAssignment: entitlement/quota facts decoupled
-- from plans, orders and balance. Defaults are the free base capabilities that every
-- workspace receives without any purchase.

-- CreateTable
CREATE TABLE `capability_policy` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(120) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` TEXT NULL,
    `source` ENUM('system_default', 'admin_grant', 'trial', 'purchase') NOT NULL DEFAULT 'system_default',
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `applies_to` ENUM('personal', 'team') NULL,
    `is_ceiling` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    `revision` INTEGER NOT NULL DEFAULT 1,
    `tunnel_types` JSON NOT NULL,
    `allow_custom_in_group` BOOLEAN NOT NULL DEFAULT false,
    `allow_custom_out_group` BOOLEAN NOT NULL DEFAULT false,
    `allowed_in_group_ids` JSON NULL,
    `allowed_out_group_ids` JSON NULL,
    `allow_shared_entry` BOOLEAN NOT NULL DEFAULT false,
    `max_tunnels` INTEGER NULL,
    `max_nodes` INTEGER NULL,
    `max_members` INTEGER NULL,
    `traffic_limit` DOUBLE NULL,
    `traffic_period` ENUM('total', 'month', 'day') NOT NULL DEFAULT 'total',
    `bandwidth_limit` INTEGER NULL,
    `client_limit` INTEGER NULL,
    `ip_limit` INTEGER NULL,
    `whitelist_ips` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `capability_policy_key_key`(`key`),
    INDEX `capability_policy_source_status_idx`(`source`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspace_policy_assignment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `policy_id` INTEGER NOT NULL,
    `source` ENUM('system_default', 'admin_grant', 'trial', 'purchase') NOT NULL DEFAULT 'system_default',
    `effective_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `granted_by_id` INTEGER NULL,
    `note` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `workspace_policy_assignment_workspace_id_policy_id_key`(`workspace_id`, `policy_id`),
    INDEX `workspace_policy_assignment_workspace_id_revoked_at_idx`(`workspace_id`, `revoked_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `workspace_policy_assignment` ADD CONSTRAINT `workspace_policy_assignment_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `workspace_policy_assignment` ADD CONSTRAINT `workspace_policy_assignment_policy_id_fkey` FOREIGN KEY (`policy_id`) REFERENCES `capability_policy`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the platform hard ceiling and the two free default templates.
-- tunnel_types is a JSON array; [] means "no protocol permitted".
INSERT INTO `capability_policy`
  (`key`, `name`, `description`, `source`, `is_default`, `applies_to`, `is_ceiling`, `status`, `revision`,
   `tunnel_types`, `allow_custom_in_group`, `allow_custom_out_group`, `allowed_in_group_ids`, `allowed_out_group_ids`,
   `allow_shared_entry`, `max_tunnels`, `max_nodes`, `max_members`, `traffic_limit`, `traffic_period`,
   `bandwidth_limit`, `client_limit`, `ip_limit`, `whitelist_ips`, `created_at`, `updated_at`)
VALUES
  ('platform_ceiling', '平台硬上限', '所有 workspace 的绝对上界（安全兜底，不直接发放）',
   'system_default', false, NULL, true, 'active', 1,
   JSON_ARRAY('tcp'), true, true, NULL, NULL, true, 100, 20, 50, 1099511627776, 'total', 4096, 512, 512, NULL,
   CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('free_personal', '免费个人能力', '个人工作空间默认获得的基础能力与额度',
   'system_default', true, 'personal', false, 'active', 1,
   JSON_ARRAY('tcp'), true, true, NULL, NULL, true, 2, 1, 2, 53687091200, 'total', 100, 64, 64, NULL,
   CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('free_team', '免费团队能力', '团队工作空间默认获得的基础能力与额度',
   'system_default', true, 'team', false, 'active', 1,
   JSON_ARRAY('tcp', 'udp'), true, true, NULL, NULL, true, 10, 2, 5, 536870912000, 'total', 100, 256, 128, NULL,
   CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

-- Grant every existing workspace its free default policy (single transaction: all
-- workspaces are covered by one statement).
INSERT INTO `workspace_policy_assignment` (`workspace_id`, `policy_id`, `source`, `effective_at`, `created_at`, `updated_at`)
SELECT w.`id`, p.`id`, 'system_default', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `workspace` w
JOIN `capability_policy` p
  ON p.`is_default` = true
 AND p.`status` = 'active'
 AND (p.`applies_to` IS NULL OR p.`applies_to` = w.`kind`);
