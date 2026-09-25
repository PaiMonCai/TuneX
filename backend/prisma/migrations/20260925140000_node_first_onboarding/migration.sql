-- Node-first onboarding + ingress/egress binding.
-- Expand-only: existing nodes/tunnels remain valid.

ALTER TABLE `node`
  ADD COLUMN `agent_id` VARCHAR(64) NULL,
  MODIFY `connect_ip` VARCHAR(255) NULL;

UPDATE `node`
SET `agent_id` = CONCAT('agt_', REPLACE(UUID(), '-', ''))
WHERE `agent_id` IS NULL;

ALTER TABLE `node`
  MODIFY `agent_id` VARCHAR(64) NOT NULL;

CREATE UNIQUE INDEX `node_agent_id_key` ON `node`(`agent_id`);

-- Port ownership is now concrete-node scoped. The old group-level unique key
-- prevented two different ingress nodes in one group from listening on the same port.
ALTER TABLE `tunnel`
  DROP INDEX `tunnel_listen_port_in_node_group_id_key`,
  ADD INDEX `tunnel_in_node_group_id_listen_port_idx`(`in_node_group_id`, `listen_port`);

CREATE TABLE `node_enrollment` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `node_id` INTEGER NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `used_at` DATETIME(3) NULL,
  `revoked_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `node_enrollment_token_hash_key`(`token_hash`),
  INDEX `node_enrollment_node_id_expires_at_idx`(`node_id`, `expires_at`),
  INDEX `node_enrollment_expires_at_used_at_revoked_at_idx`(`expires_at`, `used_at`, `revoked_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `node_binding` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `ingress_node_id` INTEGER NOT NULL,
  `egress_node_id` INTEGER NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `node_binding_ingress_node_id_egress_node_id_key`(`ingress_node_id`, `egress_node_id`),
  INDEX `node_binding_egress_node_id_idx`(`egress_node_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `node_enrollment`
  ADD CONSTRAINT `node_enrollment_node_id_fkey`
  FOREIGN KEY (`node_id`) REFERENCES `node`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `node_binding`
  ADD CONSTRAINT `node_binding_ingress_node_id_fkey`
  FOREIGN KEY (`ingress_node_id`) REFERENCES `node`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `node_binding`
  ADD CONSTRAINT `node_binding_egress_node_id_fkey`
  FOREIGN KEY (`egress_node_id`) REFERENCES `node`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
