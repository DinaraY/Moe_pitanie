import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEntry, cleanJournal, remainingToday, preferences, validDate, validatePreferences, localDate } from '../../shared/journal.js';
import { dailyTarget } from '../../shared/targets.js';
const today = '2026-11-09';
const product = { id: 7, name: 'Синтетическое тестовое блюдо', nutrition: { kcal: 200, protein: 10, fat: 8, carbs: 22 } };
const entry = (overrides = {}) => ({ ...makeEntry(product, 150, today, 'test-id', today), ...overrides });
test('diary snapshots eaten portions, calculates ranges and preserves unknown nutrition', () => {
  const saved = entry();
  product.nutrition.kcal = 300;
  assert.equal(saved.product.nutrition.kcal, 200);
  product.nutrition.kcal = 200;
  const result = remainingToday({ entries: [saved] }, dailyTarget(), today);
  assert.equal(result.eaten.kcal.min, 300);
  assert.equal(result.remaining.kcal.min, 1200);
  assert.equal(remainingToday({ entries: [] }, dailyTarget(), today).remaining.kcal.min, 1500);
  const unknown = entry({ product: { ...product, nutrition: null } });
  assert.equal(remainingToday({ entries: [unknown] }, dailyTarget(), today).remaining, null);
  const excess = entry({ grams: 1000 });
  assert.equal(remainingToday({ entries: [excess] }, dailyTarget(), today).remaining.kcal.min, -500);
  const ranged = entry({ product: { ...product, nutrition: null, nutritionRange: Object.fromEntries(Object.entries(product.nutrition).map(([k,v]) => [k, { min: v, max: v + 10 }])) } });
  const range = remainingToday({ entries: [ranged] }, dailyTarget(), today);
  assert.deepEqual(range.remaining.kcal, { min: 1185, max: 1200 });
});
test('dates use local calendar and reject future, impossible and old entries', () => {
  assert.equal(localDate(new Date(2026, 10, 9, 0, 1)), today);
  for (const date of ['2026-11-10', '2026-02-30', '2026-07-01', 'bad']) {
    assert.equal(validDate(date, today), false);
    assert.throws(() => makeEntry(product, 100, date, 'test', today));
  }
  assert.throws(() => makeEntry(product, 0, today, 'test', today));
  assert.throws(() => makeEntry(product, 5001, today, 'test', today));
});
test('restoring untrusted storage prunes invalid entries and sends only preference IDs', () => {
  const journal = cleanJournal({ entries: [entry(), { ...entry(), grams: -10 }, { ...entry(), date: '2026-01-01' }], ratings: { 7: 'liked', 8: 'blocked', 9: 'bogus', bad: 'liked' } }, today);
  assert.equal(journal.entries.length, 1);
  assert.deepEqual(preferences(journal, today), { liked: [7], blocked: [8], recent: [7] });
  assert.deepEqual(cleanJournal(null), { entries: [], ratings: {} });
  assert.throws(() => validatePreferences({ blocked: ['7'] }));
  assert.throws(() => validatePreferences({ recent: Array(501).fill(1) }));
});

test('recent preferences use seven calendar days and ignore older meals', () => {
  const journal = { entries: [entry(), entry({ date: '2026-10-30', product: { ...product, id: 8 } })], ratings: {} };
  assert.deepEqual(preferences(journal, today).recent, [7]);
});
