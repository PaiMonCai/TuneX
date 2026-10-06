-- Preserve archived traffic after a Forward/Tunnel is deleted.
--
-- Before this migration tunnel_traffic was owned by a restrictive FK to tunnel.
-- The delete path therefore had to delete usage rows before deleting the Tunnel,
-- which allowed historical quota/accounting usage to disappear with the runtime.
--
-- Traffic is an accounting ledger, not a child lifecycle object:
--   * tunnel_id remains the immutable source identity;
--   * workspace_id is copied into every row and becomes the authorization/quota key;
--   * the live Tunnel FK is dropped so history survives product deletion.
--
-- Existing rows are safe to backfill because the old FK guarantees every
-- tunnel_traffic.tunnel_id resolves to a Tunnel at migration time.

ALTER TABLE `tunnel_traffic`
  ADD COLUMN `workspace_id` INTEGER NULL;

UPDATE `tunnel_traffic` tt
JOIN `tunnel` t ON t.`id` = tt.`tunnel_id`
SET tt.`workspace_id` = t.`workspace_id`;

-- Fail visibly if an unexpected orphan somehow exists instead of inventing a tenant.
ALTER TABLE `tunnel_traffic`
  MODIFY `workspace_id` INTEGER NOT NULL;

CREATE INDEX `tunnel_traffic_workspace_id_date_idx`
  ON `tunnel_traffic`(`workspace_id`, `date`);

ALTER TABLE `tunnel_traffic`
  DROP FOREIGN KEY `tunnel_traffic_tunnel_id_fkey`;
