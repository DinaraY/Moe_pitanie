import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/index.js';
import { withMcp } from '../src/mcp.js';
const env = { ALLOWED_ORIGIN: 'https://dinaray.github.io', CATALOG_ENABLED: 'true', CATALOG_LIMITER: { limit: async () => ({ success: true }) } };
const request = (path, body, origin = env.ALLOWED_ORIGIN) => new Request('https://api.example' + path, { headers: { Origin: origin, 'Content-Type': 'application/json' }, ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}) });
test('disabled catalog and missing limiter never reach upstream', async () => {
  const worker = createWorker(() => { throw new Error('must not connect'); });
  assert.equal((await worker.fetch(request('/api/tools'), { ...env, CATALOG_ENABLED: 'false' })).status, 503);
  assert.equal((await worker.fetch(request('/api/tools'), { ...env, CATALOG_LIMITER: null })).status, 503);
});
test('reject other origins, rate excess, cart and unapproved tools', async () => {
  const worker = createWorker(() => { throw new Error('must not connect'); });
  assert.equal((await worker.fetch(request('/api/tools', undefined, 'https://evil.example'), env)).status, 403);
  assert.equal((await worker.fetch(request('/api/tools'), { ...env, CATALOG_LIMITER: { limit: async () => ({ success: false }) } })).status, 429);
  assert.equal((await worker.fetch(request('/api/cart', {}), env)).status, 501);
  assert.equal((await worker.fetch(request('/api/catalog', { tool: 'vkusvill_cart_link_create', arguments: {} }), env)).status, 400);
});
test('live data has provenance, unknown delivery; HTML upstream errors are hidden', async () => {
  const worker = createWorker(async operation => operation(async method => method === 'tools/list' ? { tools: [{ name: 'vkusvill_products_search' }, { name: 'vkusvill_orders_history' }] } : { content: [{ type: 'text', text: 'fixture' }] }));
  const tools = await (await worker.fetch(request('/api/tools'), env)).json();
  assert.equal(tools.tools.length, 1);
  const data = await (await worker.fetch(request('/api/catalog', { tool: 'vkusvill_products_search', arguments: {} }), env)).json();
  assert.equal(data.deliveryAvailability, 'unverified');
  assert.equal(data.result.content[0].text, 'fixture');
  const failure = createWorker(async () => { throw new Error('secret-token'); });
  const response = await failure.fetch(request('/api/tools'), env);
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('secret-token'));
});
test('MCP initializes session, handles SSE and closes session without credentials', async () => {
  const calls = [];
  const transport = async (url, options) => {
    calls.push(options);
    assert.equal(url, 'https://mcp.vkusvill.ru/mcp');
    assert.equal(options.headers.Authorization, undefined);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    const body = JSON.parse(options.body);
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }, { headers: { 'Mcp-Session-Id': 'test-session' } });
    assert.equal(options.headers['Mcp-Session-Id'], 'test-session');
    if (!body.id) return new Response(null, { status: 202 });
    return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  assert.deepEqual(await withMcp(rpc => rpc('tools/list', {}), transport), { tools: [] });
  assert.equal(calls.at(-1).method, 'DELETE');
});
