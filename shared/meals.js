import { nutrientBounds, totalBounds } from './food.js';
import { reviewPenalty } from './reviews.js';
// Practical defaults for this profile, not a universal definition of a healthy meal.
export const MEAL_LIMITS = Object.freeze({ minKcal: 350, maxKcal: 600, minProtein: 20, maxFat: 25 });
export const MAX_PACK_GRAMS = Object.freeze({ ready: 450, soup: 450, salad: 300 });
export function preparedComponent(product, group) {
  if (!product || product.availability === 'unavailable' || !Number.isFinite(product.packageGrams) || product.packageGrams <= 0 || product.packageGrams > (MAX_PACK_GRAMS[group] || 0)) return false;
  const categories = (product.categories || []).join(' '), name = product.name || '';
  if (!/готов|кулинар|вторые блюда|первые блюда|салаты/iu.test(categories)) return false;
  if (/заморож|полуфабрикат/iu.test(categories + ' ' + name) || /(?:^|[\s,(])зам\.|сыр(?:ой|ые|ая)(?:\s|$)|для жарки|для запекания|сухая смесь/iu.test(name)) return false;
  if (group === 'salad') return /салат|винегрет/iu.test(name);
  if (group === 'soup') return /суп|борщ|солянк|рассольник|(?:^|\s)уха(?:\s|$)|(?:^|\s)щи(?:\s|$)|бульон/iu.test(name);
  return !/салат|суп|борщ|бульон|сырник|блин|десерт|торт|каша|хашбраун/iu.test(name);
}
export function componentPortions(product, group) {
  if (!preparedComponent(product, group)) return [];
  const pack = product.packageGrams;
  const proposed = group === 'soup' ? [250, 300, 350, 400] : group === 'salad' ? [100, 150, 200] : [150, 200, 250];
  if (pack <= (group === 'soup' ? 400 : 350)) proposed.push(pack);
  return [...new Set(proposed.filter(g => g <= pack && g > 0))];
}
const fits = bounds => bounds.kcal.min >= MEAL_LIMITS.minKcal && bounds.kcal.max <= MEAL_LIMITS.maxKcal && bounds.protein.min >= MEAL_LIMITS.minProtein && bounds.fat.max <= MEAL_LIMITS.maxFat;
export function mainMealCheck(meal) {
  const items = meal.items || [];
  const combination = items.length === 2 && items.some(i => i.group === 'salad') && items.some(i => i.group === 'ready' || i.group === 'soup');
  if (!combination) return { status: 'incomplete', bounds: null };
  if (items.some(i => !preparedComponent(i.product, i.group) || !Number.isFinite(i.grams) || i.grams <= 0 || i.grams > i.product.packageGrams)) return { status: 'unsuitable', bounds: null };
  const bounds = totalBounds(items);
  if (!bounds) return { status: 'unknown', bounds: null };
  const suitable = fits(bounds);
  return { status: suitable ? 'suitable' : 'outside', bounds };
}
export function completeMeals(groups, preferences = {}) {
  const blocked = preferences.blocked || [], recent = preferences.recent || [], liked = preferences.liked || [];
  const pool = key => (groups[key] || []).filter(p => preparedComponent(p, key) && !blocked.includes(p.id)).flatMap(product => componentPortions(product, key).map(grams => ({ product, grams, bounds: nutrientBounds(product, grams) })).filter(row => row.bounds));
  const salads = pool('salad'), result = [];
  const preferenceCost = product => reviewPenalty(product) + (recent.includes(product.id) ? 0.04 : 0) - (liked.includes(product.id) ? 0.01 : 0);
  for (const group of ['ready', 'soup']) for (const main of pool(group)) for (const salad of salads) {
    const bounds = Object.fromEntries(['kcal', 'protein', 'fat', 'carbs'].map(k => [k, { min: main.bounds[k].min + salad.bounds[k].min, max: main.bounds[k].max + salad.bounds[k].max }]));
    if (!fits(bounds)) continue;
    const items = [{ group, label: group === 'soup' ? 'Суп' : 'Второе', product: main.product, grams: main.grams }, { group: 'salad', label: 'Салат', product: salad.product, grams: salad.grams }];
    const midpoint = key => (bounds[key].min + bounds[key].max) / 2;
    const cost = Math.abs(midpoint('kcal') - 425) / 425 + 0.2 * Math.abs(midpoint('protein') - 30) / 30 + preferenceCost(main.product) + preferenceCost(salad.product);
    result.push({ items, bounds, cost });
  }
  result.sort((a, b) => a.cost - b.cost);
  // Preserve different dishes, rather than filling the shortlist with portions of one pair.
  const seen = new Set(), shortlist = [];
  for (const option of result) {
    const key = option.items.map(i => i.product.id).join(':');
    if (seen.has(key)) continue;
    seen.add(key); shortlist.push(option);
    if (shortlist.length >= 40) break;
  }
  return shortlist;
}
export function replacementPortion(meal, item, product) {
  let best = null, distance = Infinity;
  for (const grams of componentPortions(product, item.group)) {
    const candidate = { items: meal.items.map(i => i === item ? { ...i, product, grams } : i) };
    const check = mainMealCheck(candidate);
    if (check.status !== 'suitable') continue;
    const score = Math.abs((check.bounds.kcal.min + check.bounds.kcal.max) / 2 - 425);
    if (score < distance) { distance = score; best = grams; }
  }
  return best;
}
