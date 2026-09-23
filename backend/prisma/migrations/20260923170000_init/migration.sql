-- CreateTable
CREATE TABLE `node_group` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `token` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `port_range` VARCHAR(255) NULL,
    `connect_ip` VARCHAR(255) NULL,
    `node_type` ENUM('in', 'out') NOT NULL,
    `load_balance_type` ENUM('round', 'rand', 'fifo', 'hash', 'll', 'lc') NOT NULL DEFAULT 'round',
    `allow_listen_protocol` BOOLEAN NOT NULL DEFAULT false,
    `allow_listen_protocols` JSON NULL,
    `allow_tunnel_types` JSON NULL,
    `bypass_type` ENUM('whitelist', 'blacklist') NOT NULL DEFAULT 'blacklist',
    `bypass_list` JSON NULL,
    `admission` BOOLEAN NOT NULL DEFAULT false,
    `block_protocols` JSON NULL,
    `traffic_rate` DOUBLE NOT NULL DEFAULT 1,
    `need_out_node_group` BOOLEAN NOT NULL DEFAULT true,
    `allow_out_node_groups` JSON NULL,
    `allow_in_node_groups` JSON NULL,
    `order_by` DOUBLE NOT NULL DEFAULT 1000,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `user_id` INTEGER NOT NULL,

    UNIQUE INDEX `node_group_token_key`(`token`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `node` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `weight` INTEGER NOT NULL DEFAULT 1,
    `status` ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    `node_id` VARCHAR(255) NOT NULL,
    `connect_ip` VARCHAR(255) NOT NULL,
    `version` VARCHAR(255) NOT NULL DEFAULT 'unknown',
    `backup` BOOLEAN NOT NULL DEFAULT false,
    `order_by` DOUBLE NOT NULL DEFAULT 1000,
    `custom_line` VARCHAR(255) NULL,
    `dns_status` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `node_group_id` INTEGER NOT NULL,

    UNIQUE INDEX `node_node_id_key`(`node_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tunnel` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `tunnel_type` ENUM('tcp', 'mtcp', 'udp', 'relayx', 'mtls', 'mwss', 'wss', 'tls', 'quic') NOT NULL DEFAULT 'wss',
    `category` ENUM('port_forward', 'remote_port_forward') NOT NULL DEFAULT 'port_forward',
    `listen_ip` VARCHAR(191) NULL,
    `listen_port` INTEGER NULL,
    `listen_protocol` JSON NULL,
    `port_conflict_at` DATETIME(3) NULL,
    `status` ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    `forward_addresses` JSON NOT NULL,
    `forward_addresses_protocol` JSON NULL,
    `load_balance_type` ENUM('round', 'rand', 'fifo', 'hash', 'll', 'lc') NOT NULL,
    `ip_type` ENUM('auto', 'ipv4', 'ipv6') NOT NULL DEFAULT 'ipv4',
    `order_by` DOUBLE NOT NULL DEFAULT 1000,
    `ip_limit` INTEGER NULL,
    `client_limit` INTEGER NULL,
    `bandwidth_limit` INTEGER NULL,
    `traffic` DOUBLE NOT NULL DEFAULT 0,
    `traffic_cost` DOUBLE NOT NULL DEFAULT 0,
    `proxy_protocol` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `in_node_group_id` INTEGER NOT NULL,
    `out_node_group_id` INTEGER NULL,
    `user_id` INTEGER NOT NULL,

    UNIQUE INDEX `tunnel_listen_port_in_node_group_id_key`(`listen_port`, `in_node_group_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tunnel_chain` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tunnel_id` INTEGER NOT NULL,
    `node_type` ENUM('in', 'out') NOT NULL,
    `node_group_id` INTEGER NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `super_admin` BOOLEAN NOT NULL DEFAULT false,
    `email` VARCHAR(191) NOT NULL,
    `balance` DOUBLE NOT NULL DEFAULT 0,
    `commission_balance` DOUBLE NOT NULL DEFAULT 0,
    `tg_id` VARCHAR(191) NULL,
    `uid` VARCHAR(191) NULL,
    `note` VARCHAR(191) NULL,
    `parent_id` INTEGER NULL,
    `referral_commission_rate` DOUBLE NULL,
    `referral_first_only` BOOLEAN NULL,
    `auto_renew` BOOLEAN NOT NULL DEFAULT false,
    `api_key` VARCHAR(191) NOT NULL,
    `subscription_key` VARCHAR(191) NOT NULL,
    `notify_subscriptions` JSON NULL,
    `admin_notify_subscriptions` JSON NULL,
    `status` ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `user_email_key`(`email`),
    UNIQUE INDEX `user_api_key_key`(`api_key`),
    UNIQUE INDEX `user_subscription_key_key`(`subscription_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admin_role` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `permissions` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `admin_role_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_plan` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `traffic` DOUBLE NULL,
    `traffic_used` DOUBLE NOT NULL DEFAULT 0,
    `max_tunnels` INTEGER NULL,
    `whitelist_ips` JSON NULL,
    `expired_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `plan_id` INTEGER NOT NULL,

    UNIQUE INDEX `user_plan_user_id_key`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plan` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `description` VARCHAR(191) NULL,
    `original_price` DOUBLE NULL,
    `price` DOUBLE NOT NULL,
    `max_tunnels` INTEGER NULL,
    `traffic` INTEGER NULL,
    `ip_limit` INTEGER NULL,
    `client_limit` INTEGER NULL,
    `bandwidth_limit` INTEGER NULL,
    `whitelist_limit` INTEGER NULL,
    `allow_custom_in_node_group` BOOLEAN NOT NULL,
    `allow_custom_out_node_group` BOOLEAN NOT NULL,
    `all_in_node_groups` BOOLEAN NOT NULL,
    `all_out_node_groups` BOOLEAN NOT NULL,
    `setup_fee` DOUBLE NULL,
    `billing_cycle` ENUM('month', 'quarter', 'half_year', 'year', 'lifetime') NOT NULL DEFAULT 'month',
    `status` ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    `renewable` BOOLEAN NOT NULL DEFAULT true,
    `stock` INTEGER NULL,
    `order_by` DOUBLE NOT NULL DEFAULT 1000,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plan_node_group` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `plan_id` INTEGER NOT NULL,
    `node_group_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plan_order` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `plan_id` INTEGER NOT NULL,
    `price` DOUBLE NOT NULL,
    `balance` DOUBLE NOT NULL,
    `coupon_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `topup_order` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `price` DOUBLE NOT NULL,
    `balance` DOUBLE NOT NULL DEFAULT 0,
    `bonus` DOUBLE NOT NULL DEFAULT 0,
    `payment_id` INTEGER NOT NULL,
    `pay_url` TEXT NOT NULL,
    `status` ENUM('pending', 'success', 'cancelled') NOT NULL DEFAULT 'pending',
    `order_id` VARCHAR(255) NOT NULL,
    `trade_id` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `topup_order_order_id_key`(`order_id`),
    UNIQUE INDEX `topup_order_trade_id_key`(`trade_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `topup_activity` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `type` ENUM('percentage', 'fixed') NOT NULL,
    `value` DOUBLE NOT NULL,
    `min_amount` DOUBLE NULL,
    `max_amount` DOUBLE NULL,
    `valid_start` DATETIME(3) NULL,
    `valid_end` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tunnel_traffic` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tunnel_id` INTEGER NOT NULL,
    `traffic` DOUBLE NOT NULL,
    `traffic_cost` DOUBLE NOT NULL,
    `date` DATETIME(3) NOT NULL,

    INDEX `tunnel_traffic_date_idx`(`date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `config` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` ENUM('MIN_TOPUP_AMOUNT', 'NOTICE', 'NOTICE_POPUP', 'NOTICE_POPUP_INTERVAL_HOURS', 'SITE_NAME', 'SITE_DESCRIPTION', 'ALLOW_REGISTER', 'LOGO_URL', 'HIDE_NODE_STATUS', 'AUTO_UPDATE_AGENT', 'CHATWOOT_BASE_URL', 'CHATWOOT_TOKEN', 'TUNNEL_TRAFFIC_RETENTION_DAYS', 'HIDE_FOOTER', 'HIDE_DOCS', 'LANDING_PAGE_URL', 'REFERRAL_COMMISSION_RATE', 'REFERRAL_FIRST_ONLY', 'REFERRAL_MODE', 'OBSERVER_PERIOD', 'EMAIL_PROVIDER', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'RESEND_API_KEY', 'RESEND_FROM', 'MIN_WITHDRAW_AMOUNT', 'WITHDRAW_METHODS', 'LIMIT_SCOPE', 'ENABLE_SUBSCRIPTION') NOT NULL,
    `value` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `config_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `fixed_fee` DOUBLE NULL,
    `percent_fee` DOUBLE NULL,
    `name` VARCHAR(255) NOT NULL,
    `url` VARCHAR(255) NOT NULL,
    `config` JSON NOT NULL,
    `method` ENUM('epay', 'bepusdt', 'heleket') NOT NULL,
    `type` VARCHAR(255) NULL,
    `status` ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    `order_by` DOUBLE NOT NULL DEFAULT 1000,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plan_coupon` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(255) NOT NULL,
    `type` ENUM('percentage', 'fixed') NOT NULL,
    `valid_cycle` ENUM('month', 'quarter', 'half_year', 'year', 'lifetime') NULL,
    `value` DOUBLE NOT NULL,
    `valid_start` DATETIME(3) NULL,
    `valid_end` DATETIME(3) NULL,
    `max_use` INTEGER NULL,
    `max_use_per_user` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `balance_log` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `balance` DOUBLE NOT NULL,
    `amount` DOUBLE NOT NULL,
    `type` ENUM('topup', 'plan', 'commission_transfer', 'admin_adjust') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commission_log` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `balance` DOUBLE NOT NULL,
    `amount` DOUBLE NOT NULL,
    `type` ENUM('referral', 'transfer', 'withdraw', 'admin_adjust') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `withdraw_request` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `amount` DOUBLE NOT NULL,
    `method` VARCHAR(255) NOT NULL,
    `account` TEXT NOT NULL,
    `status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
    `remark` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ticket` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(255) NOT NULL,
    `content` TEXT NOT NULL,
    `status` ENUM('open', 'closed') NOT NULL DEFAULT 'open',
    `user_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ticket_reply` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `content` TEXT NOT NULL,
    `is_admin` BOOLEAN NOT NULL DEFAULT false,
    `ticket_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `in_node_group_dns` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `in_node_group_id` INTEGER NOT NULL,
    `dns_provider_id` INTEGER NOT NULL,
    `ttl` INTEGER NOT NULL DEFAULT 60,
    `ipv6` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dns_provider` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `type` ENUM('cloudflare', 'huawei') NOT NULL,
    `config` JSON NOT NULL,
    `user_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_credential` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `password` VARCHAR(255) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `user_credential_user_id_key`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `_AdminRoleToUser` (
    `A` INTEGER NOT NULL,
    `B` INTEGER NOT NULL,

    UNIQUE INDEX `_AdminRoleToUser_AB_unique`(`A`, `B`),
    INDEX `_AdminRoleToUser_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `node_group` ADD CONSTRAINT `node_group_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `node` ADD CONSTRAINT `node_node_group_id_fkey` FOREIGN KEY (`node_group_id`) REFERENCES `node_group`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tunnel` ADD CONSTRAINT `tunnel_in_node_group_id_fkey` FOREIGN KEY (`in_node_group_id`) REFERENCES `node_group`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tunnel` ADD CONSTRAINT `tunnel_out_node_group_id_fkey` FOREIGN KEY (`out_node_group_id`) REFERENCES `node_group`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tunnel` ADD CONSTRAINT `tunnel_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tunnel_chain` ADD CONSTRAINT `tunnel_chain_tunnel_id_fkey` FOREIGN KEY (`tunnel_id`) REFERENCES `tunnel`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tunnel_chain` ADD CONSTRAINT `tunnel_chain_node_group_id_fkey` FOREIGN KEY (`node_group_id`) REFERENCES `node_group`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user` ADD CONSTRAINT `user_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_plan` ADD CONSTRAINT `user_plan_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_plan` ADD CONSTRAINT `user_plan_plan_id_fkey` FOREIGN KEY (`plan_id`) REFERENCES `plan`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plan_node_group` ADD CONSTRAINT `plan_node_group_node_group_id_fkey` FOREIGN KEY (`node_group_id`) REFERENCES `node_group`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plan_node_group` ADD CONSTRAINT `plan_node_group_plan_id_fkey` FOREIGN KEY (`plan_id`) REFERENCES `plan`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plan_order` ADD CONSTRAINT `plan_order_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plan_order` ADD CONSTRAINT `plan_order_plan_id_fkey` FOREIGN KEY (`plan_id`) REFERENCES `plan`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plan_order` ADD CONSTRAINT `plan_order_coupon_id_fkey` FOREIGN KEY (`coupon_id`) REFERENCES `plan_coupon`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `topup_order` ADD CONSTRAINT `topup_order_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `topup_order` ADD CONSTRAINT `topup_order_payment_id_fkey` FOREIGN KEY (`payment_id`) REFERENCES `payment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tunnel_traffic` ADD CONSTRAINT `tunnel_traffic_tunnel_id_fkey` FOREIGN KEY (`tunnel_id`) REFERENCES `tunnel`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `balance_log` ADD CONSTRAINT `balance_log_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `commission_log` ADD CONSTRAINT `commission_log_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `withdraw_request` ADD CONSTRAINT `withdraw_request_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ticket` ADD CONSTRAINT `ticket_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ticket_reply` ADD CONSTRAINT `ticket_reply_ticket_id_fkey` FOREIGN KEY (`ticket_id`) REFERENCES `ticket`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ticket_reply` ADD CONSTRAINT `ticket_reply_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `in_node_group_dns` ADD CONSTRAINT `in_node_group_dns_in_node_group_id_fkey` FOREIGN KEY (`in_node_group_id`) REFERENCES `node_group`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `in_node_group_dns` ADD CONSTRAINT `in_node_group_dns_dns_provider_id_fkey` FOREIGN KEY (`dns_provider_id`) REFERENCES `dns_provider`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dns_provider` ADD CONSTRAINT `dns_provider_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_credential` ADD CONSTRAINT `user_credential_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_AdminRoleToUser` ADD CONSTRAINT `_AdminRoleToUser_A_fkey` FOREIGN KEY (`A`) REFERENCES `admin_role`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_AdminRoleToUser` ADD CONSTRAINT `_AdminRoleToUser_B_fkey` FOREIGN KEY (`B`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

