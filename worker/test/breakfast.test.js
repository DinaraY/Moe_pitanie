import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakfastIngredient, breakfastOptions } from '../../shared/breakfast.js';
import { suggestToday } from '../../shared/today.js';
import { aiSuggest } from '../src/assistant.js';
import { environment } from './helpers.js';

// Synthetic fixtures, never published as store data.
const product = (id, name, nutrition, packageGrams = 200) => ({ id, name, nutrition, packageGrams, unit: 'шт', availability: 'available', categories: ['Готовая еда'] });
const egg = product(1, 'Яйцо куриное С1', { kcal: 157, protein: 12.7, fat: 11.5, carbs: 0.7 }, 600);
const avocado = product(2, 'Авокадо Хасс', { kcal: 160, protein: 2, fat: 14.7, carbs: 8.5 });
const vegetables = product(3, 'Томаты черри', { kcal: 20, protein: 1, fat: 0.2, carbs: 4 });
const omelet = product(4, 'Омлет с овощами', { kcal: 150, protein: 10, fat: 9, carbs: 7 });
const curd = product(5, 'Творог 5%', { kcal: 121, protein: 17, fat: 5, carbs: 2 });
const yogurt = product(6, 'Йогурт греческий', { kcal: 76, protein: 7.5, fat: 4, carbs: 2.5 }, 250);
const groups = { eggs: [egg], avocado: [avocado], vegetables: [vegetables], breakfastReady: [omelet], curd: [curd], yogurt: [yogurt] };
const input = { slots: ['breakfast', 'snack'], eaten: Object.fromEntries(['kcal', 'protein', 'fat', 'carbs'].map(k => [k, { min: 0, max: 0 }])) };

test('preferred egg breakfast is preserved when its food and nutrition are verified', () => {
  const options = breakfastOptions(groups);
  assert.equal(options.length, 1);
  assert.deepEqual(options[0].items.map(i => i.product.id), [1, 2, 3]);
  assert.equal(options[0].note, undefined);
});
test('missing avocado nutrition falls back to a complete modest breakfast, preserving every requested meal', async () => {
  const incomplete = { ...groups, avocado: [{ ...avocado, nutrition: null }] };
  const options = breakfastOptions(incomplete);
  assert.ok(options.some(o => o.items[0].product.id === omelet.id));
  assert.ok(options.some(o => o.items[0].product.id === curd.id));
  assert.ok(options.every(o => o.bounds.kcal.min >= 250 && o.bounds.kcal.max <= 450 && o.bounds.protein.min >= 15 && o.items.every(i => i.grams <= i.product.packageGrams)));
  const baseline = suggestToday(incomplete, input);
  assert.deepEqual(baseline.meals.map(m => m.key), input.slots);
  assert.match(baseline.meals[0].note, /Завтрак заменён/);
  assert.equal(incomplete.avocado[0].nutrition, null);
  const env = { ...environment().env, AI_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-key' };
  let calls = 0;
  const result = await aiSuggest(env, input, incomplete, baseline, async (url, request) => {
    calls++;
    const offered = JSON.parse(JSON.parse(request.body).input).options;
    assert.ok(offered.breakfast.length);
    assert.ok(offered.breakfast.every(o => o.items.every(i => i.id !== avocado.id)));
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ choices: baseline.meals.map(m => ({ meal: m.key, optionId: m.optionId })) }) }] }] });
  });
  assert.equal(calls, 1);
  assert.equal(result.engine, 'ai');
  assert.match(result.meals[0].note, /Завтрак заменён/);
});
test('breakfast rejects misleading search matches, oversized and frozen omelets', () => {
  for (const name of ['Шампунь для волос Авокадо', 'Сыр творожный с авокадо', 'Масло авокадо']) assert.equal(breakfastIngredient({ ...avocado, name }, 'avocado'), false);
  assert.equal(breakfastIngredient({ ...vegetables, name: 'Томаты протёртые' }, 'vegetables'), false);
  assert.equal(breakfastIngredient({ ...egg, name: 'Яйцо шоколадное' }, 'eggs'), false);
  for (const p of [{ ...omelet, packageGrams: 1000 }, { ...omelet, name: 'Омлет, зам.' }]) assert.deepEqual(breakfastOptions({ breakfastReady: [p] }), []);
});
test('alternatives honor exclusions, availability, ranges and missing nutrition', () => {
  assert.deepEqual(breakfastOptions({ breakfastReady: [omelet] }, { blocked: [omelet.id] }), []);
  assert.deepEqual(breakfastOptions({ breakfastReady: [{ ...omelet, availability: 'unavailable' }] }), []);
  const unknown = { breakfastReady: [{ ...omelet, nutrition: null }], avocado: [{ ...avocado, nutrition: null }] };
  assert.deepEqual(breakfastOptions(unknown), []);
  assert.equal(suggestToday(unknown, input).status, 'missing_nutrition');
  const range = { ...omelet, nutrition: null, nutritionRange: Object.fromEntries(Object.entries(omelet.nutrition).map(([k, v]) => [k, { min: v, max: k === 'kcal' ? 400 : v }])) };
  assert.deepEqual(breakfastOptions({ breakfastReady: [range] }), []);
  const safeRange = { ...range, nutritionRange: { ...range.nutritionRange, kcal: { min: 150, max: 160 } } };
  assert.ok(breakfastOptions({ breakfastReady: [safeRange] }).length > 0);
  assert.ok(breakfastOptions({ breakfastReady: [safeRange] }).every(o => o.bounds.kcal.max > o.bounds.kcal.min));
});
