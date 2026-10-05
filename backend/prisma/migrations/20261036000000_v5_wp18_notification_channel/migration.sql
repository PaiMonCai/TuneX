-- V5-WP18.3 / WP18.4（契约 F5）—— 通知渠道配置。
--
-- 纯 additive：只新增一张表，不动任何既有表/列。空库与存量 V4/V5 库都能直接 apply。
--
-- 三条设计依据（详见 schema.prisma 的 model NotificationChannel 注释）：
--   1. 渠道配置**不能**放 `config` 表：那里的 value 是明文、按名字 upsert、且公网免认证
--      下发面会读它（routes/public.ts）。bot token / webhook URL 需要"按 scope 归属 +
--      密文列 + 可停用"三个真正的列。
--   2. `secret_enc` 只存密文（AES-256-GCM，`v1.<iv>.<ct>.<tag>` 单行）。密钥由
--      `notification-seal.ts` 用独立 HKDF info（`tunex-notification-v1`）派生，绝不与
--      联邦/DDNS 共用派生密钥（R5）。解封失败一律 fail-closed：渠道层折叠成一条可见的
--      `secret_unreadable` 失败记录，绝不"解不开就当没配置"。
--   3. **刻意不建唯一索引**：`(scope_kind, workspace_id, kind)` 看似该唯一，但 platform 行的
--      `workspace_id` 是 NULL，而 MySQL 唯一索引里 NULL 互不相等 —— 加它只会给出假的排他性
--      （平台侧照样能插两条 telegram）。这里只建普通索引供读取（按 scope + kind 取配置）。
--
-- 全部用 VARCHAR 而不是 ENUM：F5 冻结"additive、不引 DB enum"——DB enum 增删值都会让
-- 旧二进制读到未知值时失败（与 NOTICE* 枚举值一个都不能删同一条理由）。

CREATE TABLE `notification_channel` (
    `id`            INTEGER NOT NULL AUTO_INCREMENT,
    `scope_kind`    VARCHAR(16) NOT NULL,
    `workspace_id`  INTEGER NULL,
    `kind`          VARCHAR(16) NOT NULL,
    `target`        VARCHAR(512) NOT NULL,
    `secret_enc`    TEXT NULL,
    `enabled`       BOOLEAN NOT NULL DEFAULT true,
    `created_by_id` INTEGER NULL,
    `created_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`    DATETIME(3) NOT NULL,

    INDEX `notification_channel_scope_idx`(`scope_kind`, `workspace_id`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
