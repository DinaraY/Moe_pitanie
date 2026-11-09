import { reviewPenalty } from './reviews.js';
import { totalBounds, nutrientBounds } from './food.js';

// Mifflin–St Jeor, female profile supplied by the user. Targets are estimates.
export function dailyTarget() {
  const bmr = 10 * 72 + 6.25 * 167 - 5 * 43 - 161;
  const maintenance = bmr * 1.3;
  const kcal = Math.round((maintenance - 300) / 50) * 50;
  const protein = Math.round(72 * 1.4);
  const fat = Math.round(72 * 0.8);
  return { kcal, protein, fat, carbs: Math.round((kcal - protein * 4 - fat * 9) / 4), bmr: Math.round(bmr), maintenance: Math.round(maintenance), deficit: 300 };
}
export function assessment(day, target = dailyTarget()) {
  const items = day.meals.flatMap(m => m.items);
  if (items.some(i => !i.product)) return { status: 'unknown', bounds: null };
  const bounds = totalBounds(items);
  if (!bounds) return { status: 'unknown', bounds: null };
  const fits = Object.keys(bounds).every(k => bounds[k].min >= target[k] * 0.9 && bounds[k].max <= target[k] * 1.1);
  return { status: fits ? 'within' : 'outside', bounds };
}
function score(day, target) {
  const { bounds } = assessment(day, target);
  if (!bounds) return Infinity;
  return Object.keys(bounds).reduce((s, k) => s + (k === 'kcal' ? 3 : 1) * Math.max(...['min', 'max'].map(edge => ((bounds[k][edge] - target[k]) / target[k]) ** 2)), 0);
}
const portions = {
  eggs: [110], avocado: [40, 55, 70, 85], vegetables: [150, 200, 250],
  curd: [100, 150, 200], fruit: [150, 200, 250], pastila: [15, 25, 35], sweet: [10, 15, 20]
};
// Bounded coordinate search; whole packages for ready meals and yogurt.
// A locked replacement keeps the user's choice while other portions adapt.
export function balanceDay(day, groups, target = dailyTarget(), locked = null, preferences = {}) {
  const items = day.meals.flatMap(m => m.items);
  const preferencePenalty = product => (preferences.recent?.includes(product.id) ? 0.04 : 0) - (preferences.liked?.includes(product.id) ? 0.01 : 0) + reviewPenalty(product);
  if (!Number.isFinite(score(day, target))) return assessment(day, target);
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const item of items) {
      if (item === locked) continue;
      const original = { product: item.product, grams: item.grams };
      let best = original, bestScore = score(day, target) + preferencePenalty(item.product);
      const pool = groups[item.group] || [];
      for (const product of pool) {
        if (product.availability === 'unavailable' || preferences.blocked?.includes(product.id)) continue;
        const weights = portions[item.group] || [product.packageGrams];
        for (const grams of weights) {
          if (!nutrientBounds(product, grams)) continue;
          item.product = product; item.grams = grams;
          let candidate = score(day, target) + preferencePenalty(product);
          if (item.group === 'ready' && items.some(other => other !== item && other.group === 'ready' && other.product?.id === product.id)) candidate += 0.02;
          if (candidate < bestScore - 0.000001) { bestScore = candidate; best = { product, grams }; }
        }
      }
      Object.assign(item, best);
      if (best.product !== original.product || best.grams !== original.grams) changed = true;
    }
    if (!changed) break;
  }
  return assessment(day, target);
}
