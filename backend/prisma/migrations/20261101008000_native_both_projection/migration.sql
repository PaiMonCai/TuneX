-- Native both has no honest legacy TunnelType value. Canonical protocol wins.
ALTER TABLE `tunnel` MODIFY `tunnel_type` ENUM('tcp', 'mtcp', 'udp', 'tunex', 'mtls', 'mwss', 'wss', 'tls', 'quic') NULL DEFAULT 'wss';
UPDATE `tunnel` SET `tunnel_type` = NULL
WHERE `category` = 'port_forward' AND `forward_protocol` = 'both' AND `link_resource_id` IS NULL;
