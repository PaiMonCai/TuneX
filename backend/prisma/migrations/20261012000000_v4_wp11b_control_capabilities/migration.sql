-- V4-WP11B — 控制协议能力协商落库字段（DEVELOPMENT.md §13.5 / F5）
--
-- 纯 expand：只给 node_state_report 增加两列**可空无默认值**的字段，不 DROP /
-- 不 MODIFY 任何旧列，因此代码回滚时不需要逆迁移。
--
-- 两列承载的事实：
--   control_protocol_version ← Agent 实现的控制协议版本（整数）
--   capabilities             ← Agent **实际实现**的动作清单（字符串数组）
--
-- 为什么必须可空（而不是 default 0 / default '[]'）：
--   存量行来自尚未上报这两个字段的 Agent。NULL 的含义是「这个 Agent 没有
--   协商能力」，与「版本 0」「能力为空数组」是两件不同的事：
--     · NULL       → 按**基线动作**处理：升级窗口内的旧 Agent 必须继续能收到
--                    apply_tunnel / remove_tunnel / suspend_tunnel；
--     · []/缺该键 → 明确声明"我什么都不支持"，只允许基线以外的新动作被拒绝。
--   把 NULL 读成 0 会让升级过程中的整批旧 Agent 立刻被拒发命令，把一次平滑
--   升级变成一次全网中断；把 NULL 读成"支持全部"则会让面板向不认识新动作的
--   Agent 发出未知命令（§13.5 明令禁止）。
--
-- 列宽/类型：
--   control_protocol_version INTEGER — Prisma Int?，无符号语义由应用层保证。
--   capabilities JSON              — 数组形态由 node-state.ts 的校验器把关
--                                    （非数组一律 fail-closed），DB 层不做限制。
--
-- 该 SQL 由 `prisma migrate diff --from-schema-datamodel <old> --to-schema-datamodel
-- <new> --script` 生成，未手工改写，以避免与 schema 漂移。

-- AlterTable
ALTER TABLE `node_state_report` ADD COLUMN `capabilities` JSON NULL,
    ADD COLUMN `control_protocol_version` INTEGER NULL;
