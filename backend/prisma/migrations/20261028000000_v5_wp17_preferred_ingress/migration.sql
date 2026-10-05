-- V5-WP17.1（契约 D4 收口）：首选入口节点 + 连续健康计数。
--
-- 纯 additive：两列都可空/有默认值，历史行不需要回填（NULL = 没有偏好 = 今天的行为）。
ALTER TABLE `tunnel`
  ADD COLUMN `preferred_ingress_node_id` INTEGER NULL,
  ADD COLUMN `failback_healthy_checks` INTEGER NOT NULL DEFAULT 0;

-- 与 `ingress_node_id` 同样的删除语义：节点消失只让偏好消失（SetNull），
-- 绝不级联删掉一条转发 —— 丢掉一条转发是不可逆事故，丢掉一个偏好只是"重新配一次"。
ALTER TABLE `tunnel`
  ADD CONSTRAINT `tunnel_preferred_ingress_node_id_fkey`
  FOREIGN KEY (`preferred_ingress_node_id`) REFERENCES `node`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX `tunnel_preferred_ingress_node_id_idx` ON `tunnel`(`preferred_ingress_node_id`);
