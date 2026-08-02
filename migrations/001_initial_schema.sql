CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_name VARCHAR(120) NOT NULL,
  currency CHAR(3) NOT NULL,
  kind TEXT NOT NULL DEFAULT 'customer'
    CHECK (kind IN ('customer', 'system')),
  system_code TEXT UNIQUE,
  balance_minor BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT accounts_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT customer_balance_non_negative
    CHECK (kind = 'system' OR balance_minor >= 0),
  CONSTRAINT system_code_matches_kind CHECK (
    (kind = 'system' AND system_code IS NOT NULL)
    OR (kind = 'customer' AND system_code IS NULL)
  )
);

CREATE TABLE ledger_transactions (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL
    CHECK (kind IN ('opening_balance', 'transfer', 'hold_capture')),
  reference_id UUID NOT NULL,
  currency CHAR(3) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ledger_transactions_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ledger_transactions_reference_unique UNIQUE (kind, reference_id)
);

CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES ledger_transactions(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor <> 0),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT one_entry_per_account_per_transaction
    UNIQUE (transaction_id, account_id)
);

CREATE INDEX ledger_entries_account_statement_idx
  ON ledger_entries (account_id, created_at DESC, id DESC);

INSERT INTO accounts (id, owner_name, currency, kind, system_code)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Kipu Opening Balances', 'USD', 'system', 'opening_balances');

CREATE OR REPLACE FUNCTION reject_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only: % is forbidden', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER ledger_entries_immutable
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TRIGGER ledger_transactions_immutable
BEFORE UPDATE OR DELETE ON ledger_transactions
FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE OR REPLACE FUNCTION assert_ledger_transaction_balanced()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_transaction_id UUID;
  entry_count BIGINT;
  entry_sum NUMERIC;
  invalid_currency_count BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'ledger_transactions' THEN
    target_transaction_id := NEW.id;
  ELSE
    target_transaction_id := NEW.transaction_id;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(le.amount_minor::numeric), 0)
    INTO entry_count, entry_sum
  FROM ledger_entries le
  WHERE le.transaction_id = target_transaction_id;

  IF entry_count < 2 OR entry_sum <> 0 THEN
    RAISE EXCEPTION 'unbalanced ledger transaction %: entries=%, sum=%',
      target_transaction_id, entry_count, entry_sum
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT COUNT(*)
    INTO invalid_currency_count
  FROM ledger_entries le
  JOIN accounts a ON a.id = le.account_id
  JOIN ledger_transactions lt ON lt.id = le.transaction_id
  WHERE le.transaction_id = target_transaction_id
    AND a.currency <> lt.currency;

  IF invalid_currency_count <> 0 THEN
    RAISE EXCEPTION 'currency mismatch in ledger transaction %', target_transaction_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_transaction_has_balanced_entries
AFTER INSERT ON ledger_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();

CREATE CONSTRAINT TRIGGER ledger_entries_keep_transaction_balanced
AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();

CREATE OR REPLACE FUNCTION assert_account_matches_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_account_id UUID;
  materialized_balance BIGINT;
  ledger_balance NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'accounts' THEN
    target_account_id := NEW.id;
  ELSE
    target_account_id := NEW.account_id;
  END IF;

  SELECT a.balance_minor,
         COALESCE(SUM(le.amount_minor::numeric), 0)
    INTO materialized_balance, ledger_balance
  FROM accounts a
  LEFT JOIN ledger_entries le ON le.account_id = a.id
  WHERE a.id = target_account_id
  GROUP BY a.id, a.balance_minor;

  IF materialized_balance::numeric <> ledger_balance THEN
    RAISE EXCEPTION 'account % diverged: materialized=%, ledger=%',
      target_account_id, materialized_balance, ledger_balance
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER accounts_match_ledger_after_balance_change
AFTER INSERT OR UPDATE OF balance_minor ON accounts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_account_matches_ledger();

CREATE CONSTRAINT TRIGGER accounts_match_ledger_after_entry
AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_account_matches_ledger();
