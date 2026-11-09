import { preparedComponent, completeMeals } from '../../shared/meals.js';
import { reviewPenalty } from '../../shared/reviews.js';
import { search } from './catalog.js';
import { validatePreferences } from '../../shared/journal.js';
import { dailyTarget, balanceDay } from '../../shared/targets.js';
export const GROUPS = Object.freeze([
  { key: 'eggs', query: 'яйца', label: 'Яйца', grams: 110 },
  { key: 'avocado', query: 'авокадо', label: 'Авокадо', grams: 70 },
  { key: 'vegetables', query: 'помидоры', label: 'Овощи', grams: 150 },
  { key: 'ready', query: 'готовые блюда', label: 'Второе', grams: null },
  { key: 'salad', query: 'салат', label: 'Салат', grams: null },
  { key: 'soup', query: 'суп', label: 'Суп', grams: null },
  { key: 'yogurt', query: 'йогурт', label: 'Йогурт', grams: null },
  { key: 'curd', query: 'творог', label: 'Творог', grams: 150 },
  { key: 'fruit', query: 'яблоки', label: 'Фрукты', grams: 150 },
  { key: 'pastila', query: 'пастила', label: 'Пастила', grams: 25 },
  { key: 'sweet', query: 'шоколад', label: 'Сладкое', grams: 15 }
]);
export { nutrients, totals, quote } from '../../shared/food.js';
function suitable(product, group) {
  if (product.availability === 'unavailable') return false;
  const name = product.name.toLowerCase();
  if (['ready', 'salad', 'soup'].includes(group)) return preparedComponent(product, group);
  const rules = {
    eggs: [/яйц/iu, /шоколад|салат|лапш|майонез|соус/iu],
    avocado: [/авокадо/iu, /соус|салат|ролл|масло/iu],
    vegetables: [/помидор|томат/iu, /сок|соус|паст|суш|вялен/iu],
    yogurt: [/йогурт/iu, /соус|салат/iu],
    curd: [/творог/iu, /салат|соус/iu],
    fruit: [/яблок/iu, /сок|пюре|суш|компот|салат|чипс|пастил/iu],
    pastila: [/пастил/iu, /торт/iu],
    sweet: [/шоколад/iu, /напиток|какао|порошок/iu]
  };
  return rules[group][0].test(name) && !rules[group][1].test(name);
}
export async function buildPlan(rpc, tools, authenticated, inputPreferences = {}) {
  const preference = validatePreferences(inputPreferences);
  const groups = {}, problems = [];
  // Sequential calls respect upstream pressure. A failed group remains missing, never synthetic.
  for (const group of GROUPS) {
    try {
      groups[group.key] = (await search(rpc, tools, group.query, authenticated))
        .filter(p => suitable(p, group.key) && !preference.blocked.includes(p.id));
      const preferenceScore = p => (preference.recent.includes(p.id) ? 2 : 0) - (preference.liked.includes(p.id) ? 1 : 0);
      groups[group.key].sort((a, b) => preferenceScore(a) - preferenceScore(b) || reviewPenalty(a) - reviewPenalty(b));
      if (group.key === 'ready') {
        // A ranking preference, not a claim that the full day meets a calorie target.
        const score = p => p.nutrition && p.packageGrams ? Math.abs(p.nutrition.kcal * p.packageGrams / 100 - 450) / 450 + reviewPenalty(p) : Infinity;
        groups.ready.sort((a, b) => preferenceScore(a) - preferenceScore(b) || score(a) - score(b));
      }
    } catch { groups[group.key] = []; problems.push(group.label); }
  }
  const mealOptions = completeMeals(groups, preference);
  const usedMains = new Map();
  const target = dailyTarget();
  const days = [];
  for (let day = 0; day < 2; day++) {
    const meals = [];
    for (const [name, keys] of [['Завтрак', ['eggs', 'avocado', 'vegetables']], ['Обед', ['ready']], ['Ужин', ['ready']], ['Перекусы', [day ? 'curd' : 'yogurt', 'fruit', day ? 'sweet' : 'pastila']]]) {
      if (name === 'Обед' || name === 'Ужин') {
        const choice = [...mealOptions].sort((a, b) => a.cost + (usedMains.get(a.items[0].product.id) || 0) * 0.5 - b.cost - (usedMains.get(b.items[0].product.id) || 0) * 0.5)[0];
        if (choice) usedMains.set(choice.items[0].product.id, (usedMains.get(choice.items[0].product.id) || 0) + 1);
        meals.push({ name, items: choice ? choice.items.map(i => ({ ...i })) : [{ group: 'ready', label: 'Салат и второе или салат и суп: сочетание не найдено', product: null, grams: null }] });
        continue;
      }
      const items = keys.map(key => {
        const group = GROUPS.find(g => g.key === key);
        const pool = groups[key];
        const index = key === 'ready' ? day * 2 + (name === 'Ужин' ? 1 : 0) : ['eggs', 'avocado', 'vegetables'].includes(key) ? 0 : day;
        const product = pool[index % pool.length] || null;
        return { group: key, label: group.label, product, grams: product ? group.grams || product.packageGrams || null : null };
      });
      meals.push({ name, items });
    }
    const result = { day: day + 1, meals };
    result.assessment = balanceDay(result, groups, target, null, preference);
    days.push(result);
  }
  return { preferences: preference, target, days, groups, problems, portionsAreSuggestions: true, deliveryAvailability: authenticated ? 'see_products' : 'unverified', checkedAt: new Date().toISOString() };
}
