-- V4-WP5 — Node Lifecycle（DEVELOPMENT.md §13.4 Node 托管生命周期）
--
-- 纯 expand-and-contract：
--   · 只新增可空列、一个带默认值的新列、新索引；
--   · 不 DROP / 不 MODIFY 任何旧列，不改旧列类型与可空性；
--   · 因此存量 DIRECT runtime、legacy 配置下发、旧 Agent 全部零影响；
--   · 回滚代码时**不需要逆迁移本文件**（生产回滚策略见 §6：保留新增 schema）。
--
-- 为什么 lifecycle 有 DEFAULT 'active' 而 role 留 NULL：
--   role 的真实值对存量行**不可知**（同组混挂 ingress/egress 常见），
--   §7.1「不改不猜」要求留 NULL。lifecycle 的存量语义是**已知的**——
--   所有存量节点今天都在正常承载 Forward，`active` 只是把这个现状写成默认值，
--   不是推断未知值。
--
-- 为什么不复用 legacy `Node.status`：§13.4.1 明文禁止。status 由
-- offline-detector 翻转（连接态=事实），lifecycle 由用户设置（期望态）。
-- 「维护中的节点掉线」必须两件事同时成立。

-- AlterTable
ALTER TABLE `node`
    ADD COLUMN `lifecycle` ENUM('active', 'maintenance', 'disabled', 'retiring') NOT NULL DEFAULT 'active',
    ADD COLUMN `lifecycle_updated_at` DATETIME(3) NULL,
    ADD COLUMN `lifecycle_note` VARCHAR(255) NULL;

-- CreateIndex
-- 索引服务两个查询：面板按 lifecycle 过滤（WP7 列表页），以及 WP8 编排器
-- 「当前哪些节点能作为新 Forward 候选」的批量判定。
CREATE INDEX `node_lifecycle_idx` ON `node`(`lifecycle`);
