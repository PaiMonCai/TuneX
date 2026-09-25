-- WP2 — Legacy Backfill / Upgrade（DEVELOPMENT.md §7.5）
--
-- 前置：WP1 的 `20260926040000_v3_schema_contract` 已合入 main。本迁移是 WP1
-- **之后**的第二道防线，负责回填 WP1 落地后仍然可能为 NULL 的存量行——
-- 因为 WP1 迁移跑完的那一刻，**新代码写入的行不带任何 v3 列值**：
--   · `routes/tunnels.ts` 的 tunnel.create() 不写 tunnel_mode / remote_host
--   · `socket/index.ts` 的 node.create()（agent 注册）、
--     `routes/admin-extended.ts` 的 node.create() 都不写 Node.role
-- 这些行在 WP1 迁移时还不存在，因此 WP1 的回填语句覆盖不到它们。WP2 的
-- 迁移在它们被创建**之后**运行，把这些「未声明」的行补齐，这是本迁移存在的
-- 唯一理由——它不是 WP1 的重复劳动。
--
-- ── expand-and-contract（§6）──
-- 本文件只含 DML（UPDATE），零 DDL：不加列、不删列、不改列类型与可空性。
-- 因此回滚代码时**不需要逆迁移本文件**（保留新增 schema，回滚镜像即可）。
--
-- ── 三条回填，全部幂等、可重复执行 ──
--   1. 剩余 `tunnel_mode IS NULL` 且**不带任何 v3 RELAY 指针**的行 → 'direct'
--   2. `forward_addresses` 首目标 → `remote_host` / `remote_port`
--   3. `Node.role` 按**观测到的节点组用途**确定性回填，绝不写 'both'
--
-- 为什么 tunnel_mode 与 remote_host 的判定条件比 WP1 更严：
--   WP1 的条件只判定 `tunnel_mode IS NULL`（当时全库都是存量行，等价）；
--   WP2 额外要求 `egress_node_id IS NULL AND egress_pool_id IS NULL`，
--   因为 v3 RELAY 隧道靠**这两个 WP1 新增列**标识（WP8 编排器会同时写三列）。
--   一个带着 RELAY 指针却缺 mode 的行是「写了一半的 v3 行」，应由 WP8 补齐，
--   而不是被本迁移草率标成 direct。
--
-- 为什么 Node.role 可以确定性回填，而 WP1 选择不回填：
--   §7.3 规定 WP2「只能做确定性回填，不得猜测 Node.role」，§7.5 进一步要求
--   「不能猜 BOTH」。判定依据不是 `NodeGroup.node_type`（§2.1：该列只是 legacy
--   兼容字段，v3 不得把它当方向判定的最终依据，且同一组内混挂 in/out 常见），
--   而是**节点组实际被哪些隧道引用**的观测事实：
--     只被 in 组引用  → 该组节点 = ingress
--     只被 out 组引用 → 该组节点 = egress
--     in/out 都引用    → 留 NULL（组内多节点谁走哪个方向无法从组级观测推出）
--     没有任何隧道引用 → 留 NULL（未声明）
--   'both' 永远不写：那是「单机兼任」的显式管理动作，不是能从数据里推导的
--   事实。留 NULL 让管理员在面板显式设置，成本远低于把未声明节点误判成兼任。

-- ==================================================================
-- 回填 1：剩余 NULL 的 tunnel_mode → 'direct'
--
-- 幂等：只碰 `tunnel_mode IS NULL` 的行，重复执行为 no-op；
-- 已被 v3 显式声明为 relay 的行永不被回改。
-- ==================================================================
UPDATE `tunnel`
SET `tunnel_mode` = 'direct'
WHERE `tunnel_mode` IS NULL
  -- v3 RELAY 的标识列；带着指针却缺 mode = 写了一半的 v3 行，留给 WP8。
  AND `egress_node_id` IS NULL
  AND `egress_pool_id` IS NULL;

-- ==================================================================
-- 回填 2：forward_addresses 首目标 → remote_host / remote_port
--
-- 地址形态与端口取法与 WP1 / `socket/config-generator.ts#formatIP`、
-- `routes/tunnels.ts` 的 FORWARD_RE 完全一致：
--   · 形态 A：字符串数组 ["host:port", ...]（建隧道时写入的形态）
--   · 形态 B：对象数组 [{"address":"host:port", ...}]（原版 / 导入数据）
--   · `host:port` / `[ipv6]:port`；端口取最后一个冒号后的片段（IPv6 冒号
--     不会被误当分隔符）；host 剥掉 []（`[::1]:8080` → `::1`）
-- 只回填**首个**目标：DIRECT 实际只用第一个地址；RELAY 的目标在 EgressTarget
-- 上，与本列无关。
-- 解析不出（无冒号 / 非数字端口 / 空数组 / 非数组 / 端口越界）一律留 NULL，
-- 绝不写 0 端口或空 host。
-- 幂等：外层 `remote_host IS NULL AND remote_port IS NULL` 限定只回填一次。
--
-- 表达式逐字重复的原因：MySQL 的 UPDATE 不允许在 SET 子句里引用同语句定义的
-- 列别名，因此 JSON 取值被重复书写，而不是抽成可读的中间别名。
-- ==================================================================

-- 形态 A：字符串数组 ["host:port", ...]
UPDATE `tunnel`
SET
  `remote_port` = CAST(SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(`forward_addresses`, '$[0]')), ':', -1) AS UNSIGNED),
  `remote_host` = TRIM(LEADING '[' FROM TRIM(TRAILING ']' FROM LEFT(
      JSON_UNQUOTE(JSON_EXTRACT(`forward_addresses`, '$[0]')),
      CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(`forward_addresses`, '$[0]')))
        - CHAR_LENGTH(SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(`forward_addresses`, '$[0]')), ':', -1)) - 1
  )))
WHERE `remote_host` IS NULL
  AND `remote_port` IS NULL
  -- RELAY 不使用 remote_host/remote_port（目标在 EgressTarget 上）。
  AND `egress_node_id` IS NULL
  AND `egress_pool_id` IS NULL
  AND (`tunnel_mode` IS NULL OR `tunnel_mode` = 'direct')
  AND JSON_TYPE(`forward_addresses`) = 'ARRAY'
  AND JSON_LENGTH(`forward_addresses`) > 0
  AND JSON_TYPE(JSON_EXTRACT(`forward_addresses`, '$[0]')) = 'STRING'
  AND JSON_UNQUOTE(JSON_EXTRACT(`forward_addresses`, '$[0]')) REGEXP '^(\\[[0-9A-Fa-f:]+\\]|[^:[:space:]]+):[0-9]{1,5}$'
  AND CAST(SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(`forward_addresses`, '$[0]')), ':', -1) AS UNSIGNED) BETWEEN 1 AND 65535;

-- 形态 B：对象数组 [{"address":"host:port"}, ...]（原版 / 导入数据）
-- 与形态 A 互斥：A 已回填的行 remote_host 非 NULL，自然被本语句的 WHERE 排除。
UPDATE `tunnel`
SET
  `remote_port` = CAST(SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(`forward_addresses`, '$[0].address')), ':', -1) AS UNSIGNED),
  `remote_host` = TRIM(LEADING '[' FROM TRIM(TRAILING ']' FROM LEFT(
      JSON_UNQUOTE(JSON_EXTRACT(`forward_addresses`, '$[0].address')),
      CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(`forward_addresses`, '$[0].address')))
        - CHAR_LENGTH(SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(`forward_addresses`, '$[0].address')), ':', -1)) - 1
  )))
WHERE `remote_host` IS NULL
  AND `remote_port` IS NULL
  AND `egress_node_id` IS NULL
  AND `egress_pool_id` IS NULL
  AND (`tunnel_mode` IS NULL OR `tunnel_mode` = 'direct')
  AND JSON_TYPE(`forward_addresses`) = 'ARRAY'
  AND JSON_LENGTH(`forward_addresses`) > 0
  AND JSON_TYPE(JSON_EXTRACT(`forward_addresses`, '$[0]')) = 'OBJECT'
  AND JSON_TYPE(JSON_EXTRACT(`forward_addresses`, '$[0].address')) = 'STRING'
  AND JSON_UNQUOTE(JSON_EXTRACT(`forward_addresses`, '$[0].address')) REGEXP '^(\\[[0-9A-Fa-f:]+\\]|[^:[:space:]]+):[0-9]{1,5}$'
  AND CAST(SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(`forward_addresses`, '$[0].address')), ':', -1) AS UNSIGNED) BETWEEN 1 AND 65535;

-- ==================================================================
-- 回填 3：Node.role 按组用途确定性回填（绝不写 'both'）
--
-- 判定依据（见文件头）：节点组被 `tunnel` 直接引用的方向。同一节点组既被
-- in 引用又被 out 引用、或完全没有隧道引用时，本语句**不写任何值**——这两种
-- 情况在节点粒度上不可判定，留 NULL = 「尚未声明」，由管理员显式设置。
--
-- 为什么只认 `tunnel.in_node_group_id` / `tunnel.out_node_group_id`，
-- 不认 `tunnel_chain`：chain 是同一条隧道的附加跳，组内哪些节点实际参与
-- 该跳无法从 chain 行推出；只认主引用能把误判面压到最小。
--
-- 幂等：外层 `role IS NULL` 限定。已被 v3 显式声明 / 已被管理员设置的角色
-- 永不被回改（含显式设置的 'both'）。
-- ==================================================================
UPDATE `node` AS n
JOIN (
    SELECT
        g.`id` AS `group_id`,
        CASE
            WHEN SUM(CASE WHEN t.`in_node_group_id` = g.`id` THEN 1 ELSE 0 END) > 0
             AND SUM(CASE WHEN t.`out_node_group_id` = g.`id` THEN 1 ELSE 0 END) = 0
                THEN 'ingress'
            WHEN SUM(CASE WHEN t.`out_node_group_id` = g.`id` THEN 1 ELSE 0 END) > 0
             AND SUM(CASE WHEN t.`in_node_group_id` = g.`id` THEN 1 ELSE 0 END) = 0
                THEN 'egress'
            ELSE NULL
        END AS `direction`
    FROM `node_group` AS g
    LEFT JOIN `tunnel` AS t
           ON t.`in_node_group_id` = g.`id`
           OR t.`out_node_group_id` = g.`id`
    GROUP BY g.`id`
) AS u ON u.`group_id` = n.`node_group_id`
SET n.`role` = u.`direction`
WHERE n.`role` IS NULL
  -- direction 为 NULL 的行（in/out 双向引用、或没有任何隧道引用）不动：
  -- 这两种情形在节点粒度上不可判定，不能猜，更不能猜 BOTH。
  AND u.`direction` IS NOT NULL;
