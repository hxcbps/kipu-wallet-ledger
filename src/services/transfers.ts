import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { getConfig } from '../config/env.js';
import { withTransaction } from '../db/transaction.js';
import { formatMinorAmount, parseAmountToMinor } from '../domain/money.js';
import { AppError } from '../lib/errors.js';

type LockedAccountRow = {
  id: string;
  currency: string;
  balance_minor: string;
};

const transferResponseSchema = z.object({
  data: z.object({
    id: z.uuid(),
    type: z.literal('transfer'),
    sourceAccountId: z.uuid(),
    destinationAccountId: z.uuid(),
    amount: z.string(),
    currency: z.string(),
    createdAt: z.string(),
  }).strict(),
}).strict();

export type TransferResponseBody = z.infer<typeof transferResponseSchema>;

export type TransferResult = {
  statusCode: number;
  body: TransferResponseBody;
  replayed: boolean;
};

type IdempotencyRow = {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
};

function hashTransferRequest(
  sourceAccountId: string,
  destinationAccountId: string,
  amountMinor: bigint,
): string {
  return createHash('sha256')
    .update(`v1\n${sourceAccountId}\n${destinationAccountId}\n${amountMinor}`)
    .digest('hex');
}

async function heldAmount(client: PoolClient, accountId: string): Promise<bigint> {
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

export async function createTransfer(
  pool: Pool,
  input: {
    sourceAccountId: string;
    destinationAccountId: string;
    amount: string;
    idempotencyKey: string;
  },
): Promise<TransferResult> {
  const sourceAccountId = input.sourceAccountId.toLowerCase();
  const destinationAccountId = input.destinationAccountId.toLowerCase();

  if (sourceAccountId === destinationAccountId) {
    throw new AppError(
      422,
      'SAME_ACCOUNT_TRANSFER',
      'source and destination accounts must be different',
    );
  }

  const amountMinor = parseAmountToMinor(input.amount);
  const requestHash = hashTransferRequest(
    sourceAccountId,
    destinationAccountId,
    amountMinor,
  );
  const currency = getConfig().currency;

  return withTransaction(pool, async (client) => {
    const reservation = await client.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash)
       VALUES ('transfer', $1, $2)
       ON CONFLICT DO NOTHING
       RETURNING key`,
      [input.idempotencyKey, requestHash],
    );

    if (reservation.rowCount === 0) {
      const existingResult = await client.query<IdempotencyRow>(
        `SELECT request_hash, response_status, response_body
         FROM idempotency_keys
         WHERE scope = 'transfer' AND key = $1
         FOR UPDATE`,
        [input.idempotencyKey],
      );
      const existing = existingResult.rows[0];
      if (existing === undefined) {
        throw new Error('Idempotency reservation disappeared unexpectedly');
      }
      if (existing.request_hash !== requestHash) {
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was already used with a different request',
        );
      }
      if (existing.response_status === null || existing.response_body === null) {
        throw new Error('Committed idempotency record has no stored response');
      }
      return {
        statusCode: existing.response_status,
        body: transferResponseSchema.parse(existing.response_body),
        replayed: true,
      };
    }

    const lockedAccounts = await client.query<LockedAccountRow>(
      `SELECT id, currency, balance_minor::text
       FROM accounts
       WHERE id = ANY($1::uuid[]) AND kind = 'customer'
       ORDER BY id
       FOR UPDATE`,
      [[sourceAccountId, destinationAccountId]],
    );
    if (lockedAccounts.rowCount !== 2) {
      throw new AppError(
        404,
        'ACCOUNT_NOT_FOUND',
        'source or destination account was not found',
      );
    }

    const source = lockedAccounts.rows.find((row) => row.id === sourceAccountId);
    const destination = lockedAccounts.rows.find(
      (row) => row.id === destinationAccountId,
    );
    if (source === undefined || destination === undefined) {
      throw new AppError(
        404,
        'ACCOUNT_NOT_FOUND',
        'source or destination account was not found',
      );
    }
    if (source.currency !== currency || destination.currency !== currency) {
      throw new AppError(422, 'CURRENCY_MISMATCH', 'accounts must use the system currency');
    }

    const heldMinor = await heldAmount(client, source.id);
    const availableMinor = BigInt(source.balance_minor) - heldMinor;
    if (availableMinor < amountMinor) {
      throw new AppError(
        409,
        'INSUFFICIENT_FUNDS',
        'source account has insufficient available funds',
      );
    }

    const transferId = randomUUID();
    const transactionResult = await client.query<{ created_at: Date }>(
      `INSERT INTO ledger_transactions
         (id, kind, reference_id, currency, metadata)
       VALUES ($1, 'transfer', $1, $2, $3::jsonb)
       RETURNING created_at`,
      [
        transferId,
        currency,
        JSON.stringify({
          sourceAccountId: source.id,
          destinationAccountId: destination.id,
        }),
      ],
    );
    const createdAt = transactionResult.rows[0]?.created_at;
    if (createdAt === undefined) {
      throw new Error('Failed to create transfer ledger transaction');
    }

    await client.query(
      `INSERT INTO ledger_entries
         (transaction_id, account_id, amount_minor, created_at)
       VALUES
         ($1, $2, -$4::bigint, $5),
         ($1, $3, $4::bigint, $5)`,
      [
        transferId,
        source.id,
        destination.id,
        amountMinor.toString(),
        createdAt,
      ],
    );
    await client.query(
      `UPDATE accounts
       SET balance_minor = balance_minor + CASE
         WHEN id = $1 THEN -$3::bigint
         ELSE $3::bigint
       END
       WHERE id IN ($1, $2)`,
      [source.id, destination.id, amountMinor.toString()],
    );

    const body: TransferResponseBody = {
      data: {
        id: transferId,
        type: 'transfer',
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        amount: formatMinorAmount(amountMinor),
        currency,
        createdAt: createdAt.toISOString(),
      },
    };
    await client.query(
      `UPDATE idempotency_keys
       SET response_status = 201, response_body = $3::jsonb, resource_id = $4
       WHERE scope = 'transfer' AND key = $1 AND request_hash = $2`,
      [input.idempotencyKey, requestHash, JSON.stringify(body), transferId],
    );

    return { statusCode: 201, body, replayed: false };
  });
}
