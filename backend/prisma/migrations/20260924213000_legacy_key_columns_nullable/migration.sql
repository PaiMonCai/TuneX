-- SEC-02 收尾（第 2 步）：legacy 明文列改为可空、去掉默认值。
--
-- 第 1 步（20260924210000_user_key_hashes）只加了 `*_hash` 列，漏了明文列的
-- 约束改造，而运行时恰好需要它：
--
--  1) NOT NULL 会让 services/user-keys.ts 的两处 `SET api_key = NULL`
--     （惰性迁移、rotateKey）在 MySQL 上直接报 1048 —— 迁移与轮换全灭。
--
--  2) `DEFAULT uuid()` 更隐蔽：Prisma 不显式写 null 时 DB 会补一个随机 UUID，
--     「明文不再落库」的语义被默认值架空（seed / create 都退化成明文落库）。
--
-- 故：MODIFY 为 NULL + 去掉默认值。明文列的唯一索引保留——MySQL 唯一索引
-- 允许多行 NULL，「迁移后所有明文行均为 null」的终态不与之冲突。
--
-- 数据面影响：零。仅改列约束，不动任何行。
--
-- 回滚（要求：所有行的 api_key / subscription_key 均非 NULL）：
--   ALTER TABLE `user`
--     MODIFY `api_key` varchar(191) NOT NULL DEFAULT (uuid()),
--     MODIFY `subscription_key` varchar(191) NOT NULL DEFAULT (uuid());
-- 若已发生过迁移/轮换（存在明文为 NULL 的行），回滚会失败——那种状态下
-- 数据必须走哈希列路径，不应回滚本迁移。

-- AlterTable
ALTER TABLE `user` MODIFY `api_key` varchar(191) NULL;

-- AlterTable
ALTER TABLE `user` MODIFY `subscription_key` varchar(191) NULL;
