-- TEAM-01：自定义团队角色与细粒度权限。
--
-- 方案选择：**外键 role_id**，而不是把 `custom:<id>` 写进 workspace_member.role 枚举列。
-- 理由：
--   1. `role` 是 ENUM('owner','admin','member','viewer')，全仓用 TypeScript 联合类型
--      `WorkspaceRole` 接收它（`t(\`workspace.role.${role}\`)`、`role === "owner"`）。
--      改成长度为 20+ 的字符串列会同时破坏 Prisma 生成的类型、所有 switch/比较、
--      以及前端字典查词，且悬挂的 `custom:999` 在语义上是「无权限」而不是「报错」。
--   2. 外键自带删除语义：删除自定义角色时 `ON DELETE SET NULL` 会把已分配成员回落
--      到他们自己的基础角色（role 列），不会留下指向不存在角色的悬空引用。
--   3. 外键让「角色必须属于同一 workspace」可由查询条件强制（role_id 取值先经
--      workspace_id 校验），而字符串编码要先解析再查库才能知道越界与否。
--
-- 可空性：`role_id` 可空（NULL = 固定四角色）；`role` 保持 NOT NULL 且始终有值，
-- 因此本迁移不回填任何现有行——老成员继续按固定四角色判定，行为零变化。
-- 新增表 + 新增可空列，符合仓库「只加可空列/新表，不改不删旧列」的兼容式迁移风格。

-- CreateTable
CREATE TABLE `workspace_custom_role` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `description` VARCHAR(255) NULL,
    `permissions` JSON NOT NULL,
    `created_by_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `workspace_custom_role_workspace_id_name_key`(`workspace_id`, `name`),
    INDEX `workspace_custom_role_workspace_id_idx`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `workspace_member` ADD COLUMN `role_id` INTEGER NULL;

-- CreateIndex
CREATE INDEX `workspace_member_role_id_idx` ON `workspace_member`(`role_id`);

-- AddForeignKey
ALTER TABLE `workspace_custom_role` ADD CONSTRAINT `workspace_custom_role_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_custom_role` ADD CONSTRAINT `workspace_custom_role_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- 删除自定义角色时不清人：把已分配成员的 role_id 置 NULL，他们回落到的 role 列
-- 基础角色继续有效（owner/admin 仍保有原权限，member/viewer 亦不变）。
ALTER TABLE `workspace_member` ADD CONSTRAINT `workspace_member_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `workspace_custom_role`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
