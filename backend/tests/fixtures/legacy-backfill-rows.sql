-- WP2（DEVELOPMENT.md §7.5）legacy fixture：**pre-v3 存量数据**。
--
-- 只写 legacy 列；v3 列（tunnel_mode / remote_host / remote_port / Node.role）
-- 一律留给迁移回填 —— 这正是本包要验证的对象。
--
-- 用法：先只应用 LEGACY 迁移子集（到 20260926000000），灌本文件，再升级到 v3。
--
-- 覆盖的形态：
--   901 字符串形态      ["127.0.0.1:8080"]                      → direct + 回填
--   902 对象形态        [{"address":"192.168.1.10:80","weight":2}] → direct + 回填
--   903 脏数据          ["nonsense-without-port"]               → direct，remote_* 留 NULL
--   904 IPv6            ["[::1]:8080"]                          → direct + ::1:8080
--   905 多目标          ["10.9.9.9:7000","10.9.9.10:7001"]      → 回填第一个，数组不改
--   906 第二个 workspace 的 fixed-port 隧道                      → listen_port 不变
--   910 对象但无端口     [{"address":"no-port-here"}]            → remote_* 留 NULL
INSERT INTO `user` (`id`, `email`, `api_key`, `subscription_key`, `created_at`, `updated_at`)
VALUES
  (701, 'upgrade-a@example.test', '00000000-0000-4000-8000-000000000701', 'subscription-701', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (702, 'upgrade-b@example.test', '00000000-0000-4000-8000-000000000702', 'subscription-702', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

-- 复刻 20260924153000 的行为：每个 user 一个 personal workspace + owner member。
INSERT INTO `workspace` (`id`, `slug`, `name`, `kind`, `personal_user_id`, `created_by_id`, `created_at`, `updated_at`)
VALUES
  (701, 'personal-701', 'Personal 701', 'personal', 701, 701, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (702, 'personal-702', 'Personal 702', 'personal', 702, 702, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

INSERT INTO `workspace_member` (`workspace_id`, `user_id`, `role`, `active`, `created_at`, `updated_at`)
VALUES (701, 701, 'owner', true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
       (702, 702, 'owner', true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

-- 801 只被 in 引用；802 只被 out 引用；803 混挂（见 post-v3 fixture）；
-- 804 只被 in 引用（906）。
INSERT INTO `node_group` (`id`, `token`, `name`, `node_type`, `user_id`, `workspace_id`, `updated_at`)
VALUES
  (801, 'upgrade-in-node-801', 'Legacy ingress', 'in', 701, 701, CURRENT_TIMESTAMP(3)),
  (802, 'upgrade-out-node-802', 'Legacy egress', 'out', 701, 701, CURRENT_TIMESTAMP(3)),
  (803, 'upgrade-mixed-803', 'Legacy mixed', 'in', 701, 701, CURRENT_TIMESTAMP(3)),
  (804, 'upgrade-orphan-804', 'Legacy port group', 'in', 702, 702, CURRENT_TIMESTAMP(3));

INSERT INTO `node` (`id`, `node_id`, `connect_ip`, `node_group_id`, `weight`, `status`, `created_at`, `updated_at`)
VALUES
  (901, 'legacy-node-901', '10.0.0.1', 801, 1, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (902, 'legacy-node-902', '10.0.0.2', 802, 1, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (903, 'legacy-node-903', '10.0.0.3', 803, 1, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (904, 'legacy-node-904', '10.0.0.4', 804, 1, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

INSERT INTO `tunnel` (`id`, `name`, `tunnel_type`, `forward_addresses`, `load_balance_type`, `in_node_group_id`, `out_node_group_id`, `user_id`, `workspace_id`, `listen_port`, `updated_at`)
VALUES
  (901, 'Legacy TCP',    'tcp', JSON_ARRAY('127.0.0.1:8080'),      'round', 801, NULL, 701, 701, 19001, CURRENT_TIMESTAMP(3)),
  (902, 'Legacy Object', 'tcp', JSON_ARRAY(JSON_OBJECT('address', '192.168.1.10:80', 'weight', 2)), 'll', 801, NULL, 701, 701, 19002, CURRENT_TIMESTAMP(3)),
  (903, 'Legacy Dirty',  'tcp', JSON_ARRAY('nonsense-without-port'),     'round', 801, NULL, 701, 701, 19003, CURRENT_TIMESTAMP(3)),
  (904, 'Legacy v6',     'tcp', JSON_ARRAY('[::1]:8080'),         'round', 801, NULL, 701, 701, 19004, CURRENT_TIMESTAMP(3)),
  (905, 'Legacy Multi',  'tcp', JSON_ARRAY('10.9.9.9:7000', '10.9.9.10:7001'), 'round', 801, NULL, 701, 701, 19005, CURRENT_TIMESTAMP(3)),
  (906, 'Legacy Port',   'tcp', JSON_ARRAY('127.0.0.1:9090'),      'round', 804, NULL, 702, 702, 19006, CURRENT_TIMESTAMP(3)),
  (910, 'Obj no port',   'tcp', JSON_ARRAY(JSON_OBJECT('address', 'no-port-here', 'weight', 1)), 'round', 801, NULL, 701, 701, 19010, CURRENT_TIMESTAMP(3));
