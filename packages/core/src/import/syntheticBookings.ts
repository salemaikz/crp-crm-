// Синтетическая таблица записей и таблица клиентов к ней (профиль «Записи», D-324) по описанию
// tests/fixtures/import/README.md, раздел «Таблица записей». Реальных значений нет: названия собираются из
// номеров, телефоны — только +7 709 …, БИН — выдуманные. Подписи видов и дни передаёт тест: в ядре нет
// терминов клиента. В `meta` — номера строк с внесёнными дефектами (как в `syntheticSheets.ts`), чтобы тесты
// проверяли «нашли ровно то, что внесли». Инструмент тестов, не код продукта.

export const BOOKING_HEADERS = ['Наименование', 'Телефон', 'БИН', 'Дата', 'Время', 'Оператор', 'Мероприятие'] as const;
export const CLIENT_HEADERS = ['Тип', 'Наименование', 'Регион', 'Руководитель', 'ОКЭД', 'Телефон', 'Адрес', 'ЛПР подтвержден', 'Ответ', 'Статус', 'Точная ниша', 'Заметка'] as const;

export interface SyntheticBookingOptions {
  /** Обычных клиентов с записью на `days.ok` или `days.other` (по умолчанию 12). */
  clients?: number;
  /** Подписи видов в ячейке: групповой, индивидуальный, неизвестный. */
  labels: { group: string; individual: string; unknown: string };
  /** Дни 'YYYY-MM-DD': с мероприятием, с другим мероприятием того же вида, отменённое, без мероприятия, прошедшее, полное, с двумя мероприятиями. */
  days: { ok: string; other: string; cancelled: string; none: string; past: string; full: string; twoEvents: string };
  /** Мест на мероприятии `days.full`: строк на него будет на две больше. */
  fullCapacity: number;
  /** Время второго мероприятия на `days.twoEvents` (в строке оно указано). */
  secondTime?: string;
}

export interface SyntheticClient {
  name: string;
  legalForm: 'ТОО' | 'ИП';
  /** '+7 709 …' */
  phone: string;
  /** Ответ в таблице клиентов. */
  answer: 'Подтвержден' | 'Полный отказ';
}

export interface SyntheticBookingMeta {
  /** Номера строк таблицы записей (1 — заголовки). */
  notFoundRows: number[];
  sharedByNameRows: number[];
  sharedAmbiguousRows: number[];
  noEventRows: number[];
  cancelledRows: number[];
  pastRows: number[];
  duplicateRows: number[];
  conflictRows: number[];
  fullRows: number[];
  closedRows: number[];
  heldRows: number[];
  badDateRows: number[];
  badTimeRows: number[];
  unknownTypeRows: number[];
  individualRows: number[];
  noOperatorRows: number[];
  unknownOperatorRows: number[];
  withBinRows: number[];
  secondEventRows: number[];
}

export interface SyntheticBookings {
  /** Клиенты, которые должны существовать до загрузки записей. */
  clients: SyntheticClient[];
  /** Таблица клиентов (баннер, заголовки, данные) в формате профиля таблиц операторов. */
  clientsGrid: string[][];
  /** Таблица записей: заголовки и данные. */
  bookingsGrid: string[][];
  meta: SyntheticBookingMeta;
  /** Ярлыки операторов, которые есть в таблице. */
  operators: string[];
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const phoneOf = (n: number) => `+7 709 ${pad(Math.floor(n / 100) % 1000, 3)} ${pad(n % 100)} ${pad((n * 7) % 100)}`.replace(/\s+/g, ' ');
const binOf = (n: number) => `99054${pad(n, 7)}`;

/** Детерминированный набор без случайности: номера строк следуют из порядка секций. */
export function generateSyntheticBookings(opts: SyntheticBookingOptions): SyntheticBookings {
  const N = opts.clients ?? 12;
  const meta: SyntheticBookingMeta = {
    notFoundRows: [], sharedByNameRows: [], sharedAmbiguousRows: [], noEventRows: [], cancelledRows: [], pastRows: [], duplicateRows: [],
    conflictRows: [], fullRows: [], closedRows: [], heldRows: [], badDateRows: [], badTimeRows: [], unknownTypeRows: [], individualRows: [],
    noOperatorRows: [], unknownOperatorRows: [], withBinRows: [], secondEventRows: [],
  };
  const clients: SyntheticClient[] = [];
  const rows: string[][] = [];
  let seq = 0;
  const newClient = (name: string, over: Partial<SyntheticClient> = {}): SyntheticClient => {
    seq++;
    const c: SyntheticClient = { name, legalForm: 'ТОО', phone: phoneOf(seq), answer: 'Подтвержден', ...over };
    clients.push(c);
    return c;
  };
  const nameOf = (c: SyntheticClient) => (c.legalForm === 'ИП' ? `ИП ${c.name}` : `ТОО «${c.name}»`);
  const operators = Array.from({ length: 3 }, (_, i) => `Оператор-${pad(i + 1)}`);
  type Over = Partial<{ phone: string; bin: string; date: string; time: string; operator: string; type: string; name: string }>;
  const add = (c: SyntheticClient | null, over: Over = {}): number => {
    const k = rows.length;
    rows.push([
      over.name ?? (c ? nameOf(c) : ''),
      over.phone ?? c?.phone ?? '',
      over.bin ?? '',
      over.date ?? opts.days.ok,
      over.time ?? '',
      over.operator ?? (operators[k % operators.length] as string),
      over.type ?? opts.labels.group,
    ]);
    return k + 2; // 1 — заголовки
  };

  // Обычные: каждый клиент на одно мероприятие; у каждого третьего указан БИН.
  for (let i = 0; i < N; i++) {
    const c = newClient(`Клиент-${pad(i + 1)}`);
    const withBin = i % 3 === 2;
    const r = add(c, { date: i % 2 === 0 ? opts.days.ok : opts.days.other, ...(withBin ? { bin: binOf(seq) } : {}) });
    if (withBin) meta.withBinRows.push(r);
  }
  // 1. Клиента нет в таблице клиентов.
  meta.notFoundRows.push(add(null, { name: 'ТОО «Нет-Такого-01»', phone: '+7 709 990 00 01' }));
  // 2. Общий номер двух ТОО: название совпадает с одним — найден по номеру и названию; ни с одним — неоднозначно.
  const shared = phoneOf(500);
  const a = newClient('Общий-А', { phone: shared });
  newClient('Общий-Б', { phone: shared });
  meta.sharedByNameRows.push(add(a));
  meta.sharedAmbiguousRows.push(add(null, { name: 'ТОО «Общий-В»', phone: shared }));
  // 3. Даты без мероприятия, с отменённым и в прошлом.
  meta.noEventRows.push(add(newClient('Без-Мероприятия'), { date: opts.days.none }));
  meta.cancelledRows.push(add(newClient('Отменённое'), { date: opts.days.cancelled }));
  meta.pastRows.push(add(newClient('Прошедшее'), { date: opts.days.past }));
  // 4. Та же пара «клиент, мероприятие» дважды.
  const dup = newClient('Дубль');
  add(dup);
  meta.duplicateRows.push(add(dup));
  // 5. Две будущие записи одного клиента на разные даты одного вида.
  const conf = newClient('Конфликт');
  add(conf, { date: opts.days.ok });
  meta.conflictRows.push(add(conf, { date: opts.days.other }));
  // 6. Строки сверх вместимости одного мероприятия.
  for (let i = 0; i < opts.fullCapacity + 2; i++) {
    const r = add(newClient(`Полное-${pad(i + 1)}`), { date: opts.days.full });
    if (i >= opts.fullCapacity) meta.fullRows.push(r);
  }
  // 7. Полный отказ в таблице клиентов; ИП, задержанный до юриста.
  meta.closedRows.push(add(newClient('Отказ', { answer: 'Полный отказ' })));
  meta.heldRows.push(add(newClient('Предприниматель-Один', { legalForm: 'ИП' })));
  // Прочие дефекты ячеек.
  meta.badDateRows.push(add(newClient('Дата-Без-Года'), { date: '05.11' }));
  meta.badTimeRows.push(add(newClient('Время-Не-Время'), { time: '25:99' }));
  meta.unknownTypeRows.push(add(newClient('Вид-Неизвестен'), { type: opts.labels.unknown }));
  meta.individualRows.push(add(newClient('Индивидуальный'), { type: opts.labels.individual }));
  meta.noOperatorRows.push(add(newClient('Без-Оператора'), { operator: '' }));
  meta.unknownOperatorRows.push(add(newClient('Чужой-Оператор'), { operator: 'Посторонний-99' }));
  if (opts.secondTime) meta.secondEventRows.push(add(newClient('Второе-Время'), { date: opts.days.twoEvents, time: opts.secondTime }));

  const clientsGrid: string[][] = [
    ['Выгрузка: клиенты для таблицы записей (синтетические данные)'],
    [...CLIENT_HEADERS],
    ...clients.map((c) => [c.legalForm, nameOf(c), 'г. Город-А', '', '', c.phone, '', '', c.answer, '', '', '']),
  ];
  return { clients, clientsGrid, bookingsGrid: [[...BOOKING_HEADERS], ...rows], meta, operators };
}
