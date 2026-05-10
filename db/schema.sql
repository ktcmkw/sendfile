-- SendFile PostgreSQL Schema
-- Run once on fresh database (auto-run by db.js on first start)

CREATE TABLE IF NOT EXISTS users (
  username      VARCHAR(50) PRIMARY KEY,
  full_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(100),
  department    VARCHAR(100),
  location      VARCHAR(100),
  role_id       VARCHAR(50) DEFAULT 'user',
  password_hash VARCHAR(255) NOT NULL,
  passkey_hash  VARCHAR(255),
  created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
);

CREATE TABLE IF NOT EXISTS documents (
  id                  VARCHAR(50) PRIMARY KEY,
  title               VARCHAR(200) NOT NULL,
  content_type        VARCHAR(20),
  content             JSONB,
  sender_username     VARCHAR(50),
  sender_full_name    VARCHAR(100),
  sender_department   VARCHAR(100),
  sender_location     VARCHAR(100),
  recipient_type      VARCHAR(20),
  recipient_username  VARCHAR(50),
  recipient_department VARCHAR(100),
  recipient_full_name VARCHAR(100),
  priority            VARCHAR(20) DEFAULT 'normal',
  attachment_note     TEXT,
  attachments         JSONB DEFAULT '[]',
  comments            JSONB DEFAULT '[]',
  drive_id            VARCHAR(200),
  drive_url           TEXT,
  created_at          BIGINT,
  status              VARCHAR(20) DEFAULT 'pending',
  received_at         BIGINT,
  received_by         VARCHAR(100),
  storage_location    VARCHAR(100),
  qr_url              TEXT
);

CREATE TABLE IF NOT EXISTS roles (
  id          VARCHAR(50) PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  is_default  BOOLEAN DEFAULT FALSE,
  permissions JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS notifications (
  id            VARCHAR(50) PRIMARY KEY,
  type          VARCHAR(30) NOT NULL,
  to_username   VARCHAR(50),
  from_username VARCHAR(50),
  from_full_name VARCHAR(100),
  message       TEXT,
  doc_id        VARCHAR(50),
  doc_title     VARCHAR(200),
  created_at    BIGINT,
  read          BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS locations (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS settings (
  key   VARCHAR(50) PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  action     VARCHAR(60) NOT NULL,
  username   VARCHAR(50),
  target_id  VARCHAR(100),
  details    JSONB,
  ip         VARCHAR(60),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default roles
INSERT INTO roles (id, name, is_default, permissions) VALUES
  ('user',  'User',  TRUE, '{"can_send":true,"can_receive":true,"can_view_all":false,"can_manage_users":false,"can_export":false,"can_admin":false,"can_preview_docs":false}'),
  ('admin', 'Admin', TRUE, '{"can_send":true,"can_receive":true,"can_view_all":true,"can_manage_users":true,"can_export":true,"can_admin":true,"can_preview_docs":true}')
ON CONFLICT (id) DO NOTHING;

-- Default settings
INSERT INTO settings (key, value) VALUES
  ('gdrive', '{"enabled":false,"clientId":"","folderId":""}')
ON CONFLICT (key) DO NOTHING;
