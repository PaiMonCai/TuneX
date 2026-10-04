-- V5-WP5-A1 — TLS 前端进入默认能力集合（DEVELOPMENT.md §6.1）
--
-- 为什么这一步是必需的：能力准入是**分层**的（§13.5）。
--   第 1 层 授权/套餐：workspace 策略的 `tunnel_types` 必须包含该协议；
--   第 5 层 runtime admission：节点必须真的实现了该协议。
-- `platform_ceiling` 是所有 workspace 的**硬上界**，判定时与策略取交集
-- （capability-policy.ts 的 ceiling 过滤），所以它不含 tls 时，**任何** workspace
-- 都创建不了 tls 转发——不是因为节点没实现，而是因为上界把协议本身拒了。
--
-- 本迁移把 tls 加进上界与两个免费默认模板，理由：
--   · 上界的存在意义是"安全兜底"，不是"悄悄扣留一个已经通过自己 Gate 的协议"；
--   · 默认模板与上界保持一致，除非某个套餐**故意**不给 —— 那是产品决定，应该在
--     该套餐自己的策略行上表达，而不是靠上界缺项默认剥夺全部人。
--
-- 刻意不动 `free_team` 里历史遗留的 'udp'：它是过去的事实（当时的套餐把 udp 写在
-- 能力里），而 udp 至今**没有**通过 runtime Gate，`normalizeForwardProtocol('udp')`
-- 仍然是 null。授权集合大于可用协议集合是允许的；反过来（协议开放但没人被授权）
-- 会让功能不可达。删除历史事实不在本次范围。
--
-- `revision = revision + 1` 是策略缓存的失效信号（与 e2e 里改 max_nodes 的手法一致）：
-- 不推进版本，正在使用的旧策略会继续按老集合判定。
--
-- 纯数据变更：不改表结构，代码回滚时无需逆迁移（回滚后 tls 会被 runtime 契约拒绝，
-- 授权多一项不会让任何东西跑起来）。

UPDATE `capability_policy`
SET `tunnel_types` = JSON_ARRAY('tcp', 'tls'),
    `revision` = `revision` + 1,
    `updated_at` = CURRENT_TIMESTAMP(3)
WHERE `key` = 'platform_ceiling';

UPDATE `capability_policy`
SET `tunnel_types` = JSON_ARRAY('tcp', 'tls'),
    `revision` = `revision` + 1,
    `updated_at` = CURRENT_TIMESTAMP(3)
WHERE `key` = 'free_personal';

UPDATE `capability_policy`
SET `tunnel_types` = JSON_ARRAY('tcp', 'udp', 'tls'),
    `revision` = `revision` + 1,
    `updated_at` = CURRENT_TIMESTAMP(3)
WHERE `key` = 'free_team';
