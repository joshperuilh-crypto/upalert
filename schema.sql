-- UpAlert D1 Database Schema
-- SQLite-compatible schema for Cloudflare D1

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free', -- 'free', 'pro', 'business'
  resend_api_key TEXT,
  slack_webhook_url TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Sessions table (JWT-less simple token auth)
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Monitors table
CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  check_interval INTEGER NOT NULL DEFAULT 5, -- minutes: 5 (free) or 1 (pro/business)
  is_active INTEGER NOT NULL DEFAULT 1,
  alert_email INTEGER NOT NULL DEFAULT 1,
  alert_slack INTEGER NOT NULL DEFAULT 0,
  last_status TEXT, -- 'up', 'down', NULL (never checked)
  last_checked_at INTEGER,
  last_response_time INTEGER, -- milliseconds
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Checks table (history of each ping)
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  status TEXT NOT NULL, -- 'up', 'down'
  response_time INTEGER, -- milliseconds, NULL if down
  status_code INTEGER, -- HTTP status code, NULL if connection failed
  error_message TEXT, -- error details if down
  checked_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Incidents table (tracks outages)
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  duration INTEGER, -- seconds, filled when resolved
  root_cause TEXT,
  is_acknowledged INTEGER NOT NULL DEFAULT 0
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_monitors_user_id ON monitors(user_id);
CREATE INDEX IF NOT EXISTS idx_checks_monitor_id ON checks(monitor_id);
CREATE INDEX IF NOT EXISTS idx_checks_checked_at ON checks(checked_at);
CREATE INDEX IF NOT EXISTS idx_incidents_monitor_id ON incidents(monitor_id);
