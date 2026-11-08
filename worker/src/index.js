import { withMcp } from './mcp.js';
import { configuration, oauth, sessionFor } from './auth.js';
export { AuthStore } from './auth.js';

const READ_TOOLS = new Set(['vkusvill_products_search', 'vkusvill_product_details', 'vkusvill_product_analogs']);
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
      authorization: oauthReady ? 'available' : 'not_configured', deliveryAvailability: 'unverified', cartEnabled: false
    });
    if (path.startsWith('/api/cart')) return reply({ error: 'NOT_IMPLEMENTED' }, 501);
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
    if (!((path === '/api/tools' && request.method === 'GET') || (path === '/api/catalog' && request.method === 'POST'))) return reply({ error: 'NOT_FOUND' }, 404);
    if (env.CATALOG_ENABLED !== 'true') return reply({ error: 'CATALOG_DISABLED' }, 503);
    // CORS is not authentication. Only an opaque app session selects personal access.
    if (!env.CATALOG_LIMITER) return reply({ error: 'RATE_LIMITER_MISSING' }, 503);
    const { success } = await env.CATALOG_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) return reply({ error: 'RATE_LIMITED' }, 429);
    let input;
    if (path === '/api/catalog') {
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) return reply({ error: 'JSON_REQUIRED' }, 415);
      const reader = request.body?.getReader();
      if (!reader) return reply({ error: 'INVALID_REQUEST' }, 400);
      let bytes = 0, chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.length;
          if (bytes > 8192) { await reader.cancel(); return reply({ error: 'BODY_TOO_LARGE' }, 413); }
          chunks.push(value);
        }
        const buffer = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
        input = JSON.parse(new TextDecoder().decode(buffer));
      } catch { return reply({ error: 'INVALID_JSON' }, 400); }
      if (!input || !READ_TOOLS.has(input.tool) || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) return reply({ error: 'INVALID_REQUEST' }, 400);
    }
    try {
      return await connect(async rpc => {
        const listed = await rpc('tools/list', {});
        const tools = (listed.tools || []).filter(t => READ_TOOLS.has(t.name));
        if (path === '/api/tools') return reply({ tools, nextCursor: listed.nextCursor || null });
        if (!tools.some(t => t.name === input.tool)) return reply({ error: 'TOOL_UNAVAILABLE' }, 503);
        const result = await rpc('tools/call', { name: input.tool, arguments: input.arguments });
        if (result.isError) return reply({ error: 'CATALOG_QUERY_FAILED' }, 502);
        return reply({ source: 'https://mcp.vkusvill.ru/mcp', checkedAt: new Date().toISOString(), deliveryAvailability: 'unverified', result });
      }, fetch, session?.accessToken);
    } catch { return reply({ error: 'MCP_UNAVAILABLE', message: 'Каталог недоступен. Данные магазина не подставлены.' }, 502); }
  }};
}
export default createWorker();
