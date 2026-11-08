import { search } from './catalog.js';
export const GROUPS = Object.freeze([
  { key: 'eggs', query: 'яйца', label: 'Яйца', grams: 110 },
  { key: 'avocado', query: 'авокадо', label: 'Авокадо', grams: 70 },
  { key: 'vegetables', query: 'помидоры', label: 'Овощи', grams: 150 },
  { key: 'ready', query: 'готовые блюда', label: 'Готовые блюда', grams: null },
  { key: 'yogurt', query: 'йогурт', label: 'Йогурт', grams: null },
  { key: 'curd', query: 'творог', label: 'Творог', grams: 150 },
  { key: 'fruit', query: 'яблоки', label: 'Фрукты', grams: 150 },
  { key: 'pastila', query: 'пастила', label: 'Пастила', grams: 25 },
  { key: 'sweet', query: 'шоколад', label: 'Сладкое', grams: 15 }
]);
export { nutrients, totals, quote } from '../../shared/food.js';
const ready = product => product.categories.some(c => /готов|кулинар/iu.test(c));
function suitable(product, group) {
  if (product.availability === 'unavailable') return false;
  const name = product.name.toLowerCase();
  if (group === 'ready') return ready(product) && !(product.packageGrams > 700);
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
export async function buildPlan(rpc, tools, authenticated) {
  const groups = {}, problems = [];
  // Sequential calls respect upstream pressure. A failed group remains missing, never synthetic.
  for (const group of GROUPS) {
    try {
      groups[group.key] = (await search(rpc, tools, group.query, authenticated))
        .filter(p => suitable(p, group.key));
      if (group.key === 'ready') {
        // A ranking preference, not a claim that the full day meets a calorie target.
        const score = p => p.nutrition && p.packageGrams ? Math.abs(p.nutrition.kcal * p.packageGrams / 100 - 450) : Infinity;
        groups.ready.sort((a, b) => score(a) - score(b));
      }
    } catch { groups[group.key] = []; problems.push(group.label); }
  }
  const days = [];
  for (let day = 0; day < 2; day++) {
    const meals = [];
    for (const [name, keys] of [['Завтрак', ['eggs', 'avocado', 'vegetables']], ['Обед', ['ready']], ['Ужин', ['ready']], ['Перекусы', [day ? 'curd' : 'yogurt', 'fruit', day ? 'sweet' : 'pastila']]]) {
      const items = keys.map(key => {
        const group = GROUPS.find(g => g.key === key);
        const pool = groups[key];
        const index = key === 'ready' ? day * 2 + (name === 'Ужин' ? 1 : 0) : ['eggs', 'avocado', 'vegetables'].includes(key) ? 0 : day;
        const product = pool[index % pool.length] || null;
        return { group: key, label: group.label, product, grams: product ? group.grams || product.packageGrams || null : null };
      });
      meals.push({ name, items });
    }
    days.push({ day: day + 1, meals });
  }
  return { days, groups, problems, portionsAreSuggestions: true, deliveryAvailability: authenticated ? 'see_products' : 'unverified', checkedAt: new Date().toISOString() };
}
