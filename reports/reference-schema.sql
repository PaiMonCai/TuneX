
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
SET @MYSQLDUMP_TEMP_LOG_BIN = @@SESSION.SQL_LOG_BIN;
SET @@SESSION.SQL_LOG_BIN= 0;
SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '';
DROP TABLE IF EXISTS `_AdminRoleToUser`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `_AdminRoleToUser` (
  `A` int NOT NULL,
  `B` int NOT NULL,
  UNIQUE KEY `_AdminRoleToUser_AB_unique` (`A`,`B`),
  KEY `_AdminRoleToUser_B_index` (`B`),
  CONSTRAINT `_AdminRoleToUser_A_fkey` FOREIGN KEY (`A`) REFERENCES `admin_role` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `_AdminRoleToUser_B_fkey` FOREIGN KEY (`B`) REFERENCES `user` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `_prisma_migrations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `_prisma_migrations` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `checksum` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `finished_at` datetime(3) DEFAULT NULL,
  `migration_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `logs` text COLLATE utf8mb4_unicode_ci,
  `rolled_back_at` datetime(3) DEFAULT NULL,
  `started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `applied_steps_count` int unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `admin_role`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `admin_role` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `permissions` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `admin_role_name_key` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `balance_log`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `balance_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `balance` double NOT NULL,
  `amount` double NOT NULL,
  `type` enum('topup','plan','commission_transfer','admin_adjust') COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `balance_log_user_id_fkey` (`user_id`),
  CONSTRAINT `balance_log_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `commission_log`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `commission_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `balance` double NOT NULL,
  `amount` double NOT NULL,
  `type` enum('referral','transfer','withdraw','admin_adjust') COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `commission_log_user_id_fkey` (`user_id`),
  CONSTRAINT `commission_log_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `config`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `config` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` enum('MIN_TOPUP_AMOUNT','NOTICE','NOTICE_POPUP','NOTICE_POPUP_INTERVAL_HOURS','SITE_NAME','SITE_DESCRIPTION','ALLOW_REGISTER','LOGO_URL','HIDE_NODE_STATUS','AUTO_UPDATE_AGENT','CHATWOOT_BASE_URL','CHATWOOT_TOKEN','TUNNEL_TRAFFIC_RETENTION_DAYS','HIDE_FOOTER','HIDE_DOCS','LANDING_PAGE_URL','REFERRAL_COMMISSION_RATE','REFERRAL_FIRST_ONLY','REFERRAL_MODE','OBSERVER_PERIOD','EMAIL_PROVIDER','SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASS','SMTP_FROM','RESEND_API_KEY','RESEND_FROM','MIN_WITHDRAW_AMOUNT','WITHDRAW_METHODS','LIMIT_SCOPE','ENABLE_SUBSCRIPTION') COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `config_name_key` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `dns_provider`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `dns_provider` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` enum('cloudflare','huawei') COLLATE utf8mb4_unicode_ci NOT NULL,
  `config` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  `user_id` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `dns_provider_user_id_fkey` (`user_id`),
  CONSTRAINT `dns_provider_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `in_node_group_dns`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `in_node_group_dns` (
  `id` int NOT NULL AUTO_INCREMENT,
  `in_node_group_id` int NOT NULL,
  `dns_provider_id` int NOT NULL,
  `ipv6` tinyint(1) NOT NULL DEFAULT '0',
  `status` enum('active','inactive') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  `ttl` int NOT NULL DEFAULT '60',
  PRIMARY KEY (`id`),
  KEY `in_node_group_dns_in_node_group_id_fkey` (`in_node_group_id`),
  KEY `in_node_group_dns_dns_provider_id_fkey` (`dns_provider_id`),
  CONSTRAINT `in_node_group_dns_dns_provider_id_fkey` FOREIGN KEY (`dns_provider_id`) REFERENCES `dns_provider` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `in_node_group_dns_in_node_group_id_fkey` FOREIGN KEY (`in_node_group_id`) REFERENCES `node_group` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `node`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `node` (
  `id` int NOT NULL AUTO_INCREMENT,
  `weight` int NOT NULL DEFAULT '1',
  `status` enum('active','inactive') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `node_id` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `connect_ip` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  `node_group_id` int NOT NULL,
  `version` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'unknown',
  `order_by` double NOT NULL DEFAULT '1000',
  `backup` tinyint(1) NOT NULL DEFAULT '0',
  `custom_line` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `dns_status` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `node_node_id_key` (`node_id`),
  KEY `node_node_group_id_fkey` (`node_group_id`),
  CONSTRAINT `node_node_group_id_fkey` FOREIGN KEY (`node_group_id`) REFERENCES `node_group` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `node_group`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `node_group` (
  `id` int NOT NULL AUTO_INCREMENT,
  `token` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `connect_ip` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `node_type` enum('in','out') COLLATE utf8mb4_unicode_ci NOT NULL,
  `load_balance_type` enum('round','rand','fifo','hash','ll','lc') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'round',
  `allow_tunnel_types` json DEFAULT NULL,
  `traffic_rate` double NOT NULL DEFAULT '1',
  `need_out_node_group` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  `user_id` int NOT NULL,
  `port_range` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `allow_out_node_groups` json DEFAULT NULL,
  `order_by` double NOT NULL DEFAULT '1000',
  `allow_in_node_groups` json DEFAULT NULL,
  `block_protocols` json DEFAULT NULL,
  `allow_listen_protocol` tinyint(1) NOT NULL DEFAULT '0',
  `bypass_list` json DEFAULT NULL,
  `bypass_type` enum('whitelist','blacklist') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'blacklist',
  `admission` tinyint(1) NOT NULL DEFAULT '0',
  `allow_listen_protocols` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `node_group_token_key` (`token`),
  KEY `node_group_user_id_fkey` (`user_id`),
  CONSTRAINT `node_group_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `payment`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `payment` (
  `id` int NOT NULL AUTO_INCREMENT,
  `fixed_fee` double DEFAULT NULL,
  `percent_fee` double DEFAULT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `url` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `config` json NOT NULL,
  `method` enum('epay','bepusdt','heleket') COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` enum('active','inactive') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  `order_by` double NOT NULL DEFAULT '1000',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `plan`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `plan` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `price` double NOT NULL,
  `max_tunnels` int DEFAULT NULL,
  `traffic` int DEFAULT NULL,
  `ip_limit` int DEFAULT NULL,
  `bandwidth_limit` int DEFAULT NULL,
  `allow_custom_in_node_group` tinyint(1) NOT NULL,
  `allow_custom_out_node_group` tinyint(1) NOT NULL,
  `all_in_node_groups` tinyint(1) NOT NULL,
  `all_out_node_groups` tinyint(1) NOT NULL,
  `billing_cycle` enum('month','quarter','half_year','year','lifetime') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'month',
  `status` enum('active','inactive') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `renewable` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  `original_price` double DEFAULT NULL,
  `order_by` double NOT NULL DEFAULT '1000',
  `stock` int DEFAULT NULL,
  `setup_fee` double DEFAULT NULL,
  `whitelist_limit` int DEFAULT NULL,
  `client_limit` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `plan_coupon`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `plan_coupon` (
  `id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` enum('percentage','fixed') COLLATE utf8mb4_unicode_ci NOT NULL,
  `valid_cycle` enum('month','quarter','half_year','year','lifetime') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `value` double NOT NULL,
  `valid_start` datetime(3) DEFAULT NULL,
  `valid_end` datetime(3) DEFAULT NULL,
  `max_use` int DEFAULT NULL,
  `max_use_per_user` int DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `plan_node_group`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `plan_node_group` (
  `id` int NOT NULL AUTO_INCREMENT,
  `plan_id` int NOT NULL,
  `node_group_id` int NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `plan_node_group_node_group_id_fkey` (`node_group_id`),
  KEY `plan_node_group_plan_id_fkey` (`plan_id`),
  CONSTRAINT `plan_node_group_node_group_id_fkey` FOREIGN KEY (`node_group_id`) REFERENCES `node_group` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `plan_node_group_plan_id_fkey` FOREIGN KEY (`plan_id`) REFERENCES `plan` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `plan_order`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `plan_order` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `plan_id` int NOT NULL,
  `price` double NOT NULL,
  `balance` double NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  `coupon_id` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `plan_order_user_id_fkey` (`user_id`),
  KEY `plan_order_plan_id_fkey` (`plan_id`),
  KEY `plan_order_coupon_id_fkey` (`coupon_id`),
  CONSTRAINT `plan_order_coupon_id_fkey` FOREIGN KEY (`coupon_id`) REFERENCES `plan_coupon` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `plan_order_plan_id_fkey` FOREIGN KEY (`plan_id`) REFERENCES `plan` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `plan_order_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ticket`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ticket` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `content` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('open','closed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'open',
  `user_id` int NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ticket_user_id_fkey` (`user_id`),
  CONSTRAINT `ticket_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ticket_reply`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ticket_reply` (
  `id` int NOT NULL AUTO_INCREMENT,
  `content` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `is_admin` tinyint(1) NOT NULL DEFAULT '0',
  `ticket_id` int NOT NULL,
  `user_id` int NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ticket_reply_ticket_id_fkey` (`ticket_id`),
  KEY `ticket_reply_user_id_fkey` (`user_id`),
  CONSTRAINT `ticket_reply_ticket_id_fkey` FOREIGN KEY (`ticket_id`) REFERENCES `ticket` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `ticket_reply_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `topup_activity`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `topup_activity` (
  `id` int NOT NULL AUTO_INCREMENT,
  `type` enum('percentage','fixed') COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` double NOT NULL,
  `min_amount` double DEFAULT NULL,
  `max_amount` double DEFAULT NULL,
  `valid_start` datetime(3) DEFAULT NULL,
  `valid_end` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `topup_order`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `topup_order` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `price` double NOT NULL,
  `payment_id` int NOT NULL,
  `pay_url` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('pending','success','cancelled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `order_id` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `trade_id` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  `balance` double NOT NULL DEFAULT '0',
  `bonus` double NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `topup_order_order_id_key` (`order_id`),
  UNIQUE KEY `topup_order_trade_id_key` (`trade_id`),
  KEY `topup_order_user_id_fkey` (`user_id`),
  KEY `topup_order_payment_id_fkey` (`payment_id`),
  CONSTRAINT `topup_order_payment_id_fkey` FOREIGN KEY (`payment_id`) REFERENCES `payment` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `topup_order_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `tunnel`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tunnel` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `tunnel_type` enum('tcp','mtcp','udp','tunex','mtls','mwss','wss','tls','quic') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'wss',
  `listen_ip` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `listen_port` int DEFAULT NULL,
  `status` enum('active','inactive') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `forward_addresses` json NOT NULL,
  `load_balance_type` enum('round','rand','fifo','hash','ll','lc') COLLATE utf8mb4_unicode_ci NOT NULL,
  `ip_type` enum('auto','ipv4','ipv6') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'ipv4',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  `in_node_group_id` int NOT NULL,
  `out_node_group_id` int DEFAULT NULL,
  `user_id` int NOT NULL,
  `order_by` double NOT NULL DEFAULT '1000',
  `bandwidth_limit` int DEFAULT NULL,
  `ip_limit` int DEFAULT NULL,
  `category` enum('port_forward','remote_port_forward') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'port_forward',
  `listen_protocol` json DEFAULT NULL,
  `traffic` double NOT NULL DEFAULT '0',
  `traffic_cost` double NOT NULL DEFAULT '0',
  `forward_addresses_protocol` json DEFAULT NULL,
  `proxy_protocol` tinyint(1) NOT NULL DEFAULT '0',
  `client_limit` int DEFAULT NULL,
  `port_conflict_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `tunnel_listen_port_in_node_group_id_key` (`listen_port`,`in_node_group_id`),
  KEY `tunnel_in_node_group_id_fkey` (`in_node_group_id`),
  KEY `tunnel_out_node_group_id_fkey` (`out_node_group_id`),
  KEY `tunnel_user_id_fkey` (`user_id`),
  CONSTRAINT `tunnel_in_node_group_id_fkey` FOREIGN KEY (`in_node_group_id`) REFERENCES `node_group` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `tunnel_out_node_group_id_fkey` FOREIGN KEY (`out_node_group_id`) REFERENCES `node_group` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `tunnel_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `tunnel_chain`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tunnel_chain` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tunnel_id` int NOT NULL,
  `node_group_id` int NOT NULL,
  `node_type` enum('in','out') COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  KEY `tunnel_chain_tunnel_id_fkey` (`tunnel_id`),
  KEY `tunnel_chain_node_group_id_fkey` (`node_group_id`),
  CONSTRAINT `tunnel_chain_node_group_id_fkey` FOREIGN KEY (`node_group_id`) REFERENCES `node_group` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `tunnel_chain_tunnel_id_fkey` FOREIGN KEY (`tunnel_id`) REFERENCES `tunnel` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `tunnel_traffic`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tunnel_traffic` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tunnel_id` int NOT NULL,
  `traffic` double NOT NULL,
  `traffic_cost` double NOT NULL,
  `date` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `tunnel_traffic_date_idx` (`date`),
  KEY `tunnel_traffic_tunnel_id_fkey` (`tunnel_id`),
  CONSTRAINT `tunnel_traffic_tunnel_id_fkey` FOREIGN KEY (`tunnel_id`) REFERENCES `tunnel` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `user`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user` (
  `id` int NOT NULL AUTO_INCREMENT,
  `super_admin` tinyint(1) NOT NULL DEFAULT '0',
  `email` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  `balance` double NOT NULL DEFAULT '0',
  `tg_id` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `auto_renew` tinyint(1) NOT NULL DEFAULT '0',
  `api_key` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('active','inactive') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  `notify_subscriptions` json DEFAULT NULL,
  `note` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `uid` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `parent_id` int DEFAULT NULL,
  `referral_commission_rate` double DEFAULT NULL,
  `referral_first_only` tinyint(1) DEFAULT NULL,
  `commission_balance` double NOT NULL DEFAULT '0',
  `admin_notify_subscriptions` json DEFAULT NULL,
  `subscription_key` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_email_key` (`email`),
  UNIQUE KEY `user_api_key_key` (`api_key`),
  UNIQUE KEY `user_subscription_key_key` (`subscription_key`),
  KEY `user_parent_id_fkey` (`parent_id`),
  CONSTRAINT `user_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `user` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `user_plan`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_plan` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `traffic_used` double NOT NULL DEFAULT '0',
  `expired_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  `plan_id` int NOT NULL,
  `traffic` double DEFAULT NULL,
  `max_tunnels` int DEFAULT NULL,
  `whitelist_ips` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_plan_user_id_key` (`user_id`),
  KEY `user_plan_plan_id_fkey` (`plan_id`),
  CONSTRAINT `user_plan_plan_id_fkey` FOREIGN KEY (`plan_id`) REFERENCES `plan` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `user_plan_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `withdraw_request`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `withdraw_request` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `amount` double NOT NULL,
  `method` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `account` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('pending','approved','rejected') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `remark` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `withdraw_request_user_id_fkey` (`user_id`),
  CONSTRAINT `withdraw_request_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
SET @@SESSION.SQL_LOG_BIN = @MYSQLDUMP_TEMP_LOG_BIN;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

