USE machun1;
CREATE TABLE IF NOT EXISTS source_binding_tasks (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  source ENUM('rin','munet','otogame') NOT NULL,
  session_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  boot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('pending','validating','complete','failed','cancelled','expired') NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  error VARCHAR(512) NULL,
  INDEX binding_owner_source (username,source), INDEX binding_expiry (expires_at),
  FOREIGN KEY (username) REFERENCES users(username)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
INSERT IGNORE INTO _machun_migrations (name) VALUES ('0002_source_binding_tasks');
