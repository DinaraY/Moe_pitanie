import { dailyTarget } from './shared/targets.js?v=20261109-today1';
import { MEALS } from './shared/today.js?v=20261109-today1';
import { reviewText } from './shared/reviews.js?v=20261109-today1';
const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
const money = n => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const fmt = n => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(n);
const boundsText = b => Object.entries({ kcal: 'ккал', protein: 'Б', fat: 'Ж', carbs: 'У' }).map(([k, label]) => `${label} ${b[k].min === b[k].max ? fmt(b[k].min) : `${fmt(b[k].min)}–${fmt(b[k].max)}`}${k === 'kcal' ? '' : ' г'}`).join(' · ');
export function mountToday(root, { api, journal, available, onBasket, onInvalidate }) {
  let revision = 0, busy = false, current = null;
  root.append(el('h2', 'Что съесть сегодня'));
  root.append(el('p', 'Отметьте, какие приёмы пищи ещё остались. Подбор учитывает только то, что вы сами записали в дневник. Обед и ужин — салат и второе или салат и суп. Порции могут быть меньше упаковки; остатки видны в списке покупок.'));
  const slots = el('fieldset'); slots.append(el('legend', 'Ещё планирую съесть'));
  const checks = Object.entries(MEALS).map(([key, name]) => { const label = el('label', name + ' '), input = el('input'); input.type = 'checkbox'; input.value = key; input.checked = key !== 'breakfast'; label.prepend(input); label.style.display = 'block'; slots.append(label); return input; });
  const build = el('button', 'Подобрать остаток дня');
  const consentLabel = el('label'), consent = el('input'); consent.type = 'checkbox';
  consentLabel.append(consent, document.createTextNode(' Разрешаю отправить в OpenAI дневной ориентир, КБЖУ съеденного, номера недавних и оценённых товаров и варианты из каталога. Полный дневник и данные входа не отправляются.'));
  const ai = el('button', 'Подобрать с ИИ'); ai.className = 'secondary';
  const availability = el('p'), status = el('p'), results = el('div'); status.setAttribute('role', 'status');
  root.append(slots, build, consentLabel, ai, availability, status, results);
  function reset(message = '') { revision++; current = null; results.replaceChildren(); status.textContent = message; onInvalidate(); }
  checks.forEach(input => input.addEventListener('change', () => reset('Изменён список приёмов пищи. Повторите подбор.')));
  journal.subscribe(() => reset('Дневник или оценки изменились. Повторите подбор, чтобы учесть изменения.'));
  function update() {
    const state = available();
    build.disabled = busy || !state.catalog;
    ai.disabled = busy || !state.ai || !state.signedIn || !consent.checked;
    availability.textContent = !state.ai ? 'ИИ-подбор пока не подключён. Обычный подбор доступен без ИИ.' : !state.signedIn ? 'Для ИИ-подбора сначала подключите ВкусВилл.' : 'ИИ доступен по вашему запросу. Число вызовов ограничено; покупки не выполняются автоматически.';
  }
  consent.addEventListener('change', update);
  async function run(engine) {
    if (busy) return;
    const selected = checks.filter(i => i.checked).map(i => i.value), snapshot = journal.today();
    reset();
    if (!selected.length) { status.textContent = 'Отметьте хотя бы один оставшийся приём пищи.'; return; }
    if (!snapshot.eaten) { status.textContent = 'У части съеденного неизвестны КБЖУ. Рассчитать остаток нельзя: уточните записи в дневнике.'; return; }
    if (snapshot.eaten.kcal.min >= dailyTarget().kcal) { status.textContent = 'Дневной ориентир калорий уже достигнут. Подбор под остаток не рассчитывается; это не рекомендация пропускать еду.'; return; }
    if (engine === 'ai' && (!consent.checked || !available().ai || !available().signedIn)) return;
    busy = true; update(); const version = revision;
    status.textContent = engine === 'ai' ? 'Получаем реальные товары и проверяем вариант ИИ…' : 'Получаем реальные товары и подбираем оставшиеся приёмы пищи…';
    try {
      const result = await api('/api/today', { method: 'POST', body: JSON.stringify({ engine, consent: engine === 'ai' && consent.checked, slots: selected, eaten: snapshot.eaten, preferences: journal.preferences() }) });
      if (version !== revision) return;
      if (journal.today().date !== snapshot.date) { reset('Наступил новый день. Проверьте дневник и повторите подбор.'); return; }
      if (!['within', 'outside'].includes(result.status)) {
        status.textContent = result.status === 'target_reached' ? 'Ориентир уже достигнут. Это не рекомендация пропускать еду.' : 'Не хватает товаров с полными КБЖУ для выбранных приёмов пищи. Данные не подставлены.'; return;
      }
      current = result;
      status.textContent = result.status === 'within' ? 'С учётом съеденного все показатели в пределах ±10% от дневного ориентира.' : 'Подобран ближайший вариант. С учётом доступных блюд попасть во все ориентиры не удалось — проверьте итог.';
      if (result.aiNote) status.textContent += result.aiNote === 'AI_MONTHLY_LIMIT' ? ' Лимит ИИ на месяц исчерпан; показан обычный подбор.' : result.aiNote === 'ALGORITHM_CLOSER' ? ' Вариант алгоритма ближе к цели, чем предложенный ИИ.' : ' ИИ недоступен; показан обычный подбор.';
      else if (result.engine === 'ai') status.textContent += ' Вариант ИИ проверен приложением.';
      for (const meal of result.meals) {
        const section = el('section'); section.append(el('h3', meal.name));
        for (const item of meal.items) {
          const p = item.product; section.append(el('strong', p.name), el('p', `Порция: ${fmt(item.grams)} г · ${p.price === null ? 'цена неизвестна' : `${money(p.price)} / ${p.unit || '?'}`}`), el('p', reviewText(p)));
          if (p.url) { const link = el('a', 'Карточка ВкусВилла'); link.href = p.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; section.append(link); }
          section.append(journal.controls(p, item.grams));
        }
        results.append(section);
      }
      results.append(el('p', `Предлагаемые блюда: ${boundsText(result.bounds)}`), el('p', `За день с учётом съеденного: ${boundsText(result.dayBounds)}`), el('small', 'Наличие и окончательные цены проверяются отдельно перед подтверждением корзины.'));
      const basket = el('button', 'Список покупок для этих блюд');
      basket.addEventListener('click', () => {
        if (!current || version !== revision || journal.today().date !== snapshot.date) { reset('Подбор устарел. Повторите его.'); return; }
        onBasket(current.meals.flatMap(m => m.items), snapshot.date);
      });
      results.append(basket);
    } catch { if (version === revision) status.textContent = 'Подбор сейчас недоступен. Повторите попытку; дневник сохранён.'; }
    finally { busy = false; update(); }
  }
  build.addEventListener('click', () => run('algorithm'));
  ai.addEventListener('click', () => run('ai'));
  update(); return { update, reset };
}
