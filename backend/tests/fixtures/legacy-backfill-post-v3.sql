-- WP2（DEVELOPMENT.md §7.5）post-v3 fixture：**v3 列已存在之后**才追加的引用。
--
-- 必须在 `20260926040000_v3_schema_contract` 之后执行：本文件用到
-- `tunnel.egress_node_id` / `tunnel.tunnel_mode` 这些 WP1 新增列。
--
-- 两类构造：
--   907/909  同一个节点组 803 被**入口**与**出口**同时引用 → Node.role 不可判定
--                                                              → 必须留 NULL，绝不 'both'
--   908      带 egress 指针、缺 tunnel_mode 的「半条 v3 行」→ WP2 不得标 direct
--                                                              → remote_host/port 也留 NULL
INSERT INTO `tunnel` (`id`, `name`, `tunnel_type`, `forward_addresses`, `load_balance_type`, `in_node_group_id`, `out_node_group_id`, `user_id`, `workspace_id`, `listen_port`, `updated_at`)
VALUES (907, 'Mixed ref in', 'tcp', JSON_ARRAY('127.0.0.1:9091'), 'round', 803, NULL, 701, 701, 19007, CURRENT_TIMESTAMP(3));

INSERT INTO `tunnel` (`id`, `name`, `tunnel_type`, `forward_addresses`, `load_balance_type`, `in_node_group_id`, `out_node_group_id`, `user_id`, `workspace_id`, `listen_port`, `updated_at`)
VALUES (909, 'Mixed ref out', 'tcp', JSON_ARRAY('127.0.0.1:9092'), 'round', 801, 803, 701, 701, 19009, CURRENT_TIMESTAMP(3));

INSERT INTO `tunnel` (`id`, `name`, `tunnel_type`, `forward_addresses`, `load_balance_type`, `in_node_group_id`, `out_node_group_id`, `user_id`, `workspace_id`, `listen_port`, `egress_node_id`, `updated_at`)
VALUES (908, 'Half v3 relay', 'tcp', JSON_ARRAY('10.1.1.1:9090'), 'round', 801, 802, 701, 701, 19008, 902, CURRENT_TIMESTAMP(3));

-- 805：一个**没有任何隧道引用**的节点组（含节点 905）→ role 必须留 NULL。
INSERT INTO `node_group` (`id`, `token`, `name`, `node_type`, `user_id`, `workspace_id`, `updated_at`)
VALUES (805, 'orphan-805', 'Orphan 805', 'out', 701, 701, CURRENT_TIMESTAMP(3));

INSERT INTO `node` (`id`, `node_id`, `connect_ip`, `node_group_id`, `weight`, `status`, `created_at`, `updated_at`)
VALUES (905, 'orphan-node-905', '10.0.0.5', 805, 1, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
