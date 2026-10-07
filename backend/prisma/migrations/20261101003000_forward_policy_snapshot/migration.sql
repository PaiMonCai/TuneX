-- Immutable policy and Link provenance; leave legacy snapshots unchanged.
ALTER TABLE `forward_revision`
  ADD COLUMN `bytes_per_second_in` INTEGER NULL,
  ADD COLUMN `bytes_per_second_out` INTEGER NULL,
  ADD COLUMN `max_connections` INTEGER NULL,
  ADD COLUMN `max_connections_per_ip` INTEGER NULL,
  ADD COLUMN `link_resource_id` INTEGER NULL;
