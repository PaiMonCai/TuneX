-- V4-WP3 — Forward Rollout Orchestrator（DEVELOPMENT.md §13.3.5 / §13.3.2）。
--
-- 本迁移是纯 expand-and-contract：
--   · 只新增一张新表 `forward_rollout`（+ 它的三个索引）；
--   · 不 DROP / 不 MODIFY 任何旧列；
--   · 回滚代码即整体回滚，**不需要逆迁移本文件**（`forward_rollout` 表与
--     其中的 rollout 行保留无害：它只是旁路记账，没有任何代码再读它）。
--
-- 为什么需要这张表（而不是扩展 `tunnel.apply_status`）：
--   `apply_status` 是**单值状态机**（pending/applying/active/error/suspended），
--   表达不了「这一跳到了哪个阶段、哪些资源已分配、补偿到哪一步」。
--   §13.3.2 要求「Backend/Worker 重启后，只靠 DB revision + Agent state report
--   + NodePortLease 就能继续/补偿 rollout」——这句话成立的前提是**阶段进度
--   本身已落库**。
--
-- 本表**不复制任何 runtime 事实**：
--   · `revision` / `base_revision` 只是两个整数，与 tunnel 行既有的
--     `config_revision` / `applied_revision` 同值；
--   · snapshot 内容一律读 `forward_revision`（WP1）——本表只记「流程进度」。
--
-- 与并行 WP 的边界：只碰新表 + `tunnel` 侧一条 relation 反向边（不加列、不加
-- 约束，纯 schema 层关系声明，因此本文件不含任何 ALTER TABLE）。

-- CreateTable
-- 一条 tunnel 同一时刻**至多一条**未完成 rollout：由服务层
-- `updateMany where phase in (active set)` 抢占；DB 层面**不加唯一键**——
-- 允许历史多行并存，便于排障（哪一次 rollout 卡在哪一步要能查）。
CREATE TABLE `forward_rollout` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tunnel_id` INTEGER NOT NULL,
    -- 本次 rollout 的目标 revision（创建时刻 = tunnel.config_revision 的瞬时值）。
    `revision` INTEGER NOT NULL,
    -- 回退基线：启动本次 rollout 前的 applied_revision（compensation 目标）。
    -- NULL = 该 Forward 从未被成功 apply 过（首次编辑），compensation 退化为
    -- 「撤掉新 runtime 后什么都不做」而不是「重放一个不存在的旧版本」。
    `base_revision` INTEGER NULL,
    -- validate|prepare|cutover|drain|cleanup|done|failed|compensating|degraded|waiting
    `phase` VARCHAR(20) NOT NULL,
    -- 阶段步骤记录（JSON：与 scheduler.SCHEDULER_STEPS 同构的 StepRecord[]）。
    `steps` JSON NULL,
    -- 已分配/待回收资源句柄（leaseId / bindingId / egress 命令 id …）。
    `prepared` JSON NULL,
    -- 每个 CLEANUP 项的幂等键执行结果（重复执行走「已清」分支）。
    `cleaned` JSON NULL,
    `attempt` INTEGER NOT NULL DEFAULT 0,
    `last_error_code` VARCHAR(64) NULL,
    `last_error` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `forward_rollout_tunnel_id_revision_idx`(`tunnel_id`, `revision`),
    INDEX `forward_rollout_phase_idx`(`phase`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
-- 删 Tunnel 会删掉它的 rollout 记账历史。这与「删除 Forward 不得删除历史流量/
-- 审计」不冲突（那两类在 tunnel_traffic / audit_log），也与 WP1 的
-- forward_revision.tunnel_id 级联同一取向： rollouts 是 tunnel 的派生流程记录，
-- 不是独立业务实体。
ALTER TABLE `forward_rollout` ADD CONSTRAINT `forward_rollout_tunnel_id_fkey` FOREIGN KEY (`tunnel_id`) REFERENCES `tunnel`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
