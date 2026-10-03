-- V5-WP0: separate product protocol from legacy TunnelType.
--
-- tunnel_type predates Node+Forward and mixes protocol names with historical
-- wrappers/implementations. The V4 data plane is TCP-only, so every existing
-- user-facing port_forward has a known canonical product protocol: tcp.
--
-- Expand-and-contract:
--   * non-Forward rows remain NULL;
--   * existing Forward rows are deterministically backfilled to tcp;
--   * revision history is TCP by construction and receives a non-null snapshot field.
-- No runtime behavior changes in this migration.

ALTER TABLE `tunnel`
  ADD COLUMN `forward_protocol` ENUM('tcp') NULL;

UPDATE `tunnel`
SET `forward_protocol` = 'tcp'
WHERE `category` = 'port_forward'
  AND `forward_protocol` IS NULL;

CREATE INDEX `tunnel_forward_protocol_idx`
  ON `tunnel`(`forward_protocol`);

ALTER TABLE `forward_revision`
  ADD COLUMN `protocol` ENUM('tcp') NOT NULL DEFAULT 'tcp' AFTER `mode`;
