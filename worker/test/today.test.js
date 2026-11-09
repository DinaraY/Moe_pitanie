import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyTarget } from '../../shared/targets.js';
import { suggestToday, validateToday } from '../../shared/today.js';
import { aiAvailable, aiSuggest, reserveAiCall } from '../src/assistant.js';
import { environment } from './helpers.js';
import { createWorker } from '../src/index.js';
const target = dailyTarget();
const scaled = scale => Object.fromEntries(['kcal', 'protein', 'fat', 'carbs'].map(k => [k, { min: target[k] * scale, max: target[k] * scale }]));
const nutrition = Object.fromEntries(['kcal', 'protein', 'fat', 'carbs'].map(k => [k, target[k] * 0.1]));
const p = (id, overrides = {}) => ({ id, name: `Синтетическое блюдо ${id}`, packageGrams: 200, availability: 'available', nutrition, reviews: { average: 4.8, count: 100 }, ...overrides });
const groups = { ready: [p(1), p(2)], yogurt: [p(3)], curd: [], fruit: [], pastila: [], sweet: [] };
const context = () => ({ slots: ['lunch', 'dinner', 'snack'], eaten: scaled(0.4), preferences: { blocked: [], liked: [], recent: [] } });
const enabled = () => ({ ...environment().env, AI_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-test-key' });
const answer = choices => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ choices }) }] }] });

test('today uses eaten macros once, whole meals and explicit remaining slots', () => {
  const result = suggestToday(groups, context());
  assert.equal(result.status, 'within');
  assert.ok(Math.abs(result.dayBounds.kcal.min - 1500) < 0.001);
  assert.equal(result.meals.length, 3);
  assert.deepEqual(result.meals.map(m => m.key), ['lunch', 'dinner', 'snack']);
  assert.ok(result.meals.every(m => m.items.every(i => i.grams === i.product.packageGrams)));
  assert.notEqual(result.meals[0].items[0].product.id, result.meals[1].items[0].product.id);
});
test('unknown diary, reached target, missing products and invalid slots never fabricate', () => {
  assert.equal(suggestToday({}, { ...context(), eaten: null }).status, 'unknown');
  assert.equal(suggestToday({}, { ...context(), eaten: scaled(1) }).status, 'target_reached');
  assert.equal(suggestToday({}, context()).status, 'missing_nutrition');
  assert.equal(suggestToday({ ready: [p(1, { nutrition: null })] }, { ...context(), slots: ['dinner'] }).status, 'missing_nutrition');
  for (const slots of [[], ['dinner', 'dinner'], ['arbitrary'], [{ toString: 1 }]]) assert.throws(() => validateToday({ ...context(), slots }), /INVALID_TODAY/);
  assert.throws(() => validateToday({ ...context(), eaten: { kcal: { min: -1, max: 0 } } }), /INVALID_TODAY/);
});
test('today preserves ranges and excludes user-blocked and unavailable products', () => {
  const input = context(); input.preferences.blocked = [1]; input.eaten.kcal.max += 30;
  const result = suggestToday({ ...groups, ready: [...groups.ready, p(4, { availability: 'unavailable' })] }, input);
  assert.ok(result.meals.flatMap(m => m.items).every(i => ![1, 4].includes(i.product.id)));
  assert.ok(Math.abs(result.dayBounds.kcal.max - result.dayBounds.kcal.min - 30) < 0.001);
});
test('AI quota is atomic, global for the application and persists independently of login', async () => {
  const env = { ...enabled(), AI_MONTHLY_CALL_LIMIT: '2' };
  const results = await Promise.all(Array.from({ length: 12 }, () => reserveAiCall(env)));
  assert.equal(results.filter(r => r.ok).length, 2);
  assert.equal((await reserveAiCall({ ...env })).ok, false);
});
test('AI sends bounded verified options, uses fixed model and never sends store credentials', async () => {
  const input = context(), baseline = suggestToday(groups, input), env = enabled();
  const result = await aiSuggest(env, input, groups, baseline, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.store, false);
    assert.equal(body.tools, undefined);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.max_output_tokens, 1200);
    assert.ok(!options.body.includes('test-secret'));
    assert.ok(!options.body.includes('synthetic-test-key'));
    assert.deepEqual(JSON.parse(body.input).eaten, input.eaten);
    return answer(baseline.meals.map(m => ({ meal: m.key, optionId: m.optionId })));
  });
  assert.equal(result.engine, 'ai');
  assert.equal(result.status, 'within');
});
test('AI cannot invent IDs, change portions, omit meals or return a refused/incomplete response', async () => {
  const input = context(), baseline = suggestToday(groups, input);
  const valid = baseline.meals.map(m => ({ meal: m.key, optionId: m.optionId }));
  for (const choices of [[...valid.slice(0, 2)], valid.map(c => ({ ...c, optionId: 'invented_9999' })), [valid[0], valid[0], valid[2]]]) {
    await assert.rejects(aiSuggest(enabled(), input, groups, baseline, async () => answer(choices)), /AI_INVALID_RESPONSE/);
  }
  await assert.rejects(aiSuggest(enabled(), input, groups, baseline, async () => Response.json({ status: 'incomplete' })), /AI_INVALID_RESPONSE/);
  await assert.rejects(aiSuggest(enabled(), input, groups, baseline, async () => new Response('provider secret error', { status: 500 })), /AI_UNAVAILABLE/);
});
test('disabled or exhausted AI never calls provider; nutrition unknown consumes no calls', async () => {
  assert.equal(aiAvailable({}), false);
  const input = context(), baseline = suggestToday(groups, input);
  let calls = 0; const transport = () => { calls++; throw new Error('must not fetch'); };
  await assert.rejects(aiSuggest({}, input, groups, baseline, transport), /AI_NOT_CONFIGURED/);
  const env = { ...enabled(), AI_MONTHLY_CALL_LIMIT: '1' }; await reserveAiCall(env);
  await assert.rejects(aiSuggest(env, input, groups, baseline, transport), /AI_MONTHLY_LIMIT/);
  assert.equal((await aiSuggest(enabled(), { ...input, eaten: null }, groups, { status: 'unknown' }, transport)).status, 'unknown');
  assert.equal(calls, 0);
});
test('today HTTP route rejects malformed input and unauthenticated AI before MCP, exposes no keys', async () => {
  const env = { ...enabled(), ALLOWED_ORIGIN: 'https://dinaray.github.io', CATALOG_ENABLED: 'true', CATALOG_LIMITER: { limit: async () => ({ success: true }) } };
  const worker = createWorker(() => { throw new Error('must not connect'); });
  const req = body => new Request('https://api.example/api/today', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.ALLOWED_ORIGIN }, body: JSON.stringify(body) });
  assert.equal((await worker.fetch(req({}), env)).status, 400);
  assert.equal((await worker.fetch(req({ ...context(), engine: 'ai', consent: true }), env)).status, 401);
  const unknown = await worker.fetch(req({ ...context(), eaten: null }), env);
  assert.equal((await unknown.json()).status, 'unknown');
  const status = await worker.fetch(new Request('https://api.example/api/status'), env);
  const text = await status.text(); assert.equal(JSON.parse(text).aiAvailable, true); assert.ok(!text.includes('synthetic-test-key'));
});

test('AI variant further from the daily goal falls back to the checked algorithm', async () => {
  const input = context();
  const varied = { ...groups, ready: [...groups.ready, p(9, { nutrition: { ...nutrition, kcal: 500 } })] };
  const baseline = suggestToday(varied, input);
  const result = await aiSuggest(enabled(), input, varied, baseline, async (url, options) => {
    const body = JSON.parse(options.body), offered = JSON.parse(body.input).options;
    const choices = Object.entries(offered).map(([meal, options]) => ({ meal, optionId: [...options].sort((a,b) => b.bounds.kcal.min - a.bounds.kcal.min)[0].optionId }));
    return answer(choices);
  });
  assert.equal(result.engine, 'algorithm');
  assert.equal(result.aiNote, 'ALGORITHM_CLOSER');
  assert.equal(result.score, baseline.score);
});
test('invalid monthly limit disables AI rather than silently allowing more paid calls', async () => {
  for (const value of ['0', '101', 'bad', '-1']) {
    const env = { ...enabled(), AI_MONTHLY_CALL_LIMIT: value };
    assert.equal(aiAvailable(env), false);
    await assert.rejects(reserveAiCall(env), /AI_NOT_CONFIGURED/);
  }
});
test('authenticated HTTP AI requires consent and fails safely to the algorithm on provider error', async () => {
  const { seal, storage } = await import('../src/auth.js');
  const env = { ...enabled(), CATALOG_ENABLED: 'true', CATALOG_LIMITER: { limit: async () => ({ success: true }) } };
  const sid = 'x'.repeat(43);
  await storage(env, sid, 'create', { expiresAt: Date.now() + 60000, payload: await seal(env, { accessToken: 'synthetic-vv-token' }, sid) });
  let providerCalls = 0, catalogCalls = 0;
  const rpc = async (method, params) => {
    if (method === 'tools/list') return { tools: [{ name: 'vkusvill_products_search', inputSchema: { properties: { q: { type: 'string' } } } }] };
    catalogCalls++;
    const q = params.arguments.q;
    const names = { 'готовые блюда': 'Тестовое готовое блюдо', 'йогурт': 'Тестовый йогурт' };
    return { structuredContent: { ok: true, data: { items: names[q] ? [{ id: q === 'йогурт' ? 3 : 1, name: names[q], unit: 'шт', weight: { value: 200, unit: 'г' }, price: { current: 100 }, category: [{ name: 'Готовые блюда' }], properties: [{ name: 'Ценность на 100 г', value: 'белки 10,1 г; жиры 5,8 г; углеводы 14,4 г; 150 ккал' }] }] : [] } } };
  };
  const worker = createWorker(async operation => operation(rpc), async () => { providerCalls++; return new Response('secret provider failure', { status: 500 }); });
  const req = body => new Request('https://api.example/api/today', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sid}`, Origin: env.ALLOWED_ORIGIN }, body: JSON.stringify(body) });
  assert.equal((await worker.fetch(req({ ...context(), engine: 'ai', consent: false }), env)).status, 400);
  assert.equal(catalogCalls, 0);
  assert.equal((await worker.fetch(req({ ...context(), engine: 'ai', consent: true }), { ...env, AI_ENABLED: 'false' })).status, 503);
  assert.equal(providerCalls, 0);
  const response = await worker.fetch(req({ ...context(), engine: 'ai', consent: true }), env);
  const value = await response.json();
  assert.equal(response.status, 200);
  assert.equal(value.engine, 'algorithm');
  assert.equal(value.aiNote, 'AI_UNAVAILABLE');
  assert.equal(value.meals.length, 3);
  assert.equal(providerCalls, 1);
  assert.ok(!JSON.stringify(value).includes('secret provider'));
  assert.ok(!JSON.stringify(value).includes('synthetic-vv-token'));
});
