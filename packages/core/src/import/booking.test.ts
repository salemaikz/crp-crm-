// Профиль «Записи» ядра импорта (D-324): разбор, ключи, сопоставление клиента и автора, предпросмотр, отпечаток.
// Данные синтетические (+7 709 …), подписи видов — нейтральные.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AUTHOR_LABEL_MAX, authorDecision, clipAuthorLabel, matchBookingClient, suggestAuthor, type AuthorStaff } from './bookingMatch';
import { bookingPreviewFingerprint, canonicalJsonOf } from './bookingFingerprint';
import {
  buildBookingPreview,
  type BookingCandidate,
  type BookingEventInfo,
  type BookingPartnerCard,
  type BookingPreviewInput,
  type ClientBookingInfo,
} from './bookingPreview';
import { bookingImportKey, compileBookingProfile, parseBookingSheet, parseEventDate, parseEventTime, type BookingProfile, type ParsedBookingRow } from './bookingRows';
import { generateSyntheticBookings } from './syntheticBookings';
import { normalizers, testHash } from './testProfile';

const hmac = (s: string) => createHash('sha256').update(`k:${s}`).digest('hex').slice(0, 16);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const profile: BookingProfile = {
  key: 'bookings',
  columns: { Наименование: 'name', Телефон: 'phones', БИН: 'orgId', Дата: 'eventDate', Время: 'eventTime', Оператор: 'operator', Мероприятие: 'eventType' },
  eventTypeMap: { 'Группа-1': 'grp', 'Консультация-1': 'solo' },
  defaultEventTypeKey: 'grp',
};
const cp = compileBookingProfile(profile);
const HEAD = ['Наименование', 'Телефон', 'БИН', 'Дата', 'Время', 'Оператор', 'Мероприятие'];
const parse = (data: string[][], p = cp) => {
  const r = parseBookingSheet([HEAD, ...data], p, { normalizers, hash: testHash, hmac });
  assert.ok(r.ok);
  return r.ok ? r : (null as never);
};
const one = (row: string[]) => parse([row]).rows[0] as ParsedBookingRow;
const codes = (r: ParsedBookingRow) => r.issues.map((i) => i.code);

// ---------- разбор ----------

test('дата: все форматы; без года, текстом и несуществующая — null', () => {
  assert.equal(parseEventDate('2026-11-05'), '2026-11-05');
  assert.equal(parseEventDate('05.11.2026'), '2026-11-05');
  assert.equal(parseEventDate('5.11.2026'), '2026-11-05');
  assert.equal(parseEventDate('05.11.26'), '2026-11-05');
  assert.equal(parseEventDate('05/11/2026'), '2026-11-05');
  for (const bad of ['05.11', 'в четверг', '31.11.2026', '2026-02-30', '', '05-11-2026']) assert.equal(parseEventDate(bad), null, bad);
});

test('время: Ч:ММ и ЧЧ:ММ, иначе null', () => {
  assert.equal(parseEventTime('9:30'), '09:30');
  assert.equal(parseEventTime('15:00'), '15:00');
  assert.equal(parseEventTime('15:00:00'), '15:00');
  for (const bad of ['25:00', '12:60', 'утром', '1500']) assert.equal(parseEventTime(bad), null, bad);
});

test('XLSX-ячейки: время в формате времени (эпоха 1900 и 1904), дата со временем; день эпохи в колонке даты — не дата', () => {
  // так `serialToText` отдаёт ячейки со стилями h:mm и dd.mm.yyyy hh:mm (см. tests/unit/import/booking-xlsx-cells.test.ts)
  assert.equal(parseEventTime('1899-12-30 12:00'), '12:00');
  assert.equal(parseEventTime('1904-01-01 09:30'), '09:30');
  assert.equal(parseEventTime('1899-12-30'), '00:00', 'полночь — только день эпохи');
  assert.equal(parseEventTime('2026-11-10 18:00'), '18:00', 'дата со временем в колонке времени — берётся время');
  assert.equal(parseEventTime('2026-11-10'), null, 'дата без времени — не время');
  assert.equal(parseEventTime('2026-11-10 25:00'), null);
  assert.equal(parseEventDate('2026-11-10 12:00'), '2026-11-10');
  assert.equal(parseEventDate('1899-12-30 12:00'), null, 'время без даты в колонке даты');
  assert.equal(parseEventDate('2026-11-31 12:00'), null);
});

test('разбор: XLSX-строка — время ячейкой времени; без времени — время из ячейки «дата и время»; явное время важнее', () => {
  const timeCell = one(['ТОО «Альфа»', '+7 709 111 22 33', '', '2026-11-10', '1899-12-30 12:00', '', '']);
  assert.deepEqual([timeCell.eventDate, timeCell.eventTime, codes(timeCell)], ['2026-11-10', '12:00', []]);
  const dateTime = one(['ТОО «Альфа»', '+7 709 111 22 33', '', '2026-11-10 12:00', '', '', '']);
  assert.deepEqual([dateTime.eventDate, dateTime.eventTime, codes(dateTime)], ['2026-11-10', '12:00', []]);
  assert.equal(dateTime.rowKey, timeCell.rowKey, 'та же строка, как бы ни были разложены дата и время');
  const both = one(['ТОО «Альфа»', '+7 709 111 22 33', '', '2026-11-10 12:00', '18:00', '', '']);
  assert.equal(both.eventTime, '18:00');
  const noTimeColumn = parseBookingSheet(
    [['Наименование', 'Телефон', 'Дата'], ['ТОО «Альфа»', '+7 709 111 22 33', '2026-11-10 12:00']],
    cp,
    { normalizers, hash: testHash, hmac },
  );
  assert.ok(noTimeColumn.ok && noTimeColumn.rows[0]?.eventTime === '12:00', 'колонки времени нет — время из ячейки даты');
});

test('оператор: длинный ярлык обрезается до предела карты авторов, пробелы схлопнуты, суррогатная пара не рвётся', () => {
  const long = `Комментарий ${'очень '.repeat(80)}длинный`;
  const r = one(['ТОО «Альфа»', '+7 709 111 22 33', '', '05.11.2026', '', long, '']);
  assert.ok(r.authorLabel !== null && r.authorLabel.length <= AUTHOR_LABEL_MAX && r.authorLabel.startsWith('Комментарий очень'));
  assert.equal(clipAuthorLabel('  Оператор   01 '), 'Оператор 01');
  const emoji = `${'а'.repeat(AUTHOR_LABEL_MAX - 1)}😀`;
  const cut = clipAuthorLabel(emoji);
  assert.equal(cut, 'а'.repeat(AUTHOR_LABEL_MAX - 1));
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut));
});

test('разбор: нормальная строка, вид по карте и по умолчанию', () => {
  const r = one(['ТОО «Альфа-1»', '+7 709 111 22 33', '', '05.11.2026', '15:00', 'Оператор-01', 'Группа-1']);
  assert.equal(r.eventDate, '2026-11-05');
  assert.equal(r.eventTime, '15:00');
  assert.equal(r.eventTypeKey, 'grp');
  assert.deepEqual(r.workingPhones, ['77091112233']);
  assert.equal(r.authorLabel, 'Оператор-01');
  assert.deepEqual(r.issues, []);
  assert.equal(one(['ТОО «Альфа-2»', '+7 709 111 22 34', '', '05.11.2026', '', '', '']).eventTypeKey, 'grp', 'пустая ячейка — вид по умолчанию');
  assert.equal(one(['ТОО «Альфа-3»', '+7 709 111 22 35', '', '05.11.2026', '', '', 'группа-1']).eventTypeKey, 'grp', 'регистр не важен');
});

test('разбор: ошибки bad_date, bad_time, unknown_event_type, no_client_key', () => {
  assert.ok(codes(one(['ТОО «А»', '+7 709 111 22 33', '', '05.11', '', '', ''])).includes('bad_date'));
  assert.ok(codes(one(['ТОО «А»', '+7 709 111 22 33', '', '31.11.2026', '', '', ''])).includes('bad_date'));
  assert.ok(codes(one(['ТОО «А»', '+7 709 111 22 33', '', '05.11.2026', '25:99', '', ''])).includes('bad_time'));
  assert.ok(codes(one(['ТОО «А»', '+7 709 111 22 33', '', '05.11.2026', '', '', 'Что-то'])).includes('unknown_event_type'));
  assert.ok(codes(one(['ТОО «А»', '', '', '05.11.2026', '', '', ''])).includes('no_client_key'));
  const noDefault = compileBookingProfile({ ...profile, defaultEventTypeKey: undefined } as BookingProfile);
  assert.ok(codes(parse([['ТОО «А»', '+7 709 111 22 33', '', '05.11.2026', '', '', '']], noDefault).rows[0] as ParsedBookingRow).includes('unknown_event_type'));
});

test('разбор: ИП с 12 цифрами — только HMAC, у ТОО — открытый БИН; два номера в ячейке', () => {
  const ip = one(['ИП Иванов-Тест', '+7 709 111 22 33', '990101300123', '05.11.2026', '', '', '']);
  assert.equal(ip.orgIdPersonal, true);
  assert.equal(ip.orgId, `iin:${hmac('990101300123')}`);
  assert.ok(!JSON.stringify(ip).includes('990101300123'), 'сырых 12 цифр нет нигде в строке');
  const too = one(['ТОО «Альфа»', '+7 709 111 22 33', '990101300124', '05.11.2026', '', '', '']);
  assert.equal(too.orgIdPersonal, false);
  assert.equal(too.orgId, '990101300124');
  const two = one(['ТОО «Бета»', '+7 709 111 22 33, +7 709 111 22 44', '', '05.11.2026', '', '', '']);
  assert.deepEqual(two.workingPhones.sort(), ['77091112233', '77091112244']);
  assert.ok(codes(two).includes('many_phones'));
  // форма не определена — тоже скрыто, но «по неуверенности» (D-141)
  const bare = one(['Просто Название', '', '990101300125', '05.11.2026', '', '', '']);
  assert.equal(bare.orgIdUncertain, true);
  assert.ok(!JSON.stringify(bare).includes('990101300125'));
});

test('разбор: нет заголовков — header_not_found; баннер выше заголовков и пустые строки в хвосте', () => {
  const miss = parseBookingSheet([['Колонка', 'Другая']], cp, { normalizers, hash: testHash, hmac });
  assert.deepEqual(miss.ok, false);
  const withBanner = parseBookingSheet([['Выгрузка записей'], HEAD, ['ТОО «А»', '+7 709 111 22 33', '', '05.11.2026', '', '', ''], ['', '', '', '', '', '', '']], cp, { normalizers, hash: testHash, hmac });
  assert.ok(withBanner.ok);
  if (withBanner.ok) {
    assert.equal(withBanner.headerRow, 2);
    assert.equal(withBanner.rows.length, 1);
    assert.equal(withBanner.rows[0]?.rowNo, 3);
    assert.equal(withBanner.skippedBlank, 1);
  }
});

// ---------- ключи ----------

test('ключи: автор не меняет ключ строки и меняет ключ состояния; пробелы и регистр автора не меняют состояние', () => {
  const base = ['ТОО «Альфа»', '+7 709 111 22 33', '', '05.11.2026', '15:00', 'Оператор-01', 'Группа-1'];
  const a = one(base);
  const other = one([...base.slice(0, 5), 'Оператор-02', 'Группа-1']);
  const spaced = one([...base.slice(0, 5), '  оператор-01  ', 'Группа-1']);
  assert.equal(a.rowKey, other.rowKey);
  assert.notEqual(a.stateKey, other.stateKey);
  assert.equal(a.stateKey, spaced.stateKey);
  assert.equal(a.rowKey, spaced.rowKey);
  // другая дата, время и вид — другая строка
  assert.notEqual(a.rowKey, one([...base.slice(0, 3), '06.11.2026', '15:00', 'Оператор-01', 'Группа-1']).rowKey);
  assert.notEqual(a.rowKey, one([...base.slice(0, 4), '16:00', 'Оператор-01', 'Группа-1']).rowKey);
  assert.notEqual(a.rowKey, one([...base.slice(0, 6), 'Консультация-1']).rowKey);
});

test('bookingImportKey: разный для двух пространств, одинаковый для повтора', () => {
  const r = one(['ТОО «Альфа»', '+7 709 111 22 33', '', '05.11.2026', '', '', '']);
  assert.notEqual(bookingImportKey('space-a', r.rowKey, sha), bookingImportKey('space-b', r.rowKey, sha));
  assert.equal(bookingImportKey('space-a', r.rowKey, sha), bookingImportKey('space-a', r.rowKey, sha));
  assert.match(bookingImportKey('space-a', r.rowKey, sha), /^bk:[0-9a-f]{64}$/);
});

// ---------- сопоставление клиента ----------

const cand = (id: string, over: Partial<BookingCandidate> = {}): BookingCandidate => ({
  clientId: id,
  cardId: `card-${id}`,
  nameNorm: id,
  orgId: '',
  iinKey: null,
  phones: [],
  state: 'callback',
  ownerUserId: 'op-1',
  holdReason: '',
  touchedInCrm: false,
  ...over,
});
const keys = (over: Partial<Parameters<typeof matchBookingClient>[0]> = {}) => ({ orgId: null, orgIdUncertain: false, workingPhones: [], nameNorm: '', ...over });

test('клиент: по БИН; по HMAC ИИН; по номеру; БИН важнее номера', () => {
  const list = [cand('a', { orgId: '990101300124', phones: ['77091112233'] }), cand('b', { iinKey: 'iin:zz', phones: ['77091112244'] }), cand('c', { phones: ['77091112255'] })];
  assert.deepEqual(matchBookingClient(keys({ orgId: '990101300124' }), list), { kind: 'found', by: 'org', candidate: list[0] });
  assert.deepEqual(matchBookingClient(keys({ orgId: 'iin:zz' }), list), { kind: 'found', by: 'org', candidate: list[1] });
  assert.deepEqual(matchBookingClient(keys({ workingPhones: ['77091112255'] }), list), { kind: 'found', by: 'phone', candidate: list[2] });
  assert.equal(matchBookingClient(keys({ orgId: '990101300124', workingPhones: ['77091112255'] }), list).kind, 'found');
  assert.deepEqual((matchBookingClient(keys({ orgId: '990101300124', workingPhones: ['77091112255'] }), list) as { by: string }).by, 'org');
});

test('клиент: номер клиента с другим БИН не совпадает; без ключей — не найден', () => {
  const list = [cand('a', { orgId: '990101300124', phones: ['77091112233'] }), cand('b', { phones: ['77091112244'] })];
  assert.equal(matchBookingClient(keys({ orgId: '990101300999', workingPhones: ['77091112233'] }), list).kind, 'not_found');
  // клиент без БИН подходит по номеру, даже если у строки БИН: БИН клиента не противоречит
  assert.equal(matchBookingClient(keys({ orgId: '990101300999', workingPhones: ['77091112244'] }), list).kind, 'found');
  assert.equal(matchBookingClient(keys(), list).kind, 'not_found');
  assert.equal(matchBookingClient(keys({ workingPhones: ['77090000000'] }), list).kind, 'not_found');
});

test('клиент: общий номер двух ТОО — по названию или неоднозначно', () => {
  const list = [cand('a', { nameNorm: 'альфа', phones: ['77091112233'] }), cand('b', { nameNorm: 'бета', phones: ['77091112233'] })];
  const hit = matchBookingClient(keys({ workingPhones: ['77091112233'], nameNorm: 'альфа' }), list);
  assert.deepEqual(hit.kind === 'found' && [hit.by, hit.candidate.clientId], ['phone_name', 'a']);
  assert.equal(matchBookingClient(keys({ workingPhones: ['77091112233'], nameNorm: 'гамма' }), list).kind, 'ambiguous');
});

test('клиент: неуверенно скрытый номер сверяется с открытым БИН клиента через HMAC', () => {
  const list = [cand('a', { orgId: '990101300124' })];
  const hidden = (bin: string) => `iin:${hmac(bin)}`;
  assert.equal(matchBookingClient(keys({ orgId: hidden('990101300124'), orgIdUncertain: true }), list, hidden).kind, 'found');
  assert.equal(matchBookingClient(keys({ orgId: hidden('990101300124'), orgIdUncertain: false }), list, hidden).kind, 'not_found');
});

// ---------- автор ----------

const staff: AuthorStaff[] = [
  { userId: 'u1', name: 'Иванова Анна Петровна', phoneDigits: '77093331001' },
  { userId: 'u2', name: 'Сидоров Пётр', phoneDigits: '77093331002' },
  { userId: 'u3', name: 'Сидоров Пётр', phoneDigits: '77093331003' },
];

test('автор: по номеру, по ФИО в другом порядке слов, однофамильцы — ambiguous, чужой — none', () => {
  assert.deepEqual(suggestAuthor('+7 709 333 10 01', staff, normalizers), { by: 'phone', userId: 'u1' });
  assert.deepEqual(suggestAuthor('8 (709) 333-10-01', staff, normalizers), { by: 'phone', userId: 'u1' });
  assert.deepEqual(suggestAuthor('Анна Иванова Петровна', staff, normalizers), { by: 'name', userId: 'u1' });
  assert.deepEqual(suggestAuthor('иванова анна петровна', staff, normalizers), { by: 'name', userId: 'u1' });
  assert.deepEqual(suggestAuthor('Пётр Сидоров', staff, normalizers), { by: 'ambiguous', userId: null });
  assert.deepEqual(suggestAuthor('Оператор-07', staff, normalizers), { by: 'none', userId: null });
  assert.deepEqual(suggestAuthor('', staff, normalizers), { by: 'none', userId: null });
});

test('карта авторов: регистр и пробелы ярлыка не важны; пусто — «автор неизвестен» без выбора', () => {
  const map = { 'оператор-01': 'u1', 'Оператор-02': null };
  assert.deepEqual(authorDecision(map, '  ОПЕРАТОР-01 '), { decided: true, userId: 'u1' });
  assert.deepEqual(authorDecision(map, 'Оператор-02'), { decided: true, userId: null });
  assert.deepEqual(authorDecision(map, 'Оператор-03'), { decided: false, userId: null });
  assert.deepEqual(authorDecision(map, null), { decided: true, userId: null });
  assert.deepEqual(authorDecision(map, ''), { decided: true, userId: null });
});

// ---------- предпросмотр ----------

const NOW = Date.UTC(2026, 9, 21, 9, 0);
const TODAY = '2026-10-21';
const ev = (id: string, date: string, over: Partial<BookingEventInfo> = {}): BookingEventInfo => ({
  id,
  typeKey: 'grp',
  date,
  time: '15:00',
  status: 'scheduled',
  capacity: 10,
  taken: 0,
  startsAt: Date.parse(`${date}T10:00:00Z`),
  durationMin: 180,
  ...over,
});

interface World {
  rows: string[][];
  candidates?: BookingCandidate[];
  events?: BookingEventInfo[];
  clientBookings?: ClientBookingInfo[];
  prior?: Map<string, { bookingId: string; stateKey: string | null }>;
  authorMap?: Record<string, string | null>;
  participants?: string[];
}
const NAMES = ['ТОО «Альфа»', 'ТОО «Бета»', 'ТОО «Гамма»'];
const PH = ['+7 709 111 22 01', '+7 709 111 22 02', '+7 709 111 22 03'];
const digitsOf = (p: string) => p.replace(/\D/g, '');

function preview(w: World, over: Partial<BookingPreviewInput> = {}) {
  const parsed = parse(w.rows);
  const input: BookingPreviewInput = {
    rows: parsed.rows,
    groupTypeKeys: new Set(['grp']),
    candidates: w.candidates ?? [cand('c1', { nameNorm: 'альфа', phones: [digitsOf(PH[0] as string)] })],
    events: w.events ?? [ev('e1', '2026-11-05')],
    clientBookings: w.clientBookings ?? [],
    prior: w.prior ?? new Map(),
    importKeyOf: (r) => bookingImportKey('sp', r.rowKey, sha),
    authorMap: w.authorMap ?? { 'Оператор-01': 'op-1' },
    participants: new Set(w.participants ?? ['op-1']),
    today: TODAY,
    now: NOW,
    ...over,
  };
  return { out: buildBookingPreview(input), input };
}
const row = (over: Partial<Record<'name' | 'phone' | 'bin' | 'date' | 'time' | 'op' | 'type', string>> = {}): string[] => [
  over.name ?? NAMES[0] as string,
  over.phone ?? (PH[0] as string),
  over.bin ?? '',
  over.date ?? '05.11.2026',
  over.time ?? '',
  over.op ?? 'Оператор-01',
  over.type ?? 'Группа-1',
];
const actionsOf = (w: World, over: Partial<BookingPreviewInput> = {}) => preview(w, over).out.rows.map((r) => r.action);

test('предпросмотр: create — карточка с владельцем переходит в «Договорились», автор из карты', () => {
  const { out } = preview({ rows: [row()] });
  const r = out.rows[0]!;
  assert.equal(r.action, 'create');
  assert.deepEqual([r.transition, r.ownerAfter, r.authorUserId, r.eventId, r.clientId, r.cardId], ['to_agreed', 'op-1', 'op-1', 'e1', 'c1', 'card-c1']);
  assert.deepEqual(r.flags, []);
  assert.deepEqual(r.groups, []);
  assert.equal(out.counts.toAgreed, 1);
  assert.deepEqual(out.byEvent.map((e) => [e.eventId, e.create]), [['e1', 1]]);
  assert.deepEqual(out.unmappedAuthors, []);
});

test('предпросмотр: каждое действие таблицы §6 по своему условию', () => {
  const bad = row({ date: '05.11' });
  assert.deepEqual(actionsOf({ rows: [bad] }), ['invalid']);
  assert.deepEqual(actionsOf({ rows: [row({ type: 'Консультация-1' })] }), ['unsupported_type']);
  assert.deepEqual(actionsOf({ rows: [row({ name: NAMES[1] as string, phone: PH[1] as string })] }), ['client_not_found']);
  assert.deepEqual(
    actionsOf({ rows: [row({ phone: PH[0] as string })], candidates: [cand('c1', { phones: [digitsOf(PH[0] as string)], nameNorm: 'x' }), cand('c2', { phones: [digitsOf(PH[0] as string)], nameNorm: 'y' })] }),
    ['client_ambiguous'],
  );
  assert.deepEqual(actionsOf({ rows: [row({ date: '20.10.2026' })] }), ['past_event']);
  assert.deepEqual(actionsOf({ rows: [row({ date: '06.11.2026' })] }), ['no_event']);
  assert.deepEqual(actionsOf({ rows: [row()], events: [ev('e1', '2026-11-05', { status: 'cancelled' })] }), ['event_cancelled']);
  assert.deepEqual(actionsOf({ rows: [row()], events: [ev('e1', '2026-11-05'), ev('e2', '2026-11-05', { time: '18:00' })] }), ['event_ambiguous']);
  assert.deepEqual(actionsOf({ rows: [row(), row()] }), ['create', 'duplicate_in_file']);
  assert.deepEqual(actionsOf({ rows: [row()], clientBookings: [{ clientId: 'c1', eventId: 'e1', typeKey: 'grp', status: 'attended', startsAt: 1 }] }), ['booking_exists']);
  assert.deepEqual(
    actionsOf({ rows: [row()], clientBookings: [{ clientId: 'c1', eventId: 'e0', typeKey: 'grp', status: 'registered', startsAt: NOW + 86_400_000 }], events: [ev('e0', '2026-11-04'), ev('e1', '2026-11-05')] }),
    ['booking_conflict'],
  );
  assert.deepEqual(actionsOf({ rows: [row()], candidates: [cand('c1', { phones: [digitsOf(PH[0] as string)], touchedInCrm: true })] }), ['kept_in_crm']);
  for (const state of ['not_interested', 'not_target', 'written_off', 'do_not_call']) {
    assert.deepEqual(actionsOf({ rows: [row()], candidates: [cand('c1', { phones: [digitsOf(PH[0] as string)], state })] }), ['state_conflict'], state);
  }
  assert.deepEqual(actionsOf({ rows: [row()], events: [ev('e1', '2026-11-05', { capacity: 3, taken: 3 })] }), ['event_full']);
});

test('предпросмотр: прошлая запись конфликта не создаёт, отменённая не мешает', () => {
  const ok = (status: string, startsAt: number) =>
    actionsOf({ rows: [row()], clientBookings: [{ clientId: 'c1', eventId: 'e0', typeKey: 'grp', status, startsAt }], events: [ev('e0', '2026-11-04'), ev('e1', '2026-11-05')] });
  assert.deepEqual(ok('attended', NOW - 86_400_000), ['create'], 'прошедшая явка — не будущая запись');
  assert.deepEqual(ok('cancelled', NOW + 86_400_000), ['create'], 'отменённая не занимает место');
});

test('предпросмотр: повтор ключа раньше поиска клиента; тот же автор — skip_same, другой — changed_in_file', () => {
  const w: World = { rows: [row(), row({ name: NAMES[1] as string, phone: PH[1] as string })], candidates: [] };
  const parsed = parse(w.rows);
  const key = (i: number) => bookingImportKey('sp', (parsed.rows[i] as ParsedBookingRow).rowKey, sha);
  const prior = new Map([[key(0), { bookingId: 'b1', stateKey: (parsed.rows[0] as ParsedBookingRow).stateKey }]]);
  // клиентов нет вообще: без prior было бы client_not_found, с prior — уже загружено
  assert.deepEqual(actionsOf({ ...w, prior }), ['skip_same', 'client_not_found']);
  // та же строка, но оператор в таблице сменился
  const renamed: World = { rows: [row({ op: 'Оператор-02' })], candidates: [] };
  const old = new Map([[bookingImportKey('sp', (parse(renamed.rows).rows[0] as ParsedBookingRow).rowKey, sha), { bookingId: 'b1', stateKey: (parsed.rows[0] as ParsedBookingRow).stateKey }]]);
  const changed = preview({ ...renamed, prior: old }).out.rows[0]!;
  assert.deepEqual([changed.action, changed.bookingId, changed.groups], ['changed_in_file', 'b1', ['review']]);
  // история import отсутствует — запись уже есть, считаем повтором
  assert.deepEqual(actionsOf({ ...w, prior: new Map([[key(0), { bookingId: 'b1', stateKey: null }]]) }), ['skip_same', 'client_not_found']);
});

test('предпросмотр: одинаковая строка дважды с разными операторами — повтор, а не смена автора (без «мигания» при повторе файла)', () => {
  const rows = [row(), row({ op: 'Оператор-02' })];
  const parsed = parse(rows);
  const first = parsed.rows[0] as ParsedBookingRow;
  const prior = new Map([[bookingImportKey('sp', first.rowKey, sha), { bookingId: 'b1', stateKey: first.stateKey }]]);
  assert.deepEqual(actionsOf({ rows }), ['create', 'duplicate_in_file'], 'первая загрузка');
  assert.deepEqual(actionsOf({ rows, prior }), ['skip_same', 'duplicate_in_file'], 'повтор файла');
});

test('предпросмотр: прошедшая дата раньше «нет мероприятия»; ошибка разбора раньше всего', () => {
  assert.deepEqual(actionsOf({ rows: [row({ date: '20.10.2026' })], events: [] }), ['past_event']);
  assert.deepEqual(actionsOf({ rows: [row({ date: '05.11', type: 'Консультация-1' })] }), ['invalid']);
  assert.deepEqual(actionsOf({ rows: [row({ type: 'Консультация-1', date: '20.10.2026' })] }), ['unsupported_type']);
});

test('предпросмотр: время в строке выбирает одно из двух мероприятий дня', () => {
  const events = [ev('e1', '2026-11-05', { time: '12:00' }), ev('e2', '2026-11-05', { time: '18:00' })];
  const p = preview({ rows: [row({ time: '18:00' })], events }).out.rows[0]!;
  assert.deepEqual([p.action, p.eventId], ['create', 'e2']);
  assert.deepEqual(actionsOf({ rows: [row({ time: '19:00' })], events }), ['no_event']);
});

test('предпросмотр: места считаются по порядку файла; конфликт и дубль со строкой выше', () => {
  const cands = [0, 1, 2].map((i) => cand(`c${i}`, { nameNorm: `n${i}`, phones: [digitsOf(PH[i] as string)] }));
  const rows = [0, 1, 2].map((i) => row({ name: NAMES[i] as string, phone: PH[i] as string }));
  const { out } = preview({ rows, candidates: cands, events: [ev('e1', '2026-11-05', { capacity: 3, taken: 1 })] });
  assert.deepEqual(out.rows.map((r) => r.action), ['create', 'create', 'event_full']);
  assert.deepEqual(out.byEvent[0], { eventId: 'e1', typeKey: 'grp', date: '2026-11-05', time: '15:00', create: 2, taken: 1, capacity: 3 });
  // две будущие записи одного клиента строками файла: вторая — конфликт для РОП
  const two = preview({ rows: [row(), row({ date: '06.11.2026' })], events: [ev('e1', '2026-11-05'), ev('e2', '2026-11-06')] }).out;
  assert.deepEqual(two.rows.map((r) => r.action), ['create', 'booking_conflict']);
});

test('create: уточнения по карточке — владелец, «Договорились», без владельца, задержана', () => {
  const run = (card: Partial<BookingCandidate>, w: Partial<World> = {}) => preview({ rows: [row()], candidates: [cand('c1', { phones: [digitsOf(PH[0] as string)], ...card })], ...w }).out.rows[0]!;
  const withOwner = run({ state: 'new' });
  assert.deepEqual([withOwner.transition, withOwner.ownerAfter, withOwner.flags], ['to_agreed', 'op-1', []]);
  for (const state of ['retry', 'callback']) assert.equal(run({ state }).transition, 'to_agreed', state);
  const agreed = run({ state: 'agreed' });
  assert.deepEqual([agreed.transition, agreed.ownerAfter, agreed.flags], ['none', 'op-1', []]);
  assert.equal(run({ state: 'client' }).transition, 'none');
  // без владельца: автор — участник раздачи → владелец = автор
  const fromAuthor = run({ ownerUserId: null });
  assert.deepEqual([fromAuthor.transition, fromAuthor.ownerAfter, fromAuthor.flags], ['to_agreed', 'op-1', ['owner_from_author']]);
  // автор не участник или неизвестен → карточка не меняется, на разбор
  const notParticipant = run({ ownerUserId: null }, { participants: [] });
  assert.deepEqual([notParticipant.transition, notParticipant.ownerAfter, notParticipant.flags, notParticipant.groups], ['none', null, ['card_unowned'], ['review']]);
  const unknownAuthor = run({ ownerUserId: null }, { authorMap: { 'Оператор-01': null } });
  assert.deepEqual([unknownAuthor.transition, unknownAuthor.flags.sort()], ['none', ['author_unknown', 'card_unowned']]);
  // задержана: запись есть, карточка не меняется
  const held = run({ state: 'new', holdReason: 'rule', ownerUserId: null });
  assert.deepEqual([held.action, held.transition, held.ownerAfter, held.flags, held.groups], ['create', 'none', null, ['card_held'], ['review']]);
  const heldOwned = run({ state: 'new', holdReason: 'dup_pair' });
  assert.deepEqual([heldOwned.transition, heldOwned.ownerAfter], ['none', 'op-1']);
});

test('два групповых вида: тот же клиент на оба — карточка переводится один раз, вторая строка видит «Договорились»', () => {
  const p2 = compileBookingProfile({ ...profile, eventTypeMap: { 'Группа-1': 'grp', 'Группа-2': 'grp2' } });
  const rows = parse([row({ date: '10.11.2026', time: '12:00' }), row({ date: '10.11.2026', type: 'Группа-2', time: '18:00' })], p2).rows;
  const events = [ev('e1', '2026-11-10', { time: '12:00' }), ev('e2', '2026-11-10', { time: '18:00', typeKey: 'grp2' })];
  const run = (card: Partial<BookingCandidate>, participants = ['op-1']) =>
    buildBookingPreview({
      rows,
      groupTypeKeys: new Set(['grp', 'grp2']),
      candidates: [cand('c1', { phones: [digitsOf(PH[0] as string)], ...card })],
      events,
      clientBookings: [],
      prior: new Map(),
      importKeyOf: (r) => bookingImportKey('sp', r.rowKey, sha),
      authorMap: { 'Оператор-01': 'op-1' },
      participants: new Set(participants),
      today: TODAY,
      now: NOW,
    });
  const owned = run({ state: 'callback' });
  assert.deepEqual(owned.rows.map((r) => [r.action, r.eventId, r.transition, r.ownerAfter, r.flags]), [
    ['create', 'e1', 'to_agreed', 'op-1', []],
    ['create', 'e2', 'none', 'op-1', []],
  ]);
  assert.equal(owned.counts.toAgreed, 1);
  // без владельца, автор — участник раздачи: владелец назначается первой строкой, вторая его уже видит
  const unowned = run({ state: 'new', ownerUserId: null });
  assert.deepEqual(unowned.rows.map((r) => [r.action, r.transition, r.ownerAfter, r.flags]), [
    ['create', 'to_agreed', 'op-1', ['owner_from_author']],
    ['create', 'none', 'op-1', []],
  ]);
  assert.equal(unowned.counts.toAgreed, 1);
  assert.equal(unowned.counts.byFlag.owner_from_author, 1);
  // автор не участник: карточка не меняется ни одной строкой, обе на разбор
  const stays = run({ state: 'new', ownerUserId: null }, []);
  assert.deepEqual(stays.rows.map((r) => [r.transition, r.flags]), [['none', ['card_unowned']], ['none', ['card_unowned']]]);
});

test('мероприятие сегодня: уже закончилось — past_event; идёт или впереди — create', () => {
  const H = 3_600_000;
  const today = (startsAt: number, durationMin = 120) => preview({ rows: [row({ date: '21.10.2026' })], events: [ev('e1', TODAY, { startsAt, durationMin })] }).out.rows[0]!.action;
  assert.equal(today(NOW - 3 * H), 'past_event', 'утреннее мероприятие, файл загружен вечером');
  assert.equal(today(NOW - 2 * H), 'past_event', 'закончилось ровно сейчас');
  assert.equal(today(NOW - H), 'create', 'идёт: гость в списке дежурного, явку отмечают на месте');
  assert.equal(today(NOW + H), 'create');
});

test('автор: число разных ярлыков строк create (для блокера too_many_authors); ярлыки других строк не считаются', () => {
  const cands = [0, 1, 2].map((i) => cand(`c${i}`, { nameNorm: `n${i}`, phones: [digitsOf(PH[i] as string)] }));
  const rows = [
    row({ name: NAMES[0] as string, phone: PH[0] as string, op: 'Оператор-01' }),
    row({ name: NAMES[1] as string, phone: PH[1] as string, op: ' оператор-01 ' }),
    row({ name: NAMES[2] as string, phone: PH[2] as string, op: 'Оператор-02' }),
    row({ name: 'ТОО «Нет»', phone: '+7 709 999 00 00', op: 'Оператор-03' }),
  ];
  assert.equal(preview({ rows, candidates: cands }).out.authorLabelCount, 2);
});

test('автор: пустая ячейка — «неизвестен» без блокера; нерешённый ярлык строки create — в unmappedAuthors', () => {
  const empty = preview({ rows: [row({ op: '' })] }).out;
  assert.deepEqual([empty.rows[0]?.flags, empty.rows[0]?.groups, empty.unmappedAuthors], [['author_unknown'], ['author_unknown'], []]);
  const unmapped = preview({ rows: [row({ op: 'Оператор-77' })], authorMap: {} }).out;
  assert.deepEqual(unmapped.unmappedAuthors, ['Оператор-77']);
  // ярлык строки, которая не создаёт запись, решения не требует
  const skip = preview({ rows: [row({ op: 'Оператор-77', date: '20.10.2026' })], authorMap: {} }).out;
  assert.deepEqual(skip.unmappedAuthors, []);
});

test('счётчики: по действиям, группам и замечаниям; сумма действий = число строк', () => {
  const { out } = preview({ rows: [row(), row({ date: '06.11.2026' }), row({ op: '' }), row({ name: NAMES[1] as string, phone: PH[1] as string })] });
  assert.equal(out.counts.total, 4);
  assert.equal(Object.values(out.counts.byAction).reduce((a, b) => a + b, 0), 4);
  assert.equal(out.counts.byAction.create, 1);
  assert.equal(out.counts.byAction.no_event, 1);
  assert.equal(out.counts.byAction.duplicate_in_file, 1);
  assert.equal(out.counts.byGroup.client_not_found, 1);
  assert.equal(out.counts.byGroup.no_event, 1);
  assert.equal(out.counts.byGroup.duplicate, 1);
});

// ---------- спорные пары (PROCESS 7.6, D-038, D-174) ----------

test('пара не делится: карточка без владельца в паре с карточкой оператора уходит ему же, а не автору', () => {
  const x = cand('c1', { state: 'new', ownerUserId: null, phones: [digitsOf(PH[0] as string)] });
  const run = (partner: Partial<BookingPartnerCard>, status: 'open' | 'distinct', participants = ['op-1', 'op-2']) =>
    preview(
      { rows: [row()], candidates: [x], participants },
      {
        pairs: [{ aClientId: 'c1', bClientId: 'y1', status }],
        partnerCards: [{ cardId: 'card-y1', clientId: 'y1', state: 'callback', ownerUserId: 'op-2', holdReason: '', ...partner }],
      },
    ).out.rows[0]!;
  // «Разные — тому же оператору» (distinct) и открытая пара: напарник у op-2 — карточка op-2, автор op-1 только автор записи
  for (const status of ['distinct', 'open'] as const) {
    const r = run({}, status);
    assert.deepEqual([r.action, r.transition, r.ownerAfter, r.authorUserId, r.flags], ['create', 'to_agreed', 'op-2', 'op-1', ['owner_from_pair']], status);
  }
  // держащий напарника не участвует в раздаче: карточка остаётся без владельца, на разбор
  const notPart = run({}, 'distinct', ['op-1']);
  assert.deepEqual([notPart.transition, notPart.ownerAfter, notPart.flags, notPart.groups], ['none', null, ['card_unowned'], ['review']]);
  // открытая пара с «Не звонить» или с задержанным напарником: без перехода и владельца до решения РОП
  for (const partner of [{ state: 'do_not_call', ownerUserId: 'op-2' }, { state: 'new', ownerUserId: null, holdReason: 'dup_pair' }]) {
    const r = run(partner, 'open');
    assert.deepEqual([r.action, r.transition, r.ownerAfter, r.flags, r.groups], ['create', 'none', null, ['pair_hold'], ['review']], JSON.stringify(partner));
  }
  // после решения «Разные» «Не звонить» и задержка напарника пару не держат: автор как обычно
  const dncDistinct = run({ state: 'do_not_call', ownerUserId: 'op-2' }, 'distinct');
  assert.deepEqual([dncDistinct.ownerAfter, dncDistinct.flags], ['op-1', ['owner_from_author']]);
  // напарник закрыт или в пуле готов — пару не держит: автор
  assert.deepEqual(run({ state: 'not_interested' }, 'open').flags, ['owner_from_author']);
  assert.deepEqual(run({ state: 'new', ownerUserId: null }, 'distinct').flags, ['owner_from_author']);
});

test('пара: два напарника у разных операторов — на разбор; карточка с владельцем паре не подчиняется', () => {
  const x = cand('c1', { state: 'new', ownerUserId: null, phones: [digitsOf(PH[0] as string)] });
  const pairs = [
    { aClientId: 'c1', bClientId: 'y1', status: 'distinct' as const },
    { aClientId: 'y2', bClientId: 'c1', status: 'open' as const },
  ];
  const partnerCards = [
    { cardId: 'card-y1', clientId: 'y1', state: 'callback', ownerUserId: 'op-2', holdReason: '' },
    { cardId: 'card-y2', clientId: 'y2', state: 'agreed', ownerUserId: 'op-3', holdReason: '' },
  ];
  const split = preview({ rows: [row()], candidates: [x], participants: ['op-1', 'op-2', 'op-3'] }, { pairs, partnerCards }).out.rows[0]!;
  assert.deepEqual([split.transition, split.ownerAfter, split.flags], ['none', null, ['pair_hold']]);
  // оба напарника у одного оператора — ему
  const same = preview({ rows: [row()], candidates: [x], participants: ['op-1', 'op-2'] }, { pairs, partnerCards: partnerCards.map((c) => ({ ...c, ownerUserId: 'op-2' })) }).out.rows[0]!;
  assert.deepEqual([same.ownerAfter, same.flags], ['op-2', ['owner_from_pair']]);
  // у карточки уже есть владелец: пара её не трогает (владелец не меняется импортом)
  const owned = preview({ rows: [row()], candidates: [cand('c1', { state: 'new', phones: [digitsOf(PH[0] as string)] })], participants: ['op-1', 'op-2', 'op-3'] }, { pairs, partnerCards }).out.rows[0]!;
  assert.deepEqual([owned.ownerAfter, owned.flags], ['op-1', []]);
});

test('пара в одном файле: двойники из пула с разными авторами — вторая карточка уходит владельцу первой', () => {
  const x = cand('c1', { nameNorm: 'альфа', state: 'new', ownerUserId: null, phones: [digitsOf(PH[0] as string)] });
  const y = cand('c2', { nameNorm: 'бета', state: 'new', ownerUserId: null, phones: [digitsOf(PH[1] as string)] });
  const out = preview(
    {
      rows: [row(), row({ name: NAMES[1] as string, phone: PH[1] as string, op: 'Оператор-02' })],
      candidates: [x, y],
      authorMap: { 'Оператор-01': 'op-1', 'Оператор-02': 'op-2' },
      participants: ['op-1', 'op-2'],
    },
    {
      pairs: [{ aClientId: 'c1', bClientId: 'c2', status: 'distinct' }],
      partnerCards: [
        { cardId: 'card-c1', clientId: 'c1', state: 'new', ownerUserId: null, holdReason: '' },
        { cardId: 'card-c2', clientId: 'c2', state: 'new', ownerUserId: null, holdReason: '' },
      ],
    },
  ).out;
  assert.deepEqual(out.rows.map((r) => [r.action, r.authorUserId, r.ownerAfter, r.flags]), [
    ['create', 'op-1', 'op-1', ['owner_from_author']],
    ['create', 'op-2', 'op-1', ['owner_from_pair']],
  ]);
  assert.equal(out.counts.byFlag.owner_from_pair, 1);
  assert.equal(out.counts.byGroup.review, 0);
});

// ---------- генератор и разбор вместе ----------

test('синтетическая таблица записей: разбор находит ровно внесённые дефекты разбора, действия — по строкам meta', () => {
  const g = generateSyntheticBookings({
    labels: { group: 'Группа-1', individual: 'Консультация-1', unknown: 'Неизвестно-1' },
    days: { ok: '2026-11-05', other: '2026-11-06', cancelled: '2026-11-07', none: '2026-11-08', past: '2026-10-01', full: '2026-11-09', twoEvents: '2026-11-10' },
    fullCapacity: 3,
    secondTime: '18:00',
  });
  const csvGrid = g.bookingsGrid;
  const parsed = parseBookingSheet(csvGrid, cp, { normalizers, hash: testHash, hmac });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const errors = (code: string) => parsed.rows.filter((r) => codes(r).includes(code)).map((r) => r.rowNo);
  assert.deepEqual(errors('bad_date'), g.meta.badDateRows);
  assert.deepEqual(errors('bad_time'), g.meta.badTimeRows);
  assert.deepEqual(errors('unknown_event_type'), g.meta.unknownTypeRows);
  assert.equal(new Set(parsed.rows.map((r) => r.rowKey)).size, parsed.rows.length - g.meta.duplicateRows.length, 'ключи уникальны, кроме внесённого дубля');
  assert.ok(g.meta.withBinRows.length > 0 && parsed.rows.filter((r) => r.orgId).length === g.meta.withBinRows.length);
  for (const r of g.clients) assert.match(r.phone, /^\+7 709 /);
  assert.ok(!JSON.stringify(g.bookingsGrid).match(/\+7 7(?!09)\d\d/), 'только +7 709');
});

// ---------- отпечаток ----------

test('отпечаток: порядок ключей карты не важен; меняется от автора, дня и решения одной строки', () => {
  const { out } = preview({ rows: [row(), row({ name: NAMES[1] as string, phone: PH[1] as string })] });
  const base = {
    buildId: 'b1',
    configRev: { global: 1, space: 1 },
    importId: 'imp',
    fileSha256: 'f'.repeat(64),
    profileKey: 'bookings',
    snapshotDay: '2026-10-20',
    today: TODAY,
    authorMap: { b: 'u2', a: 'u1' } as Record<string, string | null>,
    rows: out.rows,
  };
  const fp = (over: Partial<typeof base> = {}) => bookingPreviewFingerprint({ ...base, ...over }, sha);
  assert.equal(fp(), fp({ authorMap: { a: 'u1', b: 'u2' } }));
  assert.equal(fp(), fp({ authorMap: { A: 'u1', ' b ': 'u2' } }), 'ключи карты нормализуются');
  assert.notEqual(fp(), fp({ authorMap: { a: 'u1', b: 'u3' } }));
  assert.notEqual(fp(), fp({ authorMap: { a: 'u1', b: null } }));
  assert.notEqual(fp(), fp({ today: '2026-10-22' }));
  assert.notEqual(fp(), fp({ configRev: { global: 1, space: 2 } }));
  assert.notEqual(fp(), fp({ rows: [{ ...out.rows[0]!, authorUserId: 'zzz' }, out.rows[1]!] }));
  assert.notEqual(fp(), fp({ rows: [{ ...out.rows[0]!, eventId: 'e9' }, out.rows[1]!] }));
  assert.notEqual(fp(), fp({ rows: [{ ...out.rows[0]!, ownerAfter: 'op-9' }, out.rows[1]!] }));
  assert.notEqual(fp(), fp({ rows: [{ ...out.rows[0]!, transition: 'none' }, out.rows[1]!] }));
  assert.notEqual(fp(), fp({ rows: [out.rows[0]!, { ...out.rows[1]!, action: 'create' }] }), 'решение второй строки');
  assert.equal(canonicalJsonOf({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
});
