-- V5-WP17.3（契约 F7）：DNS 同步的退避状态。
--
-- 纯 additive：历史行拿到"没有待重试的失败"（count=0 / next_at=NULL），与今天的行为一致。
ALTER TABLE `tunnel`
  ADD COLUMN `dns_attempt_count` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `dns_next_attempt_at` DATETIME(3) NULL;
