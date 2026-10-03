-- V5-WP5-B1（V5.1b）— UDP 进入默认能力集合
--
-- 与 V5-WP5-A1（tls）、A2（ws）同一个理由：`platform_ceiling` 是所有 workspace 的
-- **硬上界**，判定时与 workspace 策略取交集，所以上界不含 udp 时任何 workspace 都
-- 创建不了 udp 转发 —— 不是因为节点没实现，而是因为上界把协议本身拒了。
--
-- 与 tls/ws 的差别值得记下来（V5.1b 契约 §10 的正面发现）：`udp` **早就在** wire
-- 词汇表（control-protocol/types.ts）和 DB 枚举（schema.prisma）里，因此协议投影
-- **零迁移** —— 不需要像 `ws` 那样在三个地方各补一次。需要迁移的只有授权：上界缺
-- udp，而 `free_team` 里的 udp 因为取交集被上界过滤掉了（看起来"团队套餐有 udp"，
-- 实际谁都拿不到，这是最容易误读的一处）。
--
-- `revision = revision + 1` 同样是策略缓存的失效信号。
--
-- 纯数据变更：不改表结构。回滚后 udp 会被 runtime 契约拒绝（协议白名单里没有它），
-- 授权多一项不会让任何东西跑起来。

UPDATE `capability_policy`
SET `tunnel_types` = JSON_ARRAY('tcp', 'tls', 'ws', 'udp'),
    `revision` = `revision` + 1,
    `updated_at` = CURRENT_TIMESTAMP(3)
WHERE `key` = 'platform_ceiling';

UPDATE `capability_policy`
SET `tunnel_types` = JSON_ARRAY('tcp', 'tls', 'ws', 'udp'),
    `revision` = `revision` + 1,
    `updated_at` = CURRENT_TIMESTAMP(3)
WHERE `key` = 'free_personal';

-- free_team 历史上就写了 udp；这里把它与其余协议对齐，去掉重复项带来的歧义。
UPDATE `capability_policy`
SET `tunnel_types` = JSON_ARRAY('tcp', 'udp', 'tls', 'ws'),
    `revision` = `revision` + 1,
    `updated_at` = CURRENT_TIMESTAMP(3)
WHERE `key` = 'free_team';
