# Развёртывание Pop-Up

Архитектура: статичный фронт на **GitHub Pages** + API на сервере
(Node + Express + PostgreSQL) + документы в **Cloudflare R2**. Наружу API
выходит через **Tailscale Funnel** (бесплатно, без белого IP и без открытых
портов, авто-TLS).

```
Браузер ──HTTPS──► GitHub Pages (фронт: index.html, app.js, cloud.js, …)
   │
   ├── REST API ─────► Tailscale Funnel → Node/Express (127.0.0.1:8090) → PostgreSQL
   │
   └── presigned PUT/GET ──► Cloudflare R2 (файлы документов)
```

> ⚠️ **Без авторизации.** По решению владельца вход не требуется: любой, кто
> знает адрес API, может **читать и менять** общий датасет. Защита — только в
> приватности адреса Funnel и CORS. Если позже нужна защита — добавьте общий
> пароль (хук под это оставлен в `cloud.js`/сервере).

---

## 1. Cloudflare R2 (хранилище документов)

1. Cloudflare → **R2** → создайте bucket, напр. `popup-documents`.
2. **R2 → Manage API Tokens** → токен с доступом на чтение/запись к bucket.
   Сохраните **Access Key ID** и **Secret Access Key**.
3. Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
4. **CORS** для bucket (Settings → CORS policy) — разрешите из браузера
   загрузку (PUT) и скачивание (GET) с origin вашего фронта:
   ```json
   [
     {
       "AllowedOrigins": ["https://ВАШ-ЛОГИН.github.io"],
       "AllowedMethods": ["PUT", "GET"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

## 2. PostgreSQL на сервере

```bash
sudo apt update && sudo apt install -y postgresql
sudo -u postgres psql -c "CREATE USER popup WITH PASSWORD 'СВОЙ_ПАРОЛЬ';"
sudo -u postgres psql -c "CREATE DATABASE popup OWNER popup;"
```

## 3. Backend

```bash
# нужен Node 20+ (при необходимости через nodesource)
sudo git clone <URL_РЕПО> /opt/pop-up-assistant
cd /opt/pop-up-assistant/server
npm install --omit=dev

cp .env.example .env
# заполните .env: DATABASE_URL, R2_*, CORS_ORIGINS (URL фронта на GitHub Pages)
npm run migrate                      # создаёт таблицы workspace + documents
```

Запуск как сервис:
```bash
sudo cp /opt/pop-up-assistant/deploy/popup.service /etc/systemd/system/
# при необходимости поправьте User= и пути внутри popup.service
sudo systemctl daemon-reload
sudo systemctl enable --now popup
sudo systemctl status popup
```

Проверка локально: `curl http://127.0.0.1:8090/api/health` → `{"ok":true}`

## 4. Tailscale Funnel (публичный HTTPS без домена и портов)

```bash
# установка (один раз)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# выставить порт 8090 наружу по HTTPS (фоновый режим, переживает перезагрузку)
sudo tailscale funnel --bg 8090
sudo tailscale funnel status      # покажет публичный адрес вида
                                  # https://<host>.<tailnet>.ts.net
```

Адрес `https://<host>.<tailnet>.ts.net` — это и есть ваш `APP_API_BASE`.

Проверка снаружи: `curl https://<host>.<tailnet>.ts.net/api/health` → `{"ok":true}`

## 5. Frontend (GitHub Pages)

1. В репозитории: **Settings → Pages → Source = GitHub Actions**.
   Workflow `.github/workflows/deploy-pages.yml` публикует весь каталог фронта
   при каждом пуше в ветку деплоя.
2. **Один шаг настройки фронта:** в `index.html` (блок «ОБЛАЧНАЯ КОНФИГУРАЦИЯ»,
   в самом низу) впишите адрес API:
   ```js
   window.APP_API_BASE = "https://<host>.<tailnet>.ts.net";
   ```
   - Пусто (`""`) → приложение работает автономно (всё локально), как раньше.
   - Задан URL → в шапке появляются кнопки **«☁ Загрузить / ☁ Сохранить»**,
     общий датасет берётся с сервера, документы — из R2.
3. Закоммитьте и запушьте — Pages пересоберётся автоматически.

---

## API кратко (всё открыто, без авторизации)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/health` | проверка живости |
| GET | `/api/workspace` | прочитать общий датасет (state JSONB) |
| PUT | `/api/workspace` | сохранить общий датасет |
| POST | `/api/documents/presign` | получить presigned PUT для загрузки в R2 |
| POST | `/api/documents/:id/confirm` | пометить документ загруженным |
| GET | `/api/documents/:id/download` | redirect на presigned GET (скачивание) |
| DELETE | `/api/documents/:id` | удалить документ (метаданные + объект в R2) |

## Частые проблемы

- **Кнопки облака не появились** → проверьте, что `window.APP_API_BASE` задан и
  файл `cloud.js` подключён в `index.html` после `app.js`.
- **Ошибка сети при загрузке/сохранении** → CORS. В `server/.env`
  `CORS_ORIGINS` должен точно совпадать с origin фронта (напр.
  `https://ВАШ-ЛОГИН.github.io`); перезапустите сервис.
- **Не грузятся/не качаются документы** → CORS bucket R2 должен разрешать
  `PUT` и `GET` с origin фронта.
- **«В облаке пока нет данных»** → сервер ещё пуст; нажмите **«☁ Сохранить»**,
  чтобы выгрузить текущий локальный датасет в облако.
- **Полная очистка** → `psql "$DATABASE_URL" -c "UPDATE workspace SET state='{}'::jsonb WHERE id=1; TRUNCATE documents;"`
  (объекты в R2 при этом остаются «осиротевшими» — чистятся отдельно).
