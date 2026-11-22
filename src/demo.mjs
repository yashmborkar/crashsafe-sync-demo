import { createSync } from '@yashborkar/crashsafe-sync';
import { PgSyncStore } from '@yashborkar/crashsafe-sync/postgres';
import { getCustomerPage, PAGE_SIZE, TOTAL_CUSTOMERS, TOTAL_PAGES } from './source.mjs';

const syncKey = id => `demo:customers:${id}`;

export async function readSnapshot(pool, id) {
  // One SQL statement gives the checkpoint and customers the same MVCC snapshot.
  const { rows: [row] } = await pool.query(`
    SELECT state.checkpoint, state.completed, state.pages_committed, state.records_committed,
           state.lease_until > clock_timestamp() AS active,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object('id', external_id, 'name', name, 'email', email,
                                                'company', company) ORDER BY external_id)
             FROM demo_customers WHERE run_id = $2
           ), '[]'::jsonb) AS customers
    FROM (VALUES ($1::text)) AS run(sync_key)
    LEFT JOIN crashsafe_sync_state AS state USING (sync_key)
  `, [syncKey(id), id]);
  const pagesCommitted = Number(row.pages_committed);
  let status = pagesCommitted ? 'paused' : 'ready';
  if (row.active) status = 'running';
  if (row.completed) status = 'completed';
  return {
    status,
    checkpoint: row.checkpoint,
    pagesCommitted,
    recordsCommitted: Number(row.records_committed),
    customers: row.customers,
    totalCustomers: TOTAL_CUSTOMERS,
    totalPages: TOTAL_PAGES,
    pageSize: PAGE_SIZE,
  };
}

export async function runDemo(pool, id, action) {
  let injectedFailure;
  const sync = createSync({
    key: syncKey(id),
    store: new PgSyncStore(pool),
    async fetchPage({ checkpoint, signal }) {
      signal.throwIfAborted();
      return getCustomerPage(checkpoint);
    },
    async writeBatch({ tx, records, previousCheckpoint }) {
      for (const [index, customer] of records.entries()) {
        await tx.query(`
          INSERT INTO demo_customers (run_id, external_id, name, email, company)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (run_id, external_id) DO UPDATE
          SET name = EXCLUDED.name, email = EXCLUDED.email, company = EXCLUDED.company
        `, [id, customer.id, customer.name, customer.email, customer.company]);

        if (action === 'fail' && index === 2) {
          try {
            // A real SQL constraint violation aborts this transaction after three UPSERTs.
            await tx.query("UPDATE demo_customers SET name = '' WHERE run_id = $1 AND external_id = $2",
              [id, customer.id]);
          } catch (error) {
            if (error.code === '23514' && error.constraint === 'demo_customer_name_present') {
              injectedFailure = {
                error,
                details: { sqlState: error.code, attemptedWrites: index + 1, startCheckpoint: previousCheckpoint },
              };
            }
            throw error;
          }
        }
      }
    },
  });

  try {
    const { status, state, pagesProcessed, recordsProcessed } = await sync.run({
      maxPages: action === 'resume' ? TOTAL_PAGES : 1,
    });
    return {
      outcome: status,
      result: { pagesProcessed, recordsProcessed, pagesCommitted: state?.pagesCommitted, checkpoint: state?.checkpoint },
      snapshot: await readSnapshot(pool, id),
    };
  } catch (error) {
    if (injectedFailure?.error !== error) throw error;
    return {
      outcome: 'rolled-back',
      failure: injectedFailure.details,
      snapshot: await readSnapshot(pool, id),
    };
  }
}
