-- V5.2 WP5 —— 目标观测投影表（DEVELOPMENT.md §7）
--
-- 这是一张**新增的独立投影**，不是给 EgressTarget 加列：
-- desired 与 observation 是两类事实，混在一张表里会让"目标为什么变了"无法回答。
--
-- 唯一键 (node_id, target_key)：观测是**按视角**的。同一 host:port 被两个出口节点
-- 观测是两条独立事实（一个通、一个不通本身就是运维要看的信号），合并成一条会把这个
-- 信号抹掉。
--
-- latency_ms 可空：不可达时为 NULL。**不写 0** —— 0 表示"瞬间可达"，
-- 用它表示"没有测量"是把这个字段变成两种含义。
--
-- 不存 observation_age：age = now - observed_at，读取时计算。存下来的 age 在写入的
-- 那一刻就已经过期了。observed_at（Agent 时钟）与 reported_at（DB 时钟）都保留：
-- age 用前者算，而"这份观测有多旧"需要一个不依赖 Agent 时钟的参照。
--
-- 回滚安全：本迁移只新增一张表，不触碰任何存量列；代码回滚后该表只是不再被读写。

CREATE TABLE `target_observation` (
    `id`                  INTEGER NOT NULL AUTO_INCREMENT,
    `node_id`             INTEGER NOT NULL,
    `target_key`          VARCHAR(288) NOT NULL,
    `host`                VARCHAR(255) NOT NULL,
    `port`                INTEGER NOT NULL,
    `reachable`           BOOLEAN NOT NULL,
    `latency_ms`          INTEGER NULL,
    `consecutive_success` INTEGER NOT NULL DEFAULT 0,
    `consecutive_failure` INTEGER NOT NULL DEFAULT 0,
    `success_rate`        DOUBLE NOT NULL DEFAULT 0,
    `observed_at`         DATETIME(3) NOT NULL,
    `reported_at`         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `observation_source`  VARCHAR(64) NOT NULL,
    `updated_at`          DATETIME(3) NOT NULL,

    UNIQUE INDEX `target_observation_node_id_target_key_key`(`node_id`, `target_key`),
    INDEX `target_observation_target_key_idx`(`target_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `target_observation`
  ADD CONSTRAINT `target_observation_node_id_fkey`
  FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
