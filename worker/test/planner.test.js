import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, payload } from '../src/catalog.js';
import { quote, totals, totalBounds } from '../../shared/food.js';
import { buildPlan } from '../src/planner.js';
import { createDraft, confirmDraft } from '../src/cart.js';
import { environment } from './helpers.js';

// Entirely synthetic fixtures, never shown as products in the application.
const item = overrides => ({ id: 1, name: 'Тестовый товар', price: { current: 100 }, unit: 'шт', weight: { value: 180, unit: 'г' }, available_quantity: 20, category: [{ name: 'Готовые блюда' }], properties: [{ name: 'Пищевая и энергетическая ценность на 100 г', value: 'белки 10 г; жиры 4 г; углеводы 11 г; 120 ккал' }], ...overrides });
const envelope = data => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] });
const tools = [
  { name: 'vkusvill_products_search', inputSchema: { properties: { q: { type: 'string' } } } },
  { name: 'vkusvill_product_details', inputSchema: { properties: { id: { type: 'integer' } } } },
  { name: 'vkusvill_cart_link_create', inputSchema: { properties: { products: { items: { properties: { id: { type: 'integer' }, q: { type: 'number' } } } } } } }
];
function upstream(link = 'https://vkusvill.ru/?share_basket=test-fixture') {
  let current = item(); let cartCalls = 0;
  return {
    change: overrides => { current = item(overrides); },
    count: () => cartCalls,
    async rpc(method, params) {
      if (method === 'tools/list') return { tools };
      if (params.name === 'vkusvill_product_details') return envelope({ ...current, id: params.arguments.id });
      if (params.name === 'vkusvill_products_search') return envelope({ items: [current], meta: { personalized: true } });
      if (params.name === 'vkusvill_cart_link_create') { cartCalls++; return envelope({ link }); }
      throw new Error('unexpected call');
    }
  };
}
test('official fields preserve unknowns, zero macros and unit distinctions', () => {
  const product = normalize(item(), true);
  assert.equal(product.nutrition.kcal, 120);
  assert.equal(product.availability, 'available');
  assert.equal(normalize(item(), false).availability, 'unverified');
  assert.equal(normalize(item({ price: {} }), true).price, null);
  assert.equal(normalize(item({ weight: { value: 180, unit: 'мл' } }), true).packageGrams, null);
  assert.equal(normalize(item({ available_quantity: null }), true).availability, 'unverified');
  const zero = normalize(item({ properties: [{ name: 'Пищевая ценность на 100 г', value: 'белки 0 г, жиры 0 г, углеводы 0 г, 0 ккал' }] }), true);
  assert.equal(zero.nutrition.protein, 0);
  assert.equal(normalize(item({ properties: [{ name: 'Ценность', value: 'белки 10 г, жиры 4 г, углеводы 11 г, 120 ккал' }] }), true).nutrition, null);
  assert.equal(normalize(item({ properties: [{ name: 'Ценность на 100 г', value: 'белки 10 г<br>другой производитель' }] }), true).nutrition, null);
  assert.equal(normalize(item({ url: 'javascript:alert(1)' }), true).url, null);
  assert.throws(() => payload({ content: [{ type: 'text', text: 'unstructured text' }] }));
});
test('portion calories and purchased packages are separate; missing data is never zero', () => {
  const product = normalize(item(), true);
  const entries = [{ product, grams: 100 }, { product, grams: 100 }];
  const summary = quote(entries);
  assert.equal(summary.lines.length, 1);
  assert.equal(summary.lines[0].quantity, 2);
  assert.equal(summary.lines[0].leftoverGrams, 160);
  assert.equal(summary.total, 200);
  assert.equal(summary.nutrition.kcal, 240);
  assert.equal(quote([{ product: { ...product, price: null }, grams: 100 }]).total, null);
  assert.equal(totals([{ product: { ...product, nutrition: null }, grams: 100 }]), null);
  const weighted = quote([{ product: { ...product, unit: 'кг', packageGrams: null }, grams: 155 }]);
  assert.equal(weighted.lines[0].quantity, 0.16);
  assert.equal(weighted.total, 16);
  assert.equal(weighted.estimated, true);
  const exactWeight = quote([{ product: { ...product, unit: 'кг', packageGrams: null }, grams: 1100 }]);
  assert.equal(exactWeight.lines[0].quantity, 1.1);
  assert.equal(exactWeight.total, 110);
});
test('different manufacturers produce a range; identical values stay exact', () => {
  const one = 'АО ТЕСТ А: белки 10 г, жиры 4 г, углеводы 11 г; 120 ккал';
  const two = 'АО ТЕСТ Б: белки 8 г, жиры 5 г, углеводы 12 г; 125 ккал';
  const product = normalize(item({ properties: [{ name: 'Пищевая ценность в 100 г', value: one + '<br>' + two }] }), false);
  assert.equal(product.nutrition, null);
  assert.deepEqual(product.nutritionRange.kcal, { min: 120, max: 125 });
  assert.equal(product.nutritionVariants.length, 2);
  assert.equal(product.nutritionVariants[0].manufacturer, 'АО ТЕСТ А');
  const total = totalBounds([{ product, grams: 50 }, { product: normalize(item(), false), grams: 100 }]);
  assert.deepEqual(total.kcal, { min: 180, max: 182.5 });
  assert.deepEqual(total.protein, { min: 14, max: 15 });
  const identical = normalize(item({ properties: [{ name: 'Ценность на 100 г', value: one + '<br>' + one.replace('ТЕСТ А', 'ТЕСТ Б') }] }), false);
  assert.equal(identical.nutrition.kcal, 120);
  assert.equal(identical.nutritionRange, null);
});
test('incomplete manufacturer data never becomes a partial range or a zero total', () => {
  const product = normalize(item({ properties: [{ name: 'Ценность на 100 г', value: 'ТЕСТ А: белки 10 г, жиры 4 г, углеводы 11 г; 120 ккал<br>ТЕСТ Б: данных нет' }] }), false);
  assert.equal(product.nutrition, null);
  assert.equal(product.nutritionRange, null);
  assert.equal(totalBounds([{ product, grams: 100 }]), null);
});
test('unavailable upstream leaves empty plan slots instead of fabricated meals', async () => {
  const plan = await buildPlan(async () => { throw new Error('blocked'); }, tools, false);
  assert.equal(plan.days.length, 2);
  assert.equal(plan.problems.length, 9);
  assert.ok(plan.days.every(d => d.meals.length === 4 && d.meals.every(m => m.items.every(i => i.product === null))));
});
test('plan contains two complete days only from products actually returned', async () => {
  const queries = ['яйца', 'авокадо', 'помидоры', 'готовые блюда', 'йогурт', 'творог', 'яблоки', 'пастила', 'шоколад'];
  let calls = 0;
  const plan = await buildPlan(async (method, params) => {
    calls++; const q = params.arguments.q;
    return envelope({ items: [item({ id: queries.indexOf(q) + 1, name: q === 'яйца' ? 'Яйца тестовые' : q })], meta: { personalized: true } });
  }, tools, true);
  assert.equal(calls, 9);
  assert.ok(plan.days.every(day => day.meals.length === 4 && day.meals.every(meal => meal.items.every(i => i.product && i.grams > 0))));
  assert.ok(Object.values(plan.groups).every(pool => pool.length === 1));
});
test('draft ownership, explicit consent and duplicate confirmation', async () => {
  const { env } = environment(); const store = upstream();
  const session = { owner: 'test-owner', expiresAt: Date.now() + 3600000 };
  const draft = await createDraft(env, session, store.rpc, tools, [{ id: 1, grams: 100 }]);
  assert.ok(draft.id); assert.equal(store.count(), 0);
  await assert.rejects(() => confirmDraft(env, session, store.rpc, tools, { ...draft, confirmed: false }), /CONFIRMATION_REQUIRED/);
  assert.equal((await confirmDraft(env, { ...session, owner: 'other-owner' }, store.rpc, tools, { ...draft, confirmed: true })).error, 'DRAFT_EXPIRED');
  const input = { id: draft.id, version: draft.version, displayVersion: draft.displayVersion, confirmed: true };
  const results = await Promise.all([confirmDraft(env, session, store.rpc, tools, input), confirmDraft(env, session, store.rpc, tools, input)]);
  assert.equal(store.count(), 1);
  assert.ok(results.some(r => r.link));
  const replay = await confirmDraft(env, session, store.rpc, tools, input);
  assert.ok(replay.link); assert.equal(store.count(), 1);
});
test('changed prices or availability require a new draft and new consent', async () => {
  const { env } = environment(); const store = upstream();
  const session = { owner: 'owner', expiresAt: Date.now() + 3600000 };
  const draft = await createDraft(env, session, store.rpc, tools, [{ id: 1, grams: 100 }]);
  store.change({ price: { current: 110 } });
  assert.equal((await confirmDraft(env, session, store.rpc, tools, { ...draft, confirmed: true })).error, 'DRAFT_CHANGED');
  assert.equal(store.count(), 0);
  store.change({ available_quantity: 0 });
  const missing = await createDraft(env, session, store.rpc, tools, [{ id: 1, grams: 100 }]);
  assert.equal(missing.error, 'CART_INCOMPLETE');
});
test('unsafe returned links are rejected and a failed draft never calls again', async () => {
  const { env } = environment(); const store = upstream('https://evil.example/checkout');
  const session = { owner: 'owner', expiresAt: Date.now() + 3600000 };
  const draft = await createDraft(env, session, store.rpc, tools, [{ id: 1, grams: 100 }]);
  const input = { id: draft.id, version: draft.version, displayVersion: draft.displayVersion, confirmed: true };
  await assert.rejects(() => confirmDraft(env, session, store.rpc, tools, input), /UNSAFE_CART_LINK/);
  assert.equal((await confirmDraft(env, session, store.rpc, tools, input)).error, 'DRAFT_ALREADY_USED');
  assert.equal(store.count(), 1);
});
test('a draft expiring during the stock recheck never creates a cart link', async () => {
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    const { env } = environment(); const store = upstream();
    const session = { owner: 'owner', expiresAt: now + 60000 };
    const draft = await createDraft(env, session, store.rpc, tools, [{ id: 1, grams: 100 }]);
    const delayed = async (method, params) => {
      const response = await store.rpc(method, params);
      if (params.name === 'vkusvill_product_details') now += 61000;
      return response;
    };
    const result = await confirmDraft(env, session, delayed, tools, { ...draft, confirmed: true });
    assert.equal(result.error, 'DRAFT_EXPIRED');
    assert.equal(store.count(), 0);
  } finally { Date.now = realNow; }
});
test('an old page with rounded weights cannot confirm a new cart draft', async () => {
  const { env } = environment(); const store = upstream();
  const session = { owner: 'owner', expiresAt: Date.now() + 3600000 };
  const draft = await createDraft(env, session, store.rpc, tools, [{ id: 1, grams: 100 }]);
  const result = await confirmDraft(env, session, store.rpc, tools, { id: draft.id, version: draft.version, confirmed: true });
  assert.equal(result.error, 'CLIENT_UPDATE_REQUIRED');
  assert.equal(store.count(), 0);
});

test('personal targets use the supplied profile and consistent macro energy', async () => {
  const { dailyTarget } = await import('../../shared/targets.js');
  const target = dailyTarget();
  assert.equal(target.kcal, 1500);
  assert.equal(target.protein, 101);
  assert.equal(target.fat, 58);
  assert.equal(target.carbs, 144);
  assert.ok(Math.abs(target.protein * 4 + target.fat * 9 + target.carbs * 4 - target.kcal) < 5);
});
test('balancing improves daily fit, preserves full ready packages and a chosen replacement', async () => {
  const { balanceDay, assessment } = await import('../../shared/targets.js');
  const product = (id, grams, kcal) => ({ id, packageGrams: grams, availability: 'available', nutrition: { kcal, protein: 10, fat: 5, carbs: 15 } });
  const small = product(1, 100, 100), large = product(2, 300, 100);
  const target = { kcal: 600, protein: 60, fat: 30, carbs: 90 };
  const first = { group: 'ready', product: small, grams: 100 };
  const second = { group: 'ready', product: small, grams: 100 };
  const day = { meals: [{ items: [first, second] }] };
  balanceDay(day, { ready: [small, large] }, target);
  assert.equal(assessment(day, target).status, 'within');
  assert.equal(first.grams, first.product.packageGrams);
  first.product = small; first.grams = 100;
  balanceDay(day, { ready: [small, large] }, target, first);
  assert.equal(first.product.id, 1);
  assert.equal(first.grams, 100);
  first.product = { ...small, nutrition: null };
  assert.equal(assessment(day, target).status, 'unknown');
  first.product = { ...small, nutrition: null, nutritionRange: Object.fromEntries(Object.keys(target).map(k => [k, { min: 0, max: target[k] * 3 }])) };
  assert.equal(assessment(day, target).status, 'outside');
});

test('blocked products are excluded from plan candidates and invalid preferences fail before catalog calls', async () => {
  const source = upstream();
  const plan = await buildPlan(source.rpc, tools, true, { blocked: [1] });
  assert.equal(plan.groups.ready.length, 0);
  assert.ok(plan.days.flatMap(d => d.meals.flatMap(m => m.items)).every(i => i.product === null));
  await assert.rejects(buildPlan(() => { throw new Error('must not call'); }, tools, true, { blocked: ['1'] }), /INVALID_PREFERENCES/);
});

test('equivalent meals prefer a fresh product over recently eaten food', async () => {
  const { balanceDay } = await import('../../shared/targets.js');
  const base = { packageGrams: 200, availability: 'available', nutrition: { kcal: 200, protein: 10, fat: 8, carbs: 22 } };
  const recent = { ...base, id: 1 }, fresh = { ...base, id: 2 };
  const selected = { group: 'yogurt', product: recent, grams: 200 };
  const day = { meals: [{ items: [selected] }] };
  balanceDay(day, { yogurt: [recent, fresh] }, { kcal: 400, protein: 20, fat: 16, carbs: 44 }, null, { recent: [1] });
  assert.equal(selected.product.id, 2);
});
