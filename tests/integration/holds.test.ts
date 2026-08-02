import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { createAccount, getAccountBalance } from '../../src/services/accounts.js';
import { captureHold, createHold, releaseHold } from '../../src/services/holds.js';
import { createTransfer } from '../../src/services/transfers.js';
import { assertLedgerMatchesAccounts, cleanDatabase } from './database.js';

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

describe('holds', () => {
  it('reserves available funds without changing accounting balance, then releases them', async () => {
    const account = await createAccount(pool, { owner: 'Holder', initialBalance: '100.00' });
    const hold = await createHold(pool, {
      accountId: account.id,
      amount: '30.00',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect((await getAccountBalance(pool, account.id)).balance).toEqual({
      accounting: '100.00',
      available: '70.00',
      held: '30.00',
    });

    const released = await releaseHold(pool, hold.id);
    expect(released.status).toBe('released');
    expect((await getAccountBalance(pool, account.id)).balance).toEqual({
      accounting: '100.00',
      available: '100.00',
      held: '0.00',
    });
    await assertLedgerMatchesAccounts(pool, [account.id]);
  });

  it('prevents transfers from spending retained funds', async () => {
    const source = await createAccount(pool, { owner: 'Reserved', initialBalance: '100.00' });
    const destination = await createAccount(pool, { owner: 'Destination', initialBalance: '0.00' });
    await createHold(pool, {
      accountId: source.id,
      amount: '80.00',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(createTransfer(pool, {
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amount: '20.01',
      idempotencyKey: 'held-funds-cannot-be-spent',
    })).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_FUNDS' });
  });

  it('serializes concurrent holds competing for the same available balance', async () => {
    const account = await createAccount(pool, {
      owner: 'Concurrent holds',
      initialBalance: '100.00',
    });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const attempts = await Promise.allSettled(
      Array.from({ length: 15 }, () => createHold(pool, {
        accountId: account.id,
        amount: '10.00',
        expiresAt,
      })),
    );

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(10);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(5);
    expect((await getAccountBalance(pool, account.id)).balance).toEqual({
      accounting: '100.00',
      available: '0.00',
      held: '100.00',
    });
  });

  it('rejects expirations that are not in the future', async () => {
    const account = await createAccount(pool, { owner: 'Past expiry', initialBalance: '10.00' });

    await expect(createHold(pool, {
      accountId: account.id,
      amount: '1.00',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })).rejects.toMatchObject({ statusCode: 422, code: 'INVALID_EXPIRATION' });
  });

  it('captures only once and writes the outgoing money to the ledger', async () => {
    const account = await createAccount(pool, { owner: 'Capture', initialBalance: '100.00' });
    const hold = await createHold(pool, {
      accountId: account.id,
      amount: '20.00',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const firstCapture = await captureHold(pool, hold.id);
    const replayedCapture = await captureHold(pool, hold.id);
    expect(replayedCapture.captureTransactionId).toBe(firstCapture.captureTransactionId);
    expect((await getAccountBalance(pool, account.id)).balance).toEqual({
      accounting: '80.00',
      available: '80.00',
      held: '0.00',
    });
    const captureCount = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ledger_transactions WHERE kind = 'hold_capture'",
    );
    expect(captureCount.rows[0]?.count).toBe('1');
    await assertLedgerMatchesAccounts(pool, [account.id]);
  });

  it('returns expired funds to availability and rejects capture', async () => {
    const account = await createAccount(pool, { owner: 'Expired', initialBalance: '100.00' });
    const hold = await createHold(pool, {
      accountId: account.id,
      amount: '30.00',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await pool.query(
      `UPDATE holds SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [hold.id],
    );

    await expect(captureHold(pool, hold.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'HOLD_EXPIRED',
    });
    expect((await getAccountBalance(pool, account.id)).balance).toEqual({
      accounting: '100.00',
      available: '100.00',
      held: '0.00',
    });
  });

  it('allows exactly one winner when capture and release race', async () => {
    const account = await createAccount(pool, { owner: 'Race', initialBalance: '50.00' });
    const hold = await createHold(pool, {
      accountId: account.id,
      amount: '20.00',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const actions = await Promise.allSettled([
      captureHold(pool, hold.id),
      releaseHold(pool, hold.id),
    ]);
    expect(actions.filter((action) => action.status === 'fulfilled')).toHaveLength(1);
    expect(actions.filter((action) => action.status === 'rejected')).toHaveLength(1);
    await assertLedgerMatchesAccounts(pool, [account.id]);
  });
});
