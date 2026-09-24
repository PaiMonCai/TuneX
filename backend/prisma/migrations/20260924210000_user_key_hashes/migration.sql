-- SEC-02 收尾：个人凭据（api_key / subscription_key）哈希化（兼容式迁移）
--
-- 只加可空列 + 唯一索引，**不改不删旧列**：
--   1) `user.api_key_hash` CHAR(64) NULL —— sha256 hex（明文字符串的摘要）。
--   2) `user.subscription_key_hash` CHAR(64) NULL —— 同上。
--
-- 为什么不动 api_key / subscription_key 明文列：
--   存量 60+ 用户仍以明文 UUID 存库。若此处置 NOT NULL 并全量回填，等于在
--   迁移窗口内对生产库做一次重写（锁表 / 主从延迟 / 回滚不可逆）。改为
--   「惰性迁移」：明文列保留到 **最后一次** 明文行被认证命中为止——
--   认证时先查哈希列，未命中再查明文列，命中即在同一事务内写入哈希并
--   `UPDATE ... SET api_key = NULL`。此后 user.api_key 恒为 NULL，明文只
--   存在于 settings 轮换端点的响应体（一次），不再落库。
--
-- 唯一索引：哈希列是新的凭据查找主键（`WHERE api_key_hash = ?`），
-- 可空唯一索引天然允许多行 NULL，不会与「尚未迁移的老行」冲突。
--
-- 回滚：本迁移不可自动回滚（Prisma 只记录方向）。如需回退，手工执行
--   ALTER TABLE `user` DROP INDEX `user_api_key_hash_key`,
--                       DROP INDEX `user_subscription_key_hash_key`,
--                       DROP COLUMN `api_key_hash`,
--                       DROP COLUMN `subscription_key_hash`;
-- 仅为新加列，删除不影响任何既有数据与代码路径（旧版代码不引用这两列）。

-- AlterTable
ALTER TABLE `user` ADD COLUMN `api_key_hash` CHAR(64) NULL;

-- AlterTable
ALTER TABLE `user` ADD COLUMN `subscription_key_hash` CHAR(64) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `user_api_key_hash_key` ON `user`(`api_key_hash`);

-- CreateIndex
CREATE UNIQUE INDEX `user_subscription_key_hash_key` ON `user`(`subscription_key_hash`);
