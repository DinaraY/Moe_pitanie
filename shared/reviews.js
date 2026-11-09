// Official MCP rating.average (out of 5) and rating.count. Text reviews are not exposed.
export function normalizeReviews(rating) {
  const count = Number.isSafeInteger(rating?.count) && rating.count >= 0 ? rating.count : null;
  const average = typeof rating?.average === 'number' && Number.isFinite(rating.average) && rating.average > 0 && rating.average <= 5 && count !== 0 ? rating.average : null;
  return { average, count };
}
export function reviewPenalty(product) {
  const { average, count } = product.reviews || {};
  if (!Number.isFinite(average) || average <= 0 || average > 5 || !Number.isSafeInteger(count) || count <= 0) return 0;
  // Twenty neutral prior votes at 4.5 reduce the influence of tiny samples.
  // Unknown reviews are neutral, never interpreted as zero-star feedback.
  return 0.08 * (4.5 - average) / 5 * (count / (count + 20));
}
export function reviewText(product) {
  const { average, count } = product.reviews || {};
  if (!Number.isFinite(average)) return 'Отзывы ВкусВилла: рейтинг не передан или оценок пока нет.';
  const rating = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(average);
  const votes = Number.isSafeInteger(count) && count > 0 ? `${new Intl.NumberFormat('ru-RU').format(count)} оценок` : 'количество оценок неизвестно';
  return `Отзывы ВкусВилла: ★ ${rating} из 5 · ${votes}`;
}
