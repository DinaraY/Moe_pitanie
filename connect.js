const servers = Object.freeze({
  production: 'https://moe-pitanie-api.statusdi.workers.dev',
  staging: 'https://moe-pitanie-api-staging.statusdi.workers.dev'
});
const server = document.getElementById('server');
const status = document.getElementById('status');
const connect = document.getElementById('connect');
const logout = document.getElementById('logout');
const retry = document.getElementById('retry');
const fragment = new URLSearchParams(location.hash.slice(1));
// This is an opaque app session, never a VkusVill access/refresh token.
let session = fragment.get('session');
if (!/^[A-Za-z0-9_-]{43}$/.test(session || '')) session = null;
const denied = fragment.get('auth') === 'denied';
const staging = fragment.get('server') === 'staging';
history.replaceState(null, '', location.pathname + location.search);
if (staging) server.value = 'staging';
let generation = 0;

async function api(path, options = {}) {
  const response = await fetch(servers[server.value] + path, {
    ...options, credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: session ? { Authorization: `Bearer ${session}` } : {},
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) throw new Error('UNAVAILABLE');
  return response.json();
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
    connect.disabled = state.authorization !== 'available';
    if (session) {
      const account = await api('/api/session');
      if (current !== generation) return;
      if (!account.authenticated) throw new Error('SESSION_EXPIRED');
      connect.disabled = true;
      status.textContent = 'ВкусВилл подключён. Наличие по адресу ещё не проверено; подбор товаров и корзина пока недоступны.';
    } else {
      status.textContent = state.authorization === 'available'
        ? 'Сервер готов к входу. Подтвердите доступ на сайте ВкусВилла.'
        : 'Сервер доступен. Вход через ВкусВилл ещё не настроен владельцем приложения.';
      if (denied) status.textContent += ' Доступ не был подтверждён.';
    }
  } catch {
    if (current !== generation) return;
    if (session) {
      status.textContent = 'Не удалось проверить сессию. Повторите проверку или отключите её и войдите снова.';
    } else {
      status.textContent = 'Сервер пока недоступен или не обновлён. Примерное меню на главной странице продолжает работать.';
    }
  } finally {
    if (current === generation) { retry.disabled = false; server.disabled = !!session; logout.hidden = !session; }
  }
}
connect.addEventListener('click', () => {
  if (!connect.disabled) location.assign(servers[server.value] + '/oauth/start');
});
logout.addEventListener('click', async () => {
  logout.disabled = true;
  try {
    await api('/api/session', { method: 'DELETE' });
    session = null;
    await check();
    status.textContent = 'Сессия приложения отключена. Полностью отозвать доступ можно в настройках ВкусВилла.';
  } catch { status.textContent = 'Не удалось отключить сессию на сервере. Повторите попытку; она также завершится по сроку действия.'; }
  finally { logout.disabled = false; }
});
server.addEventListener('change', check);
retry.addEventListener('click', check);
check();
