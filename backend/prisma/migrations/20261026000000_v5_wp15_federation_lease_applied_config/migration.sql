-- V5.5 WP15 —— host 侧把"已应用的联邦腿配置"持久化到租约行。
--
-- 契约：docs/v5-wp14-16-federation-contract.md §3.2（host 用自己的 orchestrator 下发）/ §3.3。
--
-- 纯 additive：加一个**可空** JSON 列，没有默认值、没有索引、没有回填。
--   · NULL（= 全部存量行）= "从未成功应用过"：快照不会发布它，存量行为逐字节不变；
--   · 有值 = 这一行租约**已经下发**的那份 Agent 运行时配置原文。
--
-- 为什么必须持久化"原文"而不是在快照里再拼一次：
-- host 的权威 desired 快照（agent-command-bus.buildDesiredNodeSnapshot）只枚举本机 tunnel 行，
-- 而联邦腿在 host 上**没有本地 Forward/tunnel 行**（契约 §1 的归属选择）。于是 Agent 的
-- "删掉不在 desired 里的 runtime"（正确逻辑）会在下一拍把它刚建好的远端腿剪掉 ——
-- 实测远端腿只活 ~20-45s。修法是把**下发时那一份事实**存下来、在快照里原样发布，
-- 而不是在下发与快照两处各拼一遍（那必然慢慢漂移）。
--
-- 为什么不新建表：租约行本来就是 host 侧这条腿的唯一真相；配置是它的属性，不是第二份实体。
ALTER TABLE `federation_lease`
    ADD COLUMN `applied_config` JSON NULL;
