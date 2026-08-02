import type { Pool, PoolClient } from 'pg';

const RETRYABLE_TRANSACTION_CODES = new Set(['40001', '40P01']);
const MAX_ATTEMPTS = 3;

type PostgresError = Error & { code?: string };

function isRetryable(error: unknown): boolean {
  return error instanceof Error
    && RETRYABLE_TRANSACTION_CODES.has((error as PostgresError).code ?? '');
}

function retryDelay(attempt: number): Promise<void> {
  const baseMilliseconds = 10 * 2 ** (attempt - 1);
  const jitterMilliseconds = Math.floor(Math.random() * 10);
  return new Promise((resolve) => {
    setTimeout(resolve, baseMilliseconds + jitterMilliseconds);
  });
}

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error: unknown) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the business/SQL error that caused the rollback.
      }

      if (attempt < MAX_ATTEMPTS && isRetryable(error)) {
        await retryDelay(attempt);
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  throw new Error('Transaction retry loop exhausted unexpectedly');
}
