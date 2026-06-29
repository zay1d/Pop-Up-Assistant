# HANDOFF.md

Операционный хэндофф проекта Pop-Up. Сначала прочитайте `CLAUDE.md`
(архитектура), здесь — живой статус и «как это эксплуатировать».

## Живые адреса

| Часть | URL / расположение |
|---|---|
| Фронт (GitHub Pages) | https://zay1d.github.io/Pop-Up-Assistant/ |
| API (Tailscale Funnel) | https://tcm-events.tail226d37.ts.net:8443 (Funnel → 127.0.0.1:8090) |
| Health check | `GET /api/health` → `{"ok":true}` |
| Сервер (SSH) | `ssh -p 54323 admintg@90.156.197.14` (Ubuntu 22.04) |
| App-каталог на сервере | `/opt/pop-up-assistant/` (репо), сервис `systemd: popup` |
| База | PostgreSQL `popup` (роль `popup`), пароль в `server/.env` (chmod 600) |
| Документы (R2) | bucket `popup-documents` — ⚠ R2-ключи в `.env` ещё пустые, документы выключены до их заполнения |

> Сервер общий с проектом TCM: Pop-Up добавлен аддитивно — отдельный порт
> (8090), отдельный Funnel (8443), отдельная БД. 443-й Funnel и tcm-events не
> тронуты.

## Что сделано (код)

- ✅ Базовое приложение импортировано в репозиторий (`index.html`, `app.js`,
  `data.js`, `styles.css`, `plans/*.png`, `docs/`). Логика app.js не менялась.
- ✅ **Облачный слой** `cloud.js` (аддитивный, отдельный файл, подключён в
  `index.html` после `app.js`):
  - Кнопки в шапке **«☁ Загрузить» / «☁ Сохранить»** + индикатор статуса.
  - Авто-загрузка общего датасета при входе; если на сервере пусто — остаётся
    локальный, предлагает «☁ Сохранить».
  - Сохранение только по кнопке (без автосохранения); предупреждение при уходе
    с несохранёнными правками.
  - Документы (хранилища `files` и `activities` типа `file`) выгружаются в R2
    по presigned-URL; в JSON — только метаданные + `docId`/`key`. При загрузке
    blob'ы тянутся обратно из R2 в IndexedDB (app.js не меняется).
  - Строка конфига `window.APP_API_BASE` (пусто ⇒ автономный режим).
- ✅ **Backend** `server/` (Node + Express + PostgreSQL): таблицы `workspace`
  (синглтон, `state JSONB`) и `documents`; эндпоинты workspace + documents.
  **Без авторизации** — чтение и запись открыты.
- ✅ **Deploy**: `.github/workflows/deploy-pages.yml` (публикует весь каталог
  фронта), `deploy/README.md` (Tailscale Funnel), `deploy/popup.service`.
- ✅ `.gitignore` защищает `server/.env`.

## Что сделано (инфраструктура)

- ✅ **GitHub Pages** включён (Source = GitHub Actions). Сайт:
      https://zay1d.github.io/Pop-Up-Assistant/
- ✅ **Сервер** поднят: PostgreSQL БД `popup`, `npm install`, `npm run migrate`
      (таблицы `workspace` + `documents`), `server/.env` заполнен (chmod 600),
      systemd-юнит `popup` активен на 127.0.0.1:8090.
- ✅ **Tailscale Funnel** на 8443 → 8090; API доступен снаружи по HTTPS,
      CORS пропускает origin `https://zay1d.github.io`.
- ✅ `window.APP_API_BASE` в `index.html` указывает на live API.

## Что осталось сделать

- [ ] **Cloudflare R2** (для документов): создать bucket `popup-documents`,
      API-токен, CORS на `https://zay1d.github.io` (PUT+GET). Затем вписать
      `R2_*` в `/opt/pop-up-assistant/server/.env` на сервере и
      `sudo systemctl restart popup`. До этого сохранение датасета БЕЗ
      вложений работает; с вложениями (фото/файлы) — упадёт на выгрузке в R2.
- [ ] End-to-end проверка на живом сайте: сохранить датасет, перезагрузить,
      (после R2) проверить загрузку/скачивание документов.

Полные шаги — в `deploy/README.md`.

## Конфигурация, которая живёт ВНЕ репозитория (на сервере, `server/.env`)

Никогда не коммитить. Меняется на сервере, затем `sudo systemctl restart popup`.

```
PORT=8090
HOST=127.0.0.1
CORS_ORIGINS=https://ВАШ-ЛОГИН.github.io
DATABASE_URL=postgres://popup:ПАРОЛЬ@localhost:5432/popup
R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_ENDPOINT
R2_PUBLIC_BASE_URL   # опционально
```

## Частые операции

- **Сменить адрес API у фронта**: правка `window.APP_API_BASE` в `index.html`
  → коммит/пуш → Pages пересоберётся.
- **Деплой изменения фронта**: просто пуш в ветку деплоя; Actions пересоберёт.
- **Полная очистка данных**:
  `psql "$DATABASE_URL" -c "UPDATE workspace SET state='{}'::jsonb WHERE id=1; TRUNCATE documents;"`
  (объекты в R2 при этом «осиротеют» — чистятся отдельно).

## Известные ограничения / будущее

- **Нет авторизации** — любой с адресом API может менять данные. Если понадобится
  защита: добавить общий пароль (заголовок/JWT) — точки для этого: `Api.req` в
  `cloud.js` и middleware на сервере.
- **«Осиротевшие» файлы в R2**: при удалении документа через карточку blob
  удаляется из IndexedDB, но объект в R2 удаляется только если фронт вызовет
  `DELETE /api/documents/:id`. Файлы, убранные при редактировании размещения,
  могут остаться в R2. Возможное улучшение — серверная сборка мусора (diff
  ключей в `workspace.state` против таблицы `documents`).
- **Загрузка тянет все документы** при входе (чтобы не менять app.js, который
  читает blob'ы из IndexedDB). Для больших архивов — будущая оптимизация:
  ленивое скачивание по требованию (потребует точечной правки рендера в app.js).
- **Одновременное редактирование**: модель «один редактор». PUT заменяет весь
  датасет — при двух одновременных редакторах побеждает последний сохранивший.

## Репозиторий / ветка

- Репозиторий: `zay1d/pop-up-assistant`.
- Ветка разработки и деплоя: `claude/popup-web-service-jmqb6v`
  (она же указана как trigger в workflow и как ветка для PR).
