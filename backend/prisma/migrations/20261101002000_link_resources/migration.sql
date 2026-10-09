ALTER TABLE `tunnel`
  ADD COLUMN `bytes_per_second_in` INTEGER NULL,
  ADD COLUMN `bytes_per_second_out` INTEGER NULL,
  ADD COLUMN `max_connections` INTEGER NULL,
  ADD COLUMN `max_connections_per_ip` INTEGER NULL,
  ADD COLUMN `link_resource_id` INTEGER NULL;

CREATE TABLE `link_resource` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `workspace_id` INTEGER NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `carrier` VARCHAR(32) NOT NULL DEFAULT 'fxp_v1',
  `status` VARCHAR(24) NOT NULL DEFAULT 'draft',
  `generation` INTEGER NOT NULL DEFAULT 0,
  `desired_version` INTEGER NOT NULL DEFAULT 1,
  `created_by` INTEGER NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `link_resource_workspace_id_name_key` (`workspace_id`, `name`),
  INDEX `link_resource_workspace_id_status_idx` (`workspace_id`, `status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `link_version` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `link_id` INTEGER NOT NULL,
  `version` INTEGER NOT NULL,
  `config` JSON NOT NULL,
  `config_digest` VARCHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `link_version_link_id_version_key` (`link_id`, `version`),
  CONSTRAINT `link_version_link_id_fkey` FOREIGN KEY (`link_id`) REFERENCES `link_resource` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `link_transport_credential` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `link_id` INTEGER NOT NULL,
  `generation` INTEGER NOT NULL,
  `secret_enc` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `link_transport_credential_link_id_generation_key` (`link_id`, `generation`),
  CONSTRAINT `link_transport_credential_link_id_fkey` FOREIGN KEY (`link_id`) REFERENCES `link_resource` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `link_deployment` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `link_id` INTEGER NOT NULL,
  `generation` INTEGER NOT NULL,
  `version` INTEGER NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'pending',
  `binding_snapshot` JSON NOT NULL,
  `lease_expires_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `link_deployment_link_id_generation_key` (`link_id`, `generation`),
  CONSTRAINT `link_deployment_link_id_fkey` FOREIGN KEY (`link_id`) REFERENCES `link_resource` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `link_placement` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `deployment_id` INTEGER NOT NULL,
  `node_id` INTEGER NOT NULL,
  `role` VARCHAR(16) NOT NULL,
  `runtime_id` VARCHAR(160) NOT NULL,
  `generation` INTEGER NOT NULL,
  `config_digest` VARCHAR(64) NOT NULL,
  `applied_generation` INTEGER NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'pending',
  `last_error_code` VARCHAR(64) NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `link_placement_deployment_id_role_key` (`deployment_id`, `role`),
  INDEX `link_placement_node_id_status_idx` (`node_id`, `status`),
  CONSTRAINT `link_placement_deployment_id_fkey` FOREIGN KEY (`deployment_id`) REFERENCES `link_deployment` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `tunnel_link_resource_id_idx` ON `tunnel` (`link_resource_id`);
ALTER TABLE `tunnel` ADD CONSTRAINT `tunnel_link_resource_id_fkey`
  FOREIGN KEY (`link_resource_id`) REFERENCES `link_resource` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
