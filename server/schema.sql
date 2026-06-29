-- Pop-Up — database schema
-- Run automatically by `npm run migrate`, or manually: psql "$DATABASE_URL" -f schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- provides gen_random_uuid()

-- One shared workspace. A single row (id = 1) holds the entire Pop-Up dataset
-- as JSON — the same shape the frontend's exportData() produces, but WITHOUT
-- document blobs: files/activities keep only their metadata plus the R2 storage
-- key. This is safe under the "single editor" model, no per-record conflicts.
CREATE TABLE IF NOT EXISTS workspace (
  id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure the singleton row exists so PUT can always upsert id = 1.
INSERT INTO workspace (id, state) VALUES (1, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

-- Metadata for uploaded documents. The bytes live in Cloudflare R2 under
-- `storage_key`; only metadata is kept here. `status` is 'pending' until the
-- browser confirms the direct-to-R2 upload finished.
CREATE TABLE IF NOT EXISTS documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename      TEXT NOT NULL,
  content_type  TEXT,
  size          BIGINT,
  storage_key   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | ready
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
