-- V5.3 WP9 —— 归属租约（fencing，防 split brain）
--
-- 危险场景：面板以为 A 掉线 → B 接管 → A 其实只是被分区，仍在监听。防它的不是"更准的
-- 心跳"，而是**所有权世代**：只有持有当前 epoch 的节点才允许服务，被降级的节点在收到
-- 更高 epoch 时拒绝继续（Agent 侧强制，见 §8 冻结契约）。
--
-- 设计要点：
--   · tunnel_id 唯一 —— 每个 Forward 最多一条租约，"两条租约都自称有效"根本无法表示；
--   · epoch 单调递增，"最后写入者获胜"被明确禁止；任何归属变更都是 epoch + 1；
--   · lease_expires_at 到期即停（fail-safe），续约由 owner 负责；
--   · revision 把租约钉在某个配置版本上，避免"新主人跑旧配置"。
--
-- 回滚安全：只新增一张表，且外键 ON DELETE CASCADE —— 删除 Forward/节点会连带清掉租约，
-- 不会留下指向已删对象的孤儿行（孤儿租约正是"幽灵主人"的来源）。

CREATE TABLE `placement_lease` (
    `id`               INTEGER NOT NULL AUTO_INCREMENT,
    `tunnel_id`        INTEGER NOT NULL,
    `owner_node_id`    INTEGER NOT NULL,
    `epoch`            INTEGER NOT NULL DEFAULT 0,
    `lease_expires_at` DATETIME(3) NOT NULL,
    `revision`         INTEGER NOT NULL,
    `created_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`       DATETIME(3) NOT NULL,

    UNIQUE INDEX `placement_lease_tunnel_id_key`(`tunnel_id`),
    INDEX `placement_lease_owner_node_id_lease_expires_at_idx`(`owner_node_id`, `lease_expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `placement_lease`
  ADD CONSTRAINT `placement_lease_tunnel_id_fkey`
  FOREIGN KEY (`tunnel_id`) REFERENCES `tunnel`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `placement_lease`
  ADD CONSTRAINT `placement_lease_owner_node_id_fkey`
  FOREIGN KEY (`owner_node_id`) REFERENCES `node`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
