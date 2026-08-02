CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  resource_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, key),
  CONSTRAINT idempotency_response_complete CHECK (
    (response_status IS NULL AND response_body IS NULL AND resource_id IS NULL)
    OR (response_status IS NOT NULL AND response_body IS NOT NULL AND resource_id IS NOT NULL)
  )
);
