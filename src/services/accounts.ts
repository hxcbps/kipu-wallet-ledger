import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { getConfig } from '../config/env.js';
import { withTransaction } from '../db/transaction.js';
import { formatMinorAmount, parseAmountToMinor } from '../domain/money.js';
import { AppError } from '../lib/errors.js';

const OPENING_BALANCES_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';

type AccountBalanceRow = {
  id: string;
  owner_name: string;
  currency: string;
  balance_minor: string;
  held_minor: string;
  created_at: Date;
};

export type AccountRepresentation = {
  id: string;
  owner: string;
  currency: string;
  balance: {
    accounting: string;
    available: string;
    held: string;
  };
  createdAt: string;
};

function representAccount(row: AccountBalanceRow): AccountRepresentation {
  const accounting = BigInt(row.balance_minor);
  const held = BigInt(row.held_minor);
  return {
    id: row.id,
    owner: row.owner_name,
    currency: row.currency,
    balance: {
      accounting: formatMinorAmount(accounting),
      available: formatMinorAmount(accounting - held),
      held: formatMinorAmount(held),
    },
    createdAt: row.created_at.toISOString(),
  };
}

export async function createAccount(
  pool: Pool,
  input: { owner: string; initialBalance: string },
): Promise<AccountRepresentation> {
  const initialMinor = parseAmountToMinor(input.initialBalance, true);
  const accountId = randomUUID();
  const currency = getConfig().currency;

  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO accounts (id, owner_name, currency, kind, balance_minor)
       VALUES ($1, $2, $3, 'customer', 0)`,
      [accountId, input.owner, currency],
    );

    if (initialMinor === 0n) {
      return;
    }

    const systemAccount = await client.query<{ id: string }>(
      `SELECT id FROM accounts
       WHERE id = $1 AND kind = 'system' AND currency = $2
       FOR UPDATE`,
      [OPENING_BALANCES_ACCOUNT_ID, currency],
    );
    if (systemAccount.rowCount !== 1) {
      throw new Error(`Opening-balance system account is missing for ${currency}`);
    }

    const transactionId = randomUUID();
    const transaction = await client.query<{ created_at: Date }>(
      `INSERT INTO ledger_transactions
         (id, kind, reference_id, currency, metadata)
       VALUES ($1, 'opening_balance', $2, $3, $4::jsonb)
       RETURNING created_at`,
      [transactionId, accountId, currency, JSON.stringify({ accountId })],
    );
    const createdAt = transaction.rows[0]?.created_at;
    if (createdAt === undefined) {
      throw new Error('Failed to create opening-balance ledger transaction');
    }

    await client.query(
      `INSERT INTO ledger_entries
         (transaction_id, account_id, amount_minor, created_at)
       VALUES
         ($1, $2, $4::bigint, $5),
         ($1, $3, -$4::bigint, $5)`,
      [
        transactionId,
        accountId,
        OPENING_BALANCES_ACCOUNT_ID,
        initialMinor.toString(),
        createdAt,
      ],
    );
    await client.query(
      `UPDATE accounts
       SET balance_minor = balance_minor + CASE
         WHEN id = $1 THEN $3::bigint
         ELSE -$3::bigint
       END
       WHERE id IN ($1, $2)`,
      [accountId, OPENING_BALANCES_ACCOUNT_ID, initialMinor.toString()],
    );
  });

  return getAccountBalance(pool, accountId);
}

export async function getAccountBalance(
  pool: Pool,
  accountId: string,
): Promise<AccountRepresentation> {
  const result = await pool.query<AccountBalanceRow>(
    `SELECT
       a.id,
       a.owner_name,
       a.currency,
       a.balance_minor::text,
       a.created_at,
       COALESCE((
         SELECT SUM(h.amount_minor)
         FROM holds h
         WHERE h.account_id = a.id
           AND h.status = 'active'
           AND h.expires_at > clock_timestamp()
       ), 0)::text AS held_minor
     FROM accounts a
     WHERE a.id = $1 AND a.kind = 'customer'`,
    [accountId],
  );
  const account = result.rows[0];
  if (account === undefined) {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'account was not found');
  }
  return representAccount(account);
}
