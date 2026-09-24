-- Add nullable ownership columns first. Backfill from the existing user_id FK below,
-- then enforce NOT NULL; directly adding NOT NULL fails on a populated database.
ALTER TABLE `node_group` ADD COLUMN `workspace_id` INTEGER NULL;
ALTER TABLE `tunnel` ADD COLUMN `workspace_id` INTEGER NULL;

-- CreateTable
CREATE TABLE `workspace` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `slug` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `kind` ENUM('personal', 'team') NOT NULL,
    `personal_user_id` INTEGER NULL,
    `created_by_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `workspace_slug_key`(`slug`),
    UNIQUE INDEX `workspace_personal_user_id_key`(`personal_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspace_member` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,
    `role` ENUM('owner', 'admin', 'member', 'viewer') NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `workspace_member_user_id_active_idx`(`user_id`, `active`),
    UNIQUE INDEX `workspace_member_workspace_id_user_id_key`(`workspace_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspace_invite` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `role` ENUM('owner', 'admin', 'member', 'viewer') NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `invited_by_id` INTEGER NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `accepted_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `workspace_invite_token_hash_key`(`token_hash`),
    INDEX `workspace_invite_workspace_id_email_idx`(`workspace_id`, `email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspace_api_key` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `key_hash` CHAR(64) NOT NULL,
    `prefix` VARCHAR(20) NOT NULL,
    `scopes` JSON NOT NULL,
    `expires_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_by_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `workspace_api_key_key_hash_key`(`key_hash`),
    INDEX `workspace_api_key_workspace_id_revoked_at_idx`(`workspace_id`, `revoked_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_event` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `actor_user_id` INTEGER NULL,
    `action` VARCHAR(100) NOT NULL,
    `resource_type` VARCHAR(80) NOT NULL,
    `resource_id` VARCHAR(191) NULL,
    `ip` VARCHAR(80) NULL,
    `detail` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_event_workspace_id_created_at_idx`(`workspace_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Preserve each existing user's assets in a distinct personal workspace.
-- Existing node groups / tunnels always have a valid user_id foreign key.
INSERT INTO `workspace` (`slug`, `name`, `kind`, `personal_user_id`, `created_by_id`, `created_at`, `updated_at`)
SELECT CONCAT('personal-', `id`), CONCAT('Personal ', `id`), 'personal', `id`, `id`, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `user`;

INSERT INTO `workspace_member` (`workspace_id`, `user_id`, `role`, `active`, `created_at`, `updated_at`)
SELECT `id`, `personal_user_id`, 'owner', true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `workspace` WHERE `personal_user_id` IS NOT NULL;

UPDATE `node_group` ng JOIN `workspace` w ON w.`personal_user_id` = ng.`user_id`
SET ng.`workspace_id` = w.`id`;
UPDATE `tunnel` t JOIN `workspace` w ON w.`personal_user_id` = t.`user_id`
SET t.`workspace_id` = w.`id`;

ALTER TABLE `node_group` MODIFY COLUMN `workspace_id` INTEGER NOT NULL;
ALTER TABLE `tunnel` MODIFY COLUMN `workspace_id` INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX `node_group_workspace_id_idx` ON `node_group`(`workspace_id`);

-- CreateIndex
CREATE INDEX `tunnel_workspace_id_idx` ON `tunnel`(`workspace_id`);

-- AddForeignKey
ALTER TABLE `workspace` ADD CONSTRAINT `workspace_personal_user_id_fkey` FOREIGN KEY (`personal_user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_member` ADD CONSTRAINT `workspace_member_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_member` ADD CONSTRAINT `workspace_member_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_invite` ADD CONSTRAINT `workspace_invite_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_api_key` ADD CONSTRAINT `workspace_api_key_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_event` ADD CONSTRAINT `audit_event_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `node_group` ADD CONSTRAINT `node_group_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tunnel` ADD CONSTRAINT `tunnel_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
