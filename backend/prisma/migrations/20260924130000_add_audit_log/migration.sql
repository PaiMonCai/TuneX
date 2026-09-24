-- CreateTable
CREATE TABLE `audit_log` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `actor_type` ENUM('user', 'super_admin', 'admin', 'system', 'anonymous') NOT NULL DEFAULT 'anonymous',
    `actor_id` INTEGER NULL,
    `actor_email` VARCHAR(255) NULL,
    `action` VARCHAR(191) NOT NULL,
    `resource` VARCHAR(64) NOT NULL,
    `resource_id` VARCHAR(64) NULL,
    `method` VARCHAR(10) NOT NULL,
    `path` VARCHAR(255) NOT NULL,
    `status` INTEGER NOT NULL,
    `ip` VARCHAR(64) NULL,
    `user_agent` VARCHAR(255) NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_log_actor_id_idx`(`actor_id`),
    INDEX `audit_log_resource_resource_id_idx`(`resource`, `resource_id`),
    INDEX `audit_log_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
