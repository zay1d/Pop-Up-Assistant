# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

## What this is

**Pop-Up** — учёт размещений (pop-up) в торговом центре: зоны на планах этажей,
календарь занятости, карточки арендаторов, документы, отчёты. Изначально —
локальное офлайн-приложение (vanilla HTML/CSS/JS, данные в IndexedDB). Поверх
добавлен **облачный слой**, чтобы датасет был общим для всех онлайн, а документы
хранились в Cloudflare R2.

## Architecture

```
Browser ──HTTPS──► GitHub Pages (фронт: index.html, app.js, cloud.js, …)
   │
   ├── REST API ─────► сервер: Tailscale Funnel → Node/Express (127.0.0.1:8090) → PostgreSQL
   │
   └── presigned PUT/GET ──► Cloudflare R2 (документы)
```

- **Frontend** — статика (`index.html`, `app.js`, `data.js`, `cloud.js`,
  `styles.css`, `plans/*.png`). Деплоится на GitHub Pages через
  `.github/workflows/deploy-pages.yml` (публикуется **весь каталог фронта**).
- **Backend** — `server/` (Node + Express + PostgreSQL), слушает loopback,
  наружу через Tailscale Funnel. Запускается как systemd-юнит (`deploy/`).
- **Storage** — документы льются из браузера прямо в R2 по presigned-URL; в
  Postgres только метаданные.

## Ключевая модель (отличия от обычных multi-tenant приложений)

- **Одно общее рабочее пространство.** Весь датасет — одна строка `workspace`
  (id = 1), поле `state JSONB`. Это та же форма, что даёт `exportData()` в
  app.js, но **без blob'ов**: у файлов/активностей хранятся только метаданные +
  ключ в R2.
- **Без авторизации.** Чтение И запись открыты всем, у кого есть адрес API —
  осознанное решение владельца. Реальная защита — приватность адреса Funnel и
  CORS. Хук под опциональный общий пароль можно добавить позже (и в `cloud.js`,
  и на сервере).
- **Без автосохранения.** Данные уходят на сервер только по кнопке
  «☁ Сохранить». При уходе со страницы с несохранёнными правками — нативное
  предупреждение браузера.

## Структура index.html / порядок скриптов (важно)

В конце `index.html` четыре блока, по порядку:

1. **Облачная конфигурация** — одна строка: `window.APP_API_BASE = "<url>"`.
   Пусто ⇒ приложение полностью автономно (всё локально), облако выключено.
2. `data.js` — справочные сиды (зоны, статусы, палитра).
3. `app.js` — ядро (IndexedDB, экраны, `exportData`/`importData`, `State`).
4. `cloud.js` — **аддитивный** облачный слой (IIFE).

### Золотое правило: НЕ менять логику app.js

Облачный слой намеренно аддитивный. Он переиспользует глобали ядра (общая
область видимости classic-script): `State`, `dbGetAll/dbPut/dbDel`, `loadAll`,
`toast`, `go`, `_db`. Новую облачную логику добавляйте в `cloud.js`, не трогая
app.js. Если `APP_API_BASE` пуст — `cloud.js` сразу выходит, и приложение ведёт
себя как оригинал.

### Форма датасета (дамп)

`exportData()` в app.js и `buildDump()` в cloud.js должны давать одинаковую
форму: `{ app:'popup', version, exportedAt, currency, zones, placements,
history, labels, activities, files }`. Разница: в локальном бэкапе blob'ы
кодируются в base64 (`files[].data`, `activities[].data`); в облаке blob'ы
уезжают в R2, а в JSON остаются только метаданные + `docId`/`key`
(`files[]`, `activities[]` типа `file`). Если в ядро добавится поле/хранилище —
синхронизируйте `buildDump()`/`applyDump()` в cloud.js.

Документы живут в двух местах ядра: хранилище `files` (привязаны к
`placementId`) и `activities` типа `file` (журнал работы с арендатором). Оба
несут blob → оба выгружаются в R2.

## Conventions

- **Секреты** — только в `server/.env` (в `.gitignore`). Никогда не коммитить и
  не класть во фронт (он публичный).
- После правок `index.html`/`cloud.js`/`app.js` — синтакс-чек скриптов (ниже):
  битый скрипт молча ломает страницу.

## Commands

Фронт (деплой автоматический по пушу в ветку деплоя):
```bash
git push origin claude/popup-web-service-jmqb6v   # GitHub Actions пересоберёт Pages
```

Синтакс-проверка JS:
```bash
node --check app.js && node --check cloud.js && node --check data.js
# плюс серверные файлы:
for f in server/src/*.js server/src/routes/*.js; do node --check "$f"; done
```

Бэкенд (на сервере — см. `deploy/README.md`):
```bash
cd /opt/pop-up-assistant/server
npm install --omit=dev
npm run migrate
sudo systemctl restart popup
```

## API (summary) — всё открыто, без авторизации

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/health` | живость |
| GET/PUT | `/api/workspace` | прочитать / сохранить общий датасет |
| POST | `/api/documents/presign` | presigned PUT в R2 |
| POST | `/api/documents/:id/confirm` | пометить документ готовым |
| GET | `/api/documents/:id/download` | redirect на presigned GET |
| DELETE | `/api/documents/:id` | удалить документ (метаданные + R2) |

## Notes

- Планы этажей `plans/*.png` — статические ассеты приложения (деплоятся с
  сайтом), это НЕ пользовательские документы, в R2 не уезжают.
- См. `HANDOFF.md` — актуальный статус и операционные детали (адреса, что
  сделано, что осталось).
