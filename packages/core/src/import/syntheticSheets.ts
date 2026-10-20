// Синтетический генератор таблиц операторов по описанию tests/fixtures/import/README.md.
// Реальных значений нет и быть не может: названия, ФИО и адреса собираются из слогов, номера — только
// +7 709 …, +7 712 … и служебные +7 770/774/799 для проверки префиксов. Генератор детерминирован
// (seed), доли и дефекты берутся из README; в `meta` перечислены номера строк с внесёнными дефектами,
// чтобы тесты проверяли «нашли ровно то, что внесли». Это инструмент тестов, а не код продукта.
//
// Структура файла: строка 1 — баннер выгрузки, строка 2 — заголовки, данные с 3-й. Колонок
// «оператор», «ID», «БИН», «дата звонка», «попытка» нет: владелец задаётся диапазоном строк.

import type { OperatorSlot } from './types';

export const SYNTHETIC_HEADERS = [
  'Тип', 'Наименование', 'Регион', 'Руководитель', 'ОКЭД', 'Телефон', 'Адрес',
  'ЛПР подтвержден', 'Ответ', 'Статус', 'Точная ниша', 'Заметка',
] as const;

export const SYNTHETIC_ANSWERS = [
  'Отключен/Не берет', 'Перезвонить', 'Недоступен', 'Закрылся', 'Не интересует', 'Полный отказ', 'Подтвержден', 'Не имеет отношение',
] as const;

export interface SyntheticMeta {
  /** Номера строк таблицы (как в файле). */
  stubPhoneRows: number[];
  badLengthRows: number[];
  twoPhonesRows: number[];
  emptyPhoneRows: number[];
  reviewPrefixRows: number[];
  wrongPrefixRows: number[];
  sole: { ip: number[]; ipWithoutForm: number[] };
  /** Группы строк с общим номером у разных компаний. */
  sharedPhoneGroups: number[][];
  /** Пары строк с одинаковым названием. */
  sameNamePairs: [number, number][];
  contradictionRows: number[];
  multiAnswerRows: number[];
  lineBreakNoteRows: number[];
  sensitiveNoteRows: number[];
  dncNoteRows: number[];
  dateNoteRows: number[];
  junkStatusRows: number[];
  confirmedRows: number[];
  /** Из «Подтвержден» — те, у кого есть запись в таблице записей. */
  bookedRows: number[];
  /** Строки, которые в листе «Обработанные» отличаются от основной. */
  processedChangedRows: number[];
  /** Для листа «Обработанные»: номер строки основной → номер строки в копии. */
  processedMap: Record<number, number>;
}

export interface SyntheticSheets {
  main: string[][];
  processed: string[][];
  bookings: string[][];
  slots: OperatorSlot[];
  /** Ярлык слота → id учётки (синтетические). Слоты, перекрывающиеся диапазонами, указывают на разных людей. */
  ownerMap: Record<string, string>;
  /** Строки основной таблицы, попавшие в два слота с разными учётками. */
  overlapRows: number[];
  meta: SyntheticMeta;
}

export interface SyntheticOptions {
  seed?: number;
  /** Строк данных в основной таблице (в оригинале ≈ 2 200). */
  rows?: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYL = ['ра', 'те', 'кс', 'бел', 'мор', 'сан', 'лов', 'дик', 'ту', 'ми', 'гар', 'но', 'пол', 'вар', 'кен', 'зи', 'ор', 'шан', 'ли', 'дор', 'ве', 'ста', 'кум', 'аль', 'бер', 'фи', 'мун', 'тал'];
const COLORS = ['Синий', 'Зелёный', 'Жёлтый', 'Красный', 'Серый', 'Оранжевый', 'Фиолетовый', 'Бирюзовый', 'Белый', 'Чёрный', 'Розовый', 'Коричневый'];
const NICHES = ['Ниша-А', 'Ниша-Б', 'Ниша-В', 'Ниша-Г', 'Ниша-Д'];
const LABEL_NICHES = ['нет WhatsApp', 'нет whatsapp', 'не найдена', '-', 'Не берет', 'Перезвонить'];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function generateSyntheticSheets(opts: SyntheticOptions = {}): SyntheticSheets {
  const N = opts.rows ?? 2200;
  const rnd = mulberry32(opts.seed ?? 1);
  const chance = (p: number) => rnd() < p;
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T,>(a: readonly T[]): T => a[int(a.length)] as T;
  const scale = (n: number) => Math.max(1, Math.round((n * N) / 2200));
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const word = (min = 2, max = 3) => cap(Array.from({ length: min + int(max - min + 1) }, () => pick(SYL)).join(''));
  const digits = (n: number) => Array.from({ length: n }, () => int(10)).join('');

  const usedNames = new Set<string>();
  const uniqueBase = () => {
    for (;;) {
      const b = chance(0.5) ? `${word()} ${word()}` : word(3, 4);
      if (!usedNames.has(b)) {
        usedNames.add(b);
        return b;
      }
    }
  };
  const person = () => `${word()}${pick(['ов', 'ев', 'ин', 'ко'])} ${word(2, 2)} ${word(2, 2)}${pick(['вич', 'вна', 'улы'])}`;
  const fmtPhone = (d: string) => `+7 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8, 10)}`;
  const mobile = () => fmtPhone(`709${digits(7)}`);
  const landline = () => fmtPhone(`712${digits(7)}`);

  type R = string[];
  const body: R[] = [];
  const meta: SyntheticMeta = {
    stubPhoneRows: [], badLengthRows: [], twoPhonesRows: [], emptyPhoneRows: [], reviewPrefixRows: [], wrongPrefixRows: [],
    sole: { ip: [], ipWithoutForm: [] }, sharedPhoneGroups: [], sameNamePairs: [], contradictionRows: [], multiAnswerRows: [],
    lineBreakNoteRows: [], sensitiveNoteRows: [], dncNoteRows: [], dateNoteRows: [], junkStatusRows: [], confirmedRows: [],
    bookedRows: [], processedChangedRows: [], processedMap: {},
  };
  const rowNo = (i: number) => i + 3; // 1 — баннер, 2 — заголовки

  const cities = Array.from({ length: 7 }, (_, i) => `Город-${String.fromCharCode(1040 + i)}`);
  const heads: string[] = [];
  for (let i = 0; i < N; i++) {
    const isIp = chance(0.17);
    const base = uniqueBase();
    const head = heads.length > 30 && chance(0.012) ? pick(heads) : person();
    heads.push(head);
    let name: string;
    if (isIp) {
      const bare = chance(0.03);
      name = bare ? head.split(' ').slice(0, 2).join(' ') : `ИП ${head.split(' ').slice(0, 2).join(' ')}`;
      meta.sole.ip.push(rowNo(i));
      if (bare) meta.sole.ipWithoutForm.push(rowNo(i));
    } else {
      const r = rnd();
      name = r < 0.66 ? `Товарищество с ограниченной ответственностью «${base}»` : r < 0.9 ? `ТОО «${base}»` : base;
    }
    const city = pick(cities);
    const region = `${chance(0.5) ? 'г.' : 'г. '}${city}${chance(0.65) ? `, район "${word(2, 2)}"` : ''}`;
    const addrCity = chance(0.086) ? pick(cities.filter((c) => c !== city)) : city;
    const oked = chance(0.06) ? 'Нет данных' : chance(0.0855) ? '' : `${digits(5)} Вид деятельности ${int(300)}`;
    body.push([
      isIp ? 'ИП' : 'ТОО', name, region, head, oked, mobile(), `ул. Улица-${int(90)}, д. ${1 + int(120)}, г.${addrCity}`,
      '', '', '', '', '',
    ]);
  }
  const rowsIdx = Array.from({ length: N }, (_, i) => i);
  const sample = (k: number, from: number[] = rowsIdx): number[] => {
    const pool = [...from];
    const out: number[] = [];
    while (out.length < k && pool.length) out.push(pool.splice(int(pool.length), 1)[0] as number);
    return out.sort((a, b) => a - b);
  };
  const set = (i: number, col: number, v: string) => {
    (body[i] as R)[col] = v;
  };
  const C = { phone: 5, lpr: 7, answer: 8, status: 9, niche: 10, note: 11 } as const;

  // Телефоны: городские 18 %, дефекты.
  for (const i of sample(Math.round(N * 0.18))) set(i, C.phone, landline());
  const free = new Set(rowsIdx);
  const take = (k: number) => {
    const s = sample(k, [...free]);
    s.forEach((i) => free.delete(i));
    return s;
  };
  take(scale(11)).forEach((i) => set(i, C.phone, fmtPhone(`770${digits(7)}`))); // 0,5 %
  meta.reviewPrefixRows = rowsIdx.filter((i) => (body[i] as R)[C.phone]?.startsWith('+7 770')).map(rowNo);
  const wrong = take(scale(9));
  wrong.forEach((i) => set(i, C.phone, fmtPhone(`799${digits(7)}`)));
  meta.wrongPrefixRows = wrong.map(rowNo);
  const stubs = ['+7 777 777 77 77', '+7 709 000 00 00', '+7 709 111 11 11', '+7 701 222 22 22', '+7 702 333 33 33', '+7 705 555 55 55', '+7 700 000 00 00'];
  take(7).forEach((i, k) => {
    set(i, C.phone, stubs[k % stubs.length] as string);
    meta.stubPhoneRows.push(rowNo(i));
  });
  take(4).forEach((i, k) => {
    set(i, C.phone, k % 2 ? `+7 709 ${digits(3)} ${digits(2)}` : `+7 709 ${digits(3)} ${digits(2)} ${digits(3)}`);
    meta.badLengthRows.push(rowNo(i));
  });
  take(1).forEach((i) => {
    set(i, C.phone, `${mobile()}, ${mobile()}`);
    meta.twoPhonesRows.push(rowNo(i));
  });
  take(1).forEach((i) => {
    set(i, C.phone, '');
    meta.emptyPhoneRows.push(rowNo(i));
  });

  // Общие номера у разных компаний: 44 пары и 1 тройка (в 16 группах итоги разные).
  const groupsN = scale(45);
  const touchable = [...free];
  for (let g = 0; g < groupsN; g++) {
    const size = g === 0 ? 3 : 2;
    const members = sample(size, touchable.filter((i) => !body[i]?.[C.phone]?.includes(',')));
    members.forEach((i) => touchable.splice(touchable.indexOf(i), 1));
    const shared = mobile();
    members.forEach((i) => set(i, C.phone, shared));
    meta.sharedPhoneGroups.push(members.map(rowNo));
  }
  // Одинаковые названия (9 пар): разные телефоны и руководители.
  for (let k = 0; k < scale(9); k++) {
    const [a, b] = sample(2, touchable.filter((i) => (body[i] as R)[0] === 'ТОО'));
    if (a === undefined || b === undefined) break;
    set(b, 1, (body[a] as R)[1] as string);
    touchable.splice(touchable.indexOf(a), 1);
    touchable.splice(touchable.indexOf(b), 1);
    meta.sameNamePairs.push([rowNo(a), rowNo(b)]);
  }
  // Цифры в ФИО руководителя — одна строка.
  take(1).forEach((i) => set(i, 3, `${(body[i] as R)[3]}2`));

  // ЛПР: Да 16 %, Нет 17 %.
  for (const i of sample(Math.round(N * 0.16))) set(i, C.lpr, 'Да');
  for (const i of sample(Math.round(N * 0.17), rowsIdx.filter((j) => !(body[j] as R)[C.lpr]))) set(i, C.lpr, 'Нет');

  // Ответ: 49 % заполнено; одно значение 81 %, два 17 %, три 2 %.
  const answered = sample(Math.round(N * 0.49));
  for (const i of answered) {
    const r = rnd();
    const count = r < 0.81 ? 1 : r < 0.98 ? 2 : 3;
    let vals: string[];
    if (count === 2 && chance(0.4)) vals = ['Отключен/Не берет', 'Перезвонить'];
    else {
      vals = [];
      while (vals.length < count) {
        const v = pick(SYNTHETIC_ANSWERS);
        if (!vals.includes(v)) vals.push(v);
      }
    }
    if (chance(0.5)) vals.reverse(); // порядок случайный
    set(i, C.answer, vals.join(', '));
  }

  // Общие номера: в 16 из 45 групп итоги разные.
  meta.sharedPhoneGroups.slice(0, scale(16)).forEach((g, k) => {
    const [a, b] = g;
    if (a === undefined || b === undefined) return;
    set(a - 3, C.answer, 'Перезвонить');
    set(b - 3, C.answer, k % 2 ? 'Не интересует' : 'Отключен/Не берет');
  });
  const groupRows = new Set(meta.sharedPhoneGroups.flat().map((r) => r - 3));

  // Статус: «Не целевой» 10 %, «Целевой» 5 %, одно мусорное значение.
  for (const i of sample(Math.round(N * 0.1))) set(i, C.status, 'Не целевой');
  for (const i of sample(Math.round(N * 0.05), rowsIdx.filter((j) => !(body[j] as R)[C.status]))) set(i, C.status, 'Целевой');
  take(1).forEach((i) => {
    set(i, C.status, 'не знаю');
    meta.junkStatusRows.push(rowNo(i));
  });

  // Случайные противоречия убираем: в таблице их 2,6 %, и они внесены ниже намеренно.
  for (const i of rowsIdx) {
    const st = (body[i] as R)[C.status];
    const labels = ((body[i] as R)[C.answer] ?? '').split(',').map((v) => v.trim());
    const bad = ['Закрылся', 'Полный отказ', 'Недоступен', 'Не имеет отношение'];
    if ((st === 'Целевой' && labels.some((l) => bad.includes(l))) || (st === 'Не целевой' && labels.includes('Подтвержден'))) {
      set(i, C.status, '');
    }
  }
  const answeredNow = rowsIdx.filter((i) => (body[i] as R)[C.answer] && !groupRows.has(i));
  sample(scale(57), answeredNow).forEach((i, k) => {
    if (k % 2) {
      set(i, C.status, 'Целевой');
      set(i, C.answer, pick(['Закрылся', 'Полный отказ']));
    } else {
      set(i, C.status, 'Не целевой');
      set(i, C.answer, 'Подтвержден');
    }
    meta.contradictionRows.push(rowNo(i));
  });
  meta.contradictionRows.sort((a, b) => a - b);
  meta.multiAnswerRows = rowsIdx.filter((i) => ((body[i] as R)[C.answer] ?? '').includes(',')).map(rowNo);

  // Ниша: 5,6 %, из них 75 % — метки.
  for (const i of sample(Math.round(N * 0.056))) set(i, C.niche, chance(0.75) ? pick(LABEL_NICHES) : pick(NICHES));

  // Заметки: 35 %.
  const noted = sample(Math.round(N * 0.35));
  for (const i of noted) set(i, C.note, `Заметка ${int(1000)}`);
  const lines = sample(2, noted);
  lines.forEach((i) => {
    set(i, C.note, 'первая строка\nвторая строка');
    meta.lineBreakNoteRows.push(rowNo(i));
  });
  const rest = noted.filter((i) => !lines.includes(i));
  const per = scale(5);
  const targets: [string, number[]][] = [
    ['набрать 14.10', meta.dateNoteRows],
    ['просили удалить, не звонить', meta.dncNoteRows],
    ['[личное]', meta.sensitiveNoteRows],
  ];
  targets.forEach(([text, bucket], k) => {
    for (const i of rest.slice(k * per, (k + 1) * per)) {
      set(i, C.note, text);
      bucket.push(rowNo(i));
    }
  });
  // Пробелы по краям: ≈ 2,5 % заметок.
  for (const i of sample(Math.max(1, Math.round(noted.length * 0.025)), rest.slice(targets.length * per))) {
    set(i, C.note, `  ${(body[i] as R)[C.note]} `);
  }

  meta.confirmedRows = rowsIdx.filter((i) => (body[i] as R)[C.answer]?.split(',').some((v) => v.trim() === 'Подтвержден')).map(rowNo);
  meta.bookedRows = meta.confirmedRows.filter((_, k) => k % 3 !== 2);

  // Операторы: по 200 строк на слот; один диапазон в 100 строк закреплён за двумя слотами.
  const slotCount = Math.max(2, Math.ceil(N / 200));
  const slots: OperatorSlot[] = Array.from({ length: slotCount }, (_, s) => {
    const from = 3 + s * 200;
    const to = Math.min(2 + (s + 1) * 200, N + 2);
    const color = COLORS[s % COLORS.length] as string;
    return { label: `Оператор-${pad(s + 1)} (${color})`, name: `Оператор-${pad(s + 1)}`, color, ranges: [[from, to]] };
  });
  const second = slots[1] as OperatorSlot;
  const firstRange = (slots[0] as OperatorSlot).ranges[0] as [number, number];
  const overlapFrom = firstRange[1] - 99;
  second.ranges.push([overlapFrom, firstRange[1]]);
  const overlapRows = Array.from({ length: 100 }, (_, k) => overlapFrom + k).filter((r) => r <= N + 2);
  const ownerMap = Object.fromEntries(slots.map((s, k) => [s.label, `u-op-${pad(k + 1)}`]));

  // Лист «Обработанные»: копия части строк; ≈ 10 % расходятся с основной (основная новее).
  const banner = (t: string): R[] => [[t], [...SYNTHETIC_HEADERS]];
  const copyIdx = sample(Math.round(N * (460 / 2200)));
  const changed = new Set(sample(Math.max(1, Math.round(copyIdx.length * 0.1)), copyIdx));
  const processedBody = copyIdx.map((i, k) => {
    const row = [...(body[i] as R)];
    meta.processedMap[rowNo(i)] = k + 3;
    if (changed.has(i)) {
      const cur = row[C.answer] ?? '';
      row[C.answer] = cur === 'Перезвонить' ? 'Не интересует' : 'Перезвонить';
      meta.processedChangedRows.push(rowNo(i));
    }
    return row;
  });

  const bookingRows = meta.bookedRows.map((r, k) => {
    const row = body[r - 3] as R;
    const phone = row[C.phone]?.split(',')[0]?.trim() ?? '';
    return [row[1] as string, phone, `2026-11-${pad(1 + (k % 28))}`, `Оператор-${pad(1 + (k % slotCount))}`, 'Мероприятие-1'];
  });

  return {
    main: [...banner('Выгрузка: журнал первого касания (синтетические данные)'), ...body],
    processed: [...banner('Выгрузка: обработанные организации (синтетические данные)'), ...processedBody],
    // Структура таблицы записей не подтверждена (PLAN §9 В-5): колонки — предположение для тестов.
    bookings: [['Наименование', 'Телефон', 'Дата', 'Оператор', 'Мероприятие'], ...bookingRows],
    slots,
    ownerMap,
    overlapRows,
    meta,
  };
}
