import { Pool } from 'pg';
import { getConfig } from '../config/env.js';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool === undefined) {
    const config = getConfig();
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      application_name: 'kipu-wallet-ledger',
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
  }
}
