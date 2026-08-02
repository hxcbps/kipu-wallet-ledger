import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { createAccount } from '../../src/services/accounts.js';
import { cleanDatabase } from './database.js';

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

describe('database accounting constraints', () => {
  it('rejects an unbalanced ledger transaction at commit', async () => {
    const account = await createAccount(pool, { owner: 'Integrity', initialBalance: '0.00' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const transactionId = randomUUID();
      await client.query(
        `INSERT INTO ledger_transactions (id, kind, reference_id, currency)
         VALUES ($1, 'transfer', $1, 'USD')`,
        [transactionId],
      );
      await client.query(
        `INSERT INTO ledger_entries
           (transaction_id, account_id, amount_minor, created_at)
         VALUES ($1, $2, 100, clock_timestamp())`,
        [transactionId, account.id],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/unbalanced ledger transaction/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects a materialized balance change without matching ledger entries', async () => {
    const account = await createAccount(pool, { owner: 'Integrity', initialBalance: '10.00' });
    await expect(
      pool.query('UPDATE accounts SET balance_minor = 9999 WHERE id = $1', [account.id]),
    ).rejects.toThrow(/diverged/);
  });

  it('rejects updates and deletes to ledger rows', async () => {
    const account = await createAccount(pool, { owner: 'Immutable', initialBalance: '10.00' });
    await expect(
      pool.query(
        'UPDATE ledger_entries SET amount_minor = 1 WHERE account_id = $1',
        [account.id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('DELETE FROM ledger_entries WHERE account_id = $1', [account.id]),
    ).rejects.toThrow(/append-only/);
  });
});
