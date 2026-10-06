import { createRequestHandler } from '../server/index.mjs';

const handler = createRequestHandler();

/**
 * Vercel Serverless Function entry point for CodeSync backend.
 * Reuses the existing request handler and recovers original path/query
 * when routed via Vercel wildcard rewrites.
 */
export default async function vercelHandler(req, res) {
  if (req.headers && req.headers['x-matched-path'] && (req.url === '/api' || req.url?.startsWith('/api/') || req.url?.startsWith('/api?'))) {
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    req.url = `${req.headers['x-matched-path']}${query}`;
  }
  return handler(req, res);
}
