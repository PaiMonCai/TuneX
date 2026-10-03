-- V5-WP5-A2 — WebSocket 前端进入默认能力集合
--
-- 与 V5-WP5-A1 的 tls 迁移同一个理由，只是对象换成 ws：`platform_ceiling` 是所有
-- workspace 的**硬上界**，判定时与 workspace 策略取交集。上界不含 ws 时，任何
-- workspace 都创建不了 ws 转发——不是因为节点没实现，而是因为上界把协议本身拒了。
--
-- ws 与 tls 的差别是它**没有额外配置**：握手是服务端行为，隧道不协商子协议（它
-- 承载不透明字节），所以没有"证书路径"那一类需要控制面携带的字段。开协议只需要
-- 两件事：runtime 契约里加 ws（代码）、授权集合里加 ws（这里）。
--
-- `revision = revision + 1` 同样是策略缓存的失效信号。
--
-- 纯数据变更：不改表结构，回滚时 ws 会被 runtime 契约拒绝（normalizeForwardProtocol
-- 返回 null），授权多一项不会让任何东西跑起来。

UPDATE `capability_policy`
SET `tunnel_types` = JSON_ARRAY('tcp', 'tls', 'ws'),
    `revision` = `revision` + 1,
    `updated_at` = CURRENT_TIMESTAMP(3)
WHERE `key` = 'platform_ceiling';

UPDATE `capability_policy`
SET `tunnel_types` = JSON_ARRAY('tcp', 'tls', 'ws'),
    `revision` = `revision` + 1,
    `updated_at` = CURRENT_TIMESTAMP(3)
WHERE `key` = 'free_personal';

UPDATE `capability_policy`
SET `tunnel_types` = JSON_ARRAY('tcp', 'udp', 'tls', 'ws'),
    `revision` = `revision` + 1,
    `updated_at` = CURRENT_TIMESTAMP(3)
WHERE `key` = 'free_team';
