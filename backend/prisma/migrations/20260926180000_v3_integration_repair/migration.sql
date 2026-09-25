-- v3 integration repair: persist actual ingress placement and align LB enum.
-- Additive migration: existing rows stay nullable because group->node mapping can be ambiguous.

ALTER TABLE `tunnel`
  ADD COLUMN `ingress_node_id` INTEGER NULL;

CREATE INDEX `tunnel_ingress_node_id_idx` ON `tunnel`(`ingress_node_id`);

ALTER TABLE `tunnel`
  ADD CONSTRAINT `tunnel_ingress_node_id_fkey`
  FOREIGN KEY (`ingress_node_id`) REFERENCES `node`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Prisma maps enum values to MySQL column ENUMs, so both columns must be widened.
ALTER TABLE `node`
  MODIFY COLUMN `lb_strategy` ENUM('round','rand','weighted_round') NULL;

ALTER TABLE `egress_pool`
  MODIFY COLUMN `lb_strategy` ENUM('round','rand','weighted_round') NULL;
