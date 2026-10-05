-- V5-WP19-B —— 目标观测的**延迟历史档案**：原始样本（24h）+ 小时桶（30d）。
--
-- 契约：docs/v5-wp19-latency-observability-contract.md §3 D3/D4、§4.0 Lead 裁决（O1+O4）。
--
-- **纯 additive**：两张新表 + 两个外键，零既有列改动、零回填、零数据变更。
-- 旧二进制可以安全忽略这两张表（它们**不是**任何判定输入：投影仍只回答"现在怎么样"）。
--
-- 为什么是**独立档案表**而不是给 `target_observation` 加历史行：
--   · 投影是每 (节点, 目标) 一行的 upsert，且会被 `deleteMany(notIn: seen)` 收窄 ——
--     就地扩成时序表必须改掉这两条语义，而它们正是"面板现在看到什么"的唯一真相；
--   · 档案**只追加**：没有 upsert、没有 updated_at、永不被健康判定读取（D4）。
--
-- 为什么原始表用 BIGINT 主键：一次上报为每个目标追加一行（节拍 ~30s ⇒ 2880 行/天/目标），
-- INTEGER（21 亿）在千级节点 × 数十目标的规模下一年多就会溢出。主键不出现在任何读路径
-- （避免 BigInt → JSON 的坑）。桶表按 (节点,目标,小时,口径) 唯一，行数受小时数约束，INTEGER 够。
--
-- 为什么桶的唯一键里带 `observation_source`：不同口径（观测节点角色 + 探测种类）的延迟
-- **不可平均在一起**（契约 D6/D12「不可比的量不并排成一条线」）。把它并进平均等于造一个
-- 谁都没测到的数。
--
-- 索引与清理**成对**（契约 D3「有确定保留期与配套索引」）：
--   · `observed_at` 索引 ↔ 原始表按年龄清理（G19.8「按索引清理」）；
--   · `hour_start` 索引  ↔ 桶表按年龄清理；
--   · `(node_id, target_key, observed_at)` / 唯一键  ↔ 读路径按 (节点, 目标) 取窗口。
-- 索引名与 Prisma 的 canonical 名逐字一致（`map:` 未使用）——否则 `migrate diff` 会报漂移。

-- CreateTable
CREATE TABLE `target_latency_sample` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `node_id` INTEGER NOT NULL,
    `target_key` VARCHAR(288) NOT NULL,
    `host` VARCHAR(255) NOT NULL,
    `port` INTEGER NOT NULL,
    `reachable` BOOLEAN NOT NULL,
    `latency_ms` INTEGER NULL,
    `success_rate` DOUBLE NOT NULL DEFAULT 0,
    `observation_source` VARCHAR(64) NOT NULL,
    `observed_at` DATETIME(3) NOT NULL,
    `reported_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `target_latency_sample_observed_at_idx`(`observed_at`),
    INDEX `target_latency_sample_node_id_target_key_observed_at_idx`(`node_id`, `target_key`, `observed_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `target_latency_hourly` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `node_id` INTEGER NOT NULL,
    `target_key` VARCHAR(288) NOT NULL,
    `hour_start` DATETIME(3) NOT NULL,
    `observation_source` VARCHAR(64) NOT NULL,
    `sample_count` INTEGER NOT NULL,
    `success_count` INTEGER NOT NULL,
    `failure_count` INTEGER NOT NULL,
    `latency_samples` INTEGER NOT NULL,
    `latency_sum_ms` DOUBLE NOT NULL,
    `latency_min_ms` INTEGER NULL,
    `latency_max_ms` INTEGER NULL,
    `last_observed_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `target_latency_hourly_hour_start_idx`(`hour_start`),
    UNIQUE INDEX `target_latency_hourly_node_id_target_key_hour_start_observat_key`(`node_id`, `target_key`, `hour_start`, `observation_source`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `target_latency_sample` ADD CONSTRAINT `target_latency_sample_node_id_fkey` FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `target_latency_hourly` ADD CONSTRAINT `target_latency_hourly_node_id_fkey` FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
