import type { Pool } from 'pg';

export async function cleanDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      idempotency_keys,
      holds,
      ledger_entries,
      ledger_transactions
    RESTART IDENTITY CASCADE
  `);
  await pool.query("DELETE FROM accounts WHERE kind = 'customer'");
  await pool.query("UPDATE accounts SET balance_minor = 0 WHERE kind = 'system'");
}

export async function assertLedgerMatchesAccounts(
  pool: Pool,
  accountIds: readonly string[],
): Promise<void> {
  const result = await pool.query<{
    id: string;
    balance_minor: string;
    ledger_minor: string;
  }>(
    `SELECT
       a.id,
       a.balance_minor::text,
       COALESCE(SUM(le.amount_minor), 0)::text AS ledger_minor
     FROM accounts a
     LEFT JOIN ledger_entries le ON le.account_id = a.id
     WHERE a.id = ANY($1::uuid[])
     GROUP BY a.id, a.balance_minor
     ORDER BY a.id`,
    [accountIds],
  );
  if (result.rows.length !== accountIds.length) {
    throw new Error('One or more expected accounts are missing');
  }
  for (const row of result.rows) {
    if (row.balance_minor !== row.ledger_minor) {
      throw new Error(
        `Account ${row.id} diverged: ${row.balance_minor} != ${row.ledger_minor}`,
      );
    }
  }
}
