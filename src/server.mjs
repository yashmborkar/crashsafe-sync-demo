import { createPool, loadLocalEnv } from './db.mjs';
import { createDemoServer } from './http.mjs';

loadLocalEnv();
const pool = createPool();
const server = createDemoServer(pool);
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST || '127.0.0.1';

server.listen(port, host, () => console.log(`Crashsafe Sync Demo: http://${host}:${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => void pool.end()));
}
