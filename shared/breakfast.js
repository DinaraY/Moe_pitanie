import { totalBounds } from './food.js';
import { preparedComponent } from './meals.js';

// Search matches are not necessarily the requested food (e.g. avocado shampoo).
export function breakfastIngredient(product, group) {
  const name = product?.name || '';
  if (!product || product.availability === 'unavailable') return false;
  if (group === 'eggs') return /^яйц[аоы]\s/iu.test(name) && !/шоколад|копч|маринов|соус|салат/iu.test(name);
  if (group === 'avocado') return /^авокадо(?:\s|,|$)/iu.test(name) && !/масло|соус|салат|шампун|крем/iu.test(name);
  if (group === 'vegetables') return /^(?:томаты?|помидоры?|огурцы?)(?:\s|,|$)/iu.test(name) && !/прот[её]рт|маринов|сол[её]н|суш|вялен|паст|сок|соус/iu.test(name);
  if (group === 'breakfastReady') return /^омлет(?:\s|,|$)/iu.test(name) && preparedComponent(product, 'ready');
  if (group === 'curd') return /^творог(?:\s|,|$)/iu.test(name) && !/детск|десерт|глазир/iu.test(name);
  if (group === 'yogurt') return /^йогурт(?:\s|,|$)/iu.test(name) && !/детск|питьев|соус/iu.test(name);
  return false;
}

export function breakfastOptions(groups, preferences = {}) {
  const pool = group => (groups[group] || []).filter(p => breakfastIngredient(p, group) && !(preferences.blocked || []).includes(p.id));
  const item = (group, product, grams) => ({ group, label: group, product, grams });
  const withinPack = i => i.product.unit === 'кг' || (Number.isFinite(i.product.packageGrams) && i.grams <= i.product.packageGrams);
  const checked = (items, note) => {
    if (!items.every(withinPack)) return null;
    const bounds = totalBounds(items);
    // Practical breakfast portions for this profile. Check every manufacturer range.
    if (!bounds || bounds.kcal.min < 250 || bounds.kcal.max > 450 || bounds.protein.min < 15 || bounds.fat.max > 25) return null;
    return { items, bounds, note };
  };
  const preferred = [];
  for (const egg of pool('eggs')) for (const avocado of pool('avocado')) for (const veg of pool('vegetables')) {
    const option = checked([item('eggs', egg, 110), item('avocado', avocado, 55), item('vegetables', veg, 150)]);
    if (option) preferred.push(option);
  }
  if (preferred.length) return preferred;
  const note = 'Завтрак заменён: не удалось собрать яйца, авокадо и овощи с полными КБЖУ и подходящей порцией. Выбран вариант с проверенными данными магазина.';
  const alternatives = [];
  for (const product of pool('breakfastReady')) {
    for (const grams of [...new Set([150, 200, 250, product.packageGrams].filter(g => Number.isFinite(g) && g > 0 && g <= 300))]) {
      const option = checked([item('breakfastReady', product, grams)], note);
      if (option) alternatives.push(option);
    }
  }
  for (const curd of pool('curd')) for (const yogurt of pool('yogurt')) {
    for (const curdGrams of [100, 150, 200]) for (const yogurtGrams of [100, 125, 150]) {
      const option = checked([item('curd', curd, curdGrams), item('yogurt', yogurt, yogurtGrams)], note);
      if (option) alternatives.push(option);
    }
  }
  return alternatives;
}
