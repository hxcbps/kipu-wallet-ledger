import { closePool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

migrate()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
