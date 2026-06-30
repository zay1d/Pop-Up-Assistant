// ─────────────────────────────────────────────────────────────
//  Pop-Up · справочные данные (зоны, статусы, палитра)
//  Этот файл — только начальные значения. После первого запуска
//  всё хранится в базе внутри приложения (IndexedDB) и редактируется.
// ─────────────────────────────────────────────────────────────

// Список зон из «Список локаций.xlsx» (орфография исправлена).
// floor — этаж; план этажа берётся из папки plans (L1/L2/L3.png).
// dayRate — фиксированная стоимость зоны за один день ($), из файла «Список локаций».
const SEED_ZONES = [
  { id: 'z01', name: 'Центральный атриум',              floor: 1,  code: 'L1.01', dayRate: 20000 },
  { id: 'z02', name: 'Атриум Будущее (-1)',             floor: -1, code: 'B1.01', dayRate: 6000  },
  { id: 'z03', name: 'Вход из парка',                   floor: 1,  code: 'L1.02', dayRate: 6000  },
  { id: 'z04', name: 'Зона iSpace',                     floor: 1,  code: 'L1.03', dayRate: 266.7 },
  { id: 'z05', name: 'Зона Letoile',                    floor: 1,  code: 'L1.04', dayRate: 6000  },
  { id: 'z06', name: 'Атриум Наследие',                 floor: 1,  code: 'L1.05', dayRate: 10000 },
  { id: 'z07', name: 'Зона Galmart',                    floor: 1,  code: 'L1.06', dayRate: 1000  },
  { id: 'z08', name: 'Зона BYD',                        floor: 1,  code: 'L1.07', dayRate: 500   },
  { id: 'z09', name: 'Зона MADO островок',              floor: 1,  code: 'L1.08', dayRate: 500   },
  { id: 'z10', name: 'Зона за островок PAUL',           floor: 1,  code: 'L1.09', dayRate: 500   },
  { id: 'z11', name: 'Атриум Будущее',                  floor: 1,  code: 'L1.10', dayRate: 6000  },
  { id: 'z12', name: 'Центральный атриум (LUIJO)',       floor: 1,  code: 'L1.11', dayRate: 400   },
  { id: 'z20', name: 'Центральный атриум (premium line)',floor: 1,  code: 'L1.12', dayRate: 166.7 },
  { id: 'z13', name: 'Вход с Б.Закирова',               floor: 2,  code: 'L2.01', dayRate: 6000  },
  { id: 'z14', name: 'Зона Boss',                       floor: 2,  code: 'L2.02', dayRate: 3000  },
  { id: 'z15', name: 'Зона Zara',                       floor: 2,  code: 'L2.03', dayRate: 8000  },
  { id: 'z16', name: 'Зона Zara Men',                   floor: 2,  code: 'L2.04', dayRate: 2000  },
  { id: 'z17', name: 'Зона Bershka',                    floor: 2,  code: 'L2.05', dayRate: 4000  },
  { id: 'z18', name: 'Зона Ribambelle',                 floor: 3,  code: 'L3.01', dayRate: 6000  },
  { id: 'z21', name: 'Зона Name it',                    floor: 3,  code: 'L3.02', dayRate: 200   },
  { id: 'z19', name: 'Терраса зона BeFit',              floor: 4,  code: 'L4.01', dayRate: 20000 },
  { id: 'z22', name: 'Терраса зона Dipndip',            floor: 4,  code: 'L4.02', dayRate: 20000 },
];

// Этажи и привязанные планы (файлы в папке plans/).
// Для 4 этажа (Терраса) плана пока нет — добавим, когда будет.
const FLOORS = [
  { floor: -1, label: '−1 этаж', plan: 'plans/-1.png' },
  { floor: 1, label: '1 этаж', plan: 'plans/1.png' },
  { floor: 2, label: '2 этаж', plan: 'plans/2.png' },
  { floor: 3, label: '3 этаж', plan: 'plans/3.png' },
  { floor: 4, label: '4 этаж · Терраса', plan: 'plans/4.png' },
];

// Статусы. free/process/busy задают цвет на карте; done («Завершено») ставится
// автоматически, когда срок брони истёк (в расчёте цвета зоны не участвует).
// Статусы договора (для выбора в форме). На карте/бронировании цвет берётся отсюда:
// process(Переговоры)=жёлтый, busy(Подтверждено)=зелёный. rejected/done зону не занимают.
// «Свободно» — это отсутствие брони (красный), отдельным статусом не выбирается.
const CONTRACT_STATUSES = [
  { key: 'process',  label: 'Переговоры',   color: '#f59e0b' },
  { key: 'busy',     label: 'Подтверждено', color: '#10b981' },
  { key: 'rejected', label: 'Отказано',     color: '#ef4444' },
  { key: 'done',     label: 'Завершено',    color: '#64748b' },
];

// Палитра для цветных полос размещений (приятные, различимые цвета).
const COLOR_PALETTE = [
  '#e11d48', '#db2777', '#9333ea', '#7c3aed', '#4f46e5',
  '#2563eb', '#0891b2', '#0d9488', '#16a34a', '#65a30d',
  '#ca8a04', '#ea580c', '#dc2626', '#be123c', '#a21caf',
];
