import { withMcp } from './mcp.js';
import { configuration, oauth, sessionFor } from './auth.js';
import { discover, search, details } from './catalog.js';
import { buildPlan } from './planner.js';
import { createDraft, confirmDraft } from './cart.js';
export { AuthStore } from './auth.js';

const READ_TOOLS = new Set(['vkusvill_products_search', 'vkusvill_product_details', 'vkusvill_product_analogs']);
async function readJson(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new Error('JSON_REQUIRED');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('INVALID_REQUEST');
  let bytes = 0, chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > 8192) throw new Error('BODY_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const buffer = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  let input;
  try { input = JSON.parse(new TextDecoder().decode(buffer)); } catch { throw new Error('INVALID_JSON'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_REQUEST');
  return input;
}
export function createWorker(connect = withMcp) {
  return { async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Origin' };
    if (origin === env.ALLOWED_ORIGIN) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
    if (origin && origin !== env.ALLOWED_ORIGIN) return reply({ error: 'ORIGIN_DENIED' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
    const path = new URL(request.url).pathname;
    let oauthReady = false;
    try { configuration(env); oauthReady = true; } catch {}
    if (path === '/api/status' && request.method === 'GET') return reply({
      service: 'moe-pitanie-api', catalogEnabled: env.CATALOG_ENABLED === 'true',
      authorization: oauthReady ? 'available' : 'not_configured', deliveryAvailability: 'unverified',
      cartEnabled: oauthReady && env.CATALOG_ENABLED === 'true' && env.CART_ENABLED === 'true'
    });
    if (path === '/api/cart' || (path === '/api/cart/confirm' && env.CART_ENABLED !== 'true')) return reply({ error: 'CART_DISABLED' }, 501);
    if (path.startsWith('/oauth/')) {
      if (!oauthReady) return reply({ error: 'OAUTH_NOT_CONFIGURED' }, 503);
      if (!env.CATALOG_LIMITER) return reply({ error: 'RATE_LIMITER_MISSING' }, 503);
      if (!(await env.CATALOG_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' })).success) return reply({ error: 'RATE_LIMITED' }, 429);
      try { return await oauth(request, env); }
      catch { return reply({ error: 'OAUTH_FAILED', message: 'Вход не завершён. Вернитесь в приложение и повторите подключение.' }, 400); }
    }
    let session;
    try { session = await sessionFor(request, env); }
    catch { return reply({ error: 'SESSION_EXPIRED' }, 401); }
    if (path === '/api/session' && request.method === 'GET') return reply({ authenticated: !!session, expiresAt: session?.expiresAt || null, deliveryAvailability: 'unverified' });
    if (path === '/api/session' && request.method === 'DELETE') {
      if (session) await session.destroy();
      return reply({ authenticated: false });
    }
    const postRoutes = ['/api/catalog', '/api/search', '/api/product', '/api/plan', '/api/cart/draft', '/api/cart/confirm'];
    if (!((path === '/api/tools' && request.method === 'GET') || (postRoutes.includes(path) && request.method === 'POST'))) return reply({ error: 'NOT_FOUND' }, 404);
    if (path.startsWith('/api/cart/') && !session) return reply({ error: 'LOGIN_REQUIRED' }, 401);
    if (env.CATALOG_ENABLED !== 'true') return reply({ error: 'CATALOG_DISABLED' }, 503);
    if (!env.CATALOG_LIMITER) return reply({ error: 'RATE_LIMITER_MISSING' }, 503);
    if (!(await env.CATALOG_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' })).success) return reply({ error: 'RATE_LIMITED' }, 429);
    let input;
    if (request.method === 'POST') {
      try { input = await readJson(request); }
      catch (error) { return reply({ error: error.message }, error.message === 'BODY_TOO_LARGE' ? 413 : error.message === 'JSON_REQUIRED' ? 415 : 400); }
      if (path === '/api/catalog' && (!READ_TOOLS.has(input.tool) || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments))) return reply({ error: 'INVALID_REQUEST' }, 400);
      if (path === '/api/search' && (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 120)) return reply({ error: 'INVALID_REQUEST' }, 400);
      if (path === '/api/product' && (!Number.isSafeInteger(input.id) || input.id <= 0)) return reply({ error: 'INVALID_REQUEST' }, 400);
    }
    try {
      return await connect(async rpc => {
        const tools = await discover(rpc);
        if (path === '/api/tools') return reply({ tools: tools.filter(t => READ_TOOLS.has(t.name)) });
        if (path === '/api/search') return reply({ products: await search(rpc, tools, input.query.trim(), !!session) });
        if (path === '/api/product') return reply({ product: await details(rpc, tools, input.id, !!session) });
        if (path === '/api/plan') return reply(await buildPlan(rpc, tools, !!session));
        if (path === '/api/cart/draft') {
          const result = await createDraft(env, session, rpc, tools, input.entries);
          return reply(result, result.error ? 409 : 200);
        }
        if (path === '/api/cart/confirm') {
          const result = await confirmDraft(env, session, rpc, tools, input);
          return reply(result, result.error ? 409 : 200);
        }
        if (!tools.some(t => t.name === input.tool)) return reply({ error: 'TOOL_UNAVAILABLE' }, 503);
        const result = await rpc('tools/call', { name: input.tool, arguments: input.arguments });
        if (result.isError) return reply({ error: 'CATALOG_QUERY_FAILED' }, 502);
        return reply({ source: 'https://mcp.vkusvill.ru/mcp', checkedAt: new Date().toISOString(), deliveryAvailability: 'unverified', result });
      }, fetch, session?.accessToken);
    } catch (error) {
      const validation = ['INVALID_PLAN', 'INVALID_PORTION', 'TOO_MANY_PRODUCTS', 'CONFIRMATION_REQUIRED'];
      if (validation.includes(error.message)) return reply({ error: error.message }, 400);
      return reply({ error: 'MCP_UNAVAILABLE', message: 'Каталог недоступен или его формат изменился. Данные магазина не подставлены.' }, 502);
    }
  }};
}
export default createWorker();
