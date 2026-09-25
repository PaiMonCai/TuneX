-- V4-WP1 — Forward Revision Foundation（DEVELOPMENT.md §13.3.2 / §13.3.3）
--
-- 本迁移是纯 expand-and-contract：
--   · 只新增一张新表 + 两个可空列 + 索引；
--   · 不 DROP / 不 MODIFY 任何旧列，不改旧列类型与可空性；
--   · 因此存量 Forward、legacy 配置下发、旧 Agent 全部零影响；
--   · 回滚代码时**不需要逆迁移本文件**（生产回滚策略见 §6：保留新增 schema）。
--
-- 与并行 V4-WP5（Node Lifecycle）的边界：
--   WP5 改的是 `node` 表 + 新枚举，本迁移只碰 `tunnel` 与新表
--   `forward_revision`。两者在 schema.prisma 里不相邻，合并时逐块保留双方
--   即可（见 reports/v4-wp1-plan.md §3：无 MODIFY/DROP → migrate deploy 与
--   合并顺序无关）。

-- AlterTable
-- 可空理由：存量 Forward 从未有过 revision snapshot，
-- NULL = 「V4-WP1 之前创建、尚未被编辑过一次」。V4 代码读到 NULL 时按
-- 当前投影列合成基线 snapshot（services/forward-revision.ts#baselineSnapshot），
-- 不需要回填脚本——回填反而会把「用户从未编辑过」这个事实抹成「编辑过一次」。
ALTER TABLE `tunnel` ADD COLUMN `desired_revision_id` INTEGER NULL;

-- CreateTable
-- immutable revision snapshot：`UNIQUE(tunnel_id, revision)` 是 §13.3.2
-- 「不可原地修改 + 同一 (tunnel_id, revision) 唯一」的落地。没有任何代码路径
-- update/delete 已写入的行。
--
-- 节点/池列（ingress_node_id / egress_node_id / egress_pool_id）刻意**没有外键**：
-- snapshot 的历史性正是它的价值——节点被删之后，「revision N 当时跑在哪个
-- 节点上」这个事实不能被 ON DELETE SET NULL 静默抹掉。悬空引用的校验是读取方
-- （WP3 rollout 前必须确认节点仍存在）的职责。与 `node_port_lease.tunnel_id`
-- 的无 FK 先例同一取向。
CREATE TABLE `forward_revision` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tunnel_id` INTEGER NOT NULL,
    `revision` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `desired_status` VARCHAR(20) NOT NULL,
    `mode` ENUM('direct', 'relay') NOT NULL,
    `ingress_node_id` INTEGER NOT NULL,
    `egress_node_id` INTEGER NULL,
    `listen_ip` VARCHAR(191) NULL,
    -- 用户请求的监听端口；NULL = 「自动分配」。与创建 contract 同义：
    -- 编排器 apply 时落到 concrete port 并写回 tunnel.listen_port，
    -- 但 snapshot 保留请求值，才能还原「当时要自动还是指名」。
    `listen_port` INTEGER NULL,
    `target_host` VARCHAR(255) NULL,
    `target_port` INTEGER NULL,
    `egress_pool_id` INTEGER NULL,
    `egress_port` INTEGER NULL,
    -- RELAY 保存时刻的 active EgressTarget 快照。必须冗余：池内容可能在本
    -- revision 之后变化（§2.2「目标修改只更新目标快照，不重建隧道」）。
    `targets` JSON NULL,
    -- 保存人（审计上下文）；无外键，用户删除不得改写 runtime 历史。
    `created_by_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `forward_revision_tunnel_id_revision_key`(`tunnel_id`, `revision`),
    INDEX `forward_revision_tunnel_id_created_at_idx`(`tunnel_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
-- 删 Tunnel 会删掉它的 revision 历史。这与「删除 Forward 不得删除历史流量/
-- 审计」不冲突：那两类数据在 `tunnel_traffic` / `audit_log`，不是本表。
ALTER TABLE `forward_revision` ADD CONSTRAINT `forward_revision_tunnel_id_fkey` FOREIGN KEY (`tunnel_id`) REFERENCES `tunnel`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
