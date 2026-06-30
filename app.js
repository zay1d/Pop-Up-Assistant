// ═══════════════════════════════════════════════════════════════
//  Pop-Up · приложение учёта размещений в ТЦ
//  Всё хранится локально в браузере (IndexedDB). Офлайн.
// ═══════════════════════════════════════════════════════════════

'use strict';

/* ───────── База данных (IndexedDB) ───────── */
const DB_NAME = 'popup-db';
const DB_VER = 4;
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('zones'))
        db.createObjectStore('zones', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('placements'))
        db.createObjectStore('placements', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) {
        const fs = db.createObjectStore('files', { keyPath: 'id' });
        fs.createIndex('placementId', 'placementId', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta'))
        db.createObjectStore('meta', { keyPath: 'key' });
      // v2: журнал истории занятости — хранится отдельно и не удаляется
      if (!db.objectStoreNames.contains('history')) {
        const hs = db.createObjectStore('history', { keyPath: 'id' });
        hs.createIndex('placementId', 'placementId', { unique: false });
        hs.createIndex('zoneId', 'zoneId', { unique: false });
      }
      // v3: журнал работы с арендатором (встречи, задачи, комментарии, файлы) — не удаляется
      if (!db.objectStoreNames.contains('activities')) {
        const ac = db.createObjectStore('activities', { keyPath: 'id' });
        ac.createIndex('tenantKey', 'tenantKey', { unique: false });
      }
      // v4: редактируемые подписи (названия магазинов) поверх карты
      if (!db.objectStoreNames.contains('labels')) {
        const lb = db.createObjectStore('labels', { keyPath: 'id' });
        lb.createIndex('floor', 'floor', { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // если другая вкладка обновит версию — отпустить базу и перезагрузиться
      db.onversionchange = () => { db.close(); location.reload(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    // обновление версии заблокировано открытой старой вкладкой
    req.onblocked = () => {
      const v = document.getElementById('view');
      if (v) v.innerHTML = `<div class="empty"><div class="em-icon">🔄</div>
        <h3>Закройте другие вкладки приложения</h3>
        <p>Pop-Up открыт в другой вкладке или окне со старой версией базы.<br>
        Закройте их и обновите эту страницу (F5).</p></div>`;
    };
  });
}

function idbReq(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(store, mode);
    const os = tx.objectStore(store);
    const r = fn(os);
    tx.oncomplete = () => resolve(r && r.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const dbGetAll = (s) => idbReq(s, 'readonly', (os) => os.getAll());
const dbGet = (s, k) => idbReq(s, 'readonly', (os) => os.get(k));
const dbPut = (s, v) => idbReq(s, 'readwrite', (os) => os.put(v));
const dbDel = (s, k) => idbReq(s, 'readwrite', (os) => os.delete(k));
function dbGetByIndex(store, index, key) {
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(store, 'readonly');
    const r = tx.objectStore(store).index(index).getAll(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/* ───────── Состояние ───────── */
const State = {
  view: 'home',
  zones: [],
  placements: [],
  cal: { y: new Date().getFullYear(), m: new Date().getMonth() }, // m: 0-11
  bookMonth: { y: new Date().getFullYear(), m: new Date().getMonth() }, // выбранный месяц на карте бронирования
  floor: 1,
  currency: 'сум',
  search: '',
  historyMode: null,   // null = две карточки, 'zones' | 'tenants'
  history: [],         // журнал занятости (статус «Занято»)
  labels: [],          // редактируемые подписи на карте
};

const MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const WD = ['пн','вт','ср','чт','пт','сб','вс'];

/* ───────── Утилиты ───────── */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
function parseDate(s) { if (!s) return null; const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }
function fmtDate(s) { const d = parseDate(s); if (!d) return '—'; return String(d.getDate()).padStart(2,'0')+'.'+String(d.getMonth()+1).padStart(2,'0')+'.'+d.getFullYear(); }
function fmtDateShort(s) { const d = parseDate(s); if (!d) return '—'; return String(d.getDate()).padStart(2,'0')+'.'+String(d.getMonth()+1).padStart(2,'0'); }
function daysInMonth(y, m) { return new Date(y, m+1, 0).getDate(); }
function todayStr() { return ymd(new Date()); }
function diffDaysIncl(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000) + 1; }
function addDays(s, n) { const d = parseDate(s); if (!d) return s; d.setDate(d.getDate() + n); return ymd(d); }
// Фактически занятый период зоны = аренда + дни на монтаж (до начала) и демонтаж (после конца).
function occupiedSpan(p) {
  const setup = Math.max(0, Number(p.setupDays) || 0);
  const teardown = Math.max(0, Number(p.teardownDays) || 0);
  return { start: addDays(p.start, -setup), end: addDays(p.end, teardown) };
}
function fmtMoney(n) { if (n == null || n === '' || isNaN(n)) return '—'; return Number(n).toLocaleString('ru-RU') + ' ' + State.currency; }
function fmtNum(n) { if (n == null || n === '' || isNaN(n)) return '0'; return Number(n).toLocaleString('ru-RU'); }
function fmtUsd(n) { if (n == null || n === '' || isNaN(n)) return '—'; return Number(n).toLocaleString('ru-RU') + ' $'; }

// Финансы размещения: фиксированная стоимость зоны в день × число дней, минус скидка %.
function placementMoney(p) {
  const z = zoneById(p.zoneId);
  const dayRate = z ? Number(z.dayRate) || 0 : 0;
  const days = (p.start && p.end) ? diffDaysIncl(p.start, p.end) : 0;
  const discount = Number(p.discount) || 0;
  const totalBase = dayRate * days;
  const manual = (p.manualCost != null && p.manualCost !== '');  // ручная стоимость задана
  const totalAgreed = manual ? (Number(p.manualCost) || 0) : Math.round(totalBase * (1 - discount / 100));
  return { dayRate, days, discount, totalBase, totalAgreed, manual, area: Number(p.area) || 0 };
}

function statusInfo(key) { return CONTRACT_STATUSES.find(s => s.key === key) || CONTRACT_STATUSES[0]; }
function zoneById(id) { return State.zones.find(z => z.id === id); }
function tenantKey(brand) { return (brand || '').trim().toLowerCase(); }

/* Размещение активно «сегодня»? */
function isActiveToday(p) { const t = todayStr(); return p.start <= t && p.end >= t; }
/* Пересекается ли размещение с интервалом [a,b] (строки YYYY-MM-DD) */
function overlaps(p, a, b) { return p.start <= b && p.end >= a; }

/* Размещение зоны и его статус. Без периода — активное сегодня или ближайшее будущее.
   С периодом [a,b] — бронь, пересекающаяся с этим интервалом (для выбранного месяца).
   Отказано/Завершено зону не занимают. Нет брони → Свободно (красный). */
function zoneBooking(z, a, b) {
  let rel;
  if (a && b) {
    // При просмотре конкретного месяца показываем и «Завершено» (серым)
    const STATUS_PRIORITY = { busy: 0, process: 1, done: 2 };
    const inPeriod = State.placements
      .filter(p => p.zoneId === z.id && p.status !== 'rejected' && overlaps(p, a, b))
      .sort((x, y) => (STATUS_PRIORITY[x.status] ?? 9) - (STATUS_PRIORITY[y.status] ?? 9) || x.start.localeCompare(y.start));
    rel = inPeriod[0];
  } else {
    const ps = State.placements.filter(p => p.zoneId === z.id && p.status !== 'rejected' && p.status !== 'done');
    const t = todayStr();
    rel = ps.find(p => p.start <= t && p.end >= t) || ps.filter(p => p.start > t).sort((x, y) => x.start.localeCompare(y.start))[0];
  }
  if (!rel) return { state: 'free', p: null, color: '#ef4444', label: 'Свободно' };
  const si = statusInfo(rel.status);
  return { state: si.key, p: rel, color: si.color, label: si.label };
}
function zoneState(zoneId) {
  const b = zoneBooking(zoneById(zoneId));
  return { key: b.state, color: b.color, label: b.label };
}

// Стиль кружка на плане: заливка кружка отдельно от цвета пульсации.
//  • свободно                                  → красный / пульс красный
//  • бронь впереди (start>сегодня), не подтв.   → жёлтый  / пульс жёлтый
//  • бронь впереди, подтверждено                → жёлтый  / пульс ЗЕЛЁНЫЙ
//  • идёт сейчас, подтверждено                  → зелёный / пульс зелёный
//  • идёт сейчас, переговоры                    → жёлтый  / пульс жёлтый
const C_GREEN = '#10b981', C_YELLOW = '#f59e0b', C_RED = '#ef4444';
function mapCircleStyle(zoneId) {
  const b = zoneBooking(zoneById(zoneId));
  if (!b.p) return { key: 'free', fill: C_RED, pulse: C_RED, label: 'Свободно', brand: '' };
  const future = b.p.start > todayStr();      // дата начала ещё впереди
  const confirmed = b.p.status === 'busy';    // «Подтверждено»
  let fill, pulse, label;
  if (future) {
    fill = C_YELLOW;
    pulse = confirmed ? C_GREEN : C_YELLOW;
    label = confirmed ? 'Подтверждено · скоро' : 'Переговоры · скоро';
  } else {
    fill = confirmed ? C_GREEN : C_YELLOW;
    pulse = fill;
    label = confirmed ? 'Подтверждено' : 'Переговоры';
  }
  return { key: b.p.status, fill, pulse, label, brand: b.p.brand || '' };
}

/* ───────── Toast ───────── */
let toastTimer = null;
function toast(msg, type) {
  const t = $('#toast');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ───────── Модальное окно ───────── */
function openModal(html, wide) {
  const m = $('#modal');
  m.className = 'modal' + (wide === 'full' ? ' full' : wide === 'huge' ? ' huge' : (wide ? ' wide' : ''));
  m.innerHTML = html;
  $('#modalOverlay').hidden = false;
  m.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
}
function closeModal() { $('#modalOverlay').hidden = true; $('#modal').innerHTML = ''; }
$('#modalOverlay').addEventListener('click', (e) => { if (e.target.id === 'modalOverlay') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); const lb = $('.lightbox'); if (lb) lb.remove(); } });

function lightbox(src) {
  const lb = el('div', 'lightbox');
  lb.appendChild(el('img'));
  lb.querySelector('img').src = src;
  lb.onclick = () => lb.remove();
  document.body.appendChild(lb);
}

/* ───────── Загрузка данных ───────── */
async function loadAll() {
  State.zones = (await dbGetAll('zones')).sort((a,b) => (a.floor-b.floor) || a.name.localeCompare(b.name,'ru'));
  State.placements = await dbGetAll('placements');
  State.history = await dbGetAll('history');
  State.labels = await dbGetAll('labels');
  const cur = await dbGet('meta', 'currency');
  if (cur) State.currency = cur.value;
}

// Синхронизировать зоны из файла-списка (источник истины для названия/этажа/кода).
// Позиции на карте (mapX/mapY/mapR) сохраняются. Отсутствующие в файле зоны удаляются.
async function syncZones() {
  const seedIds = new Set(SEED_ZONES.map(s => s.id));
  const existing = await dbGetAll('zones');
  const byId = {};
  existing.forEach(z => { byId[z.id] = z; });
  for (const s of SEED_ZONES) {
    const cur = byId[s.id];
    if (cur) {
      if (cur.name !== s.name || cur.floor !== s.floor || cur.code !== s.code || cur.dayRate !== s.dayRate) {
        cur.name = s.name; cur.floor = s.floor; cur.code = s.code; cur.dayRate = s.dayRate;
        delete cur.baseRate;           // старое поле больше не используется
        await dbPut('zones', cur);     // mapX/mapY/mapR не трогаем
      }
    } else {
      await dbPut('zones', { ...s, mapX: null, mapY: null });
    }
  }
  for (const z of existing) {
    // удаляем только зоны из старого файла; вручную добавленные (custom) не трогаем
    if (!seedIds.has(z.id) && !z.custom) await dbDel('zones', z.id);
  }
}

// Перевод старых статусов размещений в новые (Свободно / В процессе / Занято / Завершено).
async function migrateStatuses() {
  const MAP = { active: 'busy', paid: 'busy', lead: 'process', reserved: 'process', signed: 'process', cancelled: 'rejected', free: 'process' };
  const valid = new Set(['process', 'busy', 'rejected', 'done']);
  const ps = await dbGetAll('placements');
  for (const p of ps) {
    let s = p.status;
    if (MAP[s]) s = MAP[s];
    if (!valid.has(s)) s = 'process';
    if (s !== p.status) { p.status = s; await dbPut('placements', p); }
  }
}

// Автозавершение: «Занято», у которого срок брони уже истёк, → «Завершено».
async function autoCompletePast() {
  const t = todayStr();
  const ps = await dbGetAll('placements');
  for (const p of ps) {
    if (p.status === 'busy' && p.end < t) { p.status = 'done'; await dbPut('placements', p); }
  }
}

// Записать/обновить запись в журнале истории для размещения со статусом «Занято».
// Одна запись на размещение (по placementId). Журнал не удаляется при удалении размещения.
async function recordHistory(p) {
  const m = placementMoney(p);
  const z = zoneById(p.zoneId);
  const existing = await dbGetByIndex('history', 'placementId', p.id);
  const id = existing[0] ? existing[0].id : 'h' + uid();
  const entry = {
    id, placementId: p.id,
    zoneId: p.zoneId, zoneName: z ? z.name : '', zoneCode: z ? z.code : '', floor: z ? z.floor : null,
    brand: p.brand, start: p.start, end: p.end, color: p.color,
    area: m.area, dayRate: m.dayRate, days: m.days, discount: m.discount,
    totalBase: m.totalBase, totalAgreed: m.totalAgreed,
    recordedAt: new Date().toISOString(),
  };
  await dbPut('history', entry);
}

// Занести в журнал уже существующие размещения со статусом «Занято» (один раз).
async function backfillHistory() {
  const ps = await dbGetAll('placements');
  for (const p of ps) {
    if (p.status === 'busy') {
      const ex = await dbGetByIndex('history', 'placementId', p.id);
      if (!ex.length) await recordHistory(p);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════
   НАВИГАЦИЯ
   ═══════════════════════════════════════════════════════════════ */
const NAV = [
  { key: 'home', label: 'Главная' },
  { key: 'calendar', label: 'Календарь' },
  { key: 'booking', label: 'Бронирование' },
  { key: 'map', label: 'План этажей' },
  { key: 'floorsview', label: 'Обзор этажей' },
  { key: 'tenants', label: 'Арендаторы' },
  { key: 'tasks', label: 'Мои задачи' },
  { key: 'history', label: 'История' },
  { key: 'dashboard', label: 'Дашборд' },
];

function renderNav() {
  const nav = $('#topnav');
  nav.innerHTML = '';
  for (const n of NAV) {
    const b = el('button', State.view === n.key ? 'active' : '', n.label);
    b.onclick = () => go(n.key);
    nav.appendChild(b);
  }
}

async function go(view, opts) {
  stopMoneyRain();          // остановить анимацию монеток при смене экрана
  stopChar();               // и анимированную девочку
  State.view = view;
  renderNav();
  const v = $('#view');
  v.innerHTML = '';
  if (view === 'home') renderHome(v);
  else if (view === 'calendar') renderCalendar(v);
  else if (view === 'booking') renderBooking(v);
  else if (view === 'map') renderMap(v, opts);
  else if (view === 'floorsview') renderFloorsOverview(v);
  else if (view === 'tenants') renderTenants(v);
  else if (view === 'tasks') renderTasks(v);
  else if (view === 'history') renderHistory(v);
  else if (view === 'dashboard') renderDashboard(v);
  window.scrollTo(0, 0);
}

/* ═══════════════════════════════════════════════════════════════
   ГЛАВНЫЙ ЭКРАН
   ═══════════════════════════════════════════════════════════════ */
function renderHome(v) {
  const activeNow = State.placements.filter(isActiveToday).length;
  const total = State.placements.length;
  const free = State.zones.length - new Set(State.placements.filter(isActiveToday).map(p=>p.zoneId)).size;

  const hero = el('div', 'home-hero', `
    <h1>Pop-Up</h1>
    <p>Управление и учёт pop-up размещений в торговом центре</p>`);
  v.appendChild(hero);

  const stats = el('div', 'home-stats');
  stats.innerHTML = `
    <div class="stat-pill"><div class="sp-num">${State.zones.length}</div><div class="sp-lbl">локаций</div></div>
    <div class="stat-pill"><div class="sp-num">${activeNow}</div><div class="sp-lbl">занято сейчас</div></div>
    <div class="stat-pill"><div class="sp-num">${free}</div><div class="sp-lbl">свободно сейчас</div></div>
    <div class="stat-pill"><div class="sp-num">${total}</div><div class="sp-lbl">всего размещений</div></div>`;
  v.appendChild(stats);

  const cards = [
    { key:'calendar', icon:'📅', t:'Календарь', d:'Занятость всех зон по дням. Выбор месяца и года.' },
    { key:'booking', icon:'🏢', t:'Карта бронирования', d:'Этажи и зоны: занято, в процессе, свободно + % бронирования.' },
    { key:'floorsview', icon:'🏬', t:'Обзор этажей', d:'Все 4 этажа на одном экране с пульсирующими зонами.' },
    { key:'tenants', icon:'🏷️', t:'Арендаторы', d:'Все pop-up, карточки с фото, файлами и историей.' },
    { key:'tasks', icon:'✅', t:'Мои задачи', d:'Все задачи по арендаторам в одном месте: комментарии, файлы, отметки.' },
    { key:'dashboard', icon:'📊', t:'Дашборд', d:'Ключевые показатели, динамика и загрузка по этажам.' },
    { key:'map', icon:'🗺️', t:'План этажей', d:'План этажа с точками-зонами: что свободно, что занято.' },
    { key:'history', icon:'🕘', t:'История', d:'Бронирования по зонам и по арендаторам.' },
    { key:'_backup', icon:'⤓', t:'Сохранение данных', d:'Резервная копия и перенос на другой компьютер.' },
  ];
  const grid = el('div', 'home-grid');
  for (const c of cards) {
    const card = el('button', 'home-card');
    card.innerHTML = `<div class="hc-icon">${c.icon}</div><h3>${c.t}</h3><p>${c.d}</p>`;
    card.onclick = () => {
      if (c.key === '_add') openPlacementForm(null, {});
      else if (c.key === '_backup') openBackup();
      else go(c.key);
    };
    grid.appendChild(card);
  }
  v.appendChild(grid);
}

/* ═══════════════════════════════════════════════════════════════
   КАЛЕНДАРЬ — режимы дни / недели / месяцы
   ═══════════════════════════════════════════════════════════════ */
// Цвет полосы: прошедшее — серый, иначе по статусу
function calBarColor(p) {
  return (p.end < todayStr()) ? '#94a3b8' : statusInfo(p.status).color;
}
// Колонки сетки в зависимости от режима
function calColumns(mode, y, m) {
  const today = todayStr(); const cols = [];
  if (mode === 'day') {
    const dim = daysInMonth(y, m);
    for (let d = 1; d <= dim; d++) {
      const wd = (new Date(y, m, d).getDay() + 6) % 7;
      const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cols.push({ start: ds, end: ds, days: 1, weekend: wd >= 5, today: ds === today, label: `<b>${d}</b><span>${WD[wd]}</span>` });
    }
  } else if (mode === 'month') {
    for (let mo = 0; mo < 12; mo++) {
      const dimm = daysInMonth(y, mo);
      const s = `${y}-${String(mo + 1).padStart(2, '0')}-01`;
      const e = `${y}-${String(mo + 1).padStart(2, '0')}-${String(dimm).padStart(2, '0')}`;
      cols.push({ start: s, end: e, days: dimm, today: today >= s && today <= e, label: `<b>${MON_SHORT[mo]}</b>` });
    }
  } else { // week — колонки строго с понедельника, по 7 дней
    let cur = parseDate(`${y}-01-01`);
    const dow = (cur.getDay() + 6) % 7;            // 0=пн … 6=вс
    cur = new Date(cur); cur.setDate(cur.getDate() - dow);  // отмотать к понедельнику недели, где 1 января
    const end = parseDate(`${y}-12-31`);
    while (cur <= end) {
      const s = ymd(cur);
      const ed = new Date(cur); ed.setDate(ed.getDate() + 6);
      cols.push({ start: s, end: ymd(ed), days: 7, today: today >= s && today <= ymd(ed),
        label: `<b>${String(cur.getDate()).padStart(2, '0')}.${String(cur.getMonth() + 1).padStart(2, '0')}</b>` });
      cur = new Date(cur); cur.setDate(cur.getDate() + 7);
    }
  }
  return cols;
}

function renderCalendar(v) {
  const c = State.cal;
  const mode = c.mode || 'day';
  const y = c.y, m = c.m;
  const cols = calColumns(mode, y, m);
  const periodStart = cols[0].start, periodEnd = cols[cols.length - 1].end;
  const totalDays = cols.reduce((s, col) => s + col.days, 0);
  const offset = (ds) => Math.round((parseDate(ds) - parseDate(periodStart)) / 86400000); // дней от начала
  const colTemplate = cols.map(col => col.days + 'fr').join(' ');
  const ZONE_W = 220, colMin = mode === 'month' ? 80 : mode === 'week' ? 46 : 26;

  // ── Заголовок и панель
  const head = el('div', 'page-head');
  head.appendChild(el('h2', null, 'Календарь занятости'));
  head.appendChild(el('div', 'spacer'));

  // режим
  const seg = el('div', 'cal-seg');
  [['day', 'Дни'], ['week', 'Недели'], ['month', 'Месяцы']].forEach(([k, lbl]) => {
    const b = el('button', mode === k ? 'active' : '', lbl);
    b.onclick = () => { State.cal.mode = k; go('calendar'); };
    seg.appendChild(b);
  });
  head.appendChild(seg);

  // период
  if (mode === 'day') {
    const monthSw = el('div', 'period-switch');
    monthSw.innerHTML = `<button data-a="pm">‹</button><div class="ps-label">${MONTHS[m]}</div><button data-a="nm">›</button>`;
    monthSw.querySelector('[data-a=pm]').onclick = () => { if (--State.cal.m < 0){State.cal.m=11;State.cal.y--;} go('calendar'); };
    monthSw.querySelector('[data-a=nm]').onclick = () => { if (++State.cal.m > 11){State.cal.m=0;State.cal.y++;} go('calendar'); };
    head.appendChild(monthSw);
  }
  const yearSw = el('div', 'period-switch small');
  yearSw.innerHTML = `<button data-a="py">‹</button><div class="ps-label">${y}</div><button data-a="ny">›</button>`;
  yearSw.querySelector('[data-a=py]').onclick = () => { State.cal.y--; go('calendar'); };
  yearSw.querySelector('[data-a=ny]').onclick = () => { State.cal.y++; go('calendar'); };
  head.appendChild(yearSw);

  const todayBtn = el('button', 'btn btn-sm', 'Сегодня');
  todayBtn.onclick = () => { const d = new Date(); State.cal.y = d.getFullYear(); State.cal.m = d.getMonth(); go('calendar'); };
  head.appendChild(todayBtn);

  const emptyBtn = el('button', 'btn btn-sm' + (c.hideEmpty ? ' btn-primary' : ''), c.hideEmpty ? 'Показать все' : 'Скрыть пустые');
  emptyBtn.onclick = () => { State.cal.hideEmpty = !c.hideEmpty; go('calendar'); };
  head.appendChild(emptyBtn);

  v.appendChild(head);

  // ── Сетка
  const wrap = el('div', 'cal-wrap');
  const scroll = el('div', 'cal-scroll');
  const grid = el('div', 'cal-grid');
  grid.style.minWidth = (ZONE_W + cols.length * colMin) + 'px';
  const rowStyle = `grid-template-columns:${ZONE_W}px 1fr`;

  // шапка колонок
  const headRow = el('div', 'cal-row cal-head');
  headRow.style.cssText = rowStyle;
  headRow.appendChild(el('div', 'cal-zone', 'Зона'));
  const daysHead = el('div', 'cal-days');
  const headBg = el('div', 'cal-days-bg');
  headBg.style.gridTemplateColumns = colTemplate;
  for (const col of cols) {
    const cell = el('div', 'cal-daynum' + (col.weekend ? ' weekend' : '') + (col.today ? ' today' : ''));
    cell.innerHTML = col.label;
    headBg.appendChild(cell);
  }
  daysHead.appendChild(headBg);
  headRow.appendChild(daysHead);
  grid.appendChild(headRow);

  // зоны по этажам
  const byFloor = {};
  for (const z of State.zones) (byFloor[z.floor] = byFloor[z.floor] || []).push(z);
  const floors = Object.keys(byFloor).map(Number).sort((a, b) => a - b);
  const placementsInPeriod = (zid) => State.placements.filter(p => p.zoneId === zid && overlaps(p, periodStart, periodEnd));

  let shown = 0;
  for (const f of floors) {
    let zonesHere = byFloor[f];
    if (c.hideEmpty) zonesHere = zonesHere.filter(z => placementsInPeriod(z.id).length);
    if (!zonesHere.length) continue;
    const fl = FLOORS.find(x => x.floor === f);
    grid.appendChild(el('div', 'floor-group-label', (fl ? fl.label : f + ' этаж')));
    for (const z of zonesHere) {
      shown++;
      const row = el('div', 'cal-row');
      row.style.cssText = rowStyle;
      const zc = el('div', 'cal-zone');
      zc.innerHTML = `<span>${esc(z.name)}</span>`;
      row.appendChild(zc);

      const days = el('div', 'cal-days');
      const bg = el('div', 'cal-days-bg');
      bg.style.gridTemplateColumns = colTemplate;
      for (const col of cols) {
        const cell = el('div', 'cal-day-cell' + (col.weekend ? ' weekend' : '') + (col.today ? ' today' : ''));
        cell.title = `${z.name} · ${fmtDate(col.start)} — добавить размещение`;
        cell.style.cursor = 'pointer';
        cell.onclick = () => openPlacementForm(null, { zoneId: z.id, start: col.start });
        bg.appendChild(cell);
      }
      days.appendChild(bg);

      // полосы
      const bars = el('div', 'cal-bars');
      const list = placementsInPeriod(z.id).sort((a, b) => a.start.localeCompare(b.start));
      for (const p of list) {
        const s = p.start < periodStart ? periodStart : p.start;
        const e = p.end > periodEnd ? periodEnd : p.end;
        const left = offset(s) / totalDays * 100;
        const width = (offset(e) + 1 - offset(s)) / totalDays * 100;
        const bar = el('div', 'cal-bar' + (p.start < periodStart ? ' cont-left' : '') + (p.end > periodEnd ? ' cont-right' : ''));
        bar.style.left = left + '%';
        bar.style.width = `calc(${width}% - 4px)`;
        bar.style.background = calBarColor(p);
        const arrowL = p.start < periodStart ? '<span class="bar-arrow">‹</span>' : '';
        const arrowR = p.end > periodEnd ? '<span class="bar-arrow">›</span>' : '';
        bar.innerHTML = `${arrowL}<span class="bar-brand">${esc(p.brand)}</span><span class="bar-dates">${fmtDateShort(p.start)}–${fmtDateShort(p.end)}</span>${arrowR}`;
        bar.title = `${p.brand} · ${fmtDate(p.start)} – ${fmtDate(p.end)} · ${statusInfo(p.status).label}`;
        bar.onclick = (ev) => { ev.stopPropagation(); openPlacementCard(p.id); };
        bars.appendChild(bar);
      }
      days.appendChild(bars);
      row.appendChild(days);
      grid.appendChild(row);
    }
  }
  if (!shown) grid.appendChild(el('div', 'floor-group-label', 'Нет размещений в этом периоде'));

  scroll.appendChild(grid);
  wrap.appendChild(scroll);
  v.appendChild(wrap);

  // легенда
  const legend = el('div', 'cal-legend');
  legend.innerHTML = `
    <span><i style="background:#10b981"></i> подтверждено</span>
    <span><i style="background:#f59e0b"></i> переговоры</span>
    <span><i style="background:#ef4444"></i> отказано</span>
    <span><i style="background:#94a3b8"></i> прошедшее / завершено</span>`;
  v.appendChild(legend);
}

/* ═══════════════════════════════════════════════════════════════
   КАРТА ЭТАЖЕЙ — масштаб, перетаскивание, рисование локаций-кружков
   ═══════════════════════════════════════════════════════════════ */
let MAP_BASE_W = 1000;            // базовая ширина холста = натуральная ширина плана (задаётся при загрузке)
const DEFAULT_R = 0.025;          // радиус кружка по умолчанию (доля ширины)
const Map = {
  scale: 1, panX: 0, panY: 0,     // трансформация холста
  edit: false,                    // режим рисования новых кружков
  sel: null,                      // выбранная в панели зона для рисования
  selZone: null,                  // выделенный на карте кружок (ЛКМ)
  copyR: null,                    // скопированный размер кружка
  vp: null, canvas: null,         // ссылки на элементы
};

function mapApplyTransform() {
  if (Map.canvas) Map.canvas.style.transform = `translate(${Map.panX}px,${Map.panY}px) scale(${Map.scale})`;
}
function mapClampScale(s) { return Math.min(8, Math.max(0.2, s)); }

function renderMap(v, opts) {
  if (opts && opts.floor) State.floor = opts.floor;
  const fl = FLOORS.find(x => x.floor === State.floor);
  const zonesHere = State.zones.filter(z => z.floor === State.floor);

  // ── Заголовок
  const head = el('div', 'page-head');
  head.appendChild(el('h2', null, 'План этажей'));
  v.appendChild(head);

  // ── Раскладка: панель слева + карта справа
  const layout = el('div', 'map-layout');
  v.appendChild(layout);

  const rail = el('div', 'map-rail');
  layout.appendChild(rail);

  const vp = el('div', 'map-viewport' + (Map.edit && Map.sel ? ' drawing' : ''));
  layout.appendChild(vp);
  Map.vp = vp;

  // ── Левая панель: этажи
  const gFloor = el('div', 'rail-group');
  gFloor.appendChild(el('div', 'rail-title', 'Этаж'));
  const floorMini = el('div', 'floor-mini');
  for (const f of FLOORS) {
    const b = el('button', State.floor === f.floor ? 'active' : '', f.label);
    b.onclick = () => { State.floor = f.floor; Map.sel = null; mapResetView(); go('map'); };
    floorMini.appendChild(b);
  }
  gFloor.appendChild(floorMini);
  rail.appendChild(gFloor);

  // ── Левая панель: масштаб
  const gZoom = el('div', 'rail-group');
  gZoom.appendChild(el('div', 'rail-title', 'Масштаб'));
  const zr = el('div', 'zoom-row');
  zr.innerHTML = `<button data-z="out" title="Уменьшить">−</button><button data-z="fit" title="По размеру">⤢</button><button data-z="in" title="Увеличить">+</button>`;
  gZoom.appendChild(zr);
  rail.appendChild(gZoom);
  zr.querySelector('[data-z=in]').onclick = () => mapZoomCenter(1.25);
  zr.querySelector('[data-z=out]').onclick = () => mapZoomCenter(0.8);
  zr.querySelector('[data-z=fit]').onclick = () => { mapResetView(); mapApplyTransform(); };

  // ── Левая панель: рисование локаций
  if (fl && fl.plan) {
    const gEdit = el('div', 'rail-group');
    gEdit.appendChild(el('div', 'rail-title', 'Локации'));
    const editBtn = el('button', 'rail-btn' + (Map.edit ? ' active' : ''), (Map.edit ? '✓ Готово' : '✏️ Рисовать'));
    editBtn.onclick = () => { Map.edit = !Map.edit; Map.sel = null; go('map'); };
    gEdit.appendChild(editBtn);

    const addZoneBtn = el('button', 'rail-btn', '➕ Добавить локацию');
    addZoneBtn.onclick = () => addZonePrompt();
    gEdit.appendChild(addZoneBtn);

    if (Map.edit) {
      gEdit.appendChild(el('div', 'rail-title', 'Выберите локацию,<br>затем обведите её на плане'));
      const pick = el('div', 'zone-pick');
      for (const z of zonesHere) {
        const placed = z.mapX != null;
        const b = el('button', (Map.sel === z.id ? 'active ' : '') + (placed ? 'placed' : ''),
          `${placed ? '✓' : '○'} ${esc(z.code || z.name)}`);
        b.title = z.name;
        b.onclick = () => { Map.sel = (Map.sel === z.id ? null : z.id); go('map'); };
        pick.appendChild(b);
      }
      gEdit.appendChild(pick);
    }
    rail.appendChild(gEdit);

    // ── Левая панель: названия магазинов (редактируемые подписи)
    const gLab = el('div', 'rail-group');
    gLab.appendChild(el('div', 'rail-title', 'Названия магазинов'));
    const addLab = el('button', 'rail-btn', '➕ Добавить название');
    addLab.onclick = () => addMapLabel();
    gLab.appendChild(addLab);
    gLab.appendChild(el('div', 'rail-title', 'двойной клик — переименовать,<br>перетащить — двигать'));
    rail.appendChild(gLab);
  }

  // ── Левая панель: легенда
  const gLeg = el('div', 'rail-group');
  gLeg.innerHTML = `<div class="rail-title">Обозначения</div>
    <div style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-soft)">
      <span><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:#10b981;vertical-align:-1px"></span> подтверждено</span>
      <span><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:#f59e0b;vertical-align:-1px"></span> переговоры</span>
      <span><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:#ef4444;vertical-align:-1px"></span> свободно</span>
    </div>`;
  rail.appendChild(gLeg);

  // ── Карта
  if (!fl || !fl.plan) {
    vp.style.cursor = 'default';
    vp.appendChild(el('div', 'map-empty', `<div style="font-size:40px">🗺️</div><p>План для «${fl ? fl.label : ''}» пока не загружен.</p>`));
    return;
  }

  const canvas = el('div', 'map-canvas');
  Map.canvas = canvas;
  const img = el('img', 'plan');
  img.src = fl.plan;
  img.draggable = false;
  img.onload = () => { MAP_BASE_W = img.naturalWidth || MAP_BASE_W; mapResetView(); mapApplyTransform(); drawCircles(); drawLabels(); drawBrands(); };
  img.onerror = () => { vp.innerHTML = `<div class="map-empty"><div style="font-size:40px">🗺️</div><p>Файл плана не найден: ${esc(fl.plan)}</p></div>`; };
  canvas.appendChild(img);
  vp.appendChild(canvas);
  mapApplyTransform();

  function drawCircles() {
    canvas.querySelectorAll('.loc-circle').forEach(n => n.remove());
    for (const z of zonesHere) {
      if (z.mapX == null || z.mapY == null) continue;
      canvas.appendChild(makeCircle(z));
    }
  }
  function drawLabels() {
    canvas.querySelectorAll('.map-label').forEach(n => n.remove());
    for (const lb of State.labels.filter(l => l.floor === State.floor)) canvas.appendChild(makeLabel(lb));
  }
  function drawBrands() {
    canvas.querySelectorAll('.lc-brand').forEach(n => n.remove());
    const items = [];
    for (const z of zonesHere) {
      if (z.mapX == null || z.mapY == null) continue;
      const st = mapCircleStyle(z.id);
      if (!st.brand) continue;                 // подпись только если есть арендатор
      const lab = makeBrandLabel(z, st);
      canvas.appendChild(lab);
      items.push({ z, el: lab });
    }
    // авто-распределение по вертикали, чтобы подписи не налезали друг на друга
    requestAnimationFrame(() => resolveBrandOverlaps(items));
  }
  drawCircles(); drawLabels(); drawBrands();
  // перерисовать после загрузки/масштабирования картинки
  setTimeout(() => { drawCircles(); drawLabels(); drawBrands(); }, 0);

  mapBindInteractions(vp, canvas, () => zonesHere);

  if (Map.edit && Map.sel) {
    const z = zoneById(Map.sel);
    v.appendChild(el('div', 'map-hint', `✏️ Зажмите и обведите место на плане, чтобы нарисовать кружок для «${esc(z.name)}». Готовый кружок можно перетащить, изменить размер за край и задать код двойным кликом.`));
  } else if (Map.edit) {
    v.appendChild(el('div', 'map-hint', `Выберите локацию в списке слева, затем обведите её на плане. Готовый кружок можно перетащить, изменить размер за уголок, задать код двойным кликом или убрать крестиком.`));
  } else {
    v.appendChild(el('div', 'map-hint', `💡 Клик по кружку — выделить. Правая кнопка мыши по кружку — меню: карточка, размещение, код, копировать размер, открепить. Перетаскивание — двигать кружок. Колесо — масштаб, пустое место — двигать план.`));
  }
}

function mapResetView() {
  if (!Map.vp) return;
  const w = Map.vp.clientWidth || 800;
  Map.scale = mapClampScale(w / MAP_BASE_W);
  Map.panX = 0; Map.panY = 0;
}
function mapZoomCenter(factor) {
  const vp = Map.vp; if (!vp) return;
  const cx = vp.clientWidth / 2, cy = vp.clientHeight / 2;
  mapZoomAt(cx, cy, factor);
}
function mapZoomAt(vx, vy, factor) {
  const ns = mapClampScale(Map.scale * factor);
  const k = ns / Map.scale;
  Map.panX = vx - (vx - Map.panX) * k;
  Map.panY = vy - (vy - Map.panY) * k;
  Map.scale = ns;
  mapApplyTransform();
}

/* Кружок локации (привязан к плану в %, масштабируется вместе с холстом) */
function makeCircle(z) {
  const st = mapCircleStyle(z.id);       // заливка + цвет пульсации по статусу/дате
  const r = (z.mapR || DEFAULT_R) * MAP_BASE_W; // радиус в базовых px
  const c = el('div', 'loc-circle pulse pulse-' + st.key + (Map.edit ? ' editing' : ''));
  c.style.left = z.mapX + '%';
  c.style.top = z.mapY + '%';
  c.style.width = c.style.height = (r * 2) + 'px';
  c.style.background = hexToRgba(st.fill, 0.72);          // заливка кружка
  c.style.borderColor = st.fill;
  c.style.borderWidth = Math.max(4, r * 0.06) + 'px';     // заметная рамка, пропорц. размеру
  c.style.setProperty('--glow', hexToRgba(st.pulse, 0.85)); // цвет волны пульсации
  c.style.setProperty('--glowMax', hexToRgba(st.pulse, 0)); // прозрачный край волны
  c.dataset.zid = z.id;
  c.innerHTML = `<span class="lc-code">${esc(z.code || '')}</span>`;
  c.title = z.name + (z.code ? ' · ' + z.code : '') + ' — ' + st.label + (st.brand ? ' · ' + st.brand : '');
  // Код — крупный, пропорционально размеру кружка (масштабируется вместе с картой)
  const codeEl = c.querySelector('.lc-code');
  codeEl.style.fontSize = Math.round(Math.max(r * 0.6, 14)) + 'px';

  const selected = (Map.selZone === z.id);
  if (selected) c.classList.add('selected');

  // Ручки (размер/открепить) — на выделенном кружке или в режиме рисования.
  if (selected || Map.edit) {
    c.appendChild(makeCircleHandles(z, c));
    c.ondblclick = (e) => { e.stopPropagation(); editZoneCode(z); };
  }
  // Правая кнопка — меню редактирования и закрепления.
  c.oncontextmenu = (e) => {
    e.preventDefault(); e.stopPropagation();
    Map.selZone = z.id;
    showCircleMenu(e.clientX, e.clientY, z);
  };
  return c;
}
function makeCircleHandles(z, c) {
  const wrap = document.createDocumentFragment();
  const rm = el('button', 'loc-remove', '×');
  rm.title = 'Убрать с карты';
  rm.onclick = async (e) => { e.stopPropagation(); z.mapX = null; z.mapY = null; await dbPut('zones', z); toast('Локация убрана с карты', 'ok'); go('map'); };
  wrap.appendChild(rm);
  const rs = el('div', 'loc-resize');
  rs.title = 'Изменить размер';
  rs.dataset.resize = '1';
  wrap.appendChild(rs);
  return wrap;
}

function editZoneCode(z) {
  const code = prompt(`Код локации для «${z.name}»\n(короткий, например A1 или Ц-01):`, z.code || '');
  if (code === null) return;
  z.code = code.trim();
  dbPut('zones', z).then(() => { toast('Код сохранён', 'ok'); go('map'); });
}

/* Подпись арендатора рядом с кружком (имя бренда + статус). Позиция — под кружком,
   вертикальный сдвиг задаётся в базовых px (масштабируется вместе с картой). */
function makeBrandLabel(z, st) {
  const r = (z.mapR || DEFAULT_R) * MAP_BASE_W;
  const fs = Math.max(0.011 * MAP_BASE_W, 10);
  const d = document.createElement('div');
  d.className = 'lc-brand';
  d.style.left = z.mapX + '%';
  d.style.top = z.mapY + '%';
  d.style.marginTop = (r + r * 0.25) + 'px';   // ниже кружка
  d.style.fontSize = fs + 'px';
  d.dataset.zid = z.id;
  d.innerHTML = `<span class="lcb-name">${esc(st.brand)}</span>`;
  return d;
}
// Раздвинуть подписи арендаторов по вертикали, чтобы не налезали друг на друга.
// Работаем в базовых координатах холста (масштаб однородный → перекрытия не зависят от зума).
function resolveBrandOverlaps(items) {
  if (!items || !items.length) return;
  const scale = Map.scale || 1;
  const data = items.map(it => {
    const rect = it.el.getBoundingClientRect();
    const r = (it.z.mapR || DEFAULT_R) * MAP_BASE_W;
    const circleCenterY = (it.z.mapY / 100) * MAP_BASE_W;
    return {
      el: it.el,
      w: rect.width / scale, h: rect.height / scale,
      cx: (it.z.mapX / 100) * MAP_BASE_W,
      circleCenterY,
      top: circleCenterY + r + r * 0.3,        // исходный верх подписи (база)
    };
  });
  data.sort((a, b) => a.top - b.top);
  const vGap = Math.max(4, 0.006 * MAP_BASE_W);
  const placed = [];
  for (const d of data) {
    placed.sort((a, b) => a.top - b.top);
    for (const p of placed) {
      const xOverlap = Math.abs(d.cx - p.cx) < (d.w + p.w) / 2 + 4;
      if (xOverlap && d.top < p.top + p.h + vGap) d.top = p.top + p.h + vGap;
    }
    placed.push(d);
  }
  for (const d of data) d.el.style.marginTop = (d.top - d.circleCenterY) + 'px';
}

/* Редактируемая подпись (название магазина) поверх карты */
function makeLabel(lb) {
  const fs = (lb.size || 0.018) * MAP_BASE_W;
  const el = document.createElement('div');
  el.className = 'map-label';
  el.style.left = lb.x + '%';
  el.style.top = lb.y + '%';
  el.style.fontSize = fs + 'px';
  el.dataset.lid = lb.id;
  el.textContent = lb.text || '—';
  el.ondblclick = (e) => { e.stopPropagation(); editMapLabel(lb.id); };
  return el;
}
function editMapLabel(id) {
  const lb = State.labels.find(l => l.id === id);
  if (!lb) return;
  const t = prompt('Название магазина (пусто = удалить):', lb.text || '');
  if (t === null) return;
  if (t.trim() === '') { dbDel('labels', id).then(() => { loadAll().then(() => go('map')); }); return; }
  lb.text = t.trim();
  dbPut('labels', lb).then(() => { loadAll().then(() => go('map')); });
}
async function addMapLabel() {
  const t = prompt('Название магазина:');
  if (!t || !t.trim()) return;
  let x = 50, y = 50;
  if (Map.vp && Map.canvas) {
    const vpr = Map.vp.getBoundingClientRect(), cr = Map.canvas.getBoundingClientRect();
    x = ((vpr.left + vpr.width / 2) - cr.left) / cr.width * 100;
    y = ((vpr.top + vpr.height / 2) - cr.top) / cr.height * 100;
  }
  await dbPut('labels', { id: 'lb' + uid(), floor: State.floor, x: +x.toFixed(2), y: +y.toFixed(2), text: t.trim(), size: 0.018 });
  await loadAll();
  toast('Подпись добавлена', 'ok');
  go('map');
}

/* Добавить локацию вручную (на текущий этаж) */
function addZonePrompt() {
  const fl = FLOORS.find(x => x.floor === State.floor);
  openModal(`
    <div class="modal-head"><h3>Новая локация · ${esc(fl ? fl.label : State.floor + ' этаж')}</h3>
      <button class="modal-close" data-close>×</button></div>
    <div class="modal-body">
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="field"><label>Код локации *</label>
          <input id="nz-code" placeholder="Например, L1.13"></div>
        <div class="field"><label>Название локации *</label>
          <input id="nz-name" placeholder="Например, Зона у входа"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Отмена</button>
      <button class="btn btn-primary" id="nz-save">Добавить</button>
    </div>`);

  const save = async () => {
    const code = $('#nz-code').value.trim();
    const name = $('#nz-name').value.trim();
    if (!code) return toast('Введите код локации', 'err');
    if (!name) return toast('Введите название локации', 'err');
    if (State.zones.some(z => (z.code || '').toLowerCase() === code.toLowerCase()))
      return toast('Локация с таким кодом уже есть', 'err');
    await dbPut('zones', { id: 'zc' + uid(), name, floor: State.floor, code, dayRate: 0, mapX: null, mapY: null, custom: true });
    State.zones = (await dbGetAll('zones')).sort((a, b) => (a.floor - b.floor) || a.name.localeCompare(b.name, 'ru'));
    closeModal();
    toast('Локация добавлена', 'ok');
    if (!Map.edit) Map.edit = true;   // показать список локаций, чтобы можно было сразу разместить на плане
    go('map');
  };
  $('#nz-save').onclick = save;
  $('#nz-code').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#nz-name').focus(); } });
  $('#nz-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  setTimeout(() => $('#nz-code').focus(), 30);
}

/* Контекстное меню кружка (правая кнопка мыши) */
function closeCircleMenu() { const m = $('#ctxMenu'); if (m) m.remove(); document.removeEventListener('mousedown', ctxOutside, true); }
function ctxOutside(e) { if (!e.target.closest('#ctxMenu')) closeCircleMenu(); }
function showCircleMenu(x, y, z) {
  closeCircleMenu();
  const st = zoneState(z.id);
  const menu = el('div', 'ctx-menu');
  menu.id = 'ctxMenu';
  menu.innerHTML = `
    <div class="ctx-title">${esc(z.code ? z.code + ' · ' : '')}${esc(z.name)}</div>
    <button data-a="card">📋 Открыть карточку зоны</button>
    <button data-a="add">➕ Добавить размещение</button>
    <button data-a="code">🏷️ Изменить код</button>
    <button data-a="copy">📐 Копировать размер</button>
    <button data-a="paste" ${Map.copyR == null ? 'disabled style="opacity:.45;cursor:default"' : ''}>📌 Применить скопированный размер</button>
    <button data-a="remove" class="danger">🗑️ Открепить с карты</button>`;
  document.body.appendChild(menu);
  // позиционирование с учётом краёв экрана
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';

  const act = async (a) => {
    closeCircleMenu();
    if (a === 'card') openZoneSheet(z.id);
    else if (a === 'add') openPlacementForm(null, { zoneId: z.id });
    else if (a === 'code') editZoneCode(z);
    else if (a === 'copy') { Map.copyR = z.mapR || DEFAULT_R; toast('Размер скопирован. Применится к новым и через «Применить размер».', 'ok'); }
    else if (a === 'paste') { if (Map.copyR != null) { z.mapR = Map.copyR; await dbPut('zones', z); toast('Размер применён', 'ok'); go('map'); } }
    else if (a === 'remove') { z.mapX = null; z.mapY = null; Map.selZone = null; await dbPut('zones', z); toast('Локация откреплена', 'ok'); go('map'); }
  };
  menu.querySelectorAll('button[data-a]').forEach(b => { if (!b.disabled) b.onclick = () => act(b.dataset.a); });
  setTimeout(() => document.addEventListener('mousedown', ctxOutside, true), 0);
}

function hexToRgba(hex, a) {
  const m = hex.replace('#', '');
  const n = m.length === 3 ? m.split('').map(x => x + x).join('') : m;
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/* Интерактив: колесо-масштаб, перетаскивание холста, рисование/перенос/ресайз кружков */
function mapBindInteractions(vp, canvas, getZones) {
  // Масштаб колесом — к курсору
  vp.onwheel = (e) => {
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    mapZoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  };

  vp.onmousedown = (e) => {
    if (e.button !== 0) return;
    closeCircleMenu();
    if (e.target.closest('.loc-remove')) return;      // крестик — своя кнопка

    // Подпись (название магазина) — перетащить
    const labelEl = e.target.closest('.map-label');
    if (labelEl) { e.preventDefault(); startLabelDrag(e, labelEl); return; }

    const circleEl = e.target.closest('.loc-circle');

    // Ресайз кружка за уголок (работает на выделенном кружке)
    if (e.target.dataset && e.target.dataset.resize) {
      e.preventDefault();
      startResize(e, zoneById(circleEl.dataset.zid), circleEl);
      return;
    }
    // Рисование нового кружка (режим «Рисовать» + выбрана локация + по пустому месту)
    if (Map.edit && Map.sel && !circleEl) {
      e.preventDefault();
      startDraw(e);
      return;
    }
    // Кружок: перетащить (двигается всегда) или клик → выделить
    if (circleEl) {
      e.preventDefault();
      startCircleDragOrClick(e, zoneById(circleEl.dataset.zid), circleEl);
      return;
    }
    // Пусто — панорамирование (клик без сдвига снимет выделение)
    startPan(e);
  };

  function canvasPercent(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width * 100, y: (clientY - r.top) / r.height * 100, rw: r.width };
  }

  function startPan(e) {
    vp.classList.add('panning');
    const sx = e.clientX, sy = e.clientY, px = Map.panX, py = Map.panY;
    let moved = false;
    const mv = (ev) => { Map.panX = px + (ev.clientX - sx); Map.panY = py + (ev.clientY - sy); if (Math.abs(ev.clientX-sx)+Math.abs(ev.clientY-sy)>3) moved=true; mapApplyTransform(); };
    const up = () => {
      vp.classList.remove('panning');
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      if (!moved && Map.selZone) { Map.selZone = null; go('map'); }   // клик по пустому — снять выделение
    };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  }

  function startDraw(e) {
    const z = zoneById(Map.sel);
    const start = canvasPercent(e.clientX, e.clientY);
    const ghost = el('div', 'draw-ghost');
    ghost.style.left = start.x + '%'; ghost.style.top = start.y + '%';
    ghost.style.width = ghost.style.height = '0px';
    canvas.appendChild(ghost);
    let rFrac = 0;
    const mv = (ev) => {
      const dpx = Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY);
      rFrac = dpx / start.rw; // доля ширины (масштаб-независимо)
      const rpx = rFrac * MAP_BASE_W;
      ghost.style.width = ghost.style.height = (rpx * 2) + 'px';
    };
    const up = async () => {
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      ghost.remove();
      z.mapX = +start.x.toFixed(2); z.mapY = +start.y.toFixed(2);
      z.mapR = rFrac > 0.008 ? +rFrac.toFixed(4) : (Map.copyR || DEFAULT_R);
      await dbPut('zones', z);
      Map.sel = null;
      toast(`Локация «${z.name}» закреплена`, 'ok');
      go('map');
    };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  }

  // Перетаскивание подписи (названия магазина)
  function startLabelDrag(e, labelEl) {
    const lb = State.labels.find(l => l.id === labelEl.dataset.lid);
    if (!lb) return;
    let moved = false;
    const sx = e.clientX, sy = e.clientY;
    const mv = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true;
      const p = canvasPercent(ev.clientX, ev.clientY);
      labelEl.style.left = p.x + '%'; labelEl.style.top = p.y + '%';
      lb._nx = p.x; lb._ny = p.y;
    };
    const up = async () => {
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      if (moved && lb._nx != null) {
        lb.x = +lb._nx.toFixed(2); lb.y = +lb._ny.toFixed(2);
        delete lb._nx; delete lb._ny;
        await dbPut('labels', lb);
      }
    };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  }

  // Перетаскивание кружка или клик. Сдвиг < 4px = клик (открыть карточку),
  // больше — перенос с сохранением. Работает в любом режиме.
  function startCircleDragOrClick(e, z, circleEl) {
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    circleEl.style.zIndex = 6;
    const mv = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true;
      vp.classList.add('panning');
      const p = canvasPercent(ev.clientX, ev.clientY);
      circleEl.style.left = p.x + '%'; circleEl.style.top = p.y + '%';
      z._nx = p.x; z._ny = p.y;
    };
    const up = async () => {
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      vp.classList.remove('panning'); circleEl.style.zIndex = '';
      if (moved && z._nx != null) {
        z.mapX = +z._nx.toFixed(2); z.mapY = +z._ny.toFixed(2);
        delete z._nx; delete z._ny;
        await dbPut('zones', z);
        toast('Положение сохранено', 'ok');
      } else if (!moved) {
        Map.selZone = z.id;    // короткий клик — выделить кружок
        go('map');
      }
    };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  }

  function startResize(e, z, circleEl) {
    const r = canvas.getBoundingClientRect();
    const cx = r.left + (z.mapX / 100) * r.width, cy = r.top + (z.mapY / 100) * r.height;
    const mv = (ev) => {
      const dpx = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      const rFrac = Math.max(0.01, dpx / r.width);
      const rpx = rFrac * MAP_BASE_W;
      circleEl.style.width = circleEl.style.height = (rpx * 2) + 'px';
      z._nr = rFrac;
    };
    const up = async () => {
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      if (z._nr != null) { z.mapR = +z._nr.toFixed(4); delete z._nr; await dbPut('zones', z); }
    };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  }
}

/* ═══════════════════════════════════════════════════════════════
   ОБЗОР ЭТАЖЕЙ — 4 этажа (1–4) на одном экране, уменьшенные, с зонами
   ═══════════════════════════════════════════════════════════════ */
function makeMiniCircle(z) {
  const st = mapCircleStyle(z.id);        // та же логика цвета/пульсации, что и на плане
  const r = z.mapR || DEFAULT_R;          // доля ширины карты
  const c = el('div', 'loc-circle pulse mini pulse-' + st.key);
  c.style.left = z.mapX + '%';
  c.style.top = z.mapY + '%';
  c.style.width = (r * 2 * 100) + '%';     // % ширины контейнера → отзывчиво
  c.style.aspectRatio = '1';
  c.style.background = hexToRgba(st.fill, 0.72);
  c.style.borderColor = st.fill;
  c.style.setProperty('--glow', hexToRgba(st.pulse, 0.85));
  c.style.setProperty('--glowMax', hexToRgba(st.pulse, 0));
  c.title = z.name + (z.code ? ' · ' + z.code : '') + ' — ' + st.label + (st.brand ? ' · ' + st.brand : '');
  c.innerHTML = `<span class="lc-code" style="font-size:${(r * 0.62 * 100).toFixed(2)}cqw">${esc(z.code || '')}</span>`;
  c.onclick = (e) => { e.stopPropagation(); openZoneSheet(z.id); };
  return c;
}
function renderFloorsOverview(v) {
  const head = el('div', 'page-head');
  head.appendChild(el('h2', null, 'Обзор этажей'));
  head.appendChild(el('div', 'spacer'));
  head.appendChild(el('div', 'bk-legend', `
    <span><i style="background:#10b981"></i> подтверждено</span>
    <span><i style="background:#f59e0b"></i> переговоры</span>
    <span><i style="background:#ef4444"></i> свободно</span>`));
  v.appendChild(head);

  const grid = el('div', 'floors-grid');
  for (const f of [1, 2, 3, 4]) {
    const fl = FLOORS.find(x => x.floor === f);
    const card = el('div', 'floor-card');
    card.appendChild(el('div', 'floor-card-title', fl ? fl.label : f + ' этаж'));
    const map = el('div', 'mini-map');
    if (fl && fl.plan) {
      const img = el('img', 'mini-plan');
      img.src = fl.plan; img.alt = fl.label; img.draggable = false;
      map.appendChild(img);
      for (const z of State.zones.filter(z => z.floor === f && z.mapX != null && z.mapY != null)) map.appendChild(makeMiniCircle(z));
    } else {
      map.appendChild(el('div', 'tk-empty', 'План недоступен'));
    }
    card.appendChild(map);
    grid.appendChild(card);
  }
  v.appendChild(grid);
}

/* Лист зоны: текущее состояние + все размещения этой зоны */
function openZoneSheet(zoneId) {
  const z = zoneById(zoneId);
  const list = State.placements.filter(p => p.zoneId === zoneId).sort((a,b)=>b.start.localeCompare(a.start));
  let rows = list.map(p => historyRowHtml(p, true)).join('');
  if (!rows) rows = `<p class="muted">Размещений на этой зоне пока нет.</p>`;
  openModal(`
    <div class="modal-head"><h3>${esc(z.name)}</h3><button class="modal-close" data-close>×</button></div>
    <div class="modal-body">
      <button class="btn btn-primary" id="addHere">➕ Добавить размещение на эту зону</button>
      <div class="section-title">История размещений (${list.length})</div>
      ${rows}
    </div>`);
  $('#addHere').onclick = () => { closeModal(); openPlacementForm(null, { zoneId }); };
  $('#modal').querySelectorAll('[data-pid]').forEach(r => r.onclick = () => openPlacementCard(r.dataset.pid));
}

/* ═══════════════════════════════════════════════════════════════
   КАРТА БРОНИРОВАНИЯ — этажи здания снизу вверх + пилюли зон
   ═══════════════════════════════════════════════════════════════ */
function byCode(a, b) { return String(a.code || '').localeCompare(String(b.code || ''), 'ru', { numeric: true }); }

function renderBooking(v) {
  const bm = State.bookMonth;
  const dim = daysInMonth(bm.y, bm.m);
  const mStart = `${bm.y}-${String(bm.m + 1).padStart(2, '0')}-01`;
  const mEnd = `${bm.y}-${String(bm.m + 1).padStart(2, '0')}-${String(dim).padStart(2, '0')}`;

  const head = el('div', 'page-head');
  head.appendChild(el('h2', null, 'Карта бронирования'));
  head.appendChild(el('div', 'spacer'));
  const legend = el('div', 'bk-legend');
  legend.innerHTML = `
    <span><i style="background:#10b981"></i> подтверждено</span>
    <span><i style="background:#f59e0b"></i> переговоры</span>
    <span><i style="background:#ef4444"></i> свободно</span>`;
  head.appendChild(legend);

  // выбор месяца
  const monthSw = el('div', 'period-switch');
  monthSw.innerHTML = `<button data-a="pm">‹</button><div class="ps-label">${MONTHS[bm.m]} ${bm.y}</div><button data-a="nm">›</button>`;
  monthSw.querySelector('[data-a=pm]').onclick = () => { if (--State.bookMonth.m < 0) { State.bookMonth.m = 11; State.bookMonth.y--; } go('booking'); };
  monthSw.querySelector('[data-a=nm]').onclick = () => { if (++State.bookMonth.m > 11) { State.bookMonth.m = 0; State.bookMonth.y++; } go('booking'); };
  head.appendChild(monthSw);
  const nowBtn = el('button', 'btn btn-sm', 'Текущий');
  nowBtn.onclick = () => { const d = new Date(); State.bookMonth = { y: d.getFullYear(), m: d.getMonth() }; go('booking'); };
  head.appendChild(nowBtn);

  const addBtn = el('button', 'btn btn-primary', '➕ Добавить размещение');
  addBtn.onclick = () => openPlacementForm(null, {});
  head.appendChild(addBtn);
  v.appendChild(head);

  const floors = FLOORS.map(f => f.floor).sort((a, b) => b - a); // сверху вниз: 4,3,2,1,−1
  const zonesByFloor = {};
  for (const f of floors) zonesByFloor[f] = State.zones.filter(z => z.floor === f).sort(byCode);
  // одинаковая ширина пилюль: делим строку на число зон самого «плотного» этажа
  const maxN = Math.max(1, ...floors.map(f => zonesByFloor[f].length));
  const GAP = 8;

  const board = el('div', 'booking-board');
  board.appendChild(el('div', 'bk-roof'));

  for (const f of floors) {
    const fl = FLOORS.find(x => x.floor === f);
    const zones = zonesByFloor[f];
    const booked = zones.filter(z => zoneBooking(z, mStart, mEnd).state !== 'free').length;
    const pct = zones.length ? Math.round(booked / zones.length * 100) : 0;

    const row = el('div', 'bk-row');
    // ── левый блок-этаж (складываются в здание)
    const storey = el('div', 'bk-storey' + (f < 0 ? ' basement' : ''));
    storey.innerHTML = `
      <div class="bk-windows"></div>
      <div class="bk-storey-info">
        <div class="bk-floor-no">${f}<span>этаж</span></div>
        <div class="bk-pct">${pct}%</div>
        <div class="bk-progress"><div class="bk-progress-fill" style="width:${pct}%"></div></div>
        <div class="bk-storey-sub">${booked} из ${zones.length}</div>
      </div>`;
    row.appendChild(storey);

    // ── пилюли зон по кодам, в одну строку, одинаковой ширины и высоты
    const zonesBox = el('div', 'bk-zones');
    if (!zones.length) zonesBox.appendChild(el('div', 'muted', 'Нет зон на этаже'));
    for (const z of zones) {
      const b = zoneBooking(z, mStart, mEnd);
      const pill = el('div', 'bk-pill ' + b.state);
      pill.style.flex = `0 0 calc((100% - ${(maxN - 1) * GAP}px) / ${maxN})`;
      pill.dataset.z = z.id;
      if (b.p) pill.dataset.p = b.p.id;
      if (b.state === 'free') {
        pill.title = `${z.code || ''} · ${z.name} — свободно`;
        pill.innerHTML = `
          <span class="bk-pill-code">${esc(z.code || '—')}</span>
          <span class="bk-pill-main"><b>${esc(z.name)}</b><span class="bk-pill-sub free-lbl">свободно</span></span>`;
      } else {
        pill.title = `${z.code || ''} · ${z.name}\n${b.p.brand}\n${fmtDate(b.p.start)} – ${fmtDate(b.p.end)} (${diffDaysIncl(b.p.start, b.p.end)} дн.)`;
        pill.innerHTML = `
          <span class="bk-pill-code">${esc(z.code || '—')}</span>
          <span class="bk-pill-main">
            <b>${esc(z.name)}</b>
            <span class="bk-pill-tenant">${esc(b.p.brand)}</span>
            <span class="bk-pill-sub">${fmtDateShort(b.p.start)}–${fmtDateShort(b.p.end)} · ${diffDaysIncl(b.p.start, b.p.end)}д</span>
          </span>`;
      }
      pill.onclick = () => { if (pill.dataset.p) openPlacementCard(pill.dataset.p); else openZoneSheet(z.id); };
      zonesBox.appendChild(pill);
    }
    row.appendChild(zonesBox);
    board.appendChild(row);
  }

  board.appendChild(el('div', 'bk-ground'));
  v.appendChild(board);

  // Корзины (в потоке под зданием) + девочка, скачущая по зонам
  startMoneyRain(v);
  startChar();
}

/* ───────── Девочка, скачущая по зонам (декоративная анимация) ───────── */
let _charTimer = null, _charEl = null, _charPos = { r: 0, c: 0, dir: 1 };
// Девочка с руками за спиной (ходит, думает)
const GIRL_SVG = `<svg class="girl walking" viewBox="0 0 60 92" width="44" height="68" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs><linearGradient id="grlDress" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff8fc0"/><stop offset="1" stop-color="#e0509a"/></linearGradient>
    <clipPath id="grlFace"><circle cx="30" cy="24" r="19"/></clipPath></defs>
  <g class="leg leg-l"><rect x="25" y="63" width="4.2" height="21" rx="2.1" fill="#ffd9b8"/><ellipse cx="27" cy="85" rx="4" ry="2.4" fill="#ff5ea0"/></g>
  <g class="leg leg-r"><rect x="31" y="63" width="4.2" height="21" rx="2.1" fill="#ffd9b8"/><ellipse cx="33" cy="85" rx="4" ry="2.4" fill="#ff5ea0"/></g>
  <!-- руки за спиной: лёгкие плечи-култышки за платьем -->
  <rect x="18.5" y="47" width="3.4" height="10" rx="1.7" fill="#f3c19a" transform="rotate(20 20 48)"/>
  <rect x="38" y="47" width="3.4" height="10" rx="1.7" fill="#f3c19a" transform="rotate(-20 40 48)"/>
  <path d="M21 43 L39 43 L47 70 L13 70 Z" fill="url(#grlDress)" stroke="#cf4a90" stroke-width="0.5"/>
  <rect x="27.6" y="36" width="4.8" height="9" rx="2" fill="#ffd9b8"/>
  <g class="head">
    <circle cx="30" cy="24" r="19.6" fill="#fff"/>
    <image href="face.png" xlink:href="face.png" x="11" y="5" width="38" height="38" clip-path="url(#grlFace)" preserveAspectRatio="xMidYMid slice"/>
    <circle cx="30" cy="24" r="19" fill="none" stroke="#e0509a" stroke-width="1"/>
    <circle cx="45" cy="10" r="3.2" fill="#ff5ea0"/><circle cx="45" cy="10" r="1.3" fill="#ffec99"/>
  </g>
</svg>`;
function stopChar() {
  if (_charTimer) { clearTimeout(_charTimer); _charTimer = null; }
  if (_charEl) { _charEl.remove(); _charEl = null; }
}
function charRows() {
  return [...document.querySelectorAll('.bk-row')].map(r => [...r.querySelectorAll('.bk-pill')]).filter(a => a.length);
}
function startChar() {
  stopChar();
  const rows = charRows();
  if (!rows.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'char';
  wrap.innerHTML = `<div class="char-bubble">💭</div><div class="girl-face">${GIRL_SVG}</div>`;
  document.body.appendChild(wrap);
  _charEl = wrap;
  const girl = wrap.querySelector('.girl');
  const face = wrap.querySelector('.girl-face');
  _charPos = { r: 0, c: 0, dir: 1 };
  const placeAt = (pill, instant) => {
    const r = pill.getBoundingClientRect();
    if (instant) wrap.style.transition = 'none';
    wrap.style.left = (r.left + r.width / 2) + 'px';
    wrap.style.top = (r.top - 3) + 'px';
  };
  placeAt(rows[0][0], true);

  const step = () => {
    if (State.view !== 'booking') return stopChar();
    const rws = charRows();
    if (!rws.length) return stopChar();

    // иногда остановиться и подумать
    if (Math.random() < 0.30) {
      girl.setAttribute('class', 'girl thinking');
      wrap.classList.add('show-bubble');
      _charTimer = setTimeout(step, 1500 + Math.random() * 1800);
      return;
    }
    wrap.classList.remove('show-bubble');

    // сдвиг по горизонтали (туда-сюда), на краю — перепрыгнуть на другой этаж
    let { r, c, dir } = _charPos;
    if (r >= rws.length) r = 0;
    if (c >= rws[r].length) c = rws[r].length - 1;
    let nc = c + dir, levelJump = false;
    if (nc < 0 || nc >= rws[r].length) {
      r = (r + 1) % rws.length;
      dir = -dir;
      nc = dir > 0 ? 0 : rws[r].length - 1;
      levelJump = true;
    }
    _charPos = { r, c: nc, dir };
    const pill = rws[r][nc];

    face.classList.toggle('flip', dir < 0);           // повернуться по ходу движения
    const dur = levelJump ? 1.3 : 1.7;                // не спеша
    wrap.style.transition = `left ${dur}s ease-in-out, top ${dur}s ease-in-out`;
    girl.setAttribute('class', 'girl ' + (levelJump ? 'jumping' : 'walking'));
    requestAnimationFrame(() => placeAt(pill, false));
    _charTimer = setTimeout(step, dur * 1000 + 500 + Math.random() * 700);
  };
  _charTimer = setTimeout(step, 900);
}

/* Три одинаковые корзины внизу: Завершено · Текущие · Итого накопительно (реальные деньги, без переговоров) */
let _baskets = null, _rainTimer = null, _rainTimer2 = null;
// Стальной сейф (изображение для корзинки «Итого накопительно»)
const SAFE_SVG = `<svg class="safe-svg" viewBox="0 0 100 100" width="82" height="82" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="safeSteel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#eef2f6"/><stop offset="0.5" stop-color="#b9c3cf"/><stop offset="1" stop-color="#828e9c"/>
    </linearGradient>
    <radialGradient id="safeDial" cx="0.5" cy="0.4" r="0.65">
      <stop offset="0" stop-color="#f4f7fa"/><stop offset="1" stop-color="#94a0ad"/>
    </radialGradient>
  </defs>
  <rect x="9" y="11" width="82" height="78" rx="9" fill="url(#safeSteel)" stroke="#69737f" stroke-width="2.2"/>
  <rect x="19" y="20" width="56" height="60" rx="6" fill="#ccd4dc" stroke="#7b8794" stroke-width="1.6"/>
  <circle cx="44" cy="50" r="14" fill="url(#safeDial)" stroke="#69737f" stroke-width="2.2"/>
  <circle cx="44" cy="50" r="3.6" fill="#69737f"/>
  <g stroke="#7b8794" stroke-width="2.2" stroke-linecap="round">
    <line x1="44" y1="37" x2="44" y2="41"/><line x1="44" y1="59" x2="44" y2="63"/>
    <line x1="31" y1="50" x2="35" y2="50"/><line x1="53" y1="50" x2="57" y2="50"/>
  </g>
  <rect x="65" y="46" width="13" height="7" rx="3.5" fill="#7b8794"/>
  <circle cx="24" cy="25" r="2" fill="#7b8794"/><circle cx="70" cy="25" r="2" fill="#7b8794"/>
  <circle cx="24" cy="75" r="2" fill="#7b8794"/><circle cx="70" cy="75" r="2" fill="#7b8794"/>
  <rect x="15" y="88" width="9" height="7" rx="2" fill="#69737f"/>
  <rect x="76" y="88" width="9" height="7" rx="2" fill="#69737f"/>
</svg>`;
const BASKET_TITLES = { done: 'Завершено', current: 'Текущие', future: 'Будущие поступления', total: 'Итого накопительно' };

// Список размещений, относящихся к корзинке (для окна с информацией)
function basketList(key) {
  const today = todayStr();
  const yr = String(new Date().getFullYear());
  const inYear = p => (p.end || '').slice(0, 4) === yr;
  let ps;
  if (key === 'done') ps = State.placements.filter(p => p.status === 'done' && inYear(p));
  else if (key === 'current') ps = State.placements.filter(p => p.status === 'busy' && isActiveToday(p));
  else if (key === 'future') ps = State.placements.filter(p => p.status !== 'rejected' && p.start > today);
  else ps = State.placements.filter(p =>
    (p.status === 'done' && inYear(p)) ||
    (p.status === 'busy' && isActiveToday(p)) ||
    (p.status === 'busy' && p.end < today && inYear(p)));
  return ps.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
}

// Окно с информацией по корзинке/сейфу: Зона · Арендатор · Даты · Статус · Сумма
function openBasketInfo(key) {
  const list = basketList(key);
  const total = list.reduce((s, p) => s + placementMoney(p).totalAgreed, 0);
  const rows = list.map(p => {
    const z = zoneById(p.zoneId);
    const si = statusInfo(p.status);
    return `<tr>
      <td>${esc(z ? (z.code + ' · ' + z.name) : '—')}</td>
      <td><b>${esc(p.brand || '—')}</b></td>
      <td>${fmtDate(p.start)}</td>
      <td>${fmtDate(p.end)}</td>
      <td><span class="bi-status" style="background:${si.color}22;color:${si.color}">${si.label}</span></td>
      <td class="bi-sum">${fmtUsd(placementMoney(p).totalAgreed)}</td>
    </tr>`;
  }).join('');
  openModal(`
    <div class="modal-head"><h3>${key === 'total' ? '🔒' : '🧺'} ${BASKET_TITLES[key]} · ${fmtUsd(total)}</h3><button class="modal-close" data-close>×</button></div>
    <div class="modal-body">
      ${list.length ? `<table class="basket-info">
        <thead><tr><th>Зона</th><th>Арендатор</th><th>Начало</th><th>Окончание</th><th>Статус</th><th>Сумма</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="5">Итого</td><td class="bi-sum">${fmtUsd(total)}</td></tr></tfoot>
      </table>` : `<div class="muted" style="text-align:center;padding:26px">Пока пусто</div>`}
    </div>
    <div class="modal-foot"><button class="btn" data-close>Закрыть</button></div>`, true);
}
function busyTotalUsd(a, b) {  // сумма «Подтверждено» (за период [a,b], иначе активные сейчас)
  let s = 0;
  for (const z of State.zones) { const bk = zoneBooking(z, a, b); if (bk.state === 'busy' && bk.p) s += placementMoney(bk.p).totalAgreed; }
  return s;
}
function doneTotalUsd(year) {   // сумма всех Завершённых за год
  let s = 0;
  for (const p of State.placements) if (p.status === 'done' && (!year || (p.end || '').slice(0, 4) === String(year))) s += placementMoney(p).totalAgreed;
  return s;
}
function stopMoneyRain() {
  if (_rainTimer) { clearInterval(_rainTimer); _rainTimer = null; }
  if (_rainTimer2) { clearInterval(_rainTimer2); _rainTimer2 = null; }
  if (_baskets) { _baskets.remove(); _baskets = null; }
  document.querySelectorAll('.bk-dollar').forEach(d => d.remove());
}
function startMoneyRain(container) {
  stopMoneyRain();
  const year = new Date().getFullYear();
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  const today = todayStr();
  const doneSum = doneTotalUsd(year);
  // Текущие: Подтверждено И аренда идёт прямо сейчас (start ≤ today ≤ end)
  const busyCurrentSum = State.placements
    .filter(p => p.status === 'busy' && isActiveToday(p))
    .reduce((s, p) => s + placementMoney(p).totalAgreed, 0);
  // Завершённые busy: Подтверждено, но срок уже истёк (end < today) — идут в Итого
  const busyExpiredSum = State.placements
    .filter(p => p.status === 'busy' && p.end < today && overlaps(p, yStart, yEnd))
    .reduce((s, p) => s + placementMoney(p).totalAgreed, 0);
  const itogo = doneSum + busyCurrentSum + busyExpiredSum;
  // Будущие поступления: любой статус кроме «Отказано», дата начала ещё впереди (start > today)
  const futureSum = State.placements
    .filter(p => p.status !== 'rejected' && p.start > today)
    .reduce((s, p) => s + placementMoney(p).totalAgreed, 0);
  if (!doneSum && !busyCurrentSum && !busyExpiredSum && !futureSum) return;

  const mk = (sum, cap, cls) => `<div class="bk3 ${cls}"><div class="bk3-sum">${fmtUsd(sum)}</div><div class="bk3-ic">🧺</div><div class="bk3-cap">${cap}</div></div>`;
  const mkSafe = (sum, cap, cls) => `<div class="bk3 ${cls}"><div class="bk3-sum">${fmtUsd(sum)}</div><div class="bk-safe">${SAFE_SVG}</div><div class="bk3-cap">${cap}</div></div>`;
  const bar = el('div', 'baskets-bar');
  bar.innerHTML =
    mk(doneSum, 'Завершено', 'bk-done') +
    mk(busyCurrentSum, 'Текущие', 'bk-current') +
    mk(futureSum, 'Будущие поступления', 'bk-future') +
    mkSafe(itogo, 'Итого накопительно', 'bk-total');
  (container || document.body).appendChild(bar);
  _baskets = bar;

  const bDone = bar.querySelector('.bk-done');
  const bCurrent = bar.querySelector('.bk-current');
  const bFuture = bar.querySelector('.bk-future');
  const bTotal = bar.querySelector('.bk-total');
  const safeEl = bTotal ? bTotal.querySelector('.bk-safe') : null;

  // Клик по корзинке/сейфу — окно с информацией
  if (bDone) bDone.onclick = () => openBasketInfo('done');
  if (bCurrent) bCurrent.onclick = () => openBasketInfo('current');
  if (bFuture) bFuture.onclick = () => openBasketInfo('future');
  if (bTotal) bTotal.onclick = () => openBasketInfo('total');

  const bounce = (elm) => { if (!elm) return; elm.classList.remove('bk3-bounce'); void elm.offsetWidth; elm.classList.add('bk3-bounce'); };
  const swell = (elm) => { if (!elm) return; elm.classList.remove('swell'); void elm.offsetWidth; elm.classList.add('swell'); };
  const flyDollar = (fromRect, toRect, slow, onLand) => {
    if (!fromRect.width || !toRect.width) return;
    const startX = fromRect.left + window.scrollX + (slow ? fromRect.width / 2 - 8 : Math.random() * Math.max(fromRect.width - 10, 10));
    const startY = fromRect.top + window.scrollY + fromRect.height * (slow ? 0.55 : 0.3);
    const endX = toRect.left + window.scrollX + toRect.width / 2 - 10;
    const endY = toRect.top + window.scrollY + toRect.height * (slow ? 0.5 : 0.6);
    const d = document.createElement('span');
    d.className = 'bk-dollar' + (slow ? ' slow' : '');
    d.textContent = '$';
    d.style.left = startX + 'px';
    d.style.top = startY + 'px';
    d.style.setProperty('--dx', (endX - startX) + 'px');
    d.style.setProperty('--dy', (endY - startY) + 'px');
    document.body.appendChild(d);
    setTimeout(() => { d.remove(); if (onLand) onLand(); }, slow ? 2900 : 1500);
  };

  // 1) $ летят из активных зон (Подтверждено + сегодня внутри дат) в «Текущие»
  _rainTimer = setInterval(() => {
    const active = State.placements.filter(p => p.status === 'busy' && isActiveToday(p));
    if (!active.length || !bCurrent) return;
    const p = active[Math.floor(Math.random() * active.length)];
    const pill = document.querySelector(`.bk-pill[data-p="${p.id}"]`);
    if (!pill) return;
    flyDollar(pill.getBoundingClientRect(), bCurrent.getBoundingClientRect(), false, () => bounce(bCurrent));
  }, 1800);

  // 2) $ медленно капают из «Завершено» и «Текущие» в «Итого накопительно»
  const totalSources = [];
  if (doneSum > 0) totalSources.push(bDone);
  if (busyCurrentSum > 0) totalSources.push(bCurrent);
  if (totalSources.length && bTotal) {
    _rainTimer2 = setInterval(() => {
      const src = totalSources[Math.floor(Math.random() * totalSources.length)];
      if (!src) return;
      flyDollar(src.getBoundingClientRect(), bTotal.getBoundingClientRect(), true, () => swell(safeEl));
    }, 3000);
  }
}

/* ═══════════════════════════════════════════════════════════════
   АРЕНДАТОРЫ (список размещений)
   ═══════════════════════════════════════════════════════════════ */
async function renderTenants(v) {
  const head = el('div', 'page-head');
  head.appendChild(el('h2', null, 'Арендаторы'));
  head.appendChild(el('div', 'spacer'));
  const sb = el('div', 'search-box');
  sb.innerHTML = `🔍<input type="text" placeholder="Поиск по бренду или зоне…" value="${esc(State.search)}">`;
  head.append(sb);
  v.appendChild(head);

  const grid = el('div', 'tenant-grid');
  v.appendChild(grid);

  const draw = async () => {
    grid.innerHTML = '';
    const q = State.search.trim().toLowerCase();
    let list = [...State.placements].sort((a,b)=>b.start.localeCompare(a.start));
    if (q) list = list.filter(p => (p.brand||'').toLowerCase().includes(q) || (zoneById(p.zoneId)?.name||'').toLowerCase().includes(q));
    if (!list.length) {
      grid.appendChild(el('div', 'empty', `<div class="em-icon">🏷️</div><h3>Пока пусто</h3><p>${q?'Ничего не найдено.':'Добавьте первое размещение.'}</p>`));
      grid.style.gridTemplateColumns = '1fr';
      return;
    }
    grid.style.gridTemplateColumns = '';
    for (const p of list) {
      const z = zoneById(p.zoneId);
      const st = statusInfo(p.status);
      const photos = await dbGetByIndex('files', 'placementId', p.id);
      const photo = photos.find(f => f.kind === 'photo');
      const card = el('div', 'tenant-card');
      const photoHtml = photo
        ? `<div class="tc-photo" style="background-image:url('${URL.createObjectURL(photo.blob)}')"></div>`
        : `<div class="tc-photo">🏷️</div>`;
      card.innerHTML = `${photoHtml}
        <div class="tc-body">
          <div class="tc-brand"><span class="tc-color" style="background:${p.color||'#4f46e5'}"></span>${esc(p.brand)}</div>
          <div class="tc-zone">${esc(z?z.name:'—')}</div>
          <div class="tc-dates">${fmtDate(p.start)} – ${fmtDate(p.end)} · ${diffDaysIncl(p.start,p.end)} дн.</div>
          <div class="tc-foot">
            <span class="badge" style="background:${st.color}"><span class="dot"></span>${st.label}</span>
            <span class="muted" style="font-size:12.5px">${isActiveToday(p)?'● сейчас':''}</span>
          </div>
        </div>`;
      card.onclick = () => openPlacementCard(p.id);
      grid.appendChild(card);
    }
  };
  sb.querySelector('input').oninput = (e) => { State.search = e.target.value; draw(); };
  draw();
}

/* ═══════════════════════════════════════════════════════════════
   КАРТОЧКА РАЗМЕЩЕНИЯ (просмотр)
   ═══════════════════════════════════════════════════════════════ */
async function openPlacementCard(pid) {
  const p = State.placements.find(x => x.id === pid);
  if (!p) return;
  const z = zoneById(p.zoneId);
  const st = statusInfo(p.status);
  const m = placementMoney(p);
  const files = await dbGetByIndex('files', 'placementId', p.id);
  const photos = files.filter(f => f.kind === 'photo');
  const docs = files.filter(f => f.kind === 'doc');

  const heroPhoto = photos[0]
    ? `<img class="card-hero-photo" src="${URL.createObjectURL(photos[0].blob)}" alt="">`
    : `<div class="card-hero-photo">🏷️</div>`;

  const galleryHtml = photos.length
    ? `<div class="section-title">Фото (${photos.length})</div><div class="gallery">${photos.map(f=>`<img src="${URL.createObjectURL(f.blob)}" data-src="${URL.createObjectURL(f.blob)}">`).join('')}</div>`
    : '';

  const docsHtml = (docs.length || p.docsLink)
    ? `<div class="section-title">Документы</div><div class="gallery" style="gap:10px">
        ${docs.map(f=>`<a class="doc-link" href="${URL.createObjectURL(f.blob)}" download="${esc(f.name)}">📄 ${esc(f.name)}</a>`).join('')}
        ${p.docsLink?`<a class="doc-link" href="${esc(p.docsLink)}" target="_blank" rel="noopener">🔗 Коммерческие документы</a>`:''}
       </div>`
    : '';

  // История того же бренда (на любых зонах)
  const sameBrand = State.placements.filter(x => x.id!==p.id && (x.brand||'').toLowerCase()===(p.brand||'').toLowerCase())
    .sort((a,b)=>b.start.localeCompare(a.start));
  // История этой зоны
  const sameZone = State.placements.filter(x => x.id!==p.id && x.zoneId===p.zoneId)
    .sort((a,b)=>b.start.localeCompare(a.start));

  const rowsBrand = sameBrand.map(x=>historyRowHtml(x)).join('') || '<p class="muted">Других размещений этого бренда нет.</p>';
  const rowsZone = sameZone.map(x=>historyRowHtml(x)).join('') || '<p class="muted">Других размещений на этой зоне нет.</p>';

  openModal(`
    <div class="modal-head">
      <h3>${esc(p.brand)}</h3>
      <span class="badge" style="background:${st.color}"><span class="dot"></span>${st.label}</span>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-body card-3col">
      <div class="card-left">
        <div class="card-hero">
          ${heroPhoto}
          <div class="card-hero-info">
            <h2>${esc(p.brand)}</h2>
            <div class="chz">📍 ${esc(z?z.name:'—')} · ${FLOORS.find(f=>f.floor===(z?z.floor:0))?.label||''}</div>
            <table class="info-table">
              <tr><td class="k">Период</td><td>${fmtDate(p.start)} – ${fmtDate(p.end)} <span class="muted">(${diffDaysIncl(p.start,p.end)} дн.)</span></td></tr>
              <tr><td class="k">Монтаж · демонтаж</td><td>${Number(p.setupDays)||0} дн. · ${Number(p.teardownDays)||0} дн.${(Number(p.setupDays)||0)||(Number(p.teardownDays)||0)?` <span class="muted">(зона занята ${fmtDate(occupiedSpan(p).start)} – ${fmtDate(occupiedSpan(p).end)})</span>`:''}</td></tr>
              <tr><td class="k">Контактное лицо</td><td>${esc(p.contactPerson)||'—'}</td></tr>
              <tr><td class="k">Телефон</td><td>${p.phone?`<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>`:'—'}</td></tr>
              <tr><td class="k">E-mail</td><td>${p.email?`<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`:'—'}</td></tr>
            </table>
          </div>
        </div>

        <table class="info-table">
          <tr><td class="k">Размеры конструкции</td><td>${esc(p.dimensions)||'—'}</td></tr>
          <tr><td class="k">Площадь</td><td>${m.area?fmtNum(m.area)+' м²':'—'}</td></tr>
          <tr><td class="k">Стоимость за день</td><td>${fmtUsd(m.dayRate)}</td></tr>
          <tr><td class="k">Дней</td><td>${m.days}</td></tr>
          <tr><td class="k">Стоимость без скидки</td><td>${fmtUsd(m.totalBase)}</td></tr>
          <tr><td class="k">Скидка</td><td>${m.manual ? '—' : (m.discount ? m.discount + ' %' : '—')}</td></tr>
          <tr><td class="k">К оплате (аренда)</td><td><b style="color:var(--green)">${fmtUsd(m.totalAgreed)}</b>${m.manual ? ' <span class="muted">(вручную)</span>' : ''}</td></tr>
          <tr><td class="k">Подрядчик по изготовлению</td><td>${esc(p.contractor)||'—'}</td></tr>
          <tr><td class="k">Стоимость изготовления</td><td>${fmtMoney(p.costMake)}</td></tr>
          <tr><td class="k">Статус</td><td><span class="badge" style="background:${st.color}"><span class="dot"></span>${st.label}</span></td></tr>
          <tr><td class="k">Комментарии</td><td>${esc(p.comments)?esc(p.comments).replace(/\n/g,'<br>'):'—'}</td></tr>
        </table>

        ${galleryHtml}
        ${docsHtml}

        <div class="section-title">История бренда «${esc(p.brand)}»</div>
        ${rowsBrand}
        <div class="section-title">История зоны «${esc(z?z.name:'')}»</div>
        ${rowsZone}
      </div>

      <div class="col-resizer" data-resize="left"></div>
      <div class="card-mid" id="plannerPane">
        <div class="muted" style="padding:20px">Загрузка…</div>
      </div>
      <div class="col-resizer" data-resize="right"></div>
      <div class="card-right" id="feedPane"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-danger" id="delP">Удалить размещение</button>
      <div class="spacer" style="flex:1"></div>
      <button class="btn" data-close>Закрыть</button>
      <button class="btn btn-primary" id="editP">Редактировать</button>
    </div>`, 'full');

  renderPlanner(p);
  setupCardResizers();
  $('#editP').onclick = () => openPlacementForm(p.id, {});
  $('#delP').onclick = async () => {
    if (!confirm(`Удалить размещение «${p.brand}» и все его файлы?`)) return;
    const fs = await dbGetByIndex('files', 'placementId', p.id);
    for (const f of fs) await dbDel('files', f.id);
    await dbDel('placements', p.id);
    await loadAll();
    closeModal();
    toast('Размещение удалено', 'ok');
    go(State.view);
  };
  $('#modal').querySelectorAll('.gallery img[data-src]').forEach(img => img.onclick = () => lightbox(img.dataset.src));
  $('#modal').querySelectorAll('[data-pid]').forEach(r => r.onclick = () => openPlacementCard(r.dataset.pid));
}

/* Двигаемые границы колонок карточки (ЛКМ по разделителю — тянуть) */
function setupCardResizers() {
  const left = document.querySelector('.card-left');
  const right = document.querySelector('.card-right');
  document.querySelectorAll('.col-resizer').forEach(rz => {
    const which = rz.dataset.resize;            // 'left' двигает левую колонку, 'right' — правую
    const col = which === 'left' ? left : right;
    rz.onmousedown = (e) => {
      e.preventDefault();
      const startX = e.clientX, startW = col.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      const mv = (ev) => {
        const d = ev.clientX - startX;
        let w = which === 'left' ? startW + d : startW - d;
        w = Math.max(180, Math.min(760, w));
        col.style.flex = `0 0 ${w}px`;
      };
      const up = () => { document.body.style.cursor = ''; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    };
  });
}

/* ───────── Планировщик-чеклист работы с арендатором (правая колонка) ───────── */
function fmtWhen(s) {
  if (!s) return '';
  if (s.includes('T')) {
    const [d, t] = s.split('T');
    return fmtDate(d) + ' ' + (t || '').slice(0, 5);
  }
  return fmtDate(s);
}
function attachHtml(a) {
  if (!a.blob) return '';
  const url = URL.createObjectURL(a.blob);
  return (a.fileType || '').startsWith('image/')
    ? `<img class="pl-img" src="${url}" data-src="${url}" alt="${esc(a.fileName)}">`
    : `<a class="doc-link" href="${url}" download="${esc(a.fileName)}">📄 ${esc(a.fileName)}</a>`;
}
function childHtml(c) {
  const time = `<span class="pl-child-time">${fmtWhen((c.createdAt || '').slice(0, 16))}</span>`;
  if (c.type === 'file' || c.blob) return `<div class="pl-child">${attachHtml(c)}${time}</div>`;
  return `<div class="pl-child"><span class="pl-child-bubble">💬 ${esc(c.text || '').replace(/\n/g, '<br>')}</span>${time}</div>`;
}
function taskHtml(t, children, showTenant) {
  const whenBadge = t.when ? `<span class="pl-when-badge">📅 ${fmtWhen(t.when)}</span>` : '';
  const tenantChip = showTenant ? `<span class="pl-tenant" data-brand="${esc(t.brand || '')}">🏷️ ${esc(t.brand || '—')}</span>` : '';
  const kids = (t.blob ? attachHtml(t) : '') + children.map(childHtml).join('');
  return `<div class="pl-task${t.done ? ' done' : ''}">
    <div class="pl-task-head">
      <input type="checkbox" class="pl-checkbox" data-done="${t.id}" ${t.done ? 'checked' : ''}>
      <div class="pl-task-main">
        <div class="pl-task-text">${esc(t.text) || '(без названия)'}</div>
        <div class="pl-task-meta">${tenantChip}${whenBadge}<span class="pl-added">добавлено ${fmtWhen((t.createdAt || '').slice(0, 16))}</span></div>
      </div>
    </div>
    ${kids ? `<div class="pl-children">${kids}</div>` : ''}
    <div class="pl-cbox" data-for="${t.id}" hidden>
      <textarea rows="2" placeholder="Комментарий…"></textarea>
      <button class="btn btn-sm btn-primary pl-csend" data-send="${t.id}">Добавить</button>
    </div>
    <div class="pl-task-actions">
      <button class="pl-act" data-comment="${t.id}">💬 Комментарий</button>
      <button class="pl-act" data-file="${t.id}">📎 Файл / картинка</button>
    </div>
  </div>`;
}

// Общий обработчик задач (галочка, комментарий, файл) — для карточки и «Моих задач».
// reload() перерисовывает список после изменения.
function wireTaskHandlers(pane, reload) {
  pane.querySelectorAll('[data-done]').forEach(cb => cb.onchange = async () => {
    const a = (await dbGetAll('activities')).find(x => x.id === cb.dataset.done);
    if (a) { a.done = cb.checked; await dbPut('activities', a); reload(); }
  });
  pane.querySelectorAll('[data-comment]').forEach(btn => btn.onclick = () => {
    const box = pane.querySelector(`.pl-cbox[data-for="${btn.dataset.comment}"]`);
    if (box) { box.hidden = !box.hidden; if (!box.hidden) box.querySelector('textarea').focus(); }
  });
  pane.querySelectorAll('.pl-csend').forEach(btn => btn.onclick = async () => {
    const pid = btn.dataset.send;
    const ta = pane.querySelector(`.pl-cbox[data-for="${pid}"] textarea`);
    const text = ta.value.trim(); if (!text) return;
    const parent = (await dbGetAll('activities')).find(x => x.id === pid);
    await dbPut('activities', { id: 'a' + uid(), tenantKey: parent ? parent.tenantKey : '', brand: parent ? parent.brand : '', type: 'comment', text, parentId: pid, createdAt: new Date().toISOString() });
    reload();
  });
  let fileTarget = null;
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.hidden = true;
  fileInput.accept = 'image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx';
  pane.appendChild(fileInput);
  pane.querySelectorAll('[data-file]').forEach(btn => btn.onclick = () => { fileTarget = btn.dataset.file; fileInput.click(); });
  fileInput.onchange = async (e) => {
    const f = e.target.files[0]; if (!f || !fileTarget) return;
    const parent = (await dbGetAll('activities')).find(x => x.id === fileTarget);
    await dbPut('activities', { id: 'a' + uid(), tenantKey: parent ? parent.tenantKey : '', brand: parent ? parent.brand : '', type: 'file', fileName: f.name, fileType: f.type, blob: f, text: '', parentId: fileTarget, createdAt: new Date().toISOString() });
    reload();
  };
  pane.querySelectorAll('.pl-img[data-src]').forEach(img => img.onclick = () => lightbox(img.dataset.src));
}

/* ═══════════════════════════════════════════════════════════════
   МОИ ЗАДАЧИ — иерархия: арендаторы → задачи → лента действий
   ═══════════════════════════════════════════════════════════════ */
async function renderTasks(v) {
  const tv = State.tasksView || (State.tasksView = { mode: 'all', sel: null });

  // ── Заголовок + кнопки-фильтры
  const head = el('div', 'page-head');
  head.appendChild(el('h2', null, 'Мои задачи'));
  head.appendChild(el('div', 'spacer'));
  const seg = el('div', 'cal-seg');
  [['all', 'Показать все'], ['active', 'Показать активные'], ['tenants', 'Список арендаторов']].forEach(([k, lbl]) => {
    const b = el('button', tv.mode === k ? 'active' : '', lbl);
    b.onclick = () => { tv.mode = k; tv.sel = null; draw(); };
    seg.appendChild(b);
  });
  head.appendChild(seg);
  v.appendChild(head);

  // ── Доска из трёх колонок
  const board = el('div', 'tasks-board');
  board.innerHTML = `
    <div class="tk-tenants"><div class="tk-panel-title">Арендаторы</div><div class="tk-tenant-list" id="tkTenants"></div></div>
    <div class="tk-mid"><div class="tk-panel-title" id="tkMidTitle">Задачи</div><div class="tk-composer" id="tkComposer"></div><div class="tk-mid-body" id="tkBody"></div></div>
    <div class="tk-feed"><div class="tk-panel-title">🕘 Лента действий</div><div class="feed-list" id="tkFeed"></div></div>`;
  v.appendChild(board);

  const draw = async () => {
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.textContent === ({ all: 'Показать все', active: 'Показать активные', tenants: 'Список арендаторов' }[tv.mode])));
    const acts = await dbGetAll('activities');
    const tops = acts.filter(a => !a.parentId);
    const childMap = {};
    acts.filter(a => a.parentId).forEach(c => (childMap[c.parentId] = childMap[c.parentId] || []).push(c));
    Object.values(childMap).forEach(arr => arr.sort((x, y) => (x.createdAt || '').localeCompare(y.createdAt || '')));

    // статистика по арендаторам
    const stat = {};
    for (const t of tops) { const k = (t.brand || '').trim(); if (!k) continue; (stat[k] = stat[k] || { total: 0, active: 0 }); stat[k].total++; if (!t.done) stat[k].active++; }
    const allBrands = [...new Set([...State.placements.map(p => (p.brand || '').trim()), ...tops.map(t => (t.brand || '').trim())].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    let leftBrands;
    if (tv.mode === 'tenants') leftBrands = allBrands;
    else if (tv.mode === 'active') leftBrands = allBrands.filter(b => stat[b] && stat[b].active);
    else leftBrands = allBrands.filter(b => stat[b]);
    if (!tv.sel || !leftBrands.includes(tv.sel)) tv.sel = leftBrands[0] || null;

    // ── левая колонка: арендаторы
    const tcol = $('#tkTenants');
    tcol.innerHTML = leftBrands.length ? leftBrands.map(b => {
      const s = stat[b] || { total: 0, active: 0 };
      const cnt = tv.mode === 'active' ? s.active : s.total;
      const doneC = s.total - s.active;
      const undoneC = s.active;
      return `<div class="tk-tenant${tv.sel === b ? ' active' : ''}" data-b="${esc(b)}">
        <span class="tk-tn">${esc(b)}</span>
        <span class="tk-dot tk-dot-green">${doneC}</span>
        <span class="tk-dot tk-dot-red">${undoneC}</span>
      </div>`;
    }).join('') : `<div class="tk-empty">Нет арендаторов</div>`;
    tcol.querySelectorAll('.tk-tenant').forEach(el2 => el2.onclick = () => { tv.sel = el2.dataset.b; draw(); });

    // ── средняя колонка: задачи выбранного
    const midTitle = $('#tkMidTitle'), comp = $('#tkComposer'), body = $('#tkBody');
    if (!tv.sel) {
      midTitle.textContent = 'Задачи';
      comp.innerHTML = ''; body.innerHTML = `<div class="tk-empty">Выберите арендатора слева</div>`;
      $('#tkFeed').innerHTML = `<div class="tk-empty">—</div>`;
      return;
    }
    midTitle.innerHTML = `Задачи · <b>${esc(tv.sel)}</b>`;
    comp.innerHTML = `<input id="tk-text" class="pl-input" placeholder="Новая задача для ${esc(tv.sel)}…">
      <input type="date" id="tk-when" class="pl-input" title="Дата задачи">
      <button class="btn btn-primary btn-sm" id="tk-add">Добавить</button>`;
    let mine = tops.filter(t => (t.brand || '').trim() === tv.sel).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (tv.mode === 'active') mine = mine.filter(t => !t.done);
    body.innerHTML = mine.length ? mine.map(t => taskHtml(t, childMap[t.id] || [], false)).join('')
      : `<div class="tk-empty">${tv.mode === 'active' ? 'Активных задач нет' : 'Задач пока нет — добавьте первую'}</div>`;
    wireTaskHandlers(body, draw);

    const addTask = async () => {
      const text = $('#tk-text').value.trim(); const when = $('#tk-when').value;
      if (!text) return toast('Напишите задачу', 'err');
      await dbPut('activities', { id: 'a' + uid(), tenantKey: tenantKey(tv.sel), brand: tv.sel, type: 'task', text, when, done: false, parentId: null, createdAt: new Date().toISOString() });
      toast('Задача добавлена', 'ok'); draw();
    };
    $('#tk-add').onclick = addTask;
    $('#tk-text').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTask(); } });

    // ── правая колонка: лента действий выбранного
    const feedActs = acts.filter(a => (a.brand || '').trim() === tv.sel);
    const feedTops = feedActs.filter(a => !a.parentId).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const fmap = {}; feedActs.filter(a => a.parentId).forEach(c => (fmap[c.parentId] = fmap[c.parentId] || []).push(c));
    Object.values(fmap).forEach(arr => arr.sort((x, y) => (x.createdAt || '').localeCompare(y.createdAt || '')));
    $('#tkFeed').innerHTML = feedTops.length ? feedTops.map(t => feedTaskHtml(t, fmap[t.id] || [])).join('')
      : `<div class="tk-empty">Действий пока нет</div>`;
  };

  await draw();
}

async function renderPlanner(p) {
  const pane = $('#plannerPane');
  if (!pane) return;
  const tk = tenantKey(p.brand);
  const all = await dbGetByIndex('activities', 'tenantKey', tk);
  const tops = all.filter(a => !a.parentId).sort((a, b) => (b.when || b.createdAt || '').localeCompare(a.when || a.createdAt || ''));
  const childMap = {};
  all.filter(a => a.parentId).forEach(c => (childMap[c.parentId] = childMap[c.parentId] || []).push(c));
  Object.values(childMap).forEach(arr => arr.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')));

  const visibleTops = tops.filter(t => !(t.type === 'task' && t.done));
  const list = visibleTops.length ? visibleTops.map(t => taskHtml(t, childMap[t.id] || [])).join('')
    : `<div class="muted" style="text-align:center;padding:24px 8px">Список пуст. Добавьте первую задачу.</div>`;

  pane.innerHTML = `
    <div class="planner-head">🗂️ Работа с арендатором</div>
    <div class="planner-composer">
      <input id="pl-task" class="pl-input" placeholder="Новая задача…">
      <div class="pl-row">
        <input type="date" id="pl-when" class="pl-input" title="Дата задачи">
        <button class="btn btn-primary" id="pl-add">Добавить</button>
      </div>
    </div>
    <div class="planner-timeline">${list}</div>
    <input type="file" id="pl-file-hidden" hidden accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx">`;

  const addTask = async () => {
    const text = $('#pl-task').value.trim();
    const when = $('#pl-when').value;
    if (!text) return toast('Напишите задачу', 'err');
    await dbPut('activities', { id: 'a' + uid(), tenantKey: tk, brand: p.brand, type: 'task', text, when, done: false, parentId: null, createdAt: new Date().toISOString() });
    renderPlanner(p);
  };
  $('#pl-add').onclick = addTask;
  $('#pl-task').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTask(); } });

  // галочка «выполнено»
  pane.querySelectorAll('[data-done]').forEach(cb => cb.onchange = async () => {
    const a = all.find(x => x.id === cb.dataset.done);
    if (a) { a.done = cb.checked; await dbPut('activities', a); renderPlanner(p); }
  });

  // комментарий к задаче
  pane.querySelectorAll('[data-comment]').forEach(btn => btn.onclick = () => {
    const box = pane.querySelector(`.pl-cbox[data-for="${btn.dataset.comment}"]`);
    if (box) { box.hidden = !box.hidden; if (!box.hidden) box.querySelector('textarea').focus(); }
  });
  pane.querySelectorAll('.pl-csend').forEach(btn => btn.onclick = async () => {
    const pid = btn.dataset.send;
    const ta = pane.querySelector(`.pl-cbox[data-for="${pid}"] textarea`);
    const text = ta.value.trim();
    if (!text) return;
    await dbPut('activities', { id: 'a' + uid(), tenantKey: tk, brand: p.brand, type: 'comment', text, parentId: pid, createdAt: new Date().toISOString() });
    renderPlanner(p);
  });

  // файл/картинка к задаче
  let fileTarget = null;
  pane.querySelectorAll('[data-file]').forEach(btn => btn.onclick = () => { fileTarget = btn.dataset.file; $('#pl-file-hidden').click(); });
  $('#pl-file-hidden').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f || !fileTarget) return;
    await dbPut('activities', { id: 'a' + uid(), tenantKey: tk, brand: p.brand, type: 'file', fileName: f.name, fileType: f.type, blob: f, text: '', parentId: fileTarget, createdAt: new Date().toISOString() });
    renderPlanner(p);
  };

  pane.querySelectorAll('.pl-img[data-src]').forEach(img => img.onclick = () => lightbox(img.dataset.src));

  renderActivityFeed(all);
}

// Правая колонка: краткая лента всех действий (новые → старые)
// Системное время добавления записи (для подписи и сортировки)
function fmtAddedTs(iso) { return iso ? fmtWhen(iso.slice(0, 16)) : ''; }

// Структурированная лента: задачи (новые сверху) + их комментарии/файлы под ними (со сдвигом)
function renderActivityFeed(all) {
  const feed = $('#feedPane');
  if (!feed) return;
  const tasks = all.filter(a => !a.parentId).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')); // новые сверху
  const childMap = {};
  all.filter(a => a.parentId).forEach(c => (childMap[c.parentId] = childMap[c.parentId] || []).push(c));
  Object.values(childMap).forEach(arr => arr.sort((x, y) => (x.createdAt || '').localeCompare(y.createdAt || ''))); // хронологически
  const html = tasks.length ? tasks.map(t => feedTaskHtml(t, childMap[t.id] || [])).join('')
    : `<div class="muted" style="padding:16px;font-size:13px">Действий пока нет.</div>`;
  feed.innerHTML = `<div class="planner-head">🕘 Лента действий</div><div class="feed-list">${html}</div>`;
}
function feedTaskHtml(t, children) {
  const icon = t.type === 'file' ? '📎' : t.type === 'comment' ? '💬' : (t.done ? '✔️' : '📝');
  const txt = t.type === 'file' ? (t.fileName || 'файл') : (t.text || '(задача)');
  const due = t.when ? ` <span class="feed-due">📅 ${fmtWhen(t.when)}</span>` : '';
  const kids = children.map(c => {
    const cic = (c.type === 'file' || c.blob) ? '📎' : '💬';
    const ctx = (c.type === 'file' || c.blob) ? (c.fileName || 'файл') : (c.text || '');
    return `<div class="feed-line child"><span class="feed-ic">${cic}</span><span class="feed-tx">${esc(ctx)}</span><span class="feed-tm">${fmtAddedTs(c.createdAt)}</span></div>`;
  }).join('');
  return `<div class="feed-task${t.done ? ' done' : ''}">
    <div class="feed-line"><span class="feed-ic">${icon}</span><span class="feed-tx"><b>${esc(txt)}</b>${due}</span><span class="feed-tm">${fmtAddedTs(t.createdAt)}</span></div>
    ${kids ? `<div class="feed-children">${kids}</div>` : ''}
  </div>`;
}

function historyRowHtml(p, withZone) {
  const z = zoneById(p.zoneId);
  const st = statusInfo(p.status);
  return `<div class="history-row" data-pid="${p.id}">
    <div class="hr-color" style="background:${p.color||'#4f46e5'}"></div>
    <div class="hr-main">
      <b>${esc(p.brand)}</b>
      <div>${withZone?'':'📅 '}${fmtDate(p.start)} – ${fmtDate(p.end)} · ${diffDaysIncl(p.start,p.end)} дн.${withZone?' · '+esc(z?z.name:''):''}</div>
    </div>
    <span class="badge soft">${st.label}</span>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   ФОРМА РАЗМЕЩЕНИЯ (создание / редактирование)
   ═══════════════════════════════════════════════════════════════ */
let formFiles = []; // буфер новых файлов { id, placementId, kind, name, type, blob, _new:true }

async function openPlacementForm(pid, preset) {
  const editing = !!pid;
  const p = editing ? State.placements.find(x=>x.id===pid) : null;
  formFiles = [];
  if (editing) formFiles = await dbGetByIndex('files', 'placementId', pid);

  const zoneOpts = [...State.zones].sort(byCode).map(z => `<option value="${z.id}" ${ (p?p.zoneId:preset.zoneId)===z.id?'selected':'' }>${esc(z.code)} · ${esc(z.name)} · ${z.floor} эт.</option>`).join('');
  const statusOpts = CONTRACT_STATUSES.map(s => `<option value="${s.key}" ${ (p?p.status:'process')===s.key?'selected':'' }>${s.label}</option>`).join('');
  const curColor = p ? p.color : COLOR_PALETTE[State.placements.length % COLOR_PALETTE.length];
  const swatches = COLOR_PALETTE.map(c => `<div class="color-swatch ${c===curColor?'sel':''}" data-color="${c}" style="background:${c}"></div>`).join('');

  openModal(`
    <div class="modal-head"><h3>${editing?'Редактировать размещение':'Новое размещение'}</h3><button class="modal-close" data-close>×</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="field full"><label>Бренд *</label><input id="f-brand" value="${esc(p?p.brand:'')}" placeholder="Например, Lancôme"></div>
        <div class="field full"><label>Зона / локация *</label><select id="f-zone">${zoneOpts}</select></div>
        <div class="field"><label>Дата начала *</label><input type="date" id="f-start" value="${p?p.start:(preset.start||'')}"></div>
        <div class="field"><label>Дата окончания *</label><input type="date" id="f-end" value="${p?p.end:(preset.end||'')}"></div>
        <div class="field"><label>Дней на монтаж</label><input id="f-setup" type="number" min="0" value="${p&&p.setupDays!=null?p.setupDays:''}" placeholder="0"><div class="hint">до даты начала</div></div>
        <div class="field"><label>Дней на демонтаж</label><input id="f-teardown" type="number" min="0" value="${p&&p.teardownDays!=null?p.teardownDays:''}" placeholder="0"><div class="hint">после даты окончания</div></div>
        <div class="field full"><div class="form-warn" id="f-clash" hidden></div></div>
        <div class="field full"><label>Статус договора</label><select id="f-status">${statusOpts}</select></div>

        <div class="field"><label>Стоимость за день ($)</label><input id="f-dayrate" type="number" readonly value="" style="background:var(--surface-2)"><div class="hint">из зоны (изменяется в файле)</div></div>
        <div class="field"><label>Скидка, %</label><input id="f-discount" type="number" min="0" max="100" value="${p&&p.discount!=null?p.discount:''}" placeholder="0"></div>
        <div class="field full"><label class="check-row"><input type="checkbox" id="f-manual-on" ${p&&p.manualCost!=null&&p.manualCost!==''?'checked':''}> Добавить стоимость вручную</label>
          <input id="f-manual" type="number" placeholder="Сумма к оплате, $" value="${p&&p.manualCost!=null?p.manualCost:''}"></div>
        <div class="field full"><label>Расчёт стоимости аренды</label><div class="rate-summary" id="f-totals">—</div></div>

        <div class="field full">
          <label>Фото и файлы (хранятся внутри приложения)</label>
          <div class="attach-zone" id="attachBtn">📎 Нажмите, чтобы прикрепить фото или документы</div>
          <input type="file" id="fileInput" multiple style="display:none" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx">
          <div class="attach-list" id="attachList"></div>
        </div>

        <div class="field full"><button type="button" class="more-toggle" id="moreBtn">⊕ Дополнительно</button></div>

        <div class="form-extra" id="f-extra" hidden>
          <div class="field full"><label>Цвет в календаре</label><div class="color-row" id="f-colors">${swatches}</div></div>
          <div class="field"><label>Контактное лицо</label><input id="f-contact" value="${esc(p?p.contactPerson:'')}"></div>
          <div class="field"><label>Телефон</label><input id="f-phone" value="${esc(p?p.phone:'')}" placeholder="+998 ..."></div>
          <div class="field"><label>E-mail</label><input id="f-email" value="${esc(p?p.email:'')}"></div>
          <div class="field"><label>Размеры конструкции</label><input id="f-dim" value="${esc(p?p.dimensions:'')}" placeholder="напр. 3×2×2,5 м"></div>
          <div class="field"><label>Площадь, м²</label><input id="f-area" type="number" value="${esc(p?p.area:'')}" placeholder="напр. 6"></div>
          <div class="field"><label>Стоимость изготовления (${esc(State.currency)})</label><input id="f-make" type="number" value="${p&&p.costMake!=null?p.costMake:''}"></div>
          <div class="field full"><label>Подрядчик по изготовлению</label><input id="f-contractor" value="${esc(p?p.contractor:'')}"></div>
          <div class="field full"><label>Ссылка на коммерческие документы</label><input id="f-docs" value="${esc(p?p.docsLink:'')}" placeholder="https://..."></div>
          <div class="field full"><label>Комментарии и особенности</label><textarea id="f-comments">${esc(p?p.comments:'')}</textarea></div>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Отмена</button>
      <button class="btn btn-primary" id="saveP">${editing?'Сохранить':'Создать'}</button>
    </div>`, true);

  // Кнопка «Дополнительно» — раскрыть/свернуть второстепенные поля
  $('#moreBtn').onclick = () => {
    const extra = $('#f-extra');
    const show = extra.hidden;
    extra.hidden = !show;
    $('#moreBtn').innerHTML = show ? '⊖ Свернуть дополнительно' : '⊕ Дополнительно';
  };

  // Цвет
  let selColor = curColor;
  $('#f-colors').querySelectorAll('.color-swatch').forEach(sw => sw.onclick = () => {
    selColor = sw.dataset.color;
    $('#f-colors').querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('sel'));
    sw.classList.add('sel');
  });

  // Стоимость аренды (живой пересчёт): ставка/день × дни − скидка, либо вручную
  const recalcRates = () => {
    const z = zoneById($('#f-zone').value);
    const dayRate = z ? Number(z.dayRate) || 0 : 0;
    $('#f-dayrate').value = dayRate;
    const s = $('#f-start').value, e = $('#f-end').value;
    const days = (s && e && e >= s) ? diffDaysIncl(s, e) : 0;
    const disc = Math.min(100, Math.max(0, Number($('#f-discount').value) || 0));
    const totalBase = dayRate * days;
    const manualOn = $('#f-manual-on').checked;
    $('#f-manual').disabled = !manualOn;
    $('#f-discount').disabled = manualOn;
    const totalAgreed = manualOn ? (Number($('#f-manual').value) || 0) : Math.round(totalBase * (1 - disc / 100));
    $('#f-totals').innerHTML =
      `<span>Дней: <b>${days}</b></span>` +
      `<span>Без скидки: <b>${fmtUsd(totalBase)}</b></span>` +
      `<span>Скидка: <b>${manualOn ? '—' : disc + '%'}</b></span>` +
      `<span>К оплате: <b style="color:var(--green)">${fmtUsd(totalAgreed)}</b>${manualOn ? ' (вручную)' : ''}</span>`;
  };
  ['#f-zone', '#f-start', '#f-end', '#f-discount', '#f-manual', '#f-manual-on'].forEach(sel => {
    const ev = (sel === '#f-zone' || sel === '#f-manual-on') ? 'change' : 'input';
    $(sel).addEventListener(ev, recalcRates);
  });
  recalcRates();

  // Мгновенная проверка пересечения с учётом дней на монтаж/демонтаж
  const checkClash = () => {
    const zoneId = $('#f-zone').value, s = $('#f-start').value, e = $('#f-end').value;
    const warn = $('#f-clash');
    const clear = () => { warn.hidden = true; warn.textContent = ''; $('#f-start').classList.remove('field-bad'); $('#f-end').classList.remove('field-bad'); $('#saveP').disabled = false; };
    if (!zoneId || (!s && !e)) return clear();
    const a = s || e, b = e || s;
    const rs = a < b ? a : b, re = a < b ? b : a;
    const setup = Math.max(0, Number($('#f-setup').value) || 0);
    const teardown = Math.max(0, Number($('#f-teardown').value) || 0);
    const newStart = addDays(rs, -setup), newEnd = addDays(re, teardown);
    const clash = State.placements.find(x => x.zoneId === zoneId && x.id !== pid
      && x.status !== 'rejected' && x.status !== 'done'
      && (() => { const sp = occupiedSpan(x); return newStart <= sp.end && newEnd >= sp.start; })());
    if (!clash) return clear();
    const sp = occupiedSpan(clash);
    const buffered = (sp.start !== clash.start || sp.end !== clash.end);
    warn.hidden = false;
    warn.textContent = `❌ Пересечение с «${clash.brand}» (${fmtDate(clash.start)} – ${fmtDate(clash.end)}${buffered ? `; с монтажом/демонтажом ${fmtDate(sp.start)} – ${fmtDate(sp.end)}` : ''}). Выберите другие даты.`;
    $('#f-start').classList.toggle('field-bad', !!s);
    $('#f-end').classList.toggle('field-bad', !!e);
    $('#saveP').disabled = true;
  };
  ['#f-zone', '#f-start', '#f-end', '#f-setup', '#f-teardown'].forEach(sel => {
    $(sel).addEventListener('change', checkClash);
    $(sel).addEventListener('input', checkClash);
  });
  checkClash();

  // Вложения
  const renderAttach = () => {
    const box = $('#attachList'); box.innerHTML = '';
    formFiles.forEach((f, i) => {
      const item = el('div', 'attach-item');
      const isImg = f.kind === 'photo';
      const thumb = isImg
        ? `<img class="thumb" src="${URL.createObjectURL(f.blob)}">`
        : `<div class="thumb">📄</div>`;
      item.innerHTML = `${thumb}<div class="att-name">${esc(f.name)}</div><button class="att-del" title="Удалить">×</button>`;
      item.querySelector('.att-del').onclick = () => { formFiles.splice(i,1); renderAttach(); };
      box.appendChild(item);
    });
  };
  renderAttach();
  $('#attachBtn').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => {
    for (const file of e.target.files) {
      formFiles.push({
        id: uid(), placementId: pid || '_pending', _new: true,
        kind: file.type.startsWith('image/') ? 'photo' : 'doc',
        name: file.name, type: file.type, blob: file,
      });
    }
    renderAttach();
    e.target.value = '';
  };

  // Сохранение
  $('#saveP').onclick = async () => {
    const brand = $('#f-brand').value.trim();
    const zoneId = $('#f-zone').value;
    const start = $('#f-start').value;
    const end = $('#f-end').value;
    if (!brand) return toast('Укажите бренд', 'err');
    if (!start || !end) return toast('Укажите даты начала и окончания', 'err');
    if (end < start) return toast('Дата окончания раньше начала', 'err');

    const setupDays = Math.max(0, Number($('#f-setup').value) || 0);
    const teardownDays = Math.max(0, Number($('#f-teardown').value) || 0);

    // Запрет наложения с учётом монтажа/демонтажа (Отказано/Завершено не мешают)
    const newStart = addDays(start, -setupDays), newEnd = addDays(end, teardownDays);
    const clash = State.placements.find(x => x.zoneId===zoneId && x.id!==pid
      && x.status!=='rejected' && x.status!=='done'
      && (() => { const sp = occupiedSpan(x); return newStart <= sp.end && newEnd >= sp.start; })());
    if (clash) {
      const sp = occupiedSpan(clash);
      const buffered = (sp.start !== clash.start || sp.end !== clash.end);
      toast(`❌ Пересечение с «${clash.brand}» (${fmtDate(clash.start)} – ${fmtDate(clash.end)}${buffered ? `; с монтажом/демонтажом ${fmtDate(sp.start)} – ${fmtDate(sp.end)}` : ''}). Выберите другие даты.`, 'err');
      return;
    }

    const rec = {
      id: pid || uid(),
      zoneId, brand, start, end, color: selColor,
      setupDays, teardownDays,
      contactPerson: $('#f-contact').value.trim(),
      phone: $('#f-phone').value.trim(),
      email: $('#f-email').value.trim(),
      dimensions: $('#f-dim').value.trim(),
      area: $('#f-area').value.trim(),
      discount: $('#f-discount').value === '' ? 0 : Number($('#f-discount').value),
      manualCost: $('#f-manual-on').checked && $('#f-manual').value !== '' ? Number($('#f-manual').value) : null,
      contractor: $('#f-contractor').value.trim(),
      costMake: $('#f-make').value === '' ? null : Number($('#f-make').value),
      docsLink: $('#f-docs').value.trim(),
      comments: $('#f-comments').value.trim(),
      status: $('#f-status').value,
      createdAt: p ? p.createdAt : new Date().toISOString(),
    };
    await dbPut('placements', rec);

    // Журнал истории: фиксируем при статусе «Занято» (хранится отдельно, не удаляется)
    if (rec.status === 'busy') await recordHistory(rec);

    // Синхронизация файлов
    if (editing) {
      const existing = await dbGetByIndex('files', 'placementId', pid);
      const keepIds = new Set(formFiles.map(f=>f.id));
      for (const ex of existing) if (!keepIds.has(ex.id)) await dbDel('files', ex.id);
    }
    for (const f of formFiles) {
      await dbPut('files', { id: f.id, placementId: rec.id, kind: f.kind, name: f.name, type: f.type, blob: f.blob });
    }

    await loadAll();
    closeModal();
    toast(editing ? 'Сохранено' : 'Размещение добавлено', 'ok');
    go(State.view);
  };
}

/* ═══════════════════════════════════════════════════════════════
   ИСТОРИЯ — по зонам и по арендаторам
   ═══════════════════════════════════════════════════════════════ */
function renderHistory(v) {
  const head = el('div', 'page-head');
  head.appendChild(el('h2', null, 'История бронирования'));
  v.appendChild(head);

  // Меню из двух карточек
  if (!State.historyMode) {
    const totalH = State.history.length;
    const tenants = new Set(State.history.map(h => (h.brand || '').trim().toLowerCase())).size;
    const zonesUsed = new Set(State.history.map(h => h.zoneId)).size;
    const grid = el('div', 'home-grid');
    grid.style.maxWidth = '760px';
    const cards = [
      { m: 'zones', icon: '🗺️', t: 'История бронирования по зонам', d: `Занятые периоды по локациям. Зон в истории: ${zonesUsed}.` },
      { m: 'tenants', icon: '🏷️', t: 'История бронирования по арендаторам', d: `Занятые периоды по брендам. Арендаторов: ${tenants}.` },
    ];
    for (const c of cards) {
      const card = el('button', 'home-card');
      card.innerHTML = `<div class="hc-icon">${c.icon}</div><h3>${c.t}</h3><p>${c.d}</p>`;
      card.onclick = () => { State.historyMode = c.m; go('history'); };
      grid.appendChild(card);
    }
    v.appendChild(grid);
    v.appendChild(el('div', 'map-hint', `🔒 В историю автоматически попадают размещения со статусом «Занято». Записи хранятся отдельно и не удаляются — даже если размещение позже изменено или удалено.`));
    if (!totalH) v.appendChild(el('div', 'empty', `<div class="em-icon">🕘</div><h3>История пуста</h3><p>Появится, когда у размещения будет статус «Занято».</p>`));
    return;
  }

  // Подзаголовок + кнопка назад
  head.querySelector('h2').textContent = State.historyMode === 'zones'
    ? 'История · по зонам' : 'История · по арендаторам';
  head.appendChild(el('div', 'spacer'));
  const back = el('button', 'btn btn-sm', '‹ Назад');
  back.onclick = () => { State.historyMode = null; go('history'); };
  head.appendChild(back);

  if (State.historyMode === 'zones') renderHistoryByZones(v);
  else renderHistoryByTenants(v);
}

// Запись истории как строка из пилюль. mode 'zones' → первая пилюля = арендатор; 'tenants' → зона.
function historyEntryHtml(e, mode) {
  const first = mode === 'tenants'
    ? `<span class="he-pill he-zone">${esc((e.zoneCode ? e.zoneCode + ' · ' : '') + e.zoneName)}</span>`
    : `<span class="he-pill he-name">${esc(e.brand)}</span>`;
  const discPill = e.discount ? `<span class="he-pill">🏷️ скидка ${fmtNum(e.discount)}%</span>` : '';
  return `<div class="hist-entry" data-pid="${esc(e.placementId)}">
    ${first}
    <span class="he-pill">📅 ${fmtDate(e.start)} – ${fmtDate(e.end)} · ${e.days != null ? e.days : diffDaysIncl(e.start, e.end)} дн.</span>
    <span class="he-pill">💲 ${fmtNum(e.dayRate)} $/день</span>
    ${discPill}
    <span class="he-pill he-total">Итого ${fmtUsd(e.totalAgreed)}</span>
  </div>`;
}

function wireHistoryRows(container) {
  container.querySelectorAll('[data-pid]').forEach(r => r.onclick = () => {
    if (State.placements.some(p => p.id === r.dataset.pid)) openPlacementCard(r.dataset.pid);
    else toast('Размещение удалено — запись в истории сохранена', 'ok');
  });
}

function renderHistoryByZones(v) {
  if (!State.history.length) { v.appendChild(el('div', 'empty', `<div class="em-icon">🗺️</div><h3>История пуста</h3><p>Появится при статусе «Занято».</p>`)); return; }
  // группируем журнал по зоне
  const groups = {};
  for (const e of State.history) (groups[e.zoneId] = groups[e.zoneId] || []).push(e);
  const keys = Object.keys(groups).sort((a, b) => {
    const za = State.history.find(h => h.zoneId === a), zb = State.history.find(h => h.zoneId === b);
    return ((za.floor ?? 0) - (zb.floor ?? 0)) || String(za.zoneCode).localeCompare(String(zb.zoneCode), 'ru', { numeric: true });
  });
  const wrap = el('div');
  for (const zid of keys) {
    const list = groups[zid].sort((a, b) => b.start.localeCompare(a.start));
    const h0 = list[0];
    const total = list.reduce((s, e) => s + (Number(e.totalAgreed) || 0), 0);
    const block = el('div', 'hist-block');
    block.innerHTML = `<div class="hist-head">
      <span class="hist-code">${esc(h0.zoneCode || '—')}</span>
      <b>${esc(h0.zoneName)}</b>
      <span class="muted">${h0.floor ?? '?'} этаж · занятий: ${list.length} · сумма: ${fmtUsd(total)}</span>
    </div>`;
    block.insertAdjacentHTML('beforeend', list.map(e => historyEntryHtml(e, 'zones')).join(''));
    wrap.appendChild(block);
  }
  v.appendChild(wrap);
  wireHistoryRows(wrap);
}

function renderHistoryByTenants(v) {
  if (!State.history.length) { v.appendChild(el('div', 'empty', `<div class="em-icon">🏷️</div><h3>История пуста</h3><p>Появится при статусе «Занято».</p>`)); return; }
  const groups = {};
  for (const e of State.history) {
    const key = (e.brand || '—').trim().toLowerCase();
    (groups[key] = groups[key] || { name: (e.brand || '—').trim(), items: [] }).items.push(e);
  }
  const arr = Object.values(groups).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const wrap = el('div');
  for (const g of arr) {
    const list = g.items.sort((a, b) => b.start.localeCompare(a.start));
    const total = list.reduce((s, e) => s + (Number(e.totalAgreed) || 0), 0);
    const color = list[0].color || '#4f46e5';
    const block = el('div', 'hist-block');
    block.innerHTML = `<div class="hist-head">
      <span class="hist-code" style="background:${color};color:#fff;border:0">${esc(g.name.slice(0, 2).toUpperCase())}</span>
      <b>${esc(g.name)}</b>
      <span class="muted">занятий: ${list.length} · сумма по согласованной: ${fmtUsd(total)}</span>
    </div>`;
    block.insertAdjacentHTML('beforeend', list.map(e => historyEntryHtml(e, 'tenants')).join(''));
    wrap.appendChild(block);
  }
  v.appendChild(wrap);
  wireHistoryRows(wrap);
}

/* ═══════════════════════════════════════════════════════════════
   ДАШБОРД — ключевые показатели, динамика, загрузка по этажам
   ═══════════════════════════════════════════════════════════════ */
function overlapDays(p, a, b) { // дни пересечения размещения p с интервалом [a,b]
  const s = p.start > a ? p.start : a, e = p.end < b ? p.end : b;
  return s > e ? 0 : diffDaysIncl(s, e);
}
const MON_SHORT = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];

function renderDashboard(v) {
  const year = new Date().getFullYear();
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  const diy = diffDaysIncl(yStart, yEnd);
  const ps = State.placements;
  const real = new Set(['busy', 'done']);   // фактические бронирования (приносят деньги)

  // списки по категориям (в пределах года) + суммы
  const inYear = p => overlaps(p, yStart, yEnd);
  const byAmount = (a, b) => placementMoney(b).totalAgreed - placementMoney(a).totalAgreed;
  const doneList = ps.filter(p => p.status === 'done' && inYear(p)).sort(byAmount);
  const busyList = ps.filter(p => p.status === 'busy' && inYear(p)).sort(byAmount);
  const procList = ps.filter(p => p.status === 'process' && inYear(p)).sort(byAmount);
  const sumOf = list => list.reduce((s, p) => s + placementMoney(p).totalAgreed, 0);
  const doneSum = sumOf(doneList), busySum = sumOf(busyList), processSum = sumOf(procList);
  const itogo = doneSum + busySum;   // только реальные деньги (без Переговоров)
  const kpiList = list => list.length ? `<div class="kpi-list">${list.map(p => {
    const z = zoneById(p.zoneId);
    return `<div class="kpi-li"><span class="kpi-pair"><span class="kpi-zone">${esc(z ? z.name : '—')}</span> · <b>${esc(p.brand)}</b></span><span class="kpi-amt">${fmtUsd(placementMoney(p).totalAgreed)}</span></div>`;
  }).join('')}</div>` : '<div class="kpi-empty">— нет —</div>';

  // состояние зон сейчас
  let cBusy = 0, cProc = 0, cFree = 0;
  for (const z of State.zones) { const st = zoneBooking(z).state; if (st === 'busy') cBusy++; else if (st === 'process') cProc++; else cFree++; }
  const totalZones = State.zones.length || 1;

  // динамика РЕАЛЬНОГО дохода по месяцам — только Подтверждено + Завершено (без Переговоров).
  const months = Array(12).fill(0);
  for (const p of ps) {
    if (!real.has(p.status)) continue;
    const m = placementMoney(p); const perDay = m.days ? m.totalAgreed / m.days : 0;
    for (let mo = 0; mo < 12; mo++) {
      const ms = `${year}-${String(mo + 1).padStart(2, '0')}-01`;
      const me = `${year}-${String(mo + 1).padStart(2, '0')}-${String(daysInMonth(year, mo)).padStart(2, '0')}`;
      months[mo] += overlapDays(p, ms, me) * perDay;
    }
  }
  const maxM = Math.max(1, ...months);
  const yearRevenue = months.reduce((a, b) => a + b, 0);

  // загрузка по этажам за год (занятость = Подтверждено + Завершено), с разбивкой по зонам
  const floors = FLOORS.map(f => f.floor).sort((a, b) => a - b);
  const floorLoad = floors.map(f => {
    const zs = State.zones.filter(z => z.floor === f);
    let occ = 0;
    const zoneList = zs.map(z => {
      let zo = 0;
      for (const p of ps) if (p.zoneId === z.id && real.has(p.status)) zo += overlapDays(p, yStart, yEnd);
      occ += zo;
      return { name: z.name, code: z.code, occ: zo, pct: Math.min(100, Math.round(zo / diy * 100)) };
    }).sort((a, b) => b.occ - a.occ);
    const cap = Math.max(1, zs.length * diy);
    return { f, zones: zs.length, occ, pct: Math.min(100, Math.round(occ / cap * 100)), zoneList };
  });
  const totalOcc = floorLoad.reduce((s, x) => s + x.occ, 0);
  const avgLoad = Math.round(totalOcc / Math.max(1, totalZones * diy) * 100);
  const tenants = new Set(ps.map(p => tenantKey(p.brand))).size;

  // заголовок
  const head = el('div', 'page-head');
  head.appendChild(el('h2', null, `Дашборд · ${year}`));
  v.appendChild(head);

  // KPI
  const kpis = el('div', 'dash-kpis');
  kpis.innerHTML = `
    <div class="kpi accent"><div class="kpi-ic">🏆</div><div class="kpi-val">${fmtUsd(itogo)}</div><div class="kpi-lbl">Итого накопительно</div></div>
    <div class="kpi slate"><div class="kpi-ic">💰</div><div class="kpi-val">${fmtUsd(doneSum)}</div><div class="kpi-lbl">Завершено · доход</div>${kpiList(doneList)}</div>
    <div class="kpi green"><div class="kpi-ic">✅</div><div class="kpi-val">${fmtUsd(busySum)}</div><div class="kpi-lbl">Подтверждено</div>${kpiList(busyList)}</div>
    <div class="kpi amber"><div class="kpi-ic">💬</div><div class="kpi-val">${fmtUsd(processSum)}</div><div class="kpi-lbl">Переговоры</div>${kpiList(procList)}</div>
    <div class="kpi"><div class="kpi-ic">📊</div><div class="kpi-val">${avgLoad}%</div><div class="kpi-lbl">Средняя загрузка</div></div>`;
  v.appendChild(kpis);

  // полоска счётчиков
  const strip = el('div', 'dash-strip');
  strip.innerHTML = `
    <span><b>${cBusy}</b> подтверждено</span><span class="sep"></span>
    <span><b>${cProc}</b> переговоры</span><span class="sep"></span>
    <span><b>${cFree}</b> свободно</span><span class="sep"></span>
    <span><b>${tenants}</b> арендаторов</span><span class="sep"></span>
    <span><b>${ps.length}</b> размещений</span>`;
  v.appendChild(strip);

  // сетка панелей
  const grid = el('div', 'dash-grid');

  // динамика по месяцам (значения прямо на столбцах)
  const short = (n) => { n = Math.round(n); if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'млн'; if (n >= 1e3) return Math.round(n / 1e3) + 'к'; return n ? '' + n : ''; };
  const chart = el('div', 'panel');
  chart.innerHTML = `<div class="panel-title">Динамика реального дохода по месяцам <span class="muted" style="font-weight:400;font-size:12.5px">· подтверждено + завершено</span></div>
    <div class="chart">${months.map((val, i) => {
      const h = Math.round(val / maxM * 100);
      return `<div class="chart-col" title="${MONTHS[i]}: ${fmtUsd(Math.round(val))}">
        <div class="chart-bar-wrap">${val > 0 ? `<div class="chart-bar-val">${short(val)}</div>` : ''}<div class="chart-bar" style="height:${h}%"></div></div>
        <div class="chart-x">${MON_SHORT[i]}</div></div>`;
    }).join('')}</div>
    <div class="panel-foot">Реальный доход за год: <b>${fmtUsd(Math.round(yearRevenue))}</b></div>`;
  grid.appendChild(chart);

  // статус зон (пончик)
  const pB = Math.round(cBusy / totalZones * 100), pP = Math.round(cProc / totalZones * 100);
  const donut = el('div', 'panel');
  donut.innerHTML = `<div class="panel-title">Статус зон сейчас</div>
    <div class="donut-wrap">
      <div class="donut" style="background:conic-gradient(#10b981 0 ${pB}%,#f59e0b 0 ${pB + pP}%,#ef4444 0 100%)">
        <div class="donut-hole"><div class="donut-num">${totalZones}</div><div class="donut-cap">зон</div></div>
      </div>
      <div class="donut-legend">
        <div><i style="background:#10b981"></i> Подтверждено <b>${cBusy}</b></div>
        <div><i style="background:#f59e0b"></i> Переговоры <b>${cProc}</b></div>
        <div><i style="background:#ef4444"></i> Свободно <b>${cFree}</b></div>
      </div>
    </div>`;
  grid.appendChild(donut);

  // загрузка по этажам: % = занятые дни накопительно / (дни в году × число зон), с раскрытием по зонам
  const loadColor = pct => pct >= 70 ? '#10b981' : pct >= 40 ? '#f59e0b' : '#ef4444';
  const fl = el('div', 'panel span-all');
  fl.innerHTML = `<div class="panel-title fl-head">
      <span>Загрузка зон по этажам <span class="muted" style="font-weight:400;font-size:12.5px">· занятых дней из ${fmtNum(diy)} в году на зону</span></span>
      <span class="fl-head-btns"><button class="btn btn-sm" id="flShow">Показать зоны</button><button class="btn btn-sm" id="flHide">Скрыть</button></span>
    </div>
    <div class="floorload">${floorLoad.map(x => {
      const lbl = FLOORS.find(f => f.floor === x.f)?.label || `${x.f} этаж`;
      const cap = x.zones * diy;
      const zonesHtml = x.zoneList.map(z => `<div class="fl-row fl-zone-row" title="Занято ${fmtNum(z.occ)} из ${fmtNum(diy)} дн.">
        <div class="fl-name">${esc((z.code ? z.code + ' · ' : '') + z.name)}</div>
        <div class="fl-track"><div class="fl-fill" style="width:${z.pct}%;background:${loadColor(z.pct)}"></div></div>
        <div class="fl-pct">${z.pct}%</div>
        <div class="fl-days">занято <b>${fmtNum(z.occ)}</b> дн.</div></div>`).join('');
      return `<div class="fl-group">
        <div class="fl-row fl-floor-row" data-f="${x.f}" title="Нажмите, чтобы раскрыть зоны. Занято ${fmtNum(x.occ)} зоно-дней из ${fmtNum(cap)} (${x.zones} зон × ${diy} дн.)">
          <div class="fl-name"><span class="fl-toggle">▸</span>${esc(lbl)}</div>
          <div class="fl-track"><div class="fl-fill" style="width:${x.pct}%;background:${loadColor(x.pct)}"></div></div>
          <div class="fl-pct">${x.pct}%</div>
          <div class="fl-days">занято <b>${fmtNum(x.occ)}</b> дн.</div></div>
        <div class="fl-zones" data-f="${x.f}" hidden>${zonesHtml || '<div class="fl-empty">Нет зон</div>'}</div>
      </div>`;
    }).join('')}</div>`;
  const setAll = (show) => {
    fl.querySelectorAll('.fl-zones').forEach(z => z.hidden = !show);
    fl.querySelectorAll('.fl-floor-row').forEach(row => { const a = row.querySelector('.fl-toggle'); if (a) a.textContent = show ? '▾' : '▸'; row.classList.toggle('open', show); });
  };
  fl.querySelector('#flShow').onclick = () => setAll(true);
  fl.querySelector('#flHide').onclick = () => setAll(false);
  grid.appendChild(fl);

  v.appendChild(grid);
}

/* ═══════════════════════════════════════════════════════════════
   БЭКАП (экспорт / импорт)
   ═══════════════════════════════════════════════════════════════ */
function blobToB64(blob) {
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}
function b64ToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(','); const mime = (meta.match(/:(.*?);/)||[])[1] || '';
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function openBackup() {
  openModal(`
    <div class="modal-head"><h3>Сохранение и перенос данных</h3><button class="modal-close" data-close>×</button></div>
    <div class="modal-body">
      <p class="muted">Все данные хранятся внутри приложения на этом компьютере. Чтобы сделать резервную копию или перенести их на другой компьютер — выгрузите один файл и загрузите его там.</p>
      <div class="section-title">Резервная копия</div>
      <button class="btn btn-primary" id="exportBtn">⤓ Скачать копию (.json)</button>
      <div class="section-title">Восстановление / перенос</div>
      <p class="muted" style="margin-top:0">Загрузка заменит текущие данные данными из файла.</p>
      <div class="attach-zone" id="importBtn">📂 Выбрать файл копии для загрузки</div>
      <input type="file" id="importFile" accept="application/json,.json" style="display:none">
      <div class="section-title">Валюта в отчётах</div>
      <div class="field" style="max-width:200px"><input id="curInput" value="${esc(State.currency)}"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Закрыть</button>
      <button class="btn btn-primary" id="saveCur">Сохранить валюту</button>
    </div>`);

  $('#exportBtn').onclick = exportData;
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); };
  $('#saveCur').onclick = async () => {
    State.currency = $('#curInput').value.trim() || 'сум';
    await dbPut('meta', { key: 'currency', value: State.currency });
    toast('Валюта сохранена', 'ok'); closeModal();
  };
}

async function exportData() {
  toast('Готовлю копию…');
  const zones = await dbGetAll('zones');
  const placements = await dbGetAll('placements');
  const history = await dbGetAll('history');
  const labels = await dbGetAll('labels');
  const actsRaw = await dbGetAll('activities');
  const activities = [];
  for (const a of actsRaw) activities.push({ ...a, blob: undefined, data: a.blob ? await blobToB64(a.blob) : null });
  const filesRaw = await dbGetAll('files');
  const files = [];
  for (const f of filesRaw) files.push({ id:f.id, placementId:f.placementId, kind:f.kind, name:f.name, type:f.type, data: await blobToB64(f.blob) });
  const dump = { app:'popup', version:4, exportedAt:new Date().toISOString(), currency:State.currency, zones, placements, history, labels, activities, files };
  const blob = new Blob([JSON.stringify(dump)], { type:'application/json' });
  const a = el('a'); a.href = URL.createObjectURL(blob);
  a.download = `popup-backup-${todayStr()}.json`;
  a.click();
  toast('Копия скачана', 'ok');
}

async function importData(file) {
  if (!confirm('Загрузка заменит все текущие данные. Продолжить?')) return;
  try {
    const text = await file.text();
    const dump = JSON.parse(text);
    if (dump.app !== 'popup') throw new Error('Не файл Pop-Up');
    // очистка
    for (const s of ['zones','placements','history','labels','activities','files','meta']) {
      const all = await dbGetAll(s);
      for (const r of all) await dbDel(s, r[s==='meta'?'key':'id']);
    }
    for (const z of dump.zones||[]) await dbPut('zones', z);
    for (const p of dump.placements||[]) await dbPut('placements', p);
    for (const h of dump.history||[]) await dbPut('history', h);
    for (const l of dump.labels||[]) await dbPut('labels', l);
    for (const a of dump.activities||[]) { const { data, ...rest } = a; await dbPut('activities', { ...rest, blob: data ? b64ToBlob(data) : null }); }
    for (const f of dump.files||[]) await dbPut('files', { id:f.id, placementId:f.placementId, kind:f.kind, name:f.name, type:f.type, blob:b64ToBlob(f.data) });
    if (dump.currency) await dbPut('meta', { key:'currency', value:dump.currency });
    await loadAll();
    closeModal();
    toast('Данные загружены', 'ok');
    go('home');
  } catch (err) {
    toast('Ошибка загрузки: ' + err.message, 'err');
  }
}

/* ═══════════════════════════════════════════════════════════════
   СТАРТ
   ═══════════════════════════════════════════════════════════════ */
$('#brandBtn').onclick = () => go('home');
$('#backupBtn').onclick = openBackup;

(async function init() {
  // подстраховка: если запуск завис (заблокированная база) — показать подсказку
  let started = false;
  setTimeout(() => {
    if (started) return;
    const v = document.getElementById('view');
    if (v && !v.innerHTML.trim()) v.innerHTML = `<div class="empty"><div class="em-icon">⏳</div>
      <h3>Запуск занимает дольше обычного</h3>
      <p>Если приложение открыто в другой вкладке — закройте её и обновите страницу (F5).</p></div>`;
  }, 2500);
  try {
    _db = await openDB();
    await syncZones();
    await migrateStatuses();
    await loadAll();           // зоны нужны для расчёта истории
    await backfillHistory();   // записать в журнал «Занято»
    await autoCompletePast();  // истёкшие «Занято» → «Завершено»
    await loadAll();           // подхватить изменения
    started = true;
    renderNav();
    go('home');
  } catch (err) {
    started = true;
    document.getElementById('view').innerHTML =
      `<div class="empty"><div class="em-icon">⚠️</div><h3>Не удалось запустить базу данных</h3><p>${esc(err.message)}</p>
      <p class="muted">Откройте файл в Chrome или Edge. Если открыто в нескольких вкладках — оставьте одну и обновите.</p></div>`;
  }
})();
