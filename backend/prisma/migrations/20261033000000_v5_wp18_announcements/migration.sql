-- V5-WP18.5（契约 F6）—— 公告 / 已读 / 免打扰，以及遗留 `NOTICE` 的**只读**迁移。
--
-- 纯 additive：新增三张表 + 一条数据回填，不改任何既有表/列/枚举值。
-- 空库与存量 V4/V5 库都能直接 apply。
--
-- ── 三条设计依据（详见 schema.prisma 的 model 注释）──
--   1. `active_popup_key` 上的唯一索引：同 scope 只允许一条活跃弹窗，**由 DB 拒绝**。
--      不写 `@@unique([scope_kind, workspace_id, type])` —— MySQL 的唯一索引把 NULL 视为
--      互不相等，平台行（workspace_id IS NULL）之间永远不冲突，约束等于没有。
--      把「哪一格被占」落成一个非空标量后，唯一索引才真的挡得住并发下发（F6.3）。
--   2. 三张表**全部用 VARCHAR 而不是 DB ENUM**：F5 已冻结「additive、不引 DB enum」——
--      ENUM 增删值都会让旧二进制读到未知值时失败（与 `NOTICE*` 一个枚举值都不能删同一条理由）。
--   3. `notification_mute` 的类别列复用 `NOTIFICATION_SOURCE_KINDS`，渠道列复用
--      `NOTIFICATION_CHANNEL_KINDS`：免打扰不新造第二套「通知类别/渠道」词表。
--
-- ── 遗留 `NOTICE` 的处置：**只读**迁移（F6.7 / R3）──
--   · 只 **SELECT** `config`：本文件里没有任何一条语句写 `config`（连 DDL 也没有）。
--   · 非空 `NOTICE` → **一条** `type="normal"` 的**平台**公告，标题固定「站点公告」，
--     正文 = `TRIM(config.value)`，发布时间取 `config.updated_at`（来源表上的既有时间戳）。
--     作者留 NULL：旧键没有作者，**不猜**。
--   · 幂等：先判断「同正文的平台 normal 公告是否已存在」再回填。
--     判据**必须**写在插入临时表的那条语句里，不能写成
--     `INSERT INTO announcement ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM announcement ...)`：
--     MySQL 手册 13.2.5.1 明写「you cannot insert into a table and select from the same table
--     in a subquery」（目标表可以出现在 FROM 里，但**不允许**出现在子查询里）。
--     判据挂在临时表上之后，回填语句的目标表不再出现在自己的子查询里，
--     手工重复执行本文件也成为 no-op。正常路径下 Prisma 的 `_prisma_migrations`
--     台账已经保证每个迁移至多执行一次，这里的闸门是第二道。
--   · `NOTICE_POPUP` / `NOTICE_POPUP_INTERVAL_HOURS` **不做内容迁移**：它们是布尔开关与
--     展示间隔，不是内容（内容在 `NOTICE` 里，已经迁走）。三个枚举值一个都没删。

-- ==================================================================
-- 1. 公告
-- ==================================================================

CREATE TABLE `announcement` (
    `id`               INTEGER NOT NULL AUTO_INCREMENT,
    `scope_kind`       VARCHAR(16) NOT NULL,
    `workspace_id`     INTEGER NULL,
    `type`             VARCHAR(16) NOT NULL,
    `title`            VARCHAR(200) NOT NULL,
    `body`             TEXT NOT NULL,
    `active_popup_key` VARCHAR(64) NULL,
    `published_at`     DATETIME(3) NOT NULL,
    `revoked_at`       DATETIME(3) NULL,
    `created_by_id`    INTEGER NULL,
    `created_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`       DATETIME(3) NOT NULL,

    UNIQUE INDEX `announcement_active_popup_key`(`active_popup_key`),
    INDEX `announcement_scope_published_idx`(`scope_kind`, `workspace_id`, `published_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ==================================================================
-- 2. 已读（每用户一条 dismiss 记录）
-- ==================================================================

CREATE TABLE `announcement_dismissal` (
    `id`              INTEGER NOT NULL AUTO_INCREMENT,
    `announcement_id` INTEGER NOT NULL,
    `user_id`         INTEGER NOT NULL,
    `dismissed_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `announcement_dismissal_unique`(`announcement_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 外键只指向本 WP 自己新建的表（Cascade）：公告被删，它的已读记录没有意义。
-- `user_id` 刻意不建外键：加它就要给既有 `User` 模型补反向关系列（改别人的模型），
-- 而「删用户时顺手抹掉他的免打扰/已读」不是必须由 DB 保证的不变量。
ALTER TABLE `announcement_dismissal` ADD CONSTRAINT `announcement_dismissal_announcement_id_fkey` FOREIGN KEY (`announcement_id`) REFERENCES `announcement`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- ==================================================================
-- 3. 免打扰（每用户 × 每渠道 × 每类别）
-- ==================================================================

CREATE TABLE `notification_mute` (
    `id`           INTEGER NOT NULL AUTO_INCREMENT,
    `user_id`      INTEGER NOT NULL,
    `channel_kind` VARCHAR(16) NOT NULL,
    `category`     VARCHAR(32) NOT NULL,
    `created_at`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`   DATETIME(3) NOT NULL,

    UNIQUE INDEX `notification_mute_unique`(`user_id`, `channel_kind`, `category`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ==================================================================
-- 4. 遗留 `NOTICE` → 一条平台 normal 公告（只读；幂等）
--
-- 临时表只做一件事：把「要回填的正文」与「是否已经回填过」的判定**移出**
-- `announcement` 的写入语句。于是回填语句的目标表（`announcement`）不再出现在
-- 自己的子查询里，重复执行本文件也不会产生第二条公告。
-- ==================================================================

CREATE TEMPORARY TABLE `_wp18_notice_backfill` (
    `body`         TEXT NOT NULL,
    `published_at` DATETIME(3) NOT NULL
);

INSERT INTO `_wp18_notice_backfill` (`body`, `published_at`)
SELECT
    TRIM(c.`value`),
    COALESCE(c.`updated_at`, c.`created_at`, CURRENT_TIMESTAMP(3))
FROM `config` c
WHERE c.`name` = 'NOTICE'
  -- 空白值不是公告：旧面板允许把 NOTICE 存成空串（种子数据就是 ""）。
  AND TRIM(c.`value`) <> ''
  -- 幂等闸门：同正文的平台 normal 公告已存在 ⇒ 不再插（手工重复执行本文件时生效）。
  AND NOT EXISTS (
      SELECT 1
      FROM `announcement` a
      WHERE a.`scope_kind` = 'platform'
        AND a.`type` = 'normal'
        AND a.`body` = TRIM(c.`value`)
  );

INSERT INTO `announcement`
    (`scope_kind`, `workspace_id`, `type`, `title`, `body`, `active_popup_key`,
     `published_at`, `revoked_at`, `created_by_id`, `created_at`, `updated_at`)
SELECT
    'platform', NULL, 'normal', '站点公告', b.`body`, NULL,
    b.`published_at`, NULL, NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `_wp18_notice_backfill` b;

DROP TEMPORARY TABLE `_wp18_notice_backfill`;
