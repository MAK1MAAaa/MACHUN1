USE machun1;
-- Preserve existing records as unknown; only source-supplied lamps fill this column.
SET @machun_clear_column_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'scores' AND column_name = 'clear_status'
);
SET @machun_clear_migration = IF(
  @machun_clear_column_exists = 0,
  'ALTER TABLE scores ADD COLUMN clear_status ENUM(''failed'',''clear'',''hard'',''brave'',''absolute'',''catastrophy'') NULL',
  'SELECT 1'
);
PREPARE machun_clear_statement FROM @machun_clear_migration;
EXECUTE machun_clear_statement;
DEALLOCATE PREPARE machun_clear_statement;
INSERT IGNORE INTO _machun_migrations (name) VALUES ('0003_score_clear_status');
