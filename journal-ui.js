import { JOURNAL_KEY, localDate, emptyJournal, cleanJournal, makeEntry, remainingToday, preferences } from './shared/journal.js?v=20261109-reviews1';
import { dailyTarget } from './shared/targets.js?v=20261109-reviews1';
const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
const fmt = n => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(n);
const boundsText = bounds => !bounds ? 'Не хватает данных КБЖУ: неизвестное не считается нулём.' : Object.entries({ kcal: 'ккал', protein: 'Б', fat: 'Ж', carbs: 'У' }).map(([key, label]) => `${label} ${bounds[key].min === bounds[key].max ? fmt(bounds[key].min) : `${fmt(bounds[key].min)}–${fmt(bounds[key].max)}`}${key === 'kcal' ? '' : ' г'}`).join(' · ');
export function createJournal(root, onRatingChange) {
  let journal = emptyJournal(), storageError = false;
  try { journal = cleanJournal(JSON.parse(localStorage.getItem(JOURNAL_KEY))); } catch { storageError = true; }
  const notice = node('p'); notice.setAttribute('role', 'status');
  const content = node('div');
  root.append(node('h2', 'Мой дневник питания'), node('p', 'История и оценки сохраняются только в этом браузере на этом устройстве, отдельно от входа во ВкусВилл. Очистка данных браузера удалит их; синхронизации между устройствами пока нет.'));
  root.append(node('p', 'Меню не считается съеденным. Добавляйте только то, что действительно съели. Для подбора на сервер передаются только номера недавних, любимых и исключённых товаров; дневник целиком не передаётся.'));
  root.append(notice, content);
  function commit(next, message) {
    try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(next)); journal = next; storageError = false; notice.textContent = message; render(); return true; }
    catch { storageError = true; notice.textContent = 'Не удалось сохранить дневник. Проверьте, разрешено ли хранение данных в браузере. Запись не сохранена.'; return false; }
  }
  function render() {
    content.replaceChildren();
    if (storageError) notice.textContent = 'Не удалось прочитать сохранённый дневник. Новые записи сохранятся только если браузер разрешает хранение данных.';
    const target = dailyTarget(), today = localDate(), summary = remainingToday(journal, target, today);
    content.append(node('h3', `Сегодня, ${today}`), node('p', `Съедено: ${boundsText(summary.eaten)}`), node('p', `Остаток до дневного ориентира: ${boundsText(summary.remaining)}`), node('small', 'Отрицательное значение означает превышение ориентира. Остаток не является рекомендацией пропустить еду.'));
    const history = node('details'); history.append(node('summary', `История за 90 дней (${journal.entries.length})`));
    for (const entry of [...journal.entries].reverse()) {
      const row = node('p', `${entry.date} · ${entry.product.name} · ${fmt(entry.grams)} г `);
      const remove = node('button', 'Удалить запись'); remove.className = 'secondary';
      remove.addEventListener('click', () => commit({ ...journal, entries: journal.entries.filter(e => e.id !== entry.id) }, 'Запись удалена.'));
      row.append(remove); history.append(row);
    }
    content.append(history);
    const ratings = node('details'); ratings.append(node('summary', 'Мои оценки и исключения'));
    for (const [id, rating] of Object.entries(journal.ratings)) {
      const name = journal.entries.find(e => e.product.id === Number(id))?.product.name || `Товар №${id}`;
      const row = node('p', `${name}: ${rating === 'liked' ? 'понравилось' : 'не предлагать'} `);
      const undo = node('button', 'Снять оценку'); undo.className = 'secondary';
      undo.addEventListener('click', () => { const next = structuredClone(journal); delete next.ratings[id]; if (commit(next, 'Оценка снята. Следующий подбор учтёт изменение.')) onRatingChange(); });
      row.append(undo); ratings.append(row);
    }
    content.append(ratings);
    const erase = node('button', 'Очистить дневник и оценки'); erase.className = 'secondary';
    erase.addEventListener('click', () => { if (window.confirm('Удалить всю историю питания и оценки на этом устройстве?')) if (commit(emptyJournal(), 'История и оценки удалены.')) onRatingChange(); });
    content.append(erase);
  }
  function controls(product, portion) {
    const box = node('div'), details = node('details'); details.append(node('summary', 'Записать съеденное и оценить'));
    const date = node('input'); date.type = 'date'; date.value = localDate(); date.max = localDate(); date.setAttribute('aria-label', `Дата: ${product.name}`);
    const grams = node('input'); grams.type = 'number'; grams.min = '1'; grams.max = '5000'; grams.step = '1'; grams.value = portion || ''; grams.style.width = '80px'; grams.setAttribute('aria-label', `Съедено граммов: ${product.name}`);
    const dl = node('label', 'Дата: '); dl.append(date); const gl = node('label', ' Съедено, г: '); gl.append(grams);
    const add = node('button', 'Добавить в дневник'), feedback = node('p'); feedback.setAttribute('role', 'status');
    const reset = () => { add.disabled = false; feedback.textContent = ''; };
    date.addEventListener('change', reset); grams.addEventListener('input', reset);
    add.addEventListener('click', () => {
      try {
        if (!date.validity.valid || !grams.validity.valid) throw new Error();
        const entry = makeEntry(product, Number(grams.value), date.value, crypto.randomUUID());
        if (journal.entries.length >= 500) { feedback.textContent = 'В дневнике уже 500 записей. Удалите ненужные записи перед добавлением.'; return; }
        if (commit({ ...journal, entries: [...journal.entries, entry] }, 'Съеденное записано. Остаток КБЖУ пересчитан.')) { add.disabled = true; feedback.textContent = 'Записано. В корзине ничего не изменилось.'; }
        else feedback.textContent = 'Запись не сохранена: браузер запретил хранение данных.';
      } catch { feedback.textContent = 'Укажите массу от 1 до 5000 г и дату за последние 90 дней, не позднее сегодня.'; }
    });
    details.append(dl, gl, add, feedback);
    for (const [value, label] of [['liked', 'Понравилось'], ['blocked', 'Не предлагать']]) {
      const button = node('button', label); button.className = 'secondary'; button.setAttribute('aria-pressed', String(journal.ratings[product.id] === value));
      button.addEventListener('click', () => {
        const next = structuredClone(journal);
        if (next.ratings[product.id] === value) delete next.ratings[product.id]; else next.ratings[product.id] = value;
        if (Object.keys(next.ratings).length > 500) { feedback.textContent = 'Сначала удалите ненужные оценки (максимум 500).'; return; }
        if (commit(next, 'Оценка сохранена. Следующий подбор учтёт изменение.')) onRatingChange();
      });
      details.append(button);
    }
    box.append(details); return box;
  }
  render();
  return { controls, preferences: () => preferences(journal), isBlocked: id => journal.ratings[id] === 'blocked' };
}
