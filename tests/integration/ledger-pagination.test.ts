import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { createAccount } from '../../src/services/accounts.js';
import { listLedgerEntries } from '../../src/services/ledger.js';
import { createTransfer } from '../../src/services/transfers.js';
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

describe('ledger keyset pagination', () => {
  it('orders newest first and exposes direction and counterparty', async () => {
    const source = await createAccount(pool, { owner: 'Source', initialBalance: '100.00' });
    const destination = await createAccount(pool, { owner: 'Destination', initialBalance: '0.00' });
    const transfer = await createTransfer(pool, {
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amount: '5.00',
      idempotencyKey: `statement-shape-${randomUUID()}`,
    });

    const page = await listLedgerEntries(pool, { accountId: source.id, limit: 20 });
    expect(page.data).toHaveLength(2);
    expect(page.data[0]).toMatchObject({
      transactionId: transfer.body.data.id,
      type: 'transfer',
      direction: 'debit',
      amount: '-5.00',
      counterpartyAccountId: destination.id,
    });
    expect(page.data[1]?.type).toBe('opening_balance');
    expect(page.page.nextCursor).toBeNull();
  });

  it('does not duplicate or skip old entries when a newer entry arrives between pages', async () => {
    const source = await createAccount(pool, { owner: 'Statement', initialBalance: '100.00' });
    const destination = await createAccount(pool, {
      owner: 'Counterparty',
      initialBalance: '100.00',
    });
    for (let index = 0; index < 3; index += 1) {
      await createTransfer(pool, {
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        amount: '1.00',
        idempotencyKey: `page-before-${index}-${randomUUID()}`,
      });
    }

    const firstPage = await listLedgerEntries(pool, { accountId: source.id, limit: 2 });
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.page.nextCursor).not.toBeNull();

    const insertedBetweenPages = await createTransfer(pool, {
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amount: '1.00',
      idempotencyKey: `page-between-${randomUUID()}`,
    });
    const secondPage = await listLedgerEntries(pool, {
      accountId: source.id,
      limit: 2,
      cursor: firstPage.page.nextCursor ?? '',
    });

    const returnedTransactionIds = [
      ...firstPage.data.map((entry) => entry.transactionId),
      ...secondPage.data.map((entry) => entry.transactionId),
    ];
    expect(new Set(returnedTransactionIds).size).toBe(returnedTransactionIds.length);
    expect(returnedTransactionIds).not.toContain(insertedBetweenPages.body.data.id);
    expect(secondPage.data).toHaveLength(2);
    expect(secondPage.page.nextCursor).toBeNull();
  });

  it('rejects malformed cursors and unknown accounts', async () => {
    const account = await createAccount(pool, { owner: 'Cursor', initialBalance: '1.00' });

    await expect(listLedgerEntries(pool, {
      accountId: account.id,
      limit: 20,
      cursor: 'invalid-cursor',
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_CURSOR' });
    await expect(listLedgerEntries(pool, {
      accountId: '00000000-0000-0000-0000-000000000099',
      limit: 20,
    })).rejects.toMatchObject({ statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });
  });
});
