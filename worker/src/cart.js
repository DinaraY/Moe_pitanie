import { storage, seal, open, digest } from './auth.js';
import { details, officialUrl, payload } from './catalog.js';
import { quote } from './planner.js';
const DISPLAY_VERSION = 'cart-v2';
const contextFor = (session, id) => `cart:${session.owner}:${id}`;
function validate(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 60) throw new Error('INVALID_PLAN');
  if (entries.some(e => !Number.isSafeInteger(e?.id) || e.id <= 0 || !Number.isFinite(e.grams) || e.grams <= 0 || e.grams > 5000)) throw new Error('INVALID_PLAN');
  if (new Set(entries.map(e => e.id)).size > 20) throw new Error('TOO_MANY_PRODUCTS');
}
const comparison = quote => quote.lines.map(l => ({ id: l.product.id, name: l.product.name, price: l.product.price, unit: l.product.unit, mass: l.product.packageGrams, grams: l.grams, quantity: l.quantity }));
async function refresh(rpc, tools, entries) {
  const products = new Map();
  for (const { id } of entries) if (!products.has(id)) products.set(id, await details(rpc, tools, id, true));
  return quote(entries.map(e => ({ product: products.get(e.id), grams: e.grams })));
}
export async function createDraft(env, session, rpc, tools, entries) {
  validate(entries);
  const summary = await refresh(rpc, tools, entries);
  if (!summary.ready) return { error: 'CART_INCOMPLETE', summary };
  const id = crypto.randomUUID(), context = contextFor(session, id);
  const expiresAt = Math.min(Date.now() + 5 * 60 * 1000, session.expiresAt);
  const version = await digest(JSON.stringify(comparison(summary)));
  const encrypted = await seal(env, { entries, summary, version, displayVersion: DISPLAY_VERSION }, context);
  if (!(await storage(env, context, 'create', { kind: 'cart', status: 'pending', expiresAt, payload: encrypted })).ok) throw new Error('AUTH_STORE_UNAVAILABLE');
  return { id, version, expiresAt, summary, displayVersion: DISPLAY_VERSION };
}
export async function confirmDraft(env, session, rpc, tools, input) {
  if (input.confirmed !== true || !/^[0-9a-f-]{36}$/i.test(input.id || '') || !/^[A-Za-z0-9_-]{43}$/.test(input.version || '')) throw new Error('CONFIRMATION_REQUIRED');
  const context = contextFor(session, input.id);
  const { record } = await storage(env, context, 'read');
  if (!record) return { error: 'DRAFT_EXPIRED' };
  const draft = await open(env, record.payload, context);
  if (draft.version !== input.version) return { error: 'DRAFT_CHANGED' };
  if (draft.displayVersion !== DISPLAY_VERSION || input.displayVersion !== DISPLAY_VERSION) return { error: 'CLIENT_UPDATE_REQUIRED' };
  if (record.status === 'done') return open(env, record.result, context);
  // Validate tool schema before claiming. New write tools never become available implicitly.
  const tool = tools.find(t => t.name === 'vkusvill_cart_link_create');
  const item = tool?.inputSchema?.properties?.products?.items;
  if (item?.properties?.id?.type !== 'integer' || item.properties.q?.type !== 'number') throw new Error('TOOL_SCHEMA_CHANGED');
  const claimed = await storage(env, context, 'claim');
  if (!claimed.claimed) return { error: 'DRAFT_ALREADY_USED' };
  try {
    const fresh = await refresh(rpc, tools, draft.entries);
    if (!fresh.ready || await digest(JSON.stringify(comparison(fresh))) !== draft.version) {
      await storage(env, context, 'fail'); return { error: 'DRAFT_CHANGED', summary: fresh };
    }
    if (Date.now() >= record.expiresAt) {
      await storage(env, context, 'fail'); return { error: 'DRAFT_EXPIRED' };
    }
    const data = payload(await rpc('tools/call', {
      name: 'vkusvill_cart_link_create', arguments: { products: fresh.lines.map(l => ({ id: l.product.id, q: l.quantity })) }
    }));
    const link = officialUrl(data.link ?? data.url);
    if (!link) throw new Error('UNSAFE_CART_LINK');
    const result = { link, message: 'Ссылка на корзину создана. Заказ и оплата выполняются вами во ВкусВилле.' };
    await storage(env, context, 'finish', await seal(env, result, context));
    return result;
  } catch (error) { await storage(env, context, 'fail'); throw error; }
}
