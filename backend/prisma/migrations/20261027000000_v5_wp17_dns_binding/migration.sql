-- V5-WP17 —— DDNS 前门绑定（契约 docs/v5-wp17-entry-exit-group-ddns-contract.md §3 F3/F4/F6）。
--
-- 本迁移只做「落库的形状」，**零外呼**：不解析域名、不调用任何 provider、不改任何既有行。
--
-- 为什么挂 `tunnel` 而不是 Route Profile（F3）：模板与域名是 N:1——同一个 Profile 可以被
-- 多条 Forward apply，域名若属模板就会互相打架；而且域名必须随 `config_revision` 被 ACK，
-- 落在 tunnel 行上才是同一份 desired，而不是第二份真相。
--
-- 为什么值来源只认 `node.connect_ip`（F3）：写进 DNS 的是「客户端该连哪里」，那正是面板
-- 观察到的连接 IP（与跳间拨号同源）。`connect_ip IS NULL` ⇒ 拒绝写（`dns_unbound_address`），
-- 绝不回落 `listen_ip` 或节点组的遗留列——回落就是猜地址，而猜错的地址会把客户端指向别人的机器。
--
-- 为什么 `dns_state` **不是列**：它是**投影**——由「是否绑定 + dns_synced_at + dns_verified +
-- dns_last_error」推出来。存一份状态列等于给同一件事第二个家，而两份家在崩溃与并发下必然分叉。
-- 投影的取值词表（unbound / pending / synced / synced_unverified / error）住在服务层，
-- 其中 `synced_unverified` 的存在是因为：**写成功不等于已切换**（Lead 裁决 D2），没有读回
-- 确认时面板不得显示「已切换」。
--
-- 为什么 `dns_auto_resolve` 默认 false（F5.3）：自动动作必须显式 opt-in。缺省关闭时
-- 一条 Forward 也**不会**因此不可用：DNS 只是前门，关闭时面板只返回建议值集，零外呼。
--
-- 全部可空且无默认值（除两个显式默认的布尔列）：只有配了前门域名的 Forward 才填，
-- 其余行 NULL 是**明确事实**（"这条 Forward 没有前门"），不是"还没填"。

-- 1) tunnel：前门绑定
ALTER TABLE `tunnel`
    ADD COLUMN `dns_domain` VARCHAR(255) NULL,
    ADD COLUMN `dns_record_type` ENUM('A', 'AAAA', 'CNAME') NULL,
    ADD COLUMN `dns_mode` ENUM('multi_entry', 'single_active') NULL,
    ADD COLUMN `dns_provider_id` INTEGER NULL,
    ADD COLUMN `dns_auto_resolve` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `dns_confirmed_values` JSON NULL,
    ADD COLUMN `dns_synced_at` DATETIME(3) NULL,
    ADD COLUMN `dns_verified` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `dns_last_error` VARCHAR(120) NULL;

-- `dns_confirmed_values` 是「上次已确认的值集」。它同时承担两件事（F5.3）：
-- 「值集未变就不写」这条判据读它，而「多入口挂掉一个入口**无需**写 DNS」能成立也正是靠它——
-- 这一支把 DNS 写的延迟从可用性关键路径上摘掉。
--
-- `dns_verified` 与 `dns_synced_at` 一起决定投影是 synced 还是 synced_unverified；
-- `dns_last_error` 存**脱敏**原因码（绝不含凭据）。

-- 记录类型与形态用枚举而不是字符串：多值 CNAME 在 DNS 语义上不成立，未知形态也不该被
-- 静默当成默认值（F7 要求「未知值一律拒绝」）。枚举让这些状态在类型层面就不存在，
-- 而不是靠服务层事后拦。

-- Prisma 的索引/外键命名与既有迁移一致（`<table>_<column>_idx` / `_fkey`）
CREATE INDEX `tunnel_dns_provider_id_idx` ON `tunnel`(`dns_provider_id`);

-- 删 provider 时把 Forward 的前门置空（SetNull）而不是级联删 Forward：丢掉一条转发是
-- 不可逆的事故，丢掉一个 DNS 绑定只是"重新配一次"。
ALTER TABLE `tunnel` ADD CONSTRAINT `tunnel_dns_provider_id_fkey` FOREIGN KEY (`dns_provider_id`) REFERENCES `dns_provider`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) dns_provider：凭据的作用域归 workspace
--
-- 既有 `user_id` 是**错的粒度**（F6）：凭据属于资源域，不属于个人。新增可空 `workspace_id`：
--   · 非 NULL = 租户凭据，只有该 workspace 能读写；
--   · NULL   = 遗留全局行 / 平台级凭据，**非平台管理员读取即 fail-closed**。
-- 存量行保持 NULL（不猜归属）；按 F6 它们需要一次显式的迁移策略，而不是在迁移里替运维决定。
ALTER TABLE `dns_provider` ADD COLUMN `workspace_id` INTEGER NULL;

CREATE INDEX `dns_provider_workspace_id_idx` ON `dns_provider`(`workspace_id`);

ALTER TABLE `dns_provider` ADD CONSTRAINT `dns_provider_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
