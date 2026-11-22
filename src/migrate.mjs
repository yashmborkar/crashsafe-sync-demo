import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, loadLocalEnv } from './db.mjs';

export async function migrate(pool) {
  const packageEntry = import.meta.resolve('@yashborkar/crashsafe-sync');
  const migrations = [
    new URL('../sql/001_create_sync_state.sql', packageEntry),
    new URL('../migrations/002_customers.sql', import.meta.url),
  ];
  const statements = await Promise.all(migrations.map(file => readFile(file, 'utf8')));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(24801, 19277)');
    for (const sql of statements) await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadLocalEnv();
  const pool = createPool();
  try {
    await migrate(pool);
    console.log('Applied the published sync state migration and demo customer migration.');
  } finally {
    await pool.end();
  }
}
