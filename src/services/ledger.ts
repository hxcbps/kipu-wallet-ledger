import type { Pool } from 'pg';
import { decodeCursor, encodeCursor } from '../domain/cursor.js';
import { formatMinorAmount } from '../domain/money.js';
import { AppError } from '../lib/errors.js';

type LedgerEntryRow = {
  id: string;
  transaction_id: string;
  kind: 'opening_balance' | 'transfer' | 'hold_capture';
  amount_minor: string;
  created_at: Date;
  counterparty_account_id: string | null;
};

export type LedgerPage = {
  data: readonly {
    id: string;
    transactionId: string;
    type: LedgerEntryRow['kind'];
    direction: 'credit' | 'debit';
    amount: string;
    counterpartyAccountId: string | null;
    createdAt: string;
  }[];
  page: {
    nextCursor: string | null;
    limit: number;
  };
};

export async function listLedgerEntries(
  pool: Pool,
  input: { accountId: string; limit: number; cursor?: string },
): Promise<LedgerPage> {
  const account = await pool.query(
    `SELECT 1 FROM accounts WHERE id = $1 AND kind = 'customer'`,
    [input.accountId],
  );
  if (account.rowCount !== 1) {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'account was not found');
  }

  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  const result = await pool.query<LedgerEntryRow>(
    `SELECT
       le.id,
       le.transaction_id,
       lt.kind,
       le.amount_minor::text,
       le.created_at,
       (
         SELECT other.account_id
         FROM ledger_entries other
         WHERE other.transaction_id = le.transaction_id
           AND other.account_id <> le.account_id
         ORDER BY other.id
         LIMIT 1
       ) AS counterparty_account_id
     FROM ledger_entries le
     JOIN ledger_transactions lt ON lt.id = le.transaction_id
     WHERE le.account_id = $1
       AND (
         $2::timestamptz IS NULL
         OR (le.created_at, le.id) < ($2::timestamptz, $3::uuid)
       )
     ORDER BY le.created_at DESC, le.id DESC
     LIMIT $4`,
    [
      input.accountId,
      cursor?.createdAt ?? null,
      cursor?.entryId ?? null,
      input.limit + 1,
    ],
  );

  const hasMore = result.rows.length > input.limit;
  const pageRows = hasMore ? result.rows.slice(0, input.limit) : result.rows;
  const last = pageRows.at(-1);
  return {
    data: pageRows.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      type: row.kind,
      direction: BigInt(row.amount_minor) > 0n ? 'credit' : 'debit',
      amount: formatMinorAmount(row.amount_minor),
      counterpartyAccountId: row.counterparty_account_id,
      createdAt: row.created_at.toISOString(),
    })),
    page: {
      nextCursor: hasMore && last !== undefined
        ? encodeCursor({
            v: 1,
            createdAt: last.created_at.toISOString(),
            entryId: last.id,
          })
        : null,
      limit: input.limit,
    },
  };
}
