-- Explicit directional access for shared node groups, independent of payments.
-- No grant is inferred from a historical plan: operators must review shared access.
CREATE TABLE `node_group_grant` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `node_group_id` INTEGER NOT NULL,
    `direction` ENUM('in', 'out') NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `node_group_grant_node_group_id_active_idx`(`node_group_id`, `active`),
    UNIQUE INDEX `node_group_grant_user_id_node_group_id_direction_key`(`user_id`, `node_group_id`, `direction`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `node_group_grant` ADD CONSTRAINT `node_group_grant_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `node_group_grant` ADD CONSTRAINT `node_group_grant_node_group_id_fkey` FOREIGN KEY (`node_group_id`) REFERENCES `node_group`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
