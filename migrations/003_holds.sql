CREATE TABLE holds (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'captured', 'released', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  capture_transaction_id UUID UNIQUE REFERENCES ledger_transactions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT capture_state_consistent CHECK (
    (status = 'captured' AND capture_transaction_id IS NOT NULL)
    OR (status <> 'captured' AND capture_transaction_id IS NULL)
  )
);

CREATE INDEX holds_active_by_account_idx
  ON holds (account_id, expires_at)
  WHERE status = 'active';

INSERT INTO accounts (id, owner_name, currency, kind, system_code)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  'Kipu Captured Funds',
  'USD',
  'system',
  'captured_funds'
);
