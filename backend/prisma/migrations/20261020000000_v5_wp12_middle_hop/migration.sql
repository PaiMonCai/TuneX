-- V5.4 WP12 —— 线性路由的中间跳（2 跳 / 3 跳）
--
-- 一条线性路由最多 3 跳：hop 0 = `ingress_node_id`、hop N-1 = `egress_node_id`，因此**只需
-- 多出一个中间跳列**。§9.1 推荐"先让 Forward revision snapshot 承载有序路由事实，再按真实
-- 需求决定是否独立持久化 Link"，§9.3 又明确禁止第一版就做通用图 —— 为中间跳开一张链路表
-- 会在第一版就引入图结构，方向是反的。
--
-- NULL = 单跳（V4 行为，绝大多数行都是 NULL），因此本迁移对存量行**语义中性**：没有中间跳的
-- 转发行为一个字节都不变。
--
-- 归属（placement ownership）仍然只有一个持有者：hop 0。中间跳是**资源**，不是 owner
-- （§9 冻结契约第 7 条；这条来自 round 8 的教训：让非入口腿认领归属会让两阶段规则正确地
-- 拒绝每一次下发）。
--
-- 外键 ON DELETE SET NULL：删掉一台作为中间跳的节点，路由**退化成该跳缺失**（由路由校验
-- 判为非法并在下发前拒绝），而不是让整行消失 —— 静默删掉一条转发是更坏的失败方式。

ALTER TABLE `tunnel` ADD COLUMN `middle_node_id` INTEGER NULL;

ALTER TABLE `tunnel`
  ADD CONSTRAINT `tunnel_middle_node_id_fkey`
  FOREIGN KEY (`middle_node_id`) REFERENCES `node`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
