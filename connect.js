import { mainMealCheck, replacementPortion } from './shared/meals.js?v=20261109-smallpacks1';
import { mountToday } from './today-ui.js?v=20261110-retry1';
import { localDate } from './shared/journal.js?v=20261109-smallpacks1';
import { reviewText } from './shared/reviews.js?v=20261109-smallpacks1';
import { createJournal } from './journal-ui.js?v=20261109-smallpacks1';
import { dailyTarget, balanceDay, assessment } from './shared/targets.js?v=20261109-smallpacks1';
import { nutrients, totals, nutrientBounds, totalBounds, quote } from './shared/food.js?v=20261109-smallpacks1';
const servers = Object.freeze({
  testing: 'https://moe-pitanie-2.statusdi.workers.dev',
  production: 'https://moe-pitanie-api.statusdi.workers.dev',
  staging: 'https://moe-pitanie-api-staging.statusdi.workers.dev'
});
const server = document.getElementById('server');
const status = document.getElementById('status');
const connect = document.getElementById('connect');
const logout = document.getElementById('logout');
const retry = document.getElementById('retry');
const remember = document.getElementById('remember');
const RESUME_KEY = 'moe-pitanie.resume.v1';
const REMEMBER_KEY = 'moe-pitanie.remember.v1';
// Only a preference and expiry marker are persisted. No session IDs or shop tokens.
const readLocal = key => { try { return localStorage.getItem(key); } catch { return null; } };
const writeLocal = (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch {} };
remember.checked = readLocal(REMEMBER_KEY) !== 'false';
remember.addEventListener('change', () => {
  writeLocal(REMEMBER_KEY, String(remember.checked));
  if (!remember.checked) writeLocal(RESUME_KEY, null);
});
let capabilities = {}, plan = null, draft = null, planRevision = 0;
let draftTimer, today, todaySelection = null, basketMode = 'plan';
const journal = createJournal(document.getElementById('journal'), () => {
  if (plan) { invalidateDraft(); renderPlan({ preserveBasket: basketMode === 'today' }); }
});
const planner = document.getElementById('planner');
const basket = document.getElementById('basket');
const build = document.getElementById('build');
const prepare = document.getElementById('prepare');
const confirm = document.getElementById('confirm');
const approve = document.getElementById('approve');
const planStatus = document.getElementById('plan-status');
const cartStatus = document.getElementById('cart-status');
const fragment = new URLSearchParams(location.hash.slice(1));
// This is an opaque app session, never a VkusVill access/refresh token.
let session = fragment.get('session');
if (!/^[A-Za-z0-9_-]{43}$/.test(session || '')) session = null;
const denied = fragment.get('auth') === 'denied';
const expired = fragment.get('auth') === 'expired';
if (denied || expired) writeLocal(RESUME_KEY, null);
const returnedServer = fragment.get('server');
history.replaceState(null, '', location.pathname + location.search);
if (Object.hasOwn(servers, returnedServer)) server.value = returnedServer;
let generation = 0;

async function api(path, options = {}) {
  const response = await fetch(servers[server.value] + path, {
    ...options, credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Authorization: `Bearer ${session}` } : {}) },
    signal: AbortSignal.timeout(path === '/api/today' ? 90000 : path === '/api/plan' || path.startsWith('/api/cart/') ? 65000 : 12000)
  });
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('UNAVAILABLE');
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'UNAVAILABLE'); error.data = data; throw error; }
  return data;
}
async function check() {
  const current = ++generation;
  connect.disabled = true; retry.disabled = true; server.disabled = true;
  status.textContent = 'Проверяем соединение…';
  logout.hidden = !session;
  try {
    const state = await api('/api/status');
    if (current !== generation) return;
    if (state.service !== 'moe-pitanie-api') throw new Error('WRONG_SERVICE');
    capabilities = state;
    planner.hidden = !state.catalogEnabled;
    connect.disabled = state.authorization !== 'available';
    if (session) {
      const account = await api('/api/session');
      if (current !== generation) return;
      if (!account.authenticated) throw new Error('SESSION_EXPIRED');
      if (account.remembered && remember.checked) writeLocal(RESUME_KEY, JSON.stringify({ server: server.value, expiresAt: account.expiresAt }));
      else writeLocal(RESUME_KEY, null);
      connect.disabled = true;
      status.textContent = 'ВкусВилл подключён. Подберите товары: наличие по адресу будет проверено для каждой позиции.';
    } else {
      status.textContent = state.authorization === 'available'
        ? 'Сервер готов к входу. Подтвердите доступ на сайте ВкусВилла.'
        : 'Сервер доступен. Вход через ВкусВилл ещё не настроен владельцем приложения.';
      if (denied) status.textContent += ' Доступ не был подтверждён.';
      if (expired) status.textContent = 'Срок входа истёк. Подключите ВкусВилл снова.';
    }
  } catch {
    if (current !== generation) return;
    if (session) {
      status.textContent = 'Не удалось проверить сессию. Повторите проверку или отключите её и войдите снова.';
    } else {
      status.textContent = 'Сервер пока недоступен или не обновлён. Примерное меню на главной странице продолжает работать.';
    }
  } finally {
    if (current === generation) { retry.disabled = false; server.disabled = !!session; remember.disabled = !!session; logout.hidden = !session; today?.update(); }
  }
}
connect.addEventListener('click', () => {
  if (!connect.disabled) {
    writeLocal(REMEMBER_KEY, String(remember.checked));
    location.assign(servers[server.value] + '/oauth/start' + (remember.checked ? '?remember=1' : ''));
  }
});
logout.addEventListener('click', async () => {
  logout.disabled = true;
  try {
    await api('/api/session', { method: 'DELETE' });
    writeLocal(RESUME_KEY, null);
    session = null;
    clearPlan();
    await check();
    status.textContent = 'Сессия приложения отключена. Полностью отозвать доступ можно в настройках ВкусВилла.';
  } catch (error) {
    if (error.message === 'SESSION_EXPIRED') {
      session = null; writeLocal(RESUME_KEY, null); clearPlan(); await check();
      status.textContent = 'Сессия приложения завершена.';
    } else status.textContent = 'Не удалось отключить сессию на сервере. Повторите попытку; она также завершится по сроку действия.';
  }
  finally { logout.disabled = false; }
});
server.addEventListener('change', () => { clearPlan(); check(); });
retry.addEventListener('click', check);

const format = value => value === null || value === undefined ? 'нет данных' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
const quantityText = value => value === null || value === undefined ? 'нет данных' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value);
const money = value => value === null ? 'цена неизвестна' : new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const macroText = value => value ? `${format(value.kcal)} ккал · Б ${format(value.protein)} · Ж ${format(value.fat)} · У ${format(value.carbs)} г` : 'КБЖУ неизвестны или не указана масса порции';
const rangeText = bounds => {
  const f = value => value.min === value.max ? format(value.min) : `${format(value.min)}–${format(value.max)}`;
  return `${f(bounds.kcal)} ккал · Б ${f(bounds.protein)} · Ж ${f(bounds.fat)} · У ${f(bounds.carbs)} г (диапазон по производителям)`;
};
const nutritionText = (product, grams = 100) => {
  const exact = nutrients(product, grams); if (exact) return macroText(exact);
  const bounds = nutrientBounds(product, grams); return bounds ? rangeText(bounds) : macroText(null);
};
function element(tag, content, className) {
  const node = document.createElement(tag); if (content !== undefined) node.textContent = content;
  if (className) node.className = className; return node;
}
function invalidateDraft() {
  clearTimeout(draftTimer);
  planRevision++; draft = null; approve.checked = false; confirm.disabled = true;
  approve.disabled = false;
  document.getElementById('confirmation').hidden = true;
  document.getElementById('draft').replaceChildren();
  document.getElementById('cart-link').replaceChildren();
  cartStatus.textContent = '';
}
function clearPlan() {
  basketMode = 'plan'; todaySelection = null; today?.reset();
  invalidateDraft(); plan = null; basket.hidden = true;
  document.getElementById('days').replaceChildren();
  planStatus.textContent = '';
}
const allItems = () => plan ? plan.days.flatMap(day => day.meals.flatMap(meal => meal.items)) : [];
function entries() {
  if (todaySelection && todaySelection.date !== localDate()) return null;
  const items = todaySelection ? todaySelection.items : allItems();
  if (!items.length || items.some(item => !item.product || !Number.isFinite(item.grams) || item.grams <= 0 || item.grams > 5000)) return null;
  return items.map(item => ({ product: item.product, grams: item.grams }));
}
function summaryView(summary) {
  const box = element('div');
  for (const line of summary.lines) {
    const row = element('p');
    row.append(element('strong', line.product.name), element('br'));
    row.append(document.createTextNode(`${quantityText(line.quantity)} ${line.product.unit || 'единиц'} × ${money(line.product.price)} = ${money(line.subtotal)}`));
    if (line.leftoverGrams !== null) row.append(element('br'), element('small', `На меню ${format(line.grams)} г; расчётный остаток по массе упаковки ${format(line.leftoverGrams)} г.`));
    if (!line.available) row.append(element('br'), element('small', 'Наличие нужного количества не подтверждено.'));
    box.append(row);
  }
  box.append(element('strong', `${summary.estimated ? 'Предварительная сумма' : 'Сумма товаров'}: ${summary.total === null ? 'неизвестна' : money(summary.total)}`));
  box.append(element('p', 'Доставка и итоговая стоимость уточняются во ВкусВилле.', 'muted'));
  return box;
}
function renderPlan({ preserveBasket = false } = {}) {
  if (!preserveBasket) { basketMode = 'plan'; todaySelection = null; document.querySelector('#basket h2').textContent = 'Покупки на два дня'; }
  const days = document.getElementById('days'); days.replaceChildren();
  const target = plan.target || dailyTarget();
  days.append(element('p', `Дневной ориентир: ${macroText(target)}. Поддержание веса ≈ ${format(target.maintenance)} ккал; расчётный дефицит ${target.deficit} ккал. Формула Миффлина — Сан Жеора, активность 1,3; белок 1,4 г/кг, жиры 0,8 г/кг, углеводы — остаток. Это оценка; фактическая потребность уточняется по динамике веса.`));
  for (const day of plan.days) {
    const section = element('section'); section.append(element('h3', `День ${day.day}`));
    const dayEntries = [];
    let complete = true;
    for (const meal of day.meals) {
      section.append(element('h4', meal.name));
      for (const item of meal.items) {
        const box = element('div'); box.style.cssText = 'padding:12px 0;border-bottom:1px solid #e1efe5';
        box.append(element('strong', item.product?.name || `${item.label}: подходящий товар не найден`));
        if (item.product) {
          const p = item.product;
          box.append(element('p', `${money(p.price)} / ${p.unit || 'единица неизвестна'} · ${p.unit === 'кг' ? 'весовой товар' : p.packageGrams ? `${format(p.packageGrams)} г в упаковке` : 'масса упаковки неизвестна'}`));
          box.append(element('p', reviewText(p), 'muted'));
          box.append(element('p', `На 100 г: ${nutritionText(p)}`, 'muted'));
          if (p.nutritionRange) {
            const variants = element('details'); variants.append(element('summary', 'КБЖУ разных производителей'));
            for (const [index, variant] of p.nutritionVariants.entries()) variants.append(element('p', `${variant.manufacturer || `Вариант ${index + 1}`}: ${macroText(variant)} на 100 г`));
            variants.append(element('small', 'Точные значения вашей упаковки указаны на этикетке.'));
            box.append(variants);
          }
          box.append(element('p', p.availability === 'available' ? `По адресу доступно: ${quantityText(p.availableQuantity)} ${p.unit || ''}` : 'Наличие по адресу не подтверждено.', 'muted'));
          const label = element('label', 'Съедаемая порция, г: ');
          const input = element('input'); input.type = 'number'; input.min = '1'; input.max = '5000'; input.step = '1'; input.value = item.grams ?? ''; input.style.cssText = 'width:80px;font:inherit;padding:8px';
          input.setAttribute('aria-label', `Порция: ${p.name}, день ${day.day}, ${meal.name}`);
          input.addEventListener('change', () => {
            item.grams = input.value && input.validity.valid ? Number(input.value) : null;
            invalidateDraft(); renderPlan();
          });
          label.append(input); box.append(label);
          box.append(element('p', `В порции: ${nutritionText(p, item.grams)}`, 'muted'));
          dayEntries.push({ product: p, grams: item.grams });
          if (!item.grams) complete = false;
          if (p.url) { const link = element('a', 'Карточка товара'); link.href = p.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; box.append(element('br'), link); }
          box.append(element('p', `Проверено: ${new Date(p.checkedAt).toLocaleString('ru-RU')}`, 'muted'));
        } else complete = false;
        const main = ['Обед', 'Ужин'].includes(meal.name);
        const pool = (plan.groups[item.group] || []).filter(p => !journal.isBlocked(p.id) && (!main || replacementPortion(meal, item, p) !== null));
        const replace = element('button', 'Заменить'); replace.className = 'secondary'; replace.disabled = !pool.some(p => p.id !== item.product?.id);
        replace.addEventListener('click', () => {
          const index = pool.findIndex(p => p.id === item.product?.id);
          const product = pool[(index + 1) % pool.length];
          const grams = main ? replacementPortion(meal, item, product) : item.group === 'yogurt' ? product.packageGrams : item.grams;
          item.product = product; item.grams = grams;
          balanceDay(day, plan.groups, target, item, journal.preferences());
          invalidateDraft(); renderPlan();
        });
        box.append(replace);
        if (item.product) {
          box.append(journal.controls(item.product, item.grams));
          if (journal.isBlocked(item.product.id)) box.append(element('p', 'Вы исключили этот товар. Он остался в текущем меню; замените его или повторите подбор.', 'muted'));
        }
        const alternative = element('details'); alternative.append(element('summary', 'Найти другую позицию'));
        const query = element('input'); query.type = 'search'; query.maxLength = 120; query.placeholder = item.label;
        query.setAttribute('aria-label', `Поиск замены: ${item.label}, день ${day.day}, ${meal.name}`);
        query.style.cssText = 'font:inherit;max-width:100%;box-sizing:border-box;padding:8px;margin:8px 0';
        const find = element('button', 'Найти'); find.className = 'secondary';
        const results = element('div'); results.setAttribute('aria-live', 'polite');
        find.addEventListener('click', async () => {
          if (!query.value.trim() || find.disabled) return;
          find.disabled = true; results.replaceChildren(element('p', 'Ищем в каталоге…'));
          const revision = planRevision;
          try {
            const response = await api('/api/search', { method: 'POST', body: JSON.stringify({ query: query.value.trim() }) });
            if (revision !== planRevision || !box.isConnected) return;
            results.replaceChildren();
            for (const product of response.products) {
              const candidate = element('div'); candidate.append(element('p', `${product.name} · ${money(product.price)} / ${product.unit || '?'}`));
              candidate.append(element('p', reviewText(product), 'muted'));
              candidate.append(element('p', `На 100 г: ${nutritionText(product)}`, 'muted'));
              const fitsMeal = !main || replacementPortion(meal, item, product) !== null;
              const choose = element('button', !fitsMeal ? 'Не подходит для этого сочетания' : journal.isBlocked(product.id) ? 'Вы исключили этот товар' : product.availability === 'unavailable' ? 'Нет в наличии' : 'Выбрать'); choose.disabled = !fitsMeal || product.availability === 'unavailable' || journal.isBlocked(product.id);
              choose.addEventListener('click', () => {
                const grams = main ? replacementPortion(meal, item, product) : item.group === 'yogurt' ? product.packageGrams : item.grams;
                item.product = product; item.grams = grams;
                if (!item.grams) item.grams = 100;
                balanceDay(day, plan.groups, target, item, journal.preferences());
                invalidateDraft(); renderPlan();
              });
              candidate.append(choose); results.append(candidate);
            }
            if (!response.products.length) results.append(element('p', 'Ничего не найдено. Попробуйте другой запрос.'));
          } catch { if (box.isConnected && revision === planRevision) results.replaceChildren(element('p', 'Поиск недоступен. Попробуйте позже.')); }
          finally { find.disabled = false; }
        });
        alternative.append(query, find, results); box.append(alternative); section.append(box);
      }
      if (['Обед', 'Ужин'].includes(meal.name)) {
        const check = mainMealCheck(meal);
        section.append(element('p', check.status === 'suitable' ? 'Салат и второе/суп: 350–600 ккал, не менее 20 г белка и не более 25 г жиров в сумме.' : 'Это сочетание не прошло проверку полноценного приёма пищи. Проверьте порции и состав: нужны салат и второе или суп, известные КБЖУ, 350–600 ккал и не менее 20 г белка.', 'muted'));
      }
    }
    const exact = complete ? totals(dayEntries) : null;
    const bounds = complete && !exact ? totalBounds(dayEntries) : null;
    section.append(element('p', `Итого за день: ${exact ? macroText(exact) : bounds ? rangeText(bounds) : macroText(null)}`));
    const result = assessment(day, target);
    section.append(element('p', result.status === 'within' ? 'Все показатели в пределах ±10% от ориентира.' : result.status === 'unknown' ? 'Проверить соответствие цели нельзя: не хватает данных КБЖУ или порций.' : 'Есть отклонения от дневной цели. Доступные товары и целые упаковки не позволили попасть во все ориентиры; проверьте итог.', 'muted'));
    days.append(section);
  }
  if (preserveBasket) return;
  const selected = entries(); const preview = document.getElementById('shopping-preview');
  preview.replaceChildren(); basket.hidden = false; prepare.disabled = !selected;
  if (selected) preview.append(summaryView(quote(selected)));
  else preview.append(element('p', 'Для полного списка заполните все позиции и массы порций. Если товар не найден, повторите подбор позже.'));
}
build.addEventListener('click', async () => {
  if (build.disabled) return;
  build.disabled = true; clearPlan(); const revision = planRevision;
  planStatus.textContent = 'Ищем товары и сочетания для обеда и ужина. Это может занять до минуты…';
  try {
    const result = await api('/api/plan', { method: 'POST', body: JSON.stringify({ preferences: journal.preferences() }) });
    if (revision !== planRevision) return;
    plan = result; renderPlan();
    const missing = allItems().filter(item => !item.product).length;
    planStatus.textContent = missing ? `Не удалось заполнить ${missing} позиций. Отсутствующие данные не подставлены.` : 'Товары подобраны. Учтены оценки и история за 7 дней; при небольшом ассортименте повторы возможны. Это меню на полные дни; уже съеденное смотрите в дневнике.';
  } catch { if (revision === planRevision) planStatus.textContent = 'Каталог недоступен или его формат изменился. Попробуйте позже; примерное меню на главной продолжает работать.'; }
  finally { build.disabled = false; }
});
prepare.addEventListener('click', async () => {
  if (!session) { cartStatus.textContent = 'Для проверки наличия и корзины сначала подключите ВкусВилл.'; return; }
  const selected = entries(); if (!selected || prepare.disabled) return;
  invalidateDraft(); const revision = planRevision; prepare.disabled = true;
  cartStatus.textContent = 'Повторно проверяем цены, упаковки и наличие…';
  try {
    const result = await api('/api/cart/draft', { method: 'POST', body: JSON.stringify({ entries: selected.map(e => ({ id: e.product.id, grams: e.grams })) }) });
    if (revision !== planRevision) return;
    draft = result;
    const draftId = draft.id;
    draftTimer = setTimeout(() => {
      if (draft?.id !== draftId) return;
      draft = null; approve.checked = false; approve.disabled = true; confirm.disabled = true;
      document.getElementById('confirmation').hidden = true;
      cartStatus.textContent = 'Расчёт устарел. Нажмите «Проверить цены и наличие» и подтвердите свежую корзину.';
    }, Math.max(0, draft.expiresAt - Date.now()));
    document.getElementById('draft').append(summaryView(draft.summary));
    document.getElementById('confirmation').hidden = false;
    cartStatus.textContent = capabilities.cartEnabled ? `Проверьте свежий расчёт. Подтверждение действует до ${new Date(draft.expiresAt).toLocaleTimeString('ru-RU')}.` : 'Цены и наличие проверены. Создание ссылки пока выключено владельцем приложения.';
  } catch (error) {
    if (revision !== planRevision) return;
    if (error.data?.summary) document.getElementById('draft').append(summaryView(error.data.summary));
    cartStatus.textContent = 'Полную корзину подтвердить нельзя: не хватает данных, наличия или соединения. Проверьте позиции и повторите проверку.';
  } finally { prepare.disabled = !entries(); }
});
approve.addEventListener('change', () => { confirm.disabled = !entries() || !approve.checked || !draft || draft.displayVersion !== 'cart-v2' || !capabilities.cartEnabled || draft.expiresAt <= Date.now(); });
confirm.addEventListener('click', async () => {
  if (!entries() || confirm.disabled || !approve.checked || !draft || draft.displayVersion !== 'cart-v2' || draft.expiresAt <= Date.now()) return;
  confirm.disabled = true; prepare.disabled = true; build.disabled = true;
  const revision = planRevision;
  try {
    const result = await api('/api/cart/confirm', { method: 'POST', body: JSON.stringify({ id: draft.id, version: draft.version, displayVersion: draft.displayVersion, confirmed: true }) });
    if (revision !== planRevision) return;
    const url = new URL(result.link);
    if (url.protocol !== 'https:' || !['vkusvill.ru', 'www.vkusvill.ru'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('UNSAFE_LINK');
    const link = element('a', 'Открыть корзину во ВкусВилле →'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    document.getElementById('cart-link').replaceChildren(link);
    cartStatus.textContent = 'Ссылка создана. Заказ не оформлен; проверьте корзину и оплатите во ВкусВилле.';
    document.getElementById('confirmation').hidden = true;
    clearTimeout(draftTimer); draft = null; approve.checked = false;
  } catch { if (revision === planRevision) cartStatus.textContent = 'Ссылка не получена либо данные изменились. Сначала заново проверьте цены и наличие, затем подтвердите новую корзину.'; }
  finally { prepare.disabled = !entries(); build.disabled = false; }
});
function restoreLogin() {
  if (session || denied || expired || !remember.checked) return false;
  try {
    const marker = JSON.parse(readLocal(RESUME_KEY));
    if (!marker || !Object.hasOwn(servers, marker.server) || !Number.isFinite(marker.expiresAt) || marker.expiresAt <= Date.now()) {
      writeLocal(RESUME_KEY, null); return false;
    }
    status.textContent = 'Восстанавливаем вход…';
    location.replace(servers[marker.server] + '/oauth/restore');
    return true;
  } catch { writeLocal(RESUME_KEY, null); return false; }
}
today = mountToday(document.getElementById('today'), {
  api, journal, available: () => ({ catalog: !!capabilities.catalogEnabled, ai: !!capabilities.aiAvailable, signedIn: !!session }),
  onInvalidate: () => {
    if (todaySelection) { todaySelection = null; invalidateDraft(); basket.hidden = true; }
  },
  onBasket: (items, date) => {
    invalidateDraft(); basketMode = 'today'; todaySelection = { items, date };
    document.querySelector('#basket h2').textContent = 'Покупки на остаток дня';
    const selected = entries(); basket.hidden = false; prepare.disabled = !selected;
    document.getElementById('shopping-preview').replaceChildren(selected ? summaryView(quote(selected)) : element('p', 'Не хватает данных о порциях. Повторите подбор.'));
    basket.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
if (!restoreLogin()) check();
