import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { closePool, getPool } from '../src/db/pool.js';
import { AppError } from '../src/lib/errors.js';
import { createAccount, getAccountBalance } from '../src/services/accounts.js';
import { createTransfer } from '../src/services/transfers.js';

process.env.DATABASE_URL ??= 'postgres://kipu:kipu@localhost:5432/kipu';
process.env.DB_POOL_MAX ??= '30';
process.env.KIPU_CURRENCY ??= 'USD';

type ScenarioAccount = {
  id: string;
  owner: string;
};

async function verifyInvariants(
  pool: Pool,
  accounts: readonly ScenarioAccount[],
  expectedTotalMinor: bigint,
): Promise<void> {
  const accountIds = accounts.map((account) => account.id);
  const result = await pool.query<{
    id: string;
    owner_name: string;
    balance_minor: string;
    ledger_minor: string;
  }>(
    `SELECT
       a.id,
       a.owner_name,
       a.balance_minor::text,
       COALESCE(SUM(le.amount_minor), 0)::text AS ledger_minor
     FROM accounts a
     LEFT JOIN ledger_entries le ON le.account_id = a.id
     WHERE a.id = ANY($1::uuid[])
     GROUP BY a.id, a.owner_name, a.balance_minor
     ORDER BY a.owner_name`,
    [accountIds],
  );

  assert.equal(result.rows.length, accounts.length, 'all scenario accounts must exist');
  let totalMinor = 0n;
  for (const row of result.rows) {
    const balanceMinor = BigInt(row.balance_minor);
    const ledgerMinor = BigInt(row.ledger_minor);
    assert(balanceMinor >= 0n, `${row.owner_name} has a negative balance`);
    assert.equal(
      balanceMinor,
      ledgerMinor,
      `${row.owner_name}: materialized balance differs from ledger`,
    );
    totalMinor += balanceMinor;
  }
  assert.equal(totalMinor, expectedTotalMinor, 'total customer money must be conserved');
}

async function main(): Promise<void> {
  await migrate();
  const pool = getPool();
  const runId = randomUUID();
  const created = await Promise.all(
    ['A', 'B', 'C', 'D'].map(async (label) => {
      const account = await createAccount(pool, {
        owner: `Stress ${runId} ${label}`,
        initialBalance: '1000.00',
      });
      return { id: account.id, owner: account.owner };
    }),
  );
  const [a, b, c, d] = created;
  assert(a !== undefined && b !== undefined && c !== undefined && d !== undefined);

  const transferSpecs = [
    ...Array.from({ length: 25 }, () => [a.id, b.id, '75.00'] as const),
    ...Array.from({ length: 25 }, () => [b.id, a.id, '70.00'] as const),
    ...Array.from({ length: 20 }, () => [c.id, d.id, '80.00'] as const),
    ...Array.from({ length: 20 }, () => [d.id, c.id, '70.00'] as const),
    ...Array.from({ length: 20 }, () => [a.id, c.id, '200.00'] as const),
  ];

  const startedAt = Date.now();
  const attempts = await Promise.allSettled(
    transferSpecs.map(([sourceAccountId, destinationAccountId, amount], index) =>
      createTransfer(pool, {
        sourceAccountId,
        destinationAccountId,
        amount,
        idempotencyKey: `stress-${runId}-${index}`,
      }),
    ),
  );

  const rejectedAttempts = attempts.filter(
    (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
  );
  for (const rejected of rejectedAttempts) {
    assert(rejected.reason instanceof AppError, 'unexpected technical transfer failure');
    assert.equal(
      rejected.reason.code,
      'INSUFFICIENT_FUNDS',
      'only insufficient funds may reject this scenario',
    );
  }

  const idempotencyKey = `stress-retry-${runId}`;
  const retries = await Promise.all(
    Array.from({ length: 20 }, () => createTransfer(pool, {
      sourceAccountId: c.id,
      destinationAccountId: d.id,
      amount: '1.00',
      idempotencyKey,
    })),
  );
  assert.equal(
    new Set(retries.map((retry) => retry.body.data.id)).size,
    1,
    'concurrent retries must create one transfer',
  );

  await verifyInvariants(pool, created, 400_000n);
  const finalBalances = await Promise.all(
    created.map(async (account) => {
      const result = await getAccountBalance(pool, account.id);
      return { owner: result.owner, accounting: result.balance.accounting };
    }),
  );
  const succeeded = attempts.filter((attempt) => attempt.status === 'fulfilled').length;
  process.stdout.write(`${JSON.stringify({
    event: 'stress.completed',
    runId,
    durationMs: Date.now() - startedAt,
    attemptedTransfers: attempts.length,
    succeeded,
    rejectedForInsufficientFunds: rejectedAttempts.length,
    concurrentIdempotentRetries: retries.length,
    invariants: {
      noNegativeBalances: true,
      totalMoneyConserved: true,
      materializedBalancesMatchLedger: true,
      idempotencyAppliedOnce: true,
    },
    finalBalances,
  }, null, 2)}\n`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
