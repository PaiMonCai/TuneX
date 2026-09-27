-- V4-WP6 — Agent Telemetry 落库字段（DEVELOPMENT.md §13.4.4）
--
-- 纯 expand-and-contract：
--   · 只给 node_state_report 增加**可空**列，不 DROP / 不 MODIFY 任何旧列；
--   · 旧 Agent 不报这些字段 → 列保持 NULL，面板按「未知」处理（不是 0）；
--   · 新 Agent 报全 → 面板可做 health synthesis；
--   · 回滚代码时不需要逆迁移（保留新增列即可，与 §13.4.4「扩展既有
--     NodeStateReport，不新造第二套监控真相」一致）。
--
-- 为什么全部可空而不是带默认值：
--   `hostname`/`os`/`arch`/`runtime_counts`/`host_metrics` 对**存量行**不可知
--   （Agent 从未上报过）。写默认值（"" / 0）会把「从未上报」这个事实抹成
--   「上报了 0」，而 health synthesis 正是靠 NULL 判定 `unknown`。
--   对比 WP5 的 `node.lifecycle`：那一列的存量语义是已知的（都在正常承载
--   Forward），所以带 DEFAULT 'active' 是对的；这里相反。
--
-- 与 `last_error`（VARCHAR(500)，WP7）的关系：本迁移新增 `error_count` /
-- `last_error_at` 两个**计数与时间**列，让面板能区分「装完失败过一次」
-- 和「每 30s 都在失败」。`last_error` 列本身不改——它继续是最近一条消息。

-- AlterTable
ALTER TABLE `node_state_report`
    ADD COLUMN `known_revision`    INTEGER NULL,
    ADD COLUMN `agent_started_at`  DATETIME(3) NULL,
    ADD COLUMN `hostname`          VARCHAR(255) NULL,
    ADD COLUMN `os`                VARCHAR(32) NULL,
    ADD COLUMN `arch`              VARCHAR(32) NULL,
    ADD COLUMN `runtime_counts`    JSON NULL,
    ADD COLUMN `host_metrics`      JSON NULL,
    ADD COLUMN `error_count`       INTEGER NULL,
    ADD COLUMN `last_error_at`     DATETIME(3) NULL;

-- CreateIndex
-- health synthesis 与 WP8「异常入口」都要按「最近有错误的节点」筛选，
-- 而 reported_at 索引（WP7 已有）只回答「谁在报」。这一条是 §13.4.4
-- 「是否存在 apply/runtime error」的查询面。
CREATE INDEX `node_state_report_last_error_at_idx` ON `node_state_report`(`last_error_at`);
