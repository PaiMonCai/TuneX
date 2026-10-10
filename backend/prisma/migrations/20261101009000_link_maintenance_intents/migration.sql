CREATE TABLE `link_maintenance_migration` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `link_id` INTEGER NOT NULL,
  `workspace_id` INTEGER NOT NULL,
  `created_by` INTEGER NOT NULL,
  `idempotency_key` VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `request_digest` CHAR(64) NOT NULL,
  `operation` VARCHAR(24) NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'awaiting_executor',
  `state_version` INTEGER NOT NULL DEFAULT 1,
  `active_link_id` INTEGER NULL,
  `expected_version` INTEGER NOT NULL,
  `expected_generation` INTEGER NOT NULL,
  `state_token` CHAR(64) NOT NULL,
  `snapshot_digest` CHAR(64) NOT NULL,
  `snapshot` JSON NOT NULL,
  `hold_expires_at` DATETIME(3) NOT NULL,
  `reason_code` VARCHAR(64) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `link_maintenance_migration_active_link_id_key` (`active_link_id`),
  UNIQUE INDEX `link_maintenance_migration_link_id_idempotency_key_key` (`link_id`, `idempotency_key`),
  INDEX `link_maintenance_migration_status_hold_expires_at_idx` (`status`, `hold_expires_at`),
  INDEX `link_maintenance_migration_workspace_id_link_id_id_idx` (`workspace_id`, `link_id`, `id`),
  -- Ownership IDs are immutable. MySQL forbids a CHECK on an ON UPDATE CASCADE column.
  CONSTRAINT `link_maintenance_migration_link_id_fkey` FOREIGN KEY (`link_id`) REFERENCES `link_resource` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `link_maintenance_migration_state_check` CHECK (
    `state_version` > 0 AND ((`status` = 'awaiting_executor' AND `active_link_id` IS NOT NULL AND `active_link_id` = `link_id`)
    OR (`status` IN ('cancelled', 'invalidated', 'expired') AND `active_link_id` IS NULL)))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `link_maintenance_event` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `migration_id` INTEGER NOT NULL,
  `state_version` INTEGER NOT NULL,
  `status` VARCHAR(24) NOT NULL,
  `reason_code` VARCHAR(64) NULL,
  `created_by` INTEGER NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `link_maintenance_event_migration_id_state_version_key` (`migration_id`, `state_version`),
  CONSTRAINT `link_maintenance_event_migration_id_fkey` FOREIGN KEY (`migration_id`) REFERENCES `link_maintenance_migration` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
