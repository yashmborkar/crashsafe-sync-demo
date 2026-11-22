import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readSnapshot, runDemo } from './demo.mjs';
import { getCustomerPage } from './source.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
const runPath = /^\/api\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/(step|fail|resume))?$/;

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

export function createDemoServer(pool) {
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const { pathname, searchParams } = new URL(request.url, 'http://localhost');
      const route = runPath.exec(pathname);
      if (route) {
        const [, id, action] = route;
        const method = action ? 'POST' : 'GET';
        if (request.method !== method) {
          response.setHeader('Allow', method);
          return json(response, 405, { error: 'Method not allowed.' });
        }
        if (!action) return json(response, 200, await readSnapshot(pool, id));
        // A regular cross-origin form cannot issue this header, and CORS is disabled.
        if (request.headers['x-demo-action'] !== '1') return json(response, 403, { error: 'Action header required.' });
        const result = await runDemo(pool, id, action);
        return json(response, ['rolled-back', 'busy'].includes(result.outcome) ? 409 : 200, result);
      }
      if (request.method === 'GET' && pathname === '/api/source') {
        try {
          const offset = searchParams.get('offset');
          return json(response, 200, getCustomerPage(offset === null ? null : { offset: Number(offset) }));
        } catch (error) {
          if (error.name !== 'CheckpointInvalidError') throw error;
          return json(response, 400, { error: error.message });
        }
      }
      if (request.method === 'GET' && pathname === '/health') {
        try {
          await pool.query('SELECT 1 FROM crashsafe_sync_state LIMIT 0');
          await pool.query('SELECT 1 FROM demo_customers LIMIT 0');
          return json(response, 200, { status: 'ok' });
        } catch {
          return json(response, 503, { status: 'unavailable' });
        }
      }
      const asset = files.get(pathname);
      if (request.method === 'GET' && asset) {
        const [name, type] = asset;
        const bytes = readFileSync(new URL(`../public/${name}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': type });
        return response.end(bytes);
      }
      return json(response, 404, { error: 'Route not found.' });
    } catch (error) {
      console.error('Demo request failed', error.code ?? error.name);
      return json(response, 500, { error: 'The sync request failed. Refresh the dashboard before retrying.' });
    }
  });
}
