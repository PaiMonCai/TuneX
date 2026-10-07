-- Historical accounting and replay protection deliberately have no live-object FKs.
CREATE TABLE `link_traffic_checkpoint` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `node_id` INTEGER NOT NULL,
  `producer_id` VARCHAR(32) NOT NULL,
  `forward_id` INTEGER NOT NULL,
  `date` DATETIME(3) NOT NULL,
  `link_id` INTEGER NOT NULL,
  `workspace_id` INTEGER NOT NULL,
  `generation` INTEGER NOT NULL,
  `config_digest` VARCHAR(64) NOT NULL,
  `bytes_in` BIGINT NOT NULL DEFAULT 0,
  `bytes_out` BIGINT NOT NULL DEFAULT 0,
  `connections` BIGINT NOT NULL DEFAULT 0,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `link_traffic_checkpoint_identity_key` (`node_id`, `producer_id`, `forward_id`, `date`),
  INDEX `link_traffic_checkpoint_workspace_id_date_idx` (`workspace_id`, `date`),
  INDEX `link_traffic_checkpoint_workspace_id_link_id_idx` (`workspace_id`, `link_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
