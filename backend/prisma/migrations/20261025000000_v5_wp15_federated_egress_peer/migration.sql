-- V5.5 WP15 产品级接线 —— "这条 Forward 的出口腿跑在哪个 peer 上"的声明列。
--
-- 契约：docs/v5-wp14-16-federation-contract.md §3.2/§3.4/§9；DEVELOPMENT.md §1.4/§1.5/§10。
--
-- 纯 additive：两张表各加一个**可空** VARCHAR(64)，没有默认值、没有索引、没有回填。
--   · NULL（= 全部存量行）语义就是"今天的行为"：出口腿在本机，所有既有路径逐字节不变；
--   · 有值 = 该 revision 的出口腿由该 peer_panel_id 承载，本机不再有出口节点，
--     远端资源只以 `federation_placement` 的不透明引用存在（不得复制成本地 node /
--     node_port_lease 行 —— 契约 §1 的 ownership 答案，§7 的禁止项）。
--
-- 为什么两处都要：
--   · `tunnel`：兼容投影 + 当前 desired（读 desired_revision_id 之前的降级口径）；
--   · `forward_revision`：**不可变**放置事实 —— 之后改掉声明，不得改写历史 revision
--     "当时这条出口腿在哪"（与 ingress_node_id / middle_node_id 同一取向）。
--
-- 为什么不用外键：跨面板引用本机资源一律不加外键（与 forward_revision 的节点列、
-- federation_placement 同一取向）；远端节点本来也不在本机 node 表里。
--
-- 为什么同时加索引：不加。查询只按 (tunnel_id, revision) / (peer_panel_id, intent_id) 走，
-- 而 peer_panel_id 在这里是**被声明的值**，不存在"按 peer 找 Forward"的产品路径。
ALTER TABLE `tunnel`
    ADD COLUMN `federated_egress_peer` VARCHAR(64) NULL;

ALTER TABLE `forward_revision`
    ADD COLUMN `federated_egress_peer` VARCHAR(64) NULL;
