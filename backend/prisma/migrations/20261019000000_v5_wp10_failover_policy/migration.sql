-- V5.3 WP10 —— 自动故障转移策略的存储位
--
-- 为什么是配置项而不是新表：§8 冻结的是"自动迁移必须有显式 policy"，而策略本身是**运维配置**，
-- 与站点名、通知开关同类。给它开一张表会让"谁改了策略"多一条审计路径，却没有任何收益。
--
-- 为什么必须是**可缺省**的：缺省不存在 ⇒ `auto_failover=false`（fail-closed）。
-- 策略没被显式配置过就不允许自动搬流量 —— 这是 §8 "迁移必须显式"的直接落地，
-- 而不是"默认打开、出事再关"。
--
-- ENUM 取值由 schema 自动生成（手抄会与 schema 漂移，那会让 migrate 每次都报 diff）。
-- 纯枚举扩值：MySQL 的 ENUM 追加值是可加操作，存量行不受影响；回滚只需停止读写该键。

ALTER TABLE `config`
  MODIFY COLUMN `name` ENUM('MIN_TOPUP_AMOUNT','FAILOVER_POLICY','NOTICE','NOTICE_POPUP','NOTICE_POPUP_INTERVAL_HOURS','SITE_NAME','SITE_DESCRIPTION','ALLOW_REGISTER','LOGO_URL','HIDE_NODE_STATUS','AUTO_UPDATE_AGENT','CHATWOOT_BASE_URL','CHATWOOT_TOKEN','TUNNEL_TRAFFIC_RETENTION_DAYS','HIDE_FOOTER','HIDE_DOCS','LANDING_PAGE_URL','REFERRAL_COMMISSION_RATE','REFERRAL_FIRST_ONLY','REFERRAL_MODE','OBSERVER_PERIOD','EMAIL_PROVIDER','SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASS','SMTP_FROM','RESEND_API_KEY','RESEND_FROM','MIN_WITHDRAW_AMOUNT','WITHDRAW_METHODS','LIMIT_SCOPE','ENABLE_SUBSCRIPTION') NOT NULL;
