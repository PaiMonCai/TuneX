-- V5.4 WP12 fix —— revision snapshot must carry the middle-hop placement fact.
--
-- The tunnel projection already had middle_node_id, but forward_revision did not.
-- That made a topology-only edit (three-hop -> single-hop, or the reverse) lose the
-- old/new middle-hop fact as soon as rollout reconstructed its desired/applied
-- snapshots. The control plane could then mark a revision applied without
-- re-cutting the ingress data path.
--
-- Additive + nullable keeps every V4/V5 row compatible. No FK by design:
-- forward_revision is immutable history, so deleting a Node must not rewrite what
-- a past revision actually contained.

ALTER TABLE `forward_revision`
  ADD COLUMN `middle_node_id` INTEGER NULL;
