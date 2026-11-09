# Развёртывание с телефона через Cloudflare и GitHub

У ChatGPT пока нет доступа к вашему аккаунту Cloudflare. Установленное GitHub-приложение Cloudflare разрешает самому Cloudflare читать репозиторий, но не выдаёт ChatGPT ключ управления Workers.

Для уже созданного нового Worker **moe-pitanie-2** используются wrangler.jsonc в корне репозитория или worker/wrangler.jsonc. Оба указывают на серверный код, без раздачи HTML-сайта. Публичный каталог включён для проверки; OAuth подготовлен, но доступен только после добавления всех Secrets. Создание ссылки на корзину разрешено только после явного подтверждения свежего расчёта. Старый moe-pitanie-api и GitHub Pages сохраняются.

Если новый Worker уже связан с GitHub, ручная вставка не требуется. Выбрать ветку feat/worker-mcp-foundation, Build command `npm test`, Deploy command `npx wrangler@4 deploy`. Эти команды работают и из корня, и из worker/. После push Cloudflare запускает сборку. Корневая package.json только перенаправляет тесты в worker/.

Ожидаемый ответ https://moe-pitanie-2.statusdi.workers.dev/api/status: catalogEnabled=true; при трёх корректных Secrets — authorization=available и cartEnabled=true, без Secrets — not_configured и cartEnabled=false. Если остаётся Hello World!, сборка ещё не опубликована. Если в проверках GitHub указан moe-pitanie-api, это старый Worker; его сборка по умолчанию не должна перезаписывать moe-pitanie-2. Для старого Worker нужна явно выбранная production-конфигурация.

Ниже альтернативная процедура создания отдельного staging с другим именем, если она понадобится. Для текущего нового Worker повторно создавать приложение не нужно.

## Staging без секретов

1. Открыть [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create application** → **GitHub**.
2. Выбрать репозиторий **DinaraY/Moe_pitanie**. Если репозитория нет, в GitHub-настройках установленного **Cloudflare Workers and Pages** разрешить доступ к нему.
3. Имя Worker: **moe-pitanie-api-staging**. Выбрать ветку **feat/worker-mcp-foundation**, пока PR не объединён; после объединения можно переключить на main.
4. В расширенных настройках установить **Root directory: worker**. Это важно: сайт из корневого index.html переносить в Cloudflare не нужно.
5. **Build command:** `npm test`. **Deploy command:** `npx wrangler@4 deploy --config wrangler.staging.jsonc`. Если есть Preview command — `npx wrangler@4 versions upload --config wrangler.staging.jsonc`. Не использовать команды публикации Pages или статических assets.
6. Проверить имя и ветку, нажать **Save and Deploy**. Первое развёртывание создаёт Durable Object AUTH_STORE и rate limiter по wrangler.staging.jsonc. Секреты на этом этапе не нужны, все интеграционные флаги false.
7. Открыть выданный URL с `/api/status`. Ожидается service=moe-pitanie-api, catalogEnabled=false, authorization=not_configured, cartEnabled=false. Сохранить ссылку на deployment для отката.
8. В **Settings → Variables and Secrets** тестового Worker установить CATALOG_ENABLED=true. Проверить `/api/tools`, затем меню через connect.html (страница появится на GitHub Pages после объединения PR). Если MCP из Cloudflare также возвращает ошибку, каталог должен показать недоступность, без подставленных товаров.

Git-интеграция запускает сборку/деплой при следующих push в выбранную ветку. Значения флагов false, явно указанные в wrangler.jsonc, имеют приоритет над Dashboard при очередном deploy. После каждого deploy проверять /api/status и включать только прошедшие проверку функции. Дополнительные настройки OAuth сохраняются через keep_vars, Secrets не публикуются в git.

## OAuth

Регистрация клиента и Secrets: [OAUTH.md](OAUTH.md). Для staging нужен именно staging callback. Если клиент уже зарегистрирован только для production URI, не вводить его данные в staging с другим callback.

## Production

Для основного Worker подготовлена **worker/wrangler.production.jsonc** с name=moe-pitanie-api и production callback. Сохранить текущую версию Hello World! в Deployments для rollback. Существующий Worker можно связать с репозиторием через **Workers & Pages → moe-pitanie-api → Settings → Builds → Connect**. Root directory: worker, Build command: npm test, Deploy command: `npx wrangler@4 deploy --config wrangler.production.jsonc`. При наличии Preview command: `npx wrangler@4 versions upload --config wrangler.production.jsonc`. Убедиться, что система использует выбранную конфигурацию с name=moe-pitanie-api; не принимать предложенное переименование в staging и не запускать autoconfig корневого HTML-сайта.

На этапе живой проверки можно вместо production deploy использовать `npx wrangler@4 versions upload --config wrangler.production.jsonc`, чтобы загрузить версию без переключения активного deployment. Production callback будет работать только после публикации соответствующей версии; тестовая версия сама по себе его не заменяет.

Не включать CART_ENABLED до проверки схемы и свежего расчёта корзины под OAuth. После включения ссылка создаётся только по отдельному подтверждению состава и суммы. Заказ и оплата выполняются вами во ВкусВилле.

Источники: [Cloudflare Builds — подключение нового и существующего Worker](https://developers.cloudflare.com/workers/ci-cd/builds/), [настройка Git-интеграции](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/).
