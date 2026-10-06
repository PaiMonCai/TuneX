# task-43 迁移：按 Forward 自定义入口成员次序

<!-- 行为参照：ForwardX（AGPL-3.0-only）——多入口/转发组的成员表（priority + isEnabled）；本迁移为本项目改写，未复制其实现。 -->

## 内容
新增 `forward_ingress_member(tunnel_id, node_id, priority, is_enabled, created_at, updated_at)`：
唯一键 `(tunnel_id, node_id)`、索引 `(tunnel_id, priority)`、两条 FK 均 `ON DELETE CASCADE`。

## 兼容性（expand-only）
**不回填任何数据**。无行 ⇒ 读路径按 `node_id` 升序（= 迁移前的行为），因此本迁移
不改变任何既有转发的接管顺序。断言见 `backend/src/routes/__tests__/forwards-ha-route.test.ts`
与 `backend/src/services/__tests__/failover-loop.test.ts`（"无行时与今天逐位一致"）。

## 回滚
1. 应用层：把 `pickFailoverDestination` 的次序读取去掉（或直接回到前一个 commit）；
   读路径的 `member_priority.source` 会回到 `platform_rule_node_id_asc`。
2. 数据层：`DROP TABLE forward_ingress_member;`
   —— 表中的内容**只是意图**（用户自定义次序），没有任何账本/事实价值，丢弃不影响
   连接、准入、租约、DNS 或迁移历史。
3. 没有列被加到既有表上，所以不存在"必须回填旧列"的收尾步骤。

## 不做什么
- 不存健康/延迟/失败时刻（既有上报与投影才是事实来源）；
- 不改任何既有表、不重命名既有迁移、不改 `tunnel.preferred_ingress_node_id`
  （它继续由**同一条写入路径**与 `priority[0]` 一起维护）。
