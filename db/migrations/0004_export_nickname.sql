USE machun1;
-- An empty nickname uses the login name when rendering and does not alter scores.
SET @machun_nickname_column_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'workspaces' AND column_name = 'export_nickname'
);
SET @machun_nickname_migration = IF(
  @machun_nickname_column_exists = 0,
  'ALTER TABLE workspaces ADD COLUMN export_nickname VARCHAR(64) NOT NULL DEFAULT ''''',
  'SELECT 1'
);
PREPARE machun_nickname_statement FROM @machun_nickname_migration;
EXECUTE machun_nickname_statement;
DEALLOCATE PREPARE machun_nickname_statement;
INSERT IGNORE INTO _machun_migrations (name) VALUES ('0004_export_nickname');
