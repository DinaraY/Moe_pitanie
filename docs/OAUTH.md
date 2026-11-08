# Включение OAuth ВкусВилла

Код реализован, но живой flow не проверен: среда разработки получает Access Blocked от MCP. По умолчанию OAUTH_ENABLED=false. Не включать до подтверждения адресов OAuth и регистрации клиента.

## Регистрация и настройки

1. В личном кабинете ВкусВилл установить точный адрес в Долгопрудном.
2. На https://vkusvill.ru/oauth/registration/ зарегистрировать персонального клиента. Для production Redirect URI: **https://moe-pitanie-api.statusdi.workers.dev/oauth/callback**. Для staging: **https://moe-pitanie-api-staging.statusdi.workers.dev/oauth/callback**. Поддержку нескольких callback одним клиентом нужно подтвердить при регистрации; если зарегистрирован только production, staging OAuth не включать.
3. Получить текущие официальные metadata/инструкцию ВкусВилла и подтвердить **VV_AUTHORIZATION_ENDPOINT**, **VV_TOKEN_ENDPOINT**, **VV_SCOPE**, **VV_TOKEN_AUTH_METHOD**. Endpoints и scope в этом проекте намеренно не выдуманы. Поддержаны client_secret_basic и client_secret_post. Запрашивать минимальный scope каталога, без истории/персональных скидок/оформления заказа и без offline_access. Пока refresh не проверен и не реализован.
4. После развёртывания кода через Wrangler открыть Cloudflare Dashboard → Workers & Pages → выбранный Worker → Settings → Variables and Secrets. Добавить Secrets: **VV_CLIENT_ID**, **VV_CLIENT_SECRET**, **TOKEN_ENCRYPTION_KEY**. Значения клиента — из письма ВкусВилла. Ключ — 32 случайных байта в base64url. Генерация на доверенном компьютере:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

   Не присылать ключи или письмо в чат, не сохранять в git. В коде и тестах нет настоящих секретов. При смене ключа существующие сессии становятся нечитаемыми: нужен новый вход.
5. Обычные переменные Worker: подтверждённые VV_AUTHORIZATION_ENDPOINT, VV_TOKEN_ENDPOINT, VV_SCOPE, VV_TOKEN_AUTH_METHOD. Проверить **VV_REDIRECT_URI** (точное совпадение с регистрацией), **APP_RETURN_URL=https://dinaray.github.io/Moe_pitanie/connect.html**, **ALLOWED_ORIGIN=https://dinaray.github.io**. **APP_ENV=staging** на тестовом Worker, **production** на основном. После проверки всех значений установить OAUTH_ENABLED=true. CATALOG_ENABLED включается отдельно.
6. В allowlist разрешены HTTPS OAuth endpoints только на vkusvill.ru и mcp.vkusvill.ru, без credentials/query/fragment. Если официальный issuer сообщает другой домен, его сначала нужно проверить и явно добавить в конфигурационный валидатор. Нельзя отключать проверку доменов или использовать адреса из случайных примеров.
7. Развёртывать весь worker/, а не один JS файл: нужны binding AUTH_STORE, SQLite Durable Objects migration и CATALOG_LIMITER из wrangler.jsonc. Не удалять историю migrations после первого deploy. Имя Worker по умолчанию staging. Для production отдельно поменять name, APP_ENV и VV_REDIRECT_URI, как описано в INTEGRATION.md.
8. После объединения PR и обновления GitHub Pages открыть **connect.html**, выбрать основной или тестовый сервер. Страница проверит готовность. При Hello World!, недоступности Worker или незаполненном OAuth кнопка входа недоступна. Основное примерное меню продолжает работать. После каждого deploy перепроверять /api/status: значения, явно перечисленные в wrangler.jsonc (включая флаги false), имеют приоритет над Dashboard. keep_vars сохраняет дополнительные переменные, но не отменяет этот приоритет. Включать флаги через Dashboard после deploy либо изменять их явно в конфигурации перед проверенным deploy.

## Как устроен вход

- Верхнеуровневый переход /oauth/start создаёт PKCE S256, случайный state и HttpOnly Secure SameSite=Lax cookie привязки браузера. State/verifier зашифрованы на сервере и действуют 10 минут.
- Callback проверяет cookie и state, атомарно погашает state, затем обменивает code на токен сервер-сервер. Повторное использование отклоняется. Redirect и адрес обмена берутся только из проверенной конфигурации. Сетевые redirects запрещены.
- Access token хранится в Durable Object зашифрованным AES-GCM. Ключ хранится в Worker Secret; каждая запись криптографически привязана к случайному идентификатору сессии. Имена объектов используют SHA-256 идентификаторов. Refresh token не сохраняется.
- Браузер получает через fragment только случайный идентификатор сессии приложения, **не токен ВкусВилла**. JS сразу очищает fragment и держит идентификатор в памяти вкладки, без localStorage/sessionStorage. Внешних скриптов нет. Страница имеет CSP и Referrer-Policy. После перезагрузки требуется повторный вход.
- API использует идентификатор приложения в Authorization, поэтому сторонние cookies между GitHub Pages и workers.dev не нужны. Сессия живёт до часа, не дольше expires_in access token. Logout удаляет серверную запись. Полный отзыв grant выполняется отдельно у ВкусВилла.
- Сессии разных пользователей изолированы. Нет общих пользовательских токенов в глобальной переменной Worker. Внешние Cookie/Authorization не проксируются в MCP: OAuth-токен выбирается только после серверной проверки сессии.

## Проверка перед production

Нужны живые проверки на телефоне: вход, отказ на consent, повторный/неверный state, истечение сессии, logout и изоляция пользователей. Подтвердить текущий scope и каталог адреса с помощью tools/list/search. Не записывать в логи заголовки, тело token exchange, callback query, идентификаторы сессий и персональные ответы. Автоматические тесты используют только фиктивные значения.

До проверки каждого результата API возвращает deliveryAvailability=unverified даже при активной сессии. Вход не доказывает, что конкретный товар есть по адресу. Адаптер реальных товаров, КБЖУ и цен, двухдневное меню и подтверждение корзины ещё требуют реализации на проверенных схемах ответа. Все /api/cart* остаются закрыты с 501.
