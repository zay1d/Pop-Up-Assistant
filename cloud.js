// ═══════════════════════════════════════════════════════════════════════════
//  Pop-Up · ОБЛАЧНЫЙ СЛОЙ (cloud.js)
//  ---------------------------------------------------------------------------
//  Дополнительный модуль. Он НЕ меняет логику app.js — только переиспользует
//  его глобальные функции (общая область видимости classic-script): State,
//  dbGetAll/dbPut/dbDel, loadAll, toast, go.
//
//  Если window.APP_API_BASE пуст — модуль сразу выходит, и приложение работает
//  как раньше (всё локально в IndexedDB, перенос через кнопку «⤓ Бэкап»).
//  Если задан URL API — добавляются кнопки «☁ Загрузить / ☁ Сохранить», общий
//  датасет хранится на сервере (JSONB), а документы — в Cloudflare R2.
//
//  Модель: ОДНО общее рабочее пространство, БЕЗ авторизации — все могут читать
//  и писать. Сохранение только по явной кнопке (без автосохранения).
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var API_BASE = (window.APP_API_BASE || localStorage.getItem('popup_api_base') || '').replace(/\/+$/, '');
  if (!API_BASE) return;                       // автономный режим — ничего не меняем.
  localStorage.setItem('popup_api_base', API_BASE);

  // Версия дампа — должна совпадать с exportData() в app.js.
  var DUMP_VERSION = 4;
  // Хранилища IndexedDB, которые мы очищаем/заполняем при загрузке (как importData).
  var STORES = ['zones', 'placements', 'history', 'labels', 'activities', 'files', 'meta'];

  // Карта «id файла → {docId, key, size}». Заполняется при загрузке с сервера
  // и при загрузке новых файлов в R2, чтобы не перезаливать их при каждом
  // сохранении. Живёт в памяти; после перезагрузки страницы восстанавливается
  // из серверного дампа (autoLoad).
  var docKeys = Object.create(null);

  var lastSig = null;        // подпись данных на момент последнего сохранения/загрузки
  var busy = false;          // идёт сохранение/загрузка

  // ── HTTP-клиент ────────────────────────────────────────────────────────────
  var Api = {
    req: async function (method, path, body) {
      var headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      var res = await fetch(API_BASE + path, {
        method: method, headers: headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      if (!res.ok) {
        var msg;
        try { msg = (await res.json()).error; } catch (e) { msg = res.statusText; }
        throw new Error(msg || ('HTTP ' + res.status));
      }
      return res.status === 204 ? null : res.json();
    },
    getWorkspace: function () { return this.req('GET', '/api/workspace'); },
    putWorkspace: function (state) { return this.req('PUT', '/api/workspace', { state: state }); },
    presignDoc: function (meta) { return this.req('POST', '/api/documents/presign', meta); },
    confirmDoc: function (id) { return this.req('POST', '/api/documents/' + id + '/confirm'); },
    docDownloadUrl: function (id) { return API_BASE + '/api/documents/' + id + '/download'; }
  };
  window.PopupCloud = { api: Api };

  // ── Загрузка одного файла в R2 (presign → PUT → confirm) ────────────────────
  // Возвращает {docId, key, size}. Если файл уже выгружен (есть в docKeys) —
  // переиспользует прежний ключ, ничего не заливая повторно.
  async function ensureUploaded(id, blob, name, type) {
    if (docKeys[id]) return docKeys[id];
    var ct = type || (blob && blob.type) || 'application/octet-stream';
    var pre = await Api.presignDoc({ filename: name || ('file-' + id), contentType: ct, size: blob ? blob.size : null });
    var put = await fetch(pre.uploadUrl, { method: 'PUT', headers: { 'Content-Type': ct }, body: blob });
    if (!put.ok) throw new Error('R2 вернул ' + put.status);
    await Api.confirmDoc(pre.documentId);
    docKeys[id] = { docId: pre.documentId, key: pre.storageKey, size: blob ? blob.size : null };
    return docKeys[id];
  }

  // ── Скачивание файла из R2 → Blob (по docId) ────────────────────────────────
  async function downloadBlob(docId) {
    var res = await fetch(Api.docDownloadUrl(docId));   // 302 → R2 presigned GET
    if (!res.ok) throw new Error('R2 вернул ' + res.status);
    return res.blob();
  }

  // ── Сборка дампа (как exportData(), но файлы → R2, в JSON только метаданные) ─
  async function buildDump() {
    var zones = await dbGetAll('zones');
    var placements = await dbGetAll('placements');
    var history = await dbGetAll('history');
    var labels = await dbGetAll('labels');

    var actsRaw = await dbGetAll('activities');
    var activities = [];
    for (var i = 0; i < actsRaw.length; i++) {
      var a = actsRaw[i];
      var ao = Object.assign({}, a);
      delete ao.blob;
      if (a.type === 'file' && a.blob) {
        var ru = await ensureUploaded(a.id, a.blob, a.fileName || a.name, a.fileType || a.type);
        ao.docId = ru.docId; ao.key = ru.key; ao.fileSize = ru.size;
      }
      activities.push(ao);
    }

    var filesRaw = await dbGetAll('files');
    var files = [];
    for (var j = 0; j < filesRaw.length; j++) {
      var f = filesRaw[j];
      var fu = await ensureUploaded(f.id, f.blob, f.name, f.type);
      files.push({
        id: f.id, placementId: f.placementId, kind: f.kind,
        name: f.name, type: f.type,
        docId: fu.docId, key: fu.key, size: fu.size
      });
    }

    return {
      app: 'popup', version: DUMP_VERSION, exportedAt: new Date().toISOString(),
      currency: State.currency,
      zones: zones, placements: placements, history: history,
      labels: labels, activities: activities, files: files
    };
  }

  // ── Применение дампа в IndexedDB (как importData(), но blob'ы тянем из R2) ───
  async function applyDump(dump) {
    // очистка
    for (var s = 0; s < STORES.length; s++) {
      var store = STORES[s];
      var all = await dbGetAll(store);
      for (var k = 0; k < all.length; k++) {
        await dbDel(store, all[k][store === 'meta' ? 'key' : 'id']);
      }
    }
    docKeys = Object.create(null);

    var z = dump.zones || [];        for (var a = 0; a < z.length; a++) await dbPut('zones', z[a]);
    var p = dump.placements || [];   for (var b = 0; b < p.length; b++) await dbPut('placements', p[b]);
    var h = dump.history || [];      for (var c = 0; c < h.length; c++) await dbPut('history', h[c]);
    var l = dump.labels || [];       for (var d = 0; d < l.length; d++) await dbPut('labels', l[d]);

    var acts = dump.activities || [];
    for (var e = 0; e < acts.length; e++) {
      var act = Object.assign({}, acts[e]);
      var blob = null;
      if (act.type === 'file' && act.docId) {
        try { blob = await downloadBlob(act.docId); docKeys[act.id] = { docId: act.docId, key: act.key, size: act.fileSize }; }
        catch (err) { console.error('Не удалось скачать файл активности', act.id, err); }
      }
      delete act.docId; delete act.key; delete act.fileSize;
      act.blob = blob;
      await dbPut('activities', act);
    }

    var files = dump.files || [];
    for (var g = 0; g < files.length; g++) {
      var f = files[g];
      var fblob = null;
      if (f.docId) {
        try { fblob = await downloadBlob(f.docId); docKeys[f.id] = { docId: f.docId, key: f.key, size: f.size }; }
        catch (err2) { console.error('Не удалось скачать файл', f.id, err2); }
      }
      await dbPut('files', { id: f.id, placementId: f.placementId, kind: f.kind, name: f.name, type: f.type, blob: fblob });
    }

    if (dump.currency) { await dbPut('meta', { key: 'currency', value: dump.currency }); State.currency = dump.currency; }
  }

  // ── Подпись данных (для предупреждения о несохранённых правках) ──────────────
  // Лёгкая, синхронная — по State (зоны с позициями на карте, размещения,
  // подписи, валюта). Изменения ТОЛЬКО документов здесь не учитываются.
  function signature() {
    try {
      return JSON.stringify({ z: State.zones, p: State.placements, l: State.labels, c: State.currency });
    } catch (e) { return String(Date.now()); }
  }

  // ── Сохранение в облако ─────────────────────────────────────────────────────
  async function saveToCloud() {
    if (busy) return;
    busy = true; setStatus('Сохранение…');
    try {
      var dump = await buildDump();
      await Api.putWorkspace(dump);
      lastSig = signature();
      setStatus('Сохранено ✓');
      if (typeof toast === 'function') toast('Сохранено в облако', 'ok');
    } catch (e) {
      console.error('Cloud save failed:', e);
      setStatus('Ошибка сохранения');
      if (typeof toast === 'function') toast('Не удалось сохранить: ' + e.message, 'err');
    } finally { busy = false; }
  }

  // ── Загрузка из облака ──────────────────────────────────────────────────────
  // silent=true — авто-загрузка при старте (не показывает подтверждение и
  // молчит, если на сервере ещё пусто).
  async function loadFromCloud(silent) {
    if (busy) return;
    if (!silent && !confirm('Загрузка из облака заменит текущие локальные данные. Продолжить?')) return;
    busy = true; setStatus('Загрузка…');
    try {
      var ws = await Api.getWorkspace();
      var dump = ws && ws.state;
      if (!dump || dump.app !== 'popup') {            // на сервере ещё ничего нет
        setStatus(silent ? 'Облако пустое' : 'В облаке пока нет данных');
        if (!silent && typeof toast === 'function') toast('В облаке пока нет данных — нажмите «☁ Сохранить», чтобы выгрузить текущие', 'ok');
        busy = false; return;
      }
      await applyDump(dump);
      await loadAll();
      lastSig = signature();
      setStatus('Загружено ✓');
      if (typeof toast === 'function' && !silent) toast('Данные загружены из облака', 'ok');
      if (typeof go === 'function') go(State.view || 'home');
    } catch (e) {
      console.error('Cloud load failed:', e);
      setStatus('Ошибка загрузки');
      if (typeof toast === 'function') toast('Не удалось загрузить: ' + e.message, 'err');
    } finally { busy = false; }
  }

  // ── UI: кнопки в шапке ──────────────────────────────────────────────────────
  function setStatus(text) {
    var s = document.getElementById('cloudStatus');
    if (s) s.textContent = text || '';
  }

  function buildControls() {
    var right = document.querySelector('.topbar-right');
    if (!right || document.getElementById('cloudControls')) return;
    var wrap = document.createElement('span');
    wrap.id = 'cloudControls';
    wrap.style.cssText = 'display:inline-flex;gap:8px;align-items:center;margin-right:8px;';
    wrap.innerHTML =
      '<span id="cloudStatus" style="font-size:12px;color:var(--muted,#94a3b8);"></span>'
      + '<button class="icon-btn" id="cloudLoadBtn" title="Загрузить общий датасет с сервера">☁ Загрузить</button>'
      + '<button class="icon-btn" id="cloudSaveBtn" title="Сохранить общий датасет на сервер">☁ Сохранить</button>';
    right.insertBefore(wrap, right.firstChild);
    document.getElementById('cloudLoadBtn').onclick = function () { loadFromCloud(false); };
    document.getElementById('cloudSaveBtn').onclick = function () { saveToCloud(); };
  }

  // Предупреждение при уходе со страницы с несохранёнными правками.
  window.addEventListener('beforeunload', function (e) {
    if (lastSig !== null && signature() !== lastSig) { e.preventDefault(); e.returnValue = ''; }
  });

  // ── Старт ───────────────────────────────────────────────────────────────────
  // Ждём, пока app.js откроет базу и отрисует первый экран, затем добавляем
  // кнопки и автоматически тянем общий датасет с сервера.
  function whenReady(fn) {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (typeof _db !== 'undefined' && _db && typeof loadAll === 'function' && document.querySelector('.topbar-right')) {
        clearInterval(timer); fn();
      } else if (tries > 100) { clearInterval(timer); }   // ~20 c — сдаёмся
    }, 200);
  }

  whenReady(function () {
    buildControls();
    loadFromCloud(true);     // авто-загрузка общего датасета при входе
  });
})();
