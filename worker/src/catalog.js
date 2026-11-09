import { normalizeReviews } from '../../shared/reviews.js';
// Field names verified against the official vkustech/vkusvill-cli, commit
// e49df83b43429c32cb5c9c6bbd6154757f72bb1a (src/api.js, src/product.js).
// This implementation deliberately keeps missing/ambiguous values unknown.
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export const text = value => typeof value === 'string' ? value.slice(0, 8000).replace(/<[^>]{0,500}>/g, ' ').replace(/&(?:nbsp|quot|amp|laquo|raquo);/g, entity => ({ '&nbsp;': ' ', '&quot;': '"', '&amp;': '&', '&laquo;': '«', '&raquo;': '»' })[entity]).replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
export function officialUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['vkusvill.ru', 'www.vkusvill.ru'].includes(url.hostname) && !url.port && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function payload(result) {
  if (!result || result.isError) throw new Error('CATALOG_QUERY_FAILED');
  let value = result.structuredContent;
  if (!value) {
    const blocks = (result.content || []).filter(x => x.type === 'text');
    if (blocks.length !== 1) throw new Error('CATALOG_SCHEMA_CHANGED');
    value = JSON.parse(blocks[0].text);
  }
  if (!value || value.ok === false) throw new Error('CATALOG_QUERY_FAILED');
  return value.data ?? value;
}
function parseNutrition(part) {
  const source = text(part);
  const read = expression => {
    const matches = [...source.matchAll(expression)];
    if (matches.length !== 1) return null;
    return number(Number(matches[0][1].replace(',', '.')));
  };
  const values = {
    kcal: read(/([\d]+(?:[.,]\d+)?)\s*ккал/giu),
    protein: read(/белк[а-яё]*\s*[:–—-]?\s*([\d]+(?:[.,]\d+)?)/giu),
    fat: read(/жир[а-яё]*\s*[:–—-]?\s*([\d]+(?:[.,]\d+)?)/giu),
    carbs: read(/углевод[а-яё]*\s*[:–—-]?\s*([\d]+(?:[.,]\d+)?)/giu)
  };
  if (Object.values(values).some(v => v === null) || values.kcal > 1000 || values.protein > 100 || values.fat > 100 || values.carbs > 100) return null;
  return { ...values, basisGrams: 100, source };
}
function nutrition(properties) {
  const unknown = { nutrition: null, nutritionRange: null, nutritionVariants: [] };
  const candidates = properties.filter(p => /ценност/iu.test(p.name) && /100\s*(?:г(?:рамм[а-яё]*)?(?![а-яё])|g\b)/iu.test(text(p.name) + ' ' + text(p.value)));
  if (candidates.length !== 1 || candidates[0].value.length > 16000) return unknown;
  const parts = candidates[0].value.split(/<br\s*\/?\s*>/iu).map(p => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 40) return unknown;
  const variants = parts.map(part => {
    const value = parseNutrition(part);
    const colon = part.indexOf(':');
    return value ? { manufacturer: colon > 0 && colon < 180 ? text(part.slice(0, colon)) : null, ...value } : null;
  });
  // A missing manufacturer's values make the whole range unknown; never silently omit it.
  if (variants.some(v => !v)) return unknown;
  const keys = ['kcal', 'protein', 'fat', 'carbs'];
  const same = variants.every(v => keys.every(k => v[k] === variants[0][k]));
  return {
    nutrition: same ? Object.fromEntries([...keys.map(k => [k, variants[0][k]]), ['basisGrams', 100], ['source', variants[0].source]]) : null,
    nutritionRange: same ? null : { ...Object.fromEntries(keys.map(k => [k, { min: Math.min(...variants.map(v => v[k])), max: Math.max(...variants.map(v => v[k])) }])), basisGrams: 100 },
    nutritionVariants: variants
  };
}
export function normalize(item, personalized, now = new Date().toISOString()) {
  const id = typeof item?.id === 'string' && /^\d+$/.test(item.id) ? Number(item.id) : item?.id;
  if (!Number.isSafeInteger(id) || id <= 0 || !text(item.name)) throw new Error('CATALOG_SCHEMA_CHANGED');
  const properties = Array.isArray(item.properties) ? item.properties.filter(p => typeof p?.name === 'string' && typeof p.value === 'string') : [];
  const unit = ['шт', 'кг'].includes(item.unit) ? item.unit : null;
  const weight = item.weight;
  const weightValue = number(weight?.value);
  const grams = weightValue > 0 && ['г', 'кг'].includes(weight.unit) ? weightValue * (weight.unit === 'кг' ? 1000 : 1) : null;
  const available = personalized ? number(item.available_quantity) : null;
  return {
    id, name: text(item.name), price: number(item.price?.current), unit,
    packageGrams: unit === 'шт' ? grams : null,
    availability: available === null ? 'unverified' : available > 0 ? 'available' : 'unavailable',
    availableQuantity: available,
    ...nutrition(properties),
    reviews: normalizeReviews(item.rating),
    categories: Array.isArray(item.category) ? item.category.map(c => text(c?.name)).filter(Boolean) : [],
    ingredients: text(properties.find(p => /состав/iu.test(p.name))?.value) || null,
    url: officialUrl(item.url), checkedAt: now, source: 'https://mcp.vkusvill.ru/mcp'
  };
}
export async function discover(rpc) {
  const tools = []; let cursor;
  for (let page = 0; page < 5; page++) {
    const result = await rpc('tools/list', cursor ? { cursor } : {});
    if (!Array.isArray(result.tools)) throw new Error('CATALOG_SCHEMA_CHANGED');
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (!cursor) return tools;
  }
  throw new Error('TOOL_LIST_TOO_LARGE');
}
export function requireTool(tools, name, requiredProperty, type) {
  const tool = tools.find(t => t.name === name);
  if (!tool || tool.inputSchema?.properties?.[requiredProperty]?.type !== type) throw new Error('TOOL_SCHEMA_CHANGED');
  return tool;
}
export async function search(rpc, tools, query, authenticated, preferredSort = 'rating') {
  const tool = requireTool(tools, 'vkusvill_products_search', 'q', 'string');
  const sort = tool.inputSchema.properties.sort?.enum?.includes(preferredSort) ? { sort: preferredSort } : {};
  const result = payload(await rpc('tools/call', { name: 'vkusvill_products_search', arguments: { q: query, page: 1, limit: 10, mode: 'full', ...sort } }));
  if (!Array.isArray(result.items)) throw new Error('CATALOG_SCHEMA_CHANGED');
  const personal = authenticated && result.meta?.personalized !== false;
  return result.items.slice(0, 10).map(item => normalize(item, personal));
}
export async function details(rpc, tools, id, authenticated) {
  requireTool(tools, 'vkusvill_product_details', 'id', 'integer');
  const data = payload(await rpc('tools/call', { name: 'vkusvill_product_details', arguments: { id } }));
  const product = normalize(data, authenticated && data.meta?.personalized !== false);
  if (product.id !== id) throw new Error('CATALOG_SCHEMA_CHANGED');
  return product;
}
