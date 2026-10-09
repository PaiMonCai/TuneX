ALTER TABLE `tunnel` ADD COLUMN `link_target_config` JSON NULL;
ALTER TABLE `forward_revision` ADD COLUMN `link_target_config` JSON NULL;
