import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeMeals, mainMealCheck, preparedComponent, replacementPortion } from '../../shared/meals.js';
import { buildPlan } from '../src/planner.js';
import { quote } from '../../shared/food.js';
const p = (id, name, packageGrams, nutrition, categories = ['Готовая еда']) => ({ id, name, packageGrams, nutrition, categories, unit: 'шт', price: 100, availability: 'available', availableQuantity: 10, reviews: { average: 5, count: 10000 } });
// Synthetic regression fixtures reflecting the failure shown by the user.
const hash = p(1, 'Хашбраун, зам.', 400, { kcal: 185.2, protein: 2.6, fat: 7.6, carbs: 26.6 }, ['Готовая еда: просто разогреть', 'Замороженные продукты']);
const buckwheat = p(2, 'Каша гречневая на бульоне из грибов', 170, { kcal: 181.9, protein: 4.7, fat: 7.5, carbs: 23.9 });
const main = p(3, 'Курица с рисом', 300, { kcal: 150, protein: 12, fat: 6, carbs: 15 });
const salad = p(4, 'Салат с курицей и овощами', 200, { kcal: 120, protein: 8, fat: 3, carbs: 12 });
const soup = p(5, 'Суп с курицей', 350, { kcal: 80, protein: 4, fat: 3, carbs: 10 });
const groups = { ready: [hash, buckwheat, main], salad: [salad], soup: [soup] };

test('frozen hash browns, raw food and a lone side cannot become a ready lunch', () => {
  assert.equal(preparedComponent(hash, 'ready'), false);
  assert.equal(preparedComponent({ ...hash, categories: ['Готовая еда'] }, 'ready'), false);
  assert.equal(preparedComponent({ ...main, name: 'Курица сырая', categories: ['Птица'] }, 'ready'), false);
  assert.equal(preparedComponent({ ...salad, name: 'Салат Айсберг', categories: ['Овощи'] }, 'salad'), false);
  assert.equal(mainMealCheck({ items: [{ group: 'ready', product: buckwheat, grams: 170 }] }).status, 'incomplete');
  const options = completeMeals(groups);
  assert.ok(options.length > 0);
  assert.ok(options.every(o => o.items.length === 2 && o.items.some(i => i.group === 'salad')));
  assert.ok(options.every(o => o.items.every(i => ![1,2].includes(i.product.id))));
  assert.ok(options.every(o => mainMealCheck(o).status === 'suitable'));
});
test('salad plus soup and salad plus main have validated combined calories and protein', () => {
  const options = completeMeals(groups);
  assert.ok(options.some(o => o.items[0].group === 'soup'));
  assert.ok(options.some(o => o.items[0].group === 'ready'));
  for (const option of options) {
    assert.ok(option.bounds.kcal.min >= 350 && option.bounds.kcal.max <= 600);
    assert.ok(option.bounds.protein.min >= 20 && option.bounds.fat.max <= 25);
  }
  assert.deepEqual(completeMeals({ ...groups, salad: [{ ...salad, nutrition: null }] }), []);
  assert.deepEqual(completeMeals(groups, { blocked: [4] }), []);
});
test('serving mass is distinct from package purchase and replacements preserve meal rules', () => {
  const option = completeMeals(groups).find(o => o.items[0].group === 'ready');
  assert.ok(option.items[0].grams < main.packageGrams);
  const purchase = quote(option.items);
  assert.ok(purchase.lines.every(l => l.quantity === 1));
  assert.ok(purchase.lines.some(l => l.leftoverGrams > 0));
  const item = option.items[0];
  assert.equal(replacementPortion(option, item, hash), null);
  assert.equal(replacementPortion(option, item, buckwheat), null);
  assert.ok(replacementPortion(option, item, main) > 0);
});
test('unknown breakfast nutrition does not bypass the composed-lunch checks', async () => {
  const tool = [{ name: 'vkusvill_products_search', inputSchema: { properties: { q: { type: 'string' } } } }];
  const plan = await buildPlan(async (method, params) => {
    const q = params.arguments.q;
    const pool = q === 'готовые блюда' ? groups.ready : q === 'салат' ? groups.salad : q === 'суп' ? groups.soup : [];
    return { structuredContent: { ok: true, data: { items: pool.map(p => ({ id:p.id,name:p.name,unit:p.unit,price:{current:p.price},weight:{value:p.packageGrams,unit:'г'},category:p.categories.map(name=>({name})),properties:[{name:'Ценность на 100 г',value:`белки ${p.nutrition.protein} г; жиры ${p.nutrition.fat} г; углеводы ${p.nutrition.carbs} г; ${p.nutrition.kcal} ккал`}] })) } } };
  }, tool, false);
  assert.ok(plan.days.every(d => d.assessment.status === 'unknown'));
  assert.ok(plan.days.every(d => d.meals.filter(m => ['Обед','Ужин'].includes(m.name)).every(m => mainMealCheck(m).status === 'suitable')));
});
