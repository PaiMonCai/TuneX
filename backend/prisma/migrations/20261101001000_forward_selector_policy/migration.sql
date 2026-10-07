-- Additive selector expansion. Existing rows and defaults are unchanged.
ALTER TABLE `node`
  MODIFY COLUMN `lb_strategy` ENUM('round','rand','weighted_round','fallback','ip_hash') NULL;
ALTER TABLE `egress_pool`
  MODIFY COLUMN `lb_strategy` ENUM('round','rand','weighted_round','fallback','ip_hash') NULL;
