import { totalBounds } from './food.js';
const DAY = 86400000;
export const JOURNAL_KEY = 'moe-pitanie.journal.v1';
export const localDate = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const validId = id => Number.isSafeInteger(id) && id > 0;
export function validDate(date, today = localDate()) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const stamp = Date.parse(date + 'T12:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === date && date <= today && Date.parse(today + 'T12:00:00Z') - stamp < 90 * DAY;
}
export function emptyJournal() { return { entries: [], ratings: {} }; }
export function cleanJournal(value, today = localDate()) {
  const result = emptyJournal();
  if (!value || typeof value !== 'object') return result;
  for (const entry of Array.isArray(value.entries) ? value.entries.slice(-500) : []) {
    try { result.entries.push(makeEntry(entry.product, entry.grams, entry.date, entry.id, today)); } catch {}
  }
  for (const [id, rating] of Object.entries(value.ratings || {}).slice(0, 500)) {
    if (validId(Number(id)) && ['liked', 'blocked'].includes(rating)) result.ratings[id] = rating;
  }
  return result;
}
export function makeEntry(product, grams, date, id, today = localDate()) {
  if (!validId(product?.id) || typeof product.name !== 'string' || !product.name.trim() || !Number.isFinite(grams) || grams <= 0 || grams > 5000 || !validDate(date, today) || typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw new Error('INVALID_DIARY_ENTRY');
  const snapshot = { id: product.id, name: product.name.slice(0, 200), nutrition: null, nutritionRange: null };
  const valid = n => ['kcal', 'protein', 'fat', 'carbs'].every(k => Number.isFinite(n?.[k]) && n[k] >= 0 && n[k] <= 1000);
  if (valid(product.nutrition)) snapshot.nutrition = { ...product.nutrition };
  else if (product.nutritionRange && ['kcal', 'protein', 'fat', 'carbs'].every(k => Number.isFinite(product.nutritionRange[k]?.min) && Number.isFinite(product.nutritionRange[k]?.max) && product.nutritionRange[k].min >= 0 && product.nutritionRange[k].max <= 1000 && product.nutritionRange[k].max >= product.nutritionRange[k].min)) snapshot.nutritionRange = structuredClone(product.nutritionRange);
  return { id, date, grams, product: snapshot };
}
export function remainingToday(journal, target, today = localDate()) {
  const entries = journal.entries.filter(e => e.date === today);
  const eaten = entries.length ? totalBounds(entries) : Object.fromEntries(['kcal', 'protein', 'fat', 'carbs'].map(k => [k, { min: 0, max: 0 }]));
  if (!eaten) return { eaten: null, remaining: null };
  const remaining = Object.fromEntries(Object.entries(eaten).map(([k, v]) => [k, { min: Math.round((target[k] - v.max) * 10) / 10, max: Math.round((target[k] - v.min) * 10) / 10 }]));
  return { eaten, remaining };
}
export function preferences(journal, today = localDate()) {
  const cutoff = Date.parse(today + 'T12:00:00Z') - 7 * DAY;
  return {
    blocked: Object.keys(journal.ratings).filter(id => journal.ratings[id] === 'blocked').map(Number),
    liked: Object.keys(journal.ratings).filter(id => journal.ratings[id] === 'liked').map(Number),
    recent: [...new Set(journal.entries.filter(e => Date.parse(e.date + 'T12:00:00Z') >= cutoff).map(e => e.product.id))].slice(-100)
  };
}
export function validatePreferences(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_PREFERENCES');
  const result = {};
  for (const key of ['blocked', 'liked', 'recent']) {
    const ids = value[key] ?? [];
    if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => !validId(id))) throw new Error('INVALID_PREFERENCES');
    result[key] = [...new Set(ids)];
  }
  return result;
}
