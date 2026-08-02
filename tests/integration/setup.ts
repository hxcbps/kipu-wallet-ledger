process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://kipu:kipu@localhost:5432/kipu_test';
process.env.DB_POOL_MAX = '30';
process.env.KIPU_CURRENCY = 'USD';
process.env.LOG_LEVEL = 'error';
