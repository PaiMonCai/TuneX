-- V5-WP13.5B —— Route Profile Foundation（DEVELOPMENT.md §9.4.2–§9.4.6）
--
-- 契约：docs/v5-wp13-5b-route-profile-contract.md（FROZEN）。
--
-- 为什么是四张新表而不是一张：模板身份 / 版本快照 / 授权行 / 申请账本 的生命周期
-- 各不相同 —— 身份行可改名、版本行**写入后不可变**、授权行可撤销、申请账本就是历史。
-- 把它们压成一张表只有一种做法：让"当前内容"既能被改写又同时承诺不可变，那正是
-- §9.4.5 禁止的"静默重写正在运行的 Forward"。
--
-- 为什么全是**新增**、且新增列**全部可空**：§3.4 要求每个迁移同时满足
--   empty DB / existing V4 DB / legacy rows / rollback（旧二进制忽略新列）/
--   historical fact preservation。
-- 本迁移不 DROP、不 MODIFY 任何既有列，也不使用任何 DB enum（§3.4：可持续扩展的集合
-- 用字符串列 + 应用层校验；visibility / target_type / strategy 都走这条规则）。

-- ── 1. 模板身份 + 当前版本投影 ──────────────────────────────────────────
--
-- 本表**没有** status / applied_* / traffic_* 列，这是刻意的：Route Profile 不拥有
-- Agent runtime、placement lease、Forward lifecycle、applied revision、流量计数，
-- 也没有自己的 reconcile / restart-stop 状态机（§9.4.2「不得拥有」清单）。
CREATE TABLE `route_profile` (
    `id`                    INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id`          INTEGER NOT NULL,
    `user_id`               INTEGER NOT NULL,
    `name`                  VARCHAR(120) NOT NULL,
    `description`           VARCHAR(500) NULL,
    `visibility`            VARCHAR(20) NOT NULL DEFAULT 'INTERNAL',
    `enabled`               BOOLEAN NOT NULL DEFAULT true,
    `version`               INTEGER NOT NULL DEFAULT 0,
    `ingress_selector`      JSON NULL,
    `transit_selectors`     JSON NULL,
    `egress_selector`       JSON NULL,
    `ingress_policy`        JSON NULL,
    `egress_policy`         JSON NULL,
    `constraints`           JSON NULL,
    `required_capabilities` JSON NULL,
    `published_at`          DATETIME(3) NULL,
    `created_at`            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`            DATETIME(3) NOT NULL,

    UNIQUE INDEX `route_profile_workspace_id_name_key`(`workspace_id`, `name`),
    INDEX `route_profile_workspace_id_enabled_idx`(`workspace_id`, `enabled`),
    INDEX `route_profile_visibility_enabled_idx`(`visibility`, `enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── 2. 不可变的版本快照（唯一真相）─────────────────────────────────────
--
-- `@@unique(route_profile_id, version)` 是并发发布的兜底：两个请求同时发布
-- vN+1 时只会有一个成功，另一个撞 P2002 → 409 version_conflict（与
-- forward_revision 的 revision 冲突处理同一取向，不静默覆写）。
--
-- 不加外键：与 forward_revision 同理 —— 模板删除不得改写历史（谁在哪个版本
-- 申请过什么，必须留得下）。删模板时由服务层显式事务清理。
CREATE TABLE `route_profile_version` (
    `id`               INTEGER NOT NULL AUTO_INCREMENT,
    `route_profile_id` INTEGER NOT NULL,
    `version`          INTEGER NOT NULL,
    `body`             JSON NOT NULL,
    `change_summary`   VARCHAR(500) NULL,
    `created_by_id`    INTEGER NULL,
    `created_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `route_profile_version_route_profile_id_version_key`(`route_profile_id`, `version`),
    INDEX `route_profile_version_route_profile_id_created_at_idx`(`route_profile_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── 3. ASSIGNED 的授权行（workspace / plan）─────────────────────────────
--
-- `target_id` 不加外键：授权对象被删除后，"曾经授权过谁"仍是历史事实；
-- 悬空引用由读取方按「无效授权 ⇒ 不可见」处理（fail-closed）。
CREATE TABLE `route_profile_assignment` (
    `id`               INTEGER NOT NULL AUTO_INCREMENT,
    `route_profile_id` INTEGER NOT NULL,
    `target_type`      VARCHAR(20) NOT NULL,
    `target_id`        INTEGER NOT NULL,
    `active`           BOOLEAN NOT NULL DEFAULT true,
    `created_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `route_profile_assignment_target_key`(`route_profile_id`, `target_type`, `target_id`),
    INDEX `route_profile_assignment_target_type_target_id_active_idx`(`target_type`, `target_id`, `active`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── 4. apply 账本（解释链，不驱动状态机）────────────────────────────────
CREATE TABLE `route_profile_application` (
    `id`                    INTEGER NOT NULL AUTO_INCREMENT,
    `route_profile_id`      INTEGER NOT NULL,
    `route_profile_version` INTEGER NOT NULL,
    `tunnel_id`             INTEGER NOT NULL,
    `forward_revision`      INTEGER NOT NULL,
    `resolved_hops`         JSON NOT NULL,
    `applied_by_id`         INTEGER NULL,
    `created_at`            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `route_profile_application_tunnel_id_created_at_idx`(`tunnel_id`, `created_at`),
    INDEX `route_profile_application_profile_version_idx`(`route_profile_id`, `route_profile_version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── 5. Forward 的「来源模板」指针 ───────────────────────────────────────
--
-- 可空 ⇒ 存量 Forward 语义中性（NULL = 不是从某个 Route Profile 铺出来的）；
-- 它是指针，不是第二份运行时真相：执行路径永远读 forward_revision 快照。
ALTER TABLE `tunnel`
  ADD COLUMN `route_profile_id` INTEGER NULL,
  ADD COLUMN `route_profile_version` INTEGER NULL;

-- ── 6. revision 快照里的 provenance（§9.4.5）────────────────────────────
--
-- 为什么必须落在不可变快照上：模板随后被编辑/禁用/删除，都不能改写
-- 「这次为什么发到这些节点」。无外键：与 forward_revision 既有的
-- middle_node_id 同一取向（历史事实优先）。
--
-- 为什么**不**新增 resolved_hops 列：具体跳（含角色）已经在本行的 ingress/egress/
-- middle 三列里，`buildRoutePlan` 能逐字还原成有序 hop 列表；再存一列就是第二份会
-- 漂移的真相。apply 解析出的 hop 列表（带申请语义）落 `route_profile_application`。
ALTER TABLE `forward_revision`
  ADD COLUMN `route_profile_id` INTEGER NULL,
  ADD COLUMN `route_profile_version` INTEGER NULL;
