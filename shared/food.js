export function nutrients(product, grams) {
  if (!product.nutrition || !Number.isFinite(grams) || grams <= 0) return null;
  return Object.fromEntries(['kcal', 'protein', 'fat', 'carbs'].map(k => [k, Math.round(product.nutrition[k] * grams) / 100]));
}
export function totals(entries) {
  const result = { kcal: 0, protein: 0, fat: 0, carbs: 0 };
  for (const entry of entries) {
    const value = nutrients(entry.product, entry.grams);
    if (!value) return null;
    for (const key of Object.keys(result)) result[key] += value[key];
  }
  return Object.fromEntries(Object.entries(result).map(([k,v]) => [k, Math.round(v * 10) / 10]));
}
export function nutrientBounds(product, grams) {
  if (!Number.isFinite(grams) || grams <= 0) return null;
  const exact = nutrients(product, grams);
  if (exact) return Object.fromEntries(Object.entries(exact).map(([k,v]) => [k, { min: v, max: v }]));
  if (!product.nutritionRange) return null;
  return Object.fromEntries(['kcal', 'protein', 'fat', 'carbs'].map(k => [k, {
    min: Math.round(product.nutritionRange[k].min * grams) / 100,
    max: Math.round(product.nutritionRange[k].max * grams) / 100
  }]));
}
export function totalBounds(entries) {
  const result = Object.fromEntries(['kcal', 'protein', 'fat', 'carbs'].map(k => [k, { min: 0, max: 0 }]));
  for (const entry of entries) {
    const values = nutrientBounds(entry.product, entry.grams);
    if (!values) return null;
    for (const k of Object.keys(result)) { result[k].min += values[k].min; result[k].max += values[k].max; }
  }
  for (const value of Object.values(result)) { value.min = Math.round(value.min * 10) / 10; value.max = Math.round(value.max * 10) / 10; }
  return result;
}
export function quote(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 60) throw new Error('INVALID_PLAN');
  const grouped = new Map();
  for (const { product, grams } of entries) {
    if (!Number.isFinite(grams) || grams <= 0 || grams > 5000) throw new Error('INVALID_PORTION');
    const line = grouped.get(product.id);
    if (line) line.grams += grams;
    else grouped.set(product.id, { product, grams });
  }
  const lines = [...grouped.values()].map(({ product, grams }) => {
    const quantity = product.unit === 'кг' ? Math.ceil(grams / 10) / 100 : product.unit === 'шт' && product.packageGrams > 0 ? Math.ceil(grams / product.packageGrams) : null;
    return {
      product, grams, quantity,
      subtotal: quantity !== null && product.price !== null ? Math.round(quantity * product.price * 100) / 100 : null,
      leftoverGrams: quantity === null ? null : Math.round((product.unit === 'кг' ? quantity * 1000 : quantity * product.packageGrams) - grams),
      estimated: product.unit === 'кг',
      available: quantity !== null && product.availability === 'available' && product.availableQuantity >= quantity
    };
  });
  const complete = lines.every(l => l.subtotal !== null && l.quantity >= 0.01 && l.quantity <= 40);
  return { lines, total: complete ? Math.round(lines.reduce((sum, l) => sum + l.subtotal, 0) * 100) / 100 : null, estimated: lines.some(l => l.estimated), ready: complete && lines.every(l => l.available), nutrition: totals(entries), nutritionRange: totalBounds(entries) };
}
