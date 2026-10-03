-- V5-WP5-A1 — TLS 前端的证书/私钥**路径**（DEVELOPMENT.md §6.1 语义契约）
--
-- 纯 expand：给 tunnel 增加两列**可空无默认值**的 VARCHAR，不 DROP / 不 MODIFY
-- 任何旧列，因此代码回滚时不需要逆迁移。
--
-- 这两列承载的事实（契约第 4 问「证书归谁所有」）：
--   tls_cert_path ← tls 监听使用的证书文件路径（**节点本地**）
--   tls_key_path  ← 对应的私钥文件路径（**节点本地**）
--
-- 为什么控制面只存路径、不存密钥本体：
--   · 面板没有 per-resource secret store；为它新建一套，就会与 node_credential
--     以及部署层 env Fernet 形成第三套密钥系统（§1.1 禁止第二份真相）；
--   · §6.1 强制原则「certificate/key 必须进入现有 secret redaction」的含义是
--     redaction 作为**兜底**，而不是唯一防线：密钥只以路径形式流经控制面，它
--     就没有机会进入日志、诊断或 Support Bundle。
--
-- 为什么可空且无默认值：
--   只有 protocol='tls' 的行才会填这两列；其余行 NULL 是明确事实（"这条转发没有
--   TLS 前端"），而不是空字符串（那会被读成"路径配了但是空的"——一种坏配置）。
--   给默认值会把这个区别抹掉，而 TLS 配置缺路径必须 fail-closed。
--
-- 列宽 512：Linux PATH_MAX 是 4096，但节点上的证书路径在实践中远短于 512；
-- 上限存在是为了不让控制面成为一个任意长度字符串的通道（校验层同样限制长度）。
--
-- 该 SQL 由 `prisma migrate diff --from-schema-datamodel <old> --to-schema-datamodel
-- <new> --script` 生成，未手工改写，以避免与 schema 漂移。

-- AlterTable
ALTER TABLE `tunnel` ADD COLUMN `tls_cert_path` VARCHAR(512) NULL,
    ADD COLUMN `tls_key_path` VARCHAR(512) NULL;
