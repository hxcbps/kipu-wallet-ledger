import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { createAccount, getAccountBalance } from '../../src/services/accounts.js';
import { cleanDatabase } from './database.js';

process.env.DATABASE_URL ??= 'postgres://kipu:kipu@localhost:5432/kipu_test';
process.env.KIPU_CURRENCY = 'USD';
process.env.LOG_LEVEL = 'error';

let pool: Pool;

beforeAll(async () => {
  await migrate();
  pool = getPool();
});

beforeEach(async () => {
  await cleanDatabase(pool);
});

afterAll(async () => {
  await closePool();
});

describe('accounts', () => {
  it('creates a zero-balance account without ledger entries', async () => {
    const account = await createAccount(pool, {
      owner: 'Dayan Fernandez',
      initialBalance: '0.00',
    });

    expect(account.balance).toEqual({
      accounting: '0.00',
      available: '0.00',
      held: '0.00',
    });
    const ledgerCount = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM ledger_entries WHERE account_id = $1',
      [account.id],
    );
    expect(ledgerCount.rows[0]?.count).toBe('0');
  });

  it('records an opening balance as an immutable balanced transaction', async () => {
    const account = await createAccount(pool, {
      owner: 'Cuenta inicial',
      initialBalance: '125.50',
    });

    expect((await getAccountBalance(pool, account.id)).balance).toEqual({
      accounting: '125.50',
      available: '125.50',
      held: '0.00',
    });
    const ledger = await pool.query<{ entries: string; total: string }>(
      `SELECT COUNT(*)::text AS entries, SUM(amount_minor)::text AS total
       FROM ledger_entries
       WHERE transaction_id = (
         SELECT id FROM ledger_transactions
         WHERE kind = 'opening_balance' AND reference_id = $1
       )`,
      [account.id],
    );
    expect(ledger.rows[0]).toEqual({ entries: '2', total: '0' });
  });

  it('returns a domain error when the account does not exist', async () => {
    await expect(
      getAccountBalance(pool, '00000000-0000-0000-0000-000000000099'),
    ).rejects.toMatchObject({ statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });
  });
});
