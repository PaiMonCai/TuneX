-- TuneX MySQL bootstrap.
--
-- The MySQL image creates the database named by MYSQL_DATABASE and the root
-- account from MYSQL_ROOT_PASSWORD. This file intentionally creates no
-- application account and embeds no password, so the repository ships no
-- shared database credential.
--
-- Per-server unicode defaults come from the server command flags in
-- docker-compose.yaml (--character-set-server / --collation-server).
SELECT 1;