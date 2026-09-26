-- V4 rollout single-executor lease.
-- Runtime truth remains on Agent; these columns only prevent two backend executors
-- from advancing the same rollout concurrently. Lease expiry allows crash recovery.
ALTER TABLE `forward_rollout`
  ADD COLUMN `executor_owner` VARCHAR(64) NULL,
  ADD COLUMN `executor_lease_until` DATETIME(3) NULL;

CREATE INDEX `forward_rollout_executor_lease_until_idx`
  ON `forward_rollout`(`executor_lease_until`);
