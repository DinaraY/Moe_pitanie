import { dailyTarget } from './targets.js';
import { nutrientBounds } from './food.js';
import { validatePreferences } from './journal.js';
import { reviewPenalty } from './reviews.js';
export const MEALS = Object.freeze({ breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин', snack: 'Перекус' });
const KEYS = ['kcal', 'protein', 'fat', 'carbs'];
export function validateToday(input) {
  if (!input || !Array.isArray(input.slots) || !input.slots.length || input.slots.length > 4 || new Set(input.slots).size !== input.slots.length || input.slots.some(k => typeof k !== 'string' || !Object.hasOwn(MEALS, k))) throw new Error('INVALID_TODAY');
  const preferences = validatePreferences(input.preferences);
  if (input.eaten !== null && (!input.eaten || KEYS.some(k => !Number.isFinite(input.eaten[k]?.min) || !Number.isFinite(input.eaten[k]?.max) || input.eaten[k].min < 0 || input.eaten[k].max < input.eaten[k].min || input.eaten[k].max > 30000))) throw new Error('INVALID_TODAY');
  return { eaten: input.eaten, slots: input.slots, preferences };
}
const add = (a, b) => Object.fromEntries(KEYS.map(k => [k, { min: a[k].min + b[k].min, max: a[k].max + b[k].max }]));
const zero = () => Object.fromEntries(KEYS.map(k => [k, { min: 0, max: 0 }]));
export function boundsFor(items) {
  let bounds = zero();
  for (const item of items) {
    const value = item.product && nutrientBounds(item.product, item.grams);
    if (!value) return null;
    bounds = add(bounds, value);
  }
  return bounds;
}
export function dayScore(bounds, target = dailyTarget()) {
  let score = 0;
  for (const k of KEYS) { const lo = (bounds[k].min - target[k]) / target[k], hi = (bounds[k].max - target[k]) / target[k]; score += (k === 'kcal' ? 3 : 1) * Math.max(lo * lo, hi * hi); }
  return score;
}
function preferenceCost(items, preferences) {
  return items.reduce((sum, { product: p }) => sum + reviewPenalty(p) + (preferences.recent.includes(p.id) ? 0.04 : 0) - (preferences.liked.includes(p.id) ? 0.01 : 0), 0);
}
export function todayOptions(groups, context) {
  const options = {};
  const pool = key => (groups[key] || []).filter(p => p.availability !== 'unavailable' && !context.preferences.blocked.includes(p.id));
  const item = (group, product, grams) => ({ group, label: group, product, grams });
  for (const key of context.slots) {
    let combinations = [];
    if (key === 'breakfast') {
      for (const egg of pool('eggs')) for (const avocado of pool('avocado')) for (const veg of pool('vegetables')) combinations.push([item('eggs', egg, 110), item('avocado', avocado, 55), item('vegetables', veg, 150)]);
    } else if (key === 'lunch' || key === 'dinner') {
      combinations = pool('ready').map(p => [item('ready', p, p.packageGrams)]);
    } else {
      for (const group of ['yogurt', 'curd', 'fruit', 'pastila', 'sweet']) {
        for (const p of pool(group)) {
          const grams = { yogurt: [p.packageGrams], curd: [100, 150, 200], fruit: [150, 200], pastila: [15, 25], sweet: [10, 15] }[group];
          for (const weight of grams) combinations.push([item(group, p, weight)]);
        }
      }
    }
    options[key] = combinations.map(items => ({ items, bounds: boundsFor(items) })).filter(o => o.bounds).map((option, i) => ({ ...option, id: `${key}_${i}`, preferenceCost: preferenceCost(option.items, context.preferences) }));
  }
  return options;
}
export function resultFor(chosen, context, engine = 'algorithm') {
  const target = dailyTarget();
  const bounds = chosen.reduce((value, option) => add(value, option.bounds), zero());
  const dayBounds = add(context.eaten, bounds);
  const status = KEYS.every(k => dayBounds[k].min >= target[k] * 0.9 && dayBounds[k].max <= target[k] * 1.1) ? 'within' : 'outside';
  return { status, engine, target, eaten: context.eaten, bounds, dayBounds, score: dayScore(dayBounds, target), meals: chosen.map((o, i) => ({ key: context.slots[i], name: MEALS[context.slots[i]], optionId: o.id, items: o.items })) };
}
export function suggestToday(groups, input) {
  const context = validateToday(input), target = dailyTarget();
  if (!context.eaten) return { status: 'unknown', meals: [], target, engine: 'algorithm' };
  if (context.eaten.kcal.min >= target.kcal) return { status: 'target_reached', meals: [], target, engine: 'algorithm' };
  const options = todayOptions(groups, context);
  const missing = context.slots.filter(k => !options[k].length);
  if (missing.length) return { status: 'missing_nutrition', missing, meals: [], target, engine: 'algorithm' };
  let beam = [{ chosen: [], bounds: context.eaten, cost: 0, rank: 0 }];
  for (const key of context.slots) {
    const next = [];
    for (const state of beam) {
      const ids = state.chosen.flatMap(o => o.items.map(i => i.product.id));
      for (const option of options[key]) {
        const bounds = add(state.bounds, option.bounds);
        const repeat = option.items.some(i => ids.includes(i.product.id)) ? 0.02 : 0;
        const cost = state.cost + option.preferenceCost + repeat;
        next.push({ chosen: [...state.chosen, option], bounds, cost, rank: dayScore(bounds, target) + cost });
      }
    }
    next.sort((a, b) => a.rank - b.rank);
    beam = next.slice(0, 20);
  }
  return resultFor(beam[0].chosen, context);
}
