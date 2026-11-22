import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createDemoServer } from '../src/http.mjs';
import { migrate } from '../src/migrate.mjs';
import { loadLocalEnv } from '../src/db.mjs';

loadLocalEnv();

assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a disposable PostgreSQL database');
const schema = 'demo_test_' + randomUUID().replaceAll('-', '');
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let pool, server, origin;

before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  await migrate(pool);
  server = createDemoServer(pool);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.end();
  }
});

async function request(id, action, expected = 200) {
  const response = await fetch(`${origin}/api/runs/${id}${action ? '/' + action : ''}`, {
    method: action ? 'POST' : 'GET',
    headers: action ? { 'X-Demo-Action': '1' } : undefined,
  });
  assert.equal(response.status, expected, await response.clone().text());
  return response.json();
}

test('HTTP demo commits a page, rolls back real SQL failure, and resumes to 35 unique IDs', async () => {
  const id = randomUUID();
  const initial = await request(id);
  assert.equal(initial.customers.length, 0);
  assert.equal(initial.checkpoint, null);
  assert.equal(initial.status, 'ready');

  const { snapshot: first } = await request(id, 'step');
  assert.deepEqual(first.checkpoint, { offset: 10 });
  assert.equal(first.customers.length, 10);
  assert.equal(first.pagesCommitted, 1);

  const failure = await request(id, 'fail', 409);
  assert.equal(failure.outcome, 'rolled-back');
  assert.equal(failure.failure.sqlState, '23514');
  assert.equal(failure.failure.attemptedWrites, 3);
  assert.deepEqual(failure.failure.startCheckpoint, { offset: 10 });
  assert.deepEqual(failure.snapshot, first);
  assert.deepEqual(await request(id), first);

  const { snapshot: final, result } = await request(id, 'resume');
  assert.equal(result.pagesProcessed, 3);
  assert.equal(final.status, 'completed');
  assert.equal(final.pagesCommitted, 4);
  assert.equal(final.checkpoint, null);
  assert.equal(final.recordsCommitted, 35);
  const ids = Array.from({ length: 35 }, (_, index) => `CUS-${String(index + 1).padStart(3, '0')}`);
  assert.deepEqual(final.customers.map(customer => customer.id), ids);
  assert.equal((await request(id, 'resume')).result.pagesProcessed, 0);

  // Deliberately replay the first page while retaining all destination rows.
  await pool.query(`UPDATE crashsafe_sync_state
    SET checkpoint = NULL, completed = false, pages_committed = 0, records_committed = 0
    WHERE sync_key = $1`, [`demo:customers:${id}`]);
  await request(id, 'step');
  assert.deepEqual((await request(id)).customers.map(customer => customer.id), ids);
});

test('failure from the initial cursor leaves the run empty and other runs isolated', async () => {
  const id = randomUUID();
  const other = randomUUID();
  await request(other, 'step');
  const failure = await request(id, 'fail', 409);
  assert.equal(failure.snapshot.checkpoint, null);
  assert.equal(failure.snapshot.pagesCommitted, 0);
  assert.equal(failure.snapshot.customers.length, 0);
  assert.equal((await request(other)).customers.length, 10);
  assert.equal((await request(id, 'resume')).snapshot.customers.length, 35);
});

test('a failed final page preserves offset 30 and resumes the remaining five rows', async () => {
  const id = randomUUID();
  for (let page = 0; page < 3; page++) await request(id, 'step');
  const failure = await request(id, 'fail', 409);
  assert.deepEqual(failure.snapshot.checkpoint, { offset: 30 });
  assert.equal(failure.snapshot.customers.length, 30);
  assert.equal(failure.snapshot.status, 'paused');
  const { snapshot, result } = await request(id, 'resume');
  assert.equal(snapshot.customers.length, 35);
  assert.equal(result.recordsProcessed, 5);
});

test('the source exposes deterministic pages and rejects invalid cursors', async () => {
  const response = await fetch(origin + '/api/source?offset=30');
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.records.length, 5);
  assert.equal(page.records[0].id, 'CUS-031');
  assert.equal(page.records.at(-1).id, 'CUS-035');
  assert.equal(page.done, true);
  assert.equal(page.nextCheckpoint, null);
  assert.equal((await fetch(origin + '/api/source?offset=14')).status, 400);
});
