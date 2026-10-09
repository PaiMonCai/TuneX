-- One ownership table. Keep the old unique index until the conservative backfill
-- completes, then add the exact-binding key and node+port range-lock index.
ALTER TABLE `node_port_lease`
  ADD COLUMN `protocol` VARCHAR(16) NOT NULL DEFAULT 'tcp',
  ADD COLUMN `bind_scope` VARCHAR(255) NOT NULL DEFAULT '*',
  ADD COLUMN `link_id` INTEGER NULL;

-- No persisted protocol evidence (preallocations, orphaned rows, unsupported
-- historical protocols) must not silently become TCP and release UDP ownership.
UPDATE `node_port_lease` AS l
LEFT JOIN `tunnel` AS t ON t.`id` = l.`tunnel_id`
SET l.`protocol` = CASE
  -- Conflicting canonical/legacy facts cannot prove which listener still owns
  -- the socket during an upgrade or interrupted protocol change.
  WHEN LOWER(TRIM(t.`forward_protocol`)) = 'udp'
    AND LOWER(TRIM(t.`tunnel_type`)) IN ('tcp', 'tls', 'ws') THEN 'unknown'
  WHEN LOWER(TRIM(t.`forward_protocol`)) IN ('tcp', 'tls', 'ws')
    AND LOWER(TRIM(t.`tunnel_type`)) = 'udp' THEN 'unknown'
  WHEN LOWER(TRIM(COALESCE(NULLIF(t.`forward_protocol`, ''), t.`tunnel_type`))) = 'udp' THEN 'udp'
  WHEN LOWER(TRIM(COALESCE(NULLIF(t.`forward_protocol`, ''), t.`tunnel_type`))) IN ('tcp', 'tls', 'ws') THEN 'tcp'
  ELSE 'unknown'
END;

ALTER TABLE `node_port_lease`
  DROP INDEX `node_port_lease_node_id_port_key`,
  ADD UNIQUE INDEX `node_port_lease_node_id_protocol_bind_scope_port_key` (`node_id`, `protocol`, `bind_scope`, `port`),
  ADD INDEX `node_port_lease_node_id_port_idx` (`node_id`, `port`),
  ADD INDEX `node_port_lease_link_id_idx` (`link_id`);
