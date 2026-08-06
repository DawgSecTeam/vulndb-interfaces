-- Schema for the `vulns` database used by vulndb-ui.
-- Run this against a fresh MySQL/MariaDB instance to recreate the structure.

-- `description` is prose for humans and for agents that pick a competition's misconfig set.
-- It is the only place difficulty, realism and cross-config couplings are recorded, so a good
-- one says what the config changes on the box, why a real system would plausibly have it, and
-- what a defender would notice — e.g. "installs vsftpd with Ubuntu's default anonymous_enable=NO,
-- so an anonymous FTP check can never pass but a local login does".
CREATE TABLE IF NOT EXISTS configurations (
    id          INT(11)      NOT NULL AUTO_INCREMENT,
    name        VARCHAR(255) NOT NULL,
    description TEXT         NULL,
    platform    ENUM('linux', 'windows', 'other') NOT NULL,
    category    ENUM('misconfiguration', 'service', 'vulnerability') NOT NULL DEFAULT 'misconfiguration',
    depends_on  LONGTEXT     NULL,
    script      TEXT         NOT NULL,
    run_as      VARCHAR(100) NOT NULL DEFAULT 'root',
    type        ENUM('bash', 'powershell', 'command') NOT NULL DEFAULT 'bash',
    PRIMARY KEY (id),
    UNIQUE KEY name (name)
);

-- Files attached to a configuration (payloads, installers, PoCs, etc.),
-- stored in MinIO under MINIO_BUCKET; object_key is the MinIO object name.
CREATE TABLE IF NOT EXISTS attachments (
    id               INT(11)      NOT NULL AUTO_INCREMENT,
    configuration_id INT(11)      NOT NULL,
    object_key       VARCHAR(512) NOT NULL,
    original_name    VARCHAR(255) NOT NULL,
    mime_type        VARCHAR(255) NULL,
    size_bytes       BIGINT       NOT NULL,
    uploaded_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY configuration_id (configuration_id),
    CONSTRAINT fk_attachments_configuration FOREIGN KEY (configuration_id)
        REFERENCES configurations (id) ON DELETE CASCADE
);
