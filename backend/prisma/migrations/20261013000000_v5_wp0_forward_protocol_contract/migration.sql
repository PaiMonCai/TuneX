-- V5-WP0: separate product protocol from legacy TunnelType.
--
-- tunnel_type predates Node+Forward and mixes protocol names with historical
-- wrappers/implementations. The V4 data plane is TCP-only, so every existing
-- user-facing port_forward has a known canonical product protocol: tcp.
--
-- Expand-and-contract:
--   * non-Forward rows remain NULL;
--   * existing Forward rows copy their legacy tunnel_type fact verbatim (lower-case);
--   * historical wss/tls/udp/... facts are preserved without admitting those protocols;
--   * revision history is TCP by construction and receives a non-null snapshot field.
-- VARCHAR is deliberate: adding a future protocol is an application-contract/Gate
-- change, not a table-enum rewrite. Unknown persisted values still fail closed.
-- No runtime behavior changes in this migration.

ALTER TABLE `tunnel`
  ADD COLUMN `forward_protocol` VARCHAR(16) NULL;

UPDATE `tunnel`
SET `forward_protocol` = LOWER(`tunnel_type`)
WHERE `category` = 'port_forward'
  AND `forward_protocol` IS NULL;

CREATE INDEX `tunnel_forward_protocol_idx`
  ON `tunnel`(`forward_protocol`);

ALTER TABLE `forward_revision`
  ADD COLUMN `protocol` VARCHAR(16) NOT NULL DEFAULT 'tcp' AFTER `mode`;
