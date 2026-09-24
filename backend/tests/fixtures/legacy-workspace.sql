-- Pre-workspace fixture: two separate accounts, with one owning a node group and TCP tunnel.
INSERT INTO `user` (`id`, `email`, `api_key`, `subscription_key`, `created_at`, `updated_at`)
VALUES
  (701, 'upgrade-a@example.test', '00000000-0000-4000-8000-000000000701', 'subscription-701', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (702, 'upgrade-b@example.test', '00000000-0000-4000-8000-000000000702', 'subscription-702', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

INSERT INTO `node_group` (`id`, `token`, `name`, `node_type`, `user_id`, `updated_at`)
VALUES (801, 'upgrade-in-node-801', 'Legacy ingress', 'in', 701, CURRENT_TIMESTAMP(3));

INSERT INTO `tunnel` (`id`, `name`, `tunnel_type`, `forward_addresses`, `load_balance_type`, `in_node_group_id`, `user_id`, `updated_at`)
VALUES (901, 'Legacy TCP', 'tcp', JSON_ARRAY('127.0.0.1:8080'), 'round', 801, 701, CURRENT_TIMESTAMP(3));
