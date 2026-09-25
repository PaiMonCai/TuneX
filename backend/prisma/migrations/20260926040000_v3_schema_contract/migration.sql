-- WP1 — v3 Schema 契约（DEVELOPMENT.md §7.4）
--
-- 本迁移是纯 expand-and-contract：
--   · 只新增可空列、新表、新索引、新枚举；
--   · 不 DROP / 不 MODIFY 任何旧列，不改旧列类型与可空性；
--   · 因此存量 DIRECT runtime、legacy 配置下发、旧 Agent 全部零影响；
--   · 回滚代码时**不需要逆迁移本文件**（生产回滚策略见 §6：保留新增 schema）。
--
-- 回填动作（三条，全部幂等，可重复执行）：
--   1. 存量 Tunnel.tunnel_mode → 'direct'（不存在存量 RELAY，见 §2.3）
--   2. 存量 forward_addresses 首目标 → remote_host / remote_port
--   3. Node.role / port_range_* / lb_strategy 一律**不回填**：无法确定性推断
--      （NodeGroup.node_type 与节点实际角色可能不一致，混挂常见），
--      按 §7.5「只能做确定性回填，不能猜」的规则留 NULL，由管理员显式设置。
--
-- 为什么 tunnel_mode 直接给值而 remote_host 依赖回填：
--   tunnel_mode='direct' 对存量行是**已知事实**，等价于列默认值；
--   remote_host 依赖 forward_addresses 的具体内容，脏数据无真相可言，
--   解析不出来就留 NULL，让上层显式判定「存量数据无法推导」而不是误连 0 端口。

-- AlterTable
ALTER TABLE `node` ADD COLUMN `role` ENUM('ingress', 'egress', 'both') NULL,
    ADD COLUMN `last_seen_at` DATETIME(3) NULL,
    ADD COLUMN `port_range_min` INTEGER NULL,
    ADD COLUMN `port_range_max` INTEGER NULL,
    ADD COLUMN `lb_strategy` ENUM('round', 'rand') NULL;

-- CreateIndex
CREATE INDEX `node_role_idx` ON `node`(`role`);

-- AlterTable
ALTER TABLE `tunnel` ADD COLUMN `tunnel_mode` ENUM('direct', 'relay') NULL,
    ADD COLUMN `egress_node_id` INTEGER NULL,
    ADD COLUMN `egress_port` INTEGER NULL,
    ADD COLUMN `egress_pool_id` INTEGER NULL,
    ADD COLUMN `remote_host` VARCHAR(255) NULL,
    ADD COLUMN `remote_port` INTEGER NULL,
    ADD COLUMN `desired_status` VARCHAR(20) NULL,
    ADD COLUMN `apply_status` VARCHAR(20) NULL,
    ADD COLUMN `config_revision` INTEGER NULL,
    ADD COLUMN `applied_revision` INTEGER NULL,
    ADD COLUMN `apply_error_code` VARCHAR(64) NULL,
    ADD COLUMN `apply_error` VARCHAR(500) NULL,
    ADD COLUMN `last_applied_at` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `tunnel_tunnel_mode_idx` ON `tunnel`(`tunnel_mode`);
CREATE INDEX `tunnel_egress_node_id_idx` ON `tunnel`(`egress_node_id`);
CREATE INDEX `tunnel_egress_pool_id_idx` ON `tunnel`(`egress_pool_id`);
CREATE INDEX `tunnel_apply_status_idx` ON `tunnel`(`apply_status`);

-- CreateTable
CREATE TABLE `egress_pool` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `node_id` INTEGER NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `lb_strategy` ENUM('round', 'rand') NULL,
    `status` ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `egress_pool_node_id_name_key`(`node_id`, `name`),
    INDEX `egress_pool_node_id_status_idx`(`node_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `egress_target` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `pool_id` INTEGER NOT NULL,
    `host` VARCHAR(255) NOT NULL,
    `port` INTEGER NOT NULL,
    `weight` INTEGER NOT NULL DEFAULT 1,
    `order_by` DOUBLE NOT NULL DEFAULT 1000,
    `remark` VARCHAR(255) NULL,
    `status` ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `egress_target_pool_id_status_idx`(`pool_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
--
-- 端口租约：`UNIQUE(node_id, port)` 是端口所有权的最终一致性真相源
-- （DEVELOPMENT.md §5.1）。Redis NX 只做快速并发抢占/短事务协调，
-- 不作为长期唯一真相源。
CREATE TABLE `node_port_lease` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `node_id` INTEGER NOT NULL,
    `port` INTEGER NOT NULL,
    `tunnel_id` INTEGER NULL,
    `lease_type` ENUM('ingress', 'egress') NOT NULL,
    `status` VARCHAR(20) NOT NULL,
    `expires_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `node_port_lease_node_id_port_key`(`node_id`, `port`),
    INDEX `node_port_lease_tunnel_id_idx`(`tunnel_id`),
    INDEX `node_port_lease_node_id_status_idx`(`node_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
--
-- 删节点不删隧道：出口指针置 NULL，由 reconciler 把受影响隧道推到可解释的
-- suspended/error 状态（v3 铁律：节点失效不得物理删除用户隧道数据）。
ALTER TABLE `tunnel` ADD CONSTRAINT `tunnel_egress_node_id_fkey` FOREIGN KEY (`egress_node_id`) REFERENCES `node`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tunnel` ADD CONSTRAINT `tunnel_egress_pool_id_fkey` FOREIGN KEY (`egress_pool_id`) REFERENCES `egress_pool`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- 池 / 目标 / 租约都是**节点侧**配置与运行时状态，随节点删除而清理；
-- 用户侧资产（tunnel）不在这条级联链上。
ALTER TABLE `egress_pool` ADD CONSTRAINT `egress_pool_node_id_fkey` FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `egress_target` ADD CONSTRAINT `egress_target_pool_id_fkey` FOREIGN KEY (`pool_id`) REFERENCES `egress_pool`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `node_port_lease` ADD CONSTRAINT `node_port_lease_node_id_fkey` FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
--
-- 删隧道时租约指针置 NULL（而非级联删除租约行）：释放必须是编排器的显式动作，
-- 静默级联会让「主动释放」与「随隧道消失」在审计上无法区分。
ALTER TABLE `node_port_lease` ADD CONSTRAINT `node_port_lease_tunnel_id_fkey` FOREIGN KEY (`tunnel_id`) REFERENCES `tunnel`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- ==================================================================
-- 回填 1：存量 Tunnel 一律 DIRECT
--
-- 幂等：只碰 `tunnel_mode IS NULL` 的行，重复执行为 no-op；
-- 已被 v3 显式声明为 relay 的行永不被回改。
-- ==================================================================
UPDATE `tunnel`
SET `tunnel_mode` = 'direct'
WHERE `tunnel_mode` IS NULL;

-- ==================================================================
-- 回填 2：forward_addresses 首目标 → remote_host / remote_port
--
-- forward_addresses 的两种历史形态（见 socket/config-generator.ts 的
-- normalizeForwardAddresses 归一化逻辑）：
--   · 字符串数组：["host:port", ...]            —— 新建隧道写入的形态
--   · 对象数组：  [{"address":"host:port", ...}] —— 原版/导入数据可能存在的形态
--
-- 只回填**首个**目标：DIRECT 实际只用第一个地址，其余是 legacy 多目标配置的
-- 产物；RELAY 之后统一走 EgressTarget，本列不承载多目标语义。
--
-- 地址形态（与 routes/tunnels.ts 的 FORWARD_RE 一致）：
--   · `host:port`，host 不含冒号/空白
--   · `[ipv6]:port`，如 `[::1]:8080`
-- 端口取**最后一个冒号**之后的片段，因此 IPv6 地址里的冒号不会被误当分隔符；
-- host 侧剥掉 `[` `]`，落库为纯主机名/IP（`[::1]:8080` → `::1`），与
-- `socket/config-generator.ts#formatIP` 对存量 connect_ip 的归一化一致。
--
-- 幂等：外层 `remote_host IS NULL AND remote_port IS NULL` 限定保证只回填一次。
-- 解析不出的形态（无冒号、非数字端口、空数组、非数组、端口越界）一律留 NULL，
-- 绝不写入 0 端口或空 host。
--
-- 表达式重复出现的原因：MySQL 的 UPDATE 不允许在 SET 子句里引用同一语句
-- 中定义的列别名，因此 JSON 取值被逐字重复，而不是抽成一个可读的中间别名。
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
  -- RELAY 不使用 remote_host/remote_port（目标在 EgressTarget 上），
  -- 因此只回填 direct / 尚未声明模式的行，避免把 RELAY 隧道误标上 DIRECT 目标。
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
  AND (`tunnel_mode` IS NULL OR `tunnel_mode` = 'direct')
  AND JSON_TYPE(`forward_addresses`) = 'ARRAY'
  AND JSON_LENGTH(`forward_addresses`) > 0
  AND JSON_TYPE(JSON_EXTRACT(`forward_addresses`, '$[0]')) = 'OBJECT'
  AND JSON_TYPE(JSON_EXTRACT(`forward_addresses`, '$[0].address')) = 'STRING'
  AND JSON_UNQUOTE(JSON_EXTRACT(`forward_addresses`, '$[0].address')) REGEXP '^(\\[[0-9A-Fa-f:]+\\]|[^:[:space:]]+):[0-9]{1,5}$'
  AND CAST(SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(`forward_addresses`, '$[0].address')), ':', -1) AS UNSIGNED) BETWEEN 1 AND 65535;
