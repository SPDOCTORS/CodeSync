import { createRequestHandler } from '../server/index.mjs';

const handler = createRequestHandler();

/**
 * Vercel Serverless Function entry point for CodeSync backend.
 * Reuses the existing request handler and recovers original path/query
 * when routed via Vercel wildcard rewrites.
 */
export default async function vercelHandler(req, res) {
  try {
    if (req.headers && (req.url === '/api' || req.url?.startsWith('/api/') || req.url?.startsWith('/api?'))) {
      const matched = req.headers['x-matched-path'] || req.headers['x-forwarded-url'];
      if (matched && matched !== '/api' && !matched.startsWith('/api/')) {
        const incomingQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
        const [matchedPath, matchedQuery] = matched.split('?');
        const query = incomingQuery || matchedQuery || '';
        req.url = `${matchedPath}${query ? `?${query}` : ''}`;
      }
    }
    if (req.url) {
      if (!req.url.startsWith('/') && !/^https?:\/\//i.test(req.url)) {
        req.url = `/${req.url}`;
      }
      req.url = req.url.replace(/^\/{2,}/, '/');
    }
    return await handler(req, res);
  } catch (err) {
    console.error('[Vercel handler unexpected error]', err?.message ?? err);
    const status = err?.status || 500;
    res.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    return res.end(JSON.stringify({ error: err?.message || 'Internal Server Error' }));
  }
}
