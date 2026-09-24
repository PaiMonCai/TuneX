-- TEN-03 邮箱验证与密码重置（兼容式迁移：只加可空列 + 新表，不改列不删列）
--
-- 1) `user.email_verified_at`：可空时间列，NULL = 未验证。
--    老用户与 0.1 阶段的软约束（未验证仍可登录，仅前端提示）都依赖这个「可空」语义，
--    因此绝不做 NOT NULL + 回填（那会把存量老用户全部判为已验证或全部判为未验证）。
-- 2) `email_verification`：邮箱验证 / 密码重置共用的一次性令牌表。
--    只存 sha256(token) 哈希；明文 token 仅在邮件链接中出现一次。

-- AlterTable
ALTER TABLE `user` ADD COLUMN `email_verified_at` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `email_verification` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `purpose` VARCHAR(32) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `email_verification_token_hash_key`(`token_hash`),
    INDEX `email_verification_user_id_purpose_idx`(`user_id`, `purpose`),
    INDEX `email_verification_email_purpose_idx`(`email`, `purpose`),
    INDEX `email_verification_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `email_verification` ADD CONSTRAINT `email_verification_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
