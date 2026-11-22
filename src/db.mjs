import pg from 'pg';

export function loadLocalEnv() {
  try {
    process.loadEnvFile?.();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function createPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL or copy .env.example to .env for local Compose');
  }
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 8000,
  });
  pool.on('error', error => console.error('Idle PostgreSQL connection failed', error.code));
  return pool;
}
