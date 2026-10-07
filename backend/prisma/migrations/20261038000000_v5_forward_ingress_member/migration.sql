-- task-43 —— 按 Forward 自定义的**入口成员次序**（意图表）。
--
-- 为什么新增一张表：次序是"按这条转发"的意图（同一台节点可以在 A 转发里排第 1、
-- 在 B 转发里排第 3），而节点组是多条转发共享的资源 —— 把次序写进节点列会让共用
-- 该组的其它转发一起变形。行为参照 ForwardX 的成员表（priority + isEnabled），
-- 但**只落意图**：不带任何健康/延迟/失败列（那会是既有上报事实的第二份真相）。
--
-- 为什么可以 expand-only、不回填：**没有行 = 今天的行为**（合格候选按 node_id 升序）。
-- 因此本迁移不改变任何既有转发的迁移/接管结果，只有用户显式保存过次序之后才有行。
--
-- 回滚：DROP TABLE `forward_ingress_member`;（见同目录 README 说明）
-- 级联：tunnel/node 被删时意图行随之消失（它描述两者之间的关系，无账本语义）。

CREATE TABLE `forward_ingress_member` (
  `id`         INTEGER NOT NULL AUTO_INCREMENT,
  `tunnel_id`  INTEGER NOT NULL,
  `node_id`    INTEGER NOT NULL,
  `priority`   INTEGER NOT NULL,
  `is_enabled` BOOLEAN NOT NULL DEFAULT true,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `forward_ingress_member_tunnel_id_node_id_key`(`tunnel_id`, `node_id`),
  INDEX `forward_ingress_member_tunnel_id_priority_idx`(`tunnel_id`, `priority`),

  CONSTRAINT `forward_ingress_member_tunnel_id_fkey`
    FOREIGN KEY (`tunnel_id`) REFERENCES `tunnel`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `forward_ingress_member_node_id_fkey`
    FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
