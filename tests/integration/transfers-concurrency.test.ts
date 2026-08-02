import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { AppError } from '../../src/lib/errors.js';
import { createAccount, getAccountBalance } from '../../src/services/accounts.js';
import { createTransfer } from '../../src/services/transfers.js';
import { assertLedgerMatchesAccounts, cleanDatabase } from './database.js';

process.env.DATABASE_URL ??= 'postgres://kipu:kipu@localhost:5432/kipu_test';
process.env.DB_POOL_MAX = '30';
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

describe('transfer idempotency', () => {
  it('moves the money once and replays the original response', async () => {
    const source = await createAccount(pool, { owner: 'Source', initialBalance: '100.00' });
    const destination = await createAccount(pool, { owner: 'Destination', initialBalance: '0.00' });
    const idempotencyKey = `retry-${randomUUID()}`;

    const first = await createTransfer(pool, {
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amount: '25.00',
      idempotencyKey,
    });
    const replay = await createTransfer(pool, {
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amount: '25.00',
      idempotencyKey,
    });

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(first.body);
    expect((await getAccountBalance(pool, source.id)).balance.accounting).toBe('75.00');
    expect((await getAccountBalance(pool, destination.id)).balance.accounting).toBe('25.00');
  });

  it('rejects reusing the key with a different payload', async () => {
    const source = await createAccount(pool, { owner: 'Source', initialBalance: '100.00' });
    const destination = await createAccount(pool, { owner: 'Destination', initialBalance: '0.00' });
    const idempotencyKey = `conflict-${randomUUID()}`;
    await createTransfer(pool, {
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amount: '10.00',
      idempotencyKey,
    });

    await expect(createTransfer(pool, {
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amount: '11.00',
      idempotencyKey,
    })).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('rejects a transfer to the same account without creating ledger entries', async () => {
    const account = await createAccount(pool, { owner: 'Same account', initialBalance: '50.00' });

    await expect(createTransfer(pool, {
      sourceAccountId: account.id.toUpperCase(),
      destinationAccountId: account.id,
      amount: '10.00',
      idempotencyKey: `same-account-${randomUUID()}`,
    })).rejects.toMatchObject({ statusCode: 422, code: 'SAME_ACCOUNT_TRANSFER' });

    const transferCount = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ledger_transactions WHERE kind = 'transfer'",
    );
    expect(transferCount.rows[0]?.count).toBe('0');
    expect((await getAccountBalance(pool, account.id)).balance.accounting).toBe('50.00');
  });
});

describe('real PostgreSQL transfer concurrency', () => {
  it('never overdraws when many requests compete for the same funds', async () => {
    const source = await createAccount(pool, {
      owner: 'Concurrent source',
      initialBalance: '100.00',
    });
    const destination = await createAccount(pool, {
      owner: 'Concurrent destination',
      initialBalance: '0.00',
    });

    const attempts = await Promise.allSettled(
      Array.from({ length: 25 }, (_, index) => createTransfer(pool, {
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        amount: '10.00',
        idempotencyKey: `competing-${index}-${randomUUID()}`,
      })),
    );

    const succeeded = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    expect(succeeded).toHaveLength(10);
    expect(rejected).toHaveLength(15);
    for (const attempt of rejected) {
      expect(attempt.reason).toBeInstanceOf(AppError);
      expect((attempt.reason as AppError).code).toBe('INSUFFICIENT_FUNDS');
    }

    expect((await getAccountBalance(pool, source.id)).balance.accounting).toBe('0.00');
    expect((await getAccountBalance(pool, destination.id)).balance.accounting).toBe('100.00');
    const transferCount = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ledger_transactions WHERE kind = 'transfer'",
    );
    expect(transferCount.rows[0]?.count).toBe('10');
    await assertLedgerMatchesAccounts(pool, [source.id, destination.id]);
  });

  it('avoids deadlocks for crossed transfers and serializes concurrent retries', async () => {
    const left = await createAccount(pool, { owner: 'Left', initialBalance: '200.00' });
    const right = await createAccount(pool, { owner: 'Right', initialBalance: '200.00' });

    const crossed = Array.from({ length: 40 }, (_, index) => {
      const even = index % 2 === 0;
      return createTransfer(pool, {
        sourceAccountId: even ? left.id : right.id,
        destinationAccountId: even ? right.id : left.id,
        amount: '1.00',
        idempotencyKey: `crossed-${index}-${randomUUID()}`,
      });
    });
    await expect(Promise.all(crossed)).resolves.toHaveLength(40);

    const sharedKey = `same-request-${randomUUID()}`;
    const retries = await Promise.all(
      Array.from({ length: 20 }, () => createTransfer(pool, {
        sourceAccountId: left.id,
        destinationAccountId: right.id,
        amount: '5.00',
        idempotencyKey: sharedKey,
      })),
    );
    expect(new Set(retries.map((result) => result.body.data.id)).size).toBe(1);
    expect(retries.map((result) => result.body)).toEqual(
      Array.from({ length: 20 }, () => retries[0]?.body),
    );

    expect((await getAccountBalance(pool, left.id)).balance.accounting).toBe('195.00');
    expect((await getAccountBalance(pool, right.id)).balance.accounting).toBe('205.00');
    const transferCount = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ledger_transactions WHERE kind = 'transfer'",
    );
    expect(transferCount.rows[0]?.count).toBe('41');
    await assertLedgerMatchesAccounts(pool, [left.id, right.id]);
  });
});
