-- V5-WP0: separate product protocol from legacy TunnelType.
--
-- tunnel_type predates Node+Forward and mixes protocol names with historical
-- wrappers/implementations. The V4 data plane is TCP-only, so every existing
-- user-facing port_forward has a known canonical product protocol: tcp.
--
-- Expand-and-contract:
--   * non-Forward rows remain NULL;
--   * only legacy tunnel_type='tcp' Forward rows are backfilled to canonical tcp;
--   * non-TCP legacy rows stay NULL: their old enum value must never be reinterpreted
--     as TCP merely because V4/V5 no longer implements that old data plane;
--   * revision history is TCP by construction and receives a non-null snapshot field.
-- VARCHAR is deliberate: adding a future protocol is an application-contract/Gate
-- change, not a table-enum rewrite. Unknown persisted values still fail closed.
-- No runtime behavior changes in this migration.

ALTER TABLE `tunnel`
  ADD COLUMN `forward_protocol` VARCHAR(16) NULL;

UPDATE `tunnel`
SET `forward_protocol` = 'tcp'
WHERE `category` = 'port_forward'
  AND `tunnel_type` = 'tcp'
  AND `forward_protocol` IS NULL;

CREATE INDEX `tunnel_forward_protocol_idx`
  ON `tunnel`(`forward_protocol`);

ALTER TABLE `forward_revision`
  ADD COLUMN `protocol` VARCHAR(16) NOT NULL DEFAULT 'tcp' AFTER `mode`;
