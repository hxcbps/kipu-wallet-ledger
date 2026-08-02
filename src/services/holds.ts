import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getConfig } from '../config/env.js';
import { withTransaction } from '../db/transaction.js';
import { formatMinorAmount, parseAmountToMinor } from '../domain/money.js';
import { AppError } from '../lib/errors.js';

const CAPTURED_FUNDS_ACCOUNT_ID = '00000000-0000-0000-0000-000000000002';

type AccountRow = {
  id: string;
  currency: string;
  balance_minor: string;
};

type HoldRow = {
  id: string;
  account_id: string;
  amount_minor: string;
  status: 'active' | 'captured' | 'released' | 'expired';
  expires_at: Date;
  capture_transaction_id: string | null;
  created_at: Date;
  updated_at: Date;
  is_expired: boolean;
};

export type HoldRepresentation = {
  id: string;
  accountId: string;
  amount: string;
  currency: string;
  status: 'active' | 'captured' | 'released' | 'expired';
  expiresAt: string;
  captureTransactionId: string | null;
  createdAt: string;
  updatedAt: string;
};

function representHold(row: HoldRow, currency: string): HoldRepresentation {
  const effectiveStatus = row.status === 'active' && row.is_expired
    ? 'expired'
    : row.status;
  return {
    id: row.id,
    accountId: row.account_id,
    amount: formatMinorAmount(row.amount_minor),
    currency,
    status: effectiveStatus,
    expiresAt: row.expires_at.toISOString(),
    captureTransactionId: row.capture_transaction_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function getHeldMinor(client: PoolClient, accountId: string): Promise<bigint> {
  const result = await client.query<{ held_minor: string }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS held_minor
     FROM holds
     WHERE account_id = $1
       AND status = 'active'
       AND expires_at > clock_timestamp()`,
    [accountId],
  );
  return BigInt(result.rows[0]?.held_minor ?? '0');
}

export async function createHold(
  pool: Pool,
  input: { accountId: string; amount: string; expiresAt: string },
): Promise<HoldRepresentation> {
  const amountMinor = parseAmountToMinor(input.amount);
  const currency = getConfig().currency;
  const holdId = randomUUID();

  const row = await withTransaction(pool, async (client) => {
    const accountResult = await client.query<AccountRow>(
      `SELECT id, currency, balance_minor::text
       FROM accounts
       WHERE id = $1 AND kind = 'customer'
       FOR UPDATE`,
      [input.accountId],
    );
    const account = accountResult.rows[0];
    if (account === undefined) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'account was not found');
    }
    if (account.currency !== currency) {
      throw new AppError(422, 'CURRENCY_MISMATCH', 'account must use the system currency');
    }

    const heldMinor = await getHeldMinor(client, account.id);
    if (BigInt(account.balance_minor) - heldMinor < amountMinor) {
      throw new AppError(
        409,
        'INSUFFICIENT_FUNDS',
        'account has insufficient available funds',
      );
    }

    const insertResult = await client.query<HoldRow>(
      `INSERT INTO holds (id, account_id, amount_minor, expires_at)
       SELECT $1, $2, $3, $4::timestamptz
       WHERE $4::timestamptz > clock_timestamp()
       RETURNING *, expires_at <= clock_timestamp() AS is_expired`,
      [holdId, account.id, amountMinor.toString(), input.expiresAt],
    );
    const inserted = insertResult.rows[0];
    if (inserted === undefined) {
      throw new AppError(422, 'INVALID_EXPIRATION', 'expiresAt must be in the future');
    }
    return inserted;
  });
  return representHold(row, currency);
}

async function probeHoldAccount(client: PoolClient, holdId: string): Promise<string> {
  const result = await client.query<{ account_id: string }>(
    'SELECT account_id FROM holds WHERE id = $1',
    [holdId],
  );
  const accountId = result.rows[0]?.account_id;
  if (accountId === undefined) {
    throw new AppError(404, 'HOLD_NOT_FOUND', 'hold was not found');
  }
  return accountId;
}

async function lockHold(client: PoolClient, holdId: string): Promise<HoldRow> {
  const result = await client.query<HoldRow>(
    `SELECT *, expires_at <= clock_timestamp() AS is_expired
     FROM holds
     WHERE id = $1
     FOR UPDATE`,
    [holdId],
  );
  const hold = result.rows[0];
  if (hold === undefined) {
    throw new AppError(404, 'HOLD_NOT_FOUND', 'hold was not found');
  }
  return hold;
}

type CaptureOutcome =
  | { kind: 'captured'; hold: HoldRow }
  | { kind: 'expired'; hold: HoldRow };

export async function captureHold(
  pool: Pool,
  holdId: string,
): Promise<HoldRepresentation> {
  const currency = getConfig().currency;
  const outcome = await withTransaction<CaptureOutcome>(pool, async (client) => {
    const accountId = await probeHoldAccount(client, holdId);
    const lockedAccounts = await client.query<AccountRow>(
      `SELECT id, currency, balance_minor::text
       FROM accounts
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [[accountId, CAPTURED_FUNDS_ACCOUNT_ID]],
    );
    if (lockedAccounts.rowCount !== 2) {
      throw new Error('Customer or captured-funds system account is missing');
    }

    const hold = await lockHold(client, holdId);
    if (hold.account_id !== accountId) {
      throw new Error('Hold account changed unexpectedly');
    }
    if (hold.status === 'captured') {
      return { kind: 'captured', hold };
    }
    if (hold.status === 'released' || hold.status === 'expired') {
      throw new AppError(409, 'HOLD_NOT_ACTIVE', `hold is already ${hold.status}`);
    }
    if (hold.is_expired) {
      const expiredResult = await client.query<HoldRow>(
        `UPDATE holds
         SET status = 'expired', updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING *, true AS is_expired`,
        [hold.id],
      );
      const expired = expiredResult.rows[0];
      if (expired === undefined) {
        throw new Error('Failed to expire hold');
      }
      return { kind: 'expired', hold: expired };
    }

    const customer = lockedAccounts.rows.find((account) => account.id === accountId);
    if (customer?.currency !== currency) {
      throw new AppError(422, 'CURRENCY_MISMATCH', 'account must use the system currency');
    }
    if (BigInt(customer.balance_minor) < BigInt(hold.amount_minor)) {
      throw new Error('Active hold exceeds accounting balance');
    }

    const transactionId = randomUUID();
    const transactionResult = await client.query<{ created_at: Date }>(
      `INSERT INTO ledger_transactions
         (id, kind, reference_id, currency, metadata)
       VALUES ($1, 'hold_capture', $2, $3, $4::jsonb)
       RETURNING created_at`,
      [transactionId, hold.id, currency, JSON.stringify({ holdId: hold.id })],
    );
    const createdAt = transactionResult.rows[0]?.created_at;
    if (createdAt === undefined) {
      throw new Error('Failed to create hold-capture ledger transaction');
    }

    await client.query(
      `INSERT INTO ledger_entries
         (transaction_id, account_id, amount_minor, created_at)
       VALUES
         ($1, $2, -$4::bigint, $5),
         ($1, $3, $4::bigint, $5)`,
      [transactionId, accountId, CAPTURED_FUNDS_ACCOUNT_ID, hold.amount_minor, createdAt],
    );
    await client.query(
      `UPDATE accounts
       SET balance_minor = balance_minor + CASE
         WHEN id = $1 THEN -$3::bigint
         ELSE $3::bigint
       END
       WHERE id IN ($1, $2)`,
      [accountId, CAPTURED_FUNDS_ACCOUNT_ID, hold.amount_minor],
    );
    const capturedResult = await client.query<HoldRow>(
      `UPDATE holds
       SET status = 'captured',
           capture_transaction_id = $2,
           updated_at = clock_timestamp()
       WHERE id = $1
       RETURNING *, false AS is_expired`,
      [hold.id, transactionId],
    );
    const captured = capturedResult.rows[0];
    if (captured === undefined) {
      throw new Error('Failed to capture hold');
    }
    return { kind: 'captured', hold: captured };
  });

  if (outcome.kind === 'expired') {
    throw new AppError(409, 'HOLD_EXPIRED', 'expired holds cannot be captured');
  }
  return representHold(outcome.hold, currency);
}

export async function releaseHold(
  pool: Pool,
  holdId: string,
): Promise<HoldRepresentation> {
  const currency = getConfig().currency;
  const row = await withTransaction(pool, async (client) => {
    const accountId = await probeHoldAccount(client, holdId);
    const accountResult = await client.query(
      `SELECT id FROM accounts WHERE id = $1 AND kind = 'customer' FOR UPDATE`,
      [accountId],
    );
    if (accountResult.rowCount !== 1) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'account was not found');
    }
    const hold = await lockHold(client, holdId);
    if (hold.status === 'captured') {
      throw new AppError(409, 'HOLD_ALREADY_CAPTURED', 'captured holds cannot be released');
    }
    if (hold.status === 'released' || hold.status === 'expired') {
      return hold;
    }

    const nextStatus = hold.is_expired ? 'expired' : 'released';
    const updateResult = await client.query<HoldRow>(
      `UPDATE holds
       SET status = $2, updated_at = clock_timestamp()
       WHERE id = $1
       RETURNING *, expires_at <= clock_timestamp() AS is_expired`,
      [hold.id, nextStatus],
    );
    const updated = updateResult.rows[0];
    if (updated === undefined) {
      throw new Error('Failed to release hold');
    }
    return updated;
  });
  return representHold(row, currency);
}
