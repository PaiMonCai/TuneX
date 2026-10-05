-- V5-WP18.2（契约 F3/F4）—— 通知投递账本。
--
-- 纯 additive：只新增一张表，不动任何既有表/列。空库与存量 V4/V5 库都能直接 apply。
--
-- 三条设计依据（详见 schema.prisma 的 model NotificationDelivery 注释）：
--   1. 唯一索引 (dedupe_key, channel_kind) 是幂等的**兜底**：契约 F3 要求每渠道各自一条
--      投递记录，而 F4.2 的 dedupe_key 组成里没有渠道 —— 两者联立后唯一索引只能带渠道；
--      api 与 worker 是两个进程，Redis 静默期抖动或过期时，靠它保证"一行"而不是"两封信"。
--   2. `status` 从 sending 起步（先占位、后投递）：抢占失败 = 别的进程已经在投，直接放弃，
--      这是 R7「SETNX 占位 + 唯一索引 + 读走即删」三层防线里的第二层。
--   3. **不建外键**（与 federation_placement / federation_usage_record 同一取向）：
--      账本是历史证据，删 workspace 不该把它抹掉；而 Cascade 会把"我们给谁发过什么"
--      一起删掉，SetNull 又要给 Workspace 加一行仅为约束存在的反向关系。
--      workspace_id 允许 NULL = 平台级事实（契约 F6.2 同一条结构口径）。
--
-- 全部用 VARCHAR 而不是 ENUM：F5 已冻结"additive、不引 DB enum"——DB enum 增删值
-- 都会让旧二进制读到未知值时失败（与 NOTICE* 枚举值一个都不能删同一条理由）。

CREATE TABLE `notification_delivery` (
    `id`             INTEGER NOT NULL AUTO_INCREMENT,
    `scope_kind`     VARCHAR(16) NOT NULL,
    `workspace_id`   INTEGER NULL,
    `dedupe_key`     VARCHAR(64) NOT NULL,
    `source_kind`    VARCHAR(32) NOT NULL,
    `source_id`      VARCHAR(191) NOT NULL,
    `reason_code`    VARCHAR(64) NOT NULL,
    `severity`       VARCHAR(16) NOT NULL,
    `resource_type`  VARCHAR(64) NOT NULL,
    `resource_id`    VARCHAR(191) NOT NULL,
    `channel_kind`   VARCHAR(16) NOT NULL,
    `target`         VARCHAR(512) NOT NULL,
    `status`         VARCHAR(16) NOT NULL DEFAULT 'sending',
    `failure_reason` VARCHAR(32) NULL,
    `attempts`       INTEGER NOT NULL DEFAULT 0,
    `degraded`       BOOLEAN NOT NULL DEFAULT false,
    `error`          TEXT NULL,
    `occurred_at`    DATETIME(3) NOT NULL,
    `window_start`   DATETIME(3) NOT NULL,
    `created_at`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`     DATETIME(3) NOT NULL,

    UNIQUE INDEX `notification_delivery_dedupe_channel_key`(`dedupe_key`, `channel_kind`),
    INDEX `notification_delivery_workspace_created_idx`(`workspace_id`, `created_at`),
    INDEX `notification_delivery_source_idx`(`source_kind`, `source_id`),
    INDEX `notification_delivery_status_created_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
