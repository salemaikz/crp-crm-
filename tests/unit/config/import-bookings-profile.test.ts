// Профиль импорта «Записи» (D-324, docs/import-bookings-design.md §3): необязательные ключи схемы и проверка набора.
// Старые документы без новых ключей остаются верными (правило D-191); для bookings связи с видами мероприятий и колонками.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '@crm/core';
import { importDocs } from '../../integration/import/helpers';

const { validateConfigSet } = config;
type Doc = ReturnType<typeof importDocs>;
type Profile = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- документ собирается по путям

const t = (ru: string) => ({ ru });
const EVENT_TYPES = [
  { key: 'group_a', behavior: 'group', label: t('Группа А'), short: t('ГА'), capacity: 30, durationMin: 180, directions: [] },
  { key: 'solo_a', behavior: 'individual', label: t('Консультация'), short: t('К'), capacity: null, durationMin: 45, directions: [] },
];

const bookingsProfile = (): Profile => ({
  key: 'bookings_table',
  label: t('Записи'),
  kind: 'bookings',
  columns: { Наименование: 'name', Телефон: 'phones', БИН: 'orgId', Дата: 'eventDate', Время: 'eventTime', Оператор: 'operator', Мероприятие: 'eventType' },
  valueMaps: { outcome: {}, lpr: {}, target: {}, eventType: { ГА: 'group_a', К: 'solo_a' } },
  defaultEventTypeKey: 'group_a',
  maxRows: 2000,
  ownerBy: 'column',
  outcomePriority: [],
  snapshotDate: null,
});

function docs(patch?: (p: Profile) => void): Doc {
  const d = importDocs();
  const sp = d.spaces.sales as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  sp.booking.eventTypes = EVENT_TYPES;
  const p = bookingsProfile();
  patch?.(p);
  sp.import.profiles = [...sp.import.profiles, p];
  return d;
}
const check = (d: Doc) => validateConfigSet({ global: d.global, spaces: d.spaces } as never);
const paths = (d: Doc): string[] => {
  const r = check(d);
  return r.ok ? [] : r.issues.map((i) => i.path);
};

test('профиль bookings со всеми ключами проходит схему; профиль клиентов без kind остаётся верным', () => {
  const r = check(docs());
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.issues));
  const profiles = (r.ok ? r.value.spaces.sales : null) as { import: { profiles: { key: string; kind?: string }[] } };
  assert.equal(profiles.import.profiles.find((x) => x.key === 'operator_tables')!.kind, undefined);
  assert.equal(profiles.import.profiles.find((x) => x.key === 'bookings_table')!.kind, 'bookings');
});

test('bookings: без колонки даты, без поиска клиента, без вида — ошибки', () => {
  assert.ok(paths(docs((p) => void delete p.columns['Дата'])).some((x) => x.includes('columns')));
  assert.ok(paths(docs((p) => {
    delete p.columns['Телефон'];
    delete p.columns['БИН'];
  })).some((x) => x.includes('columns')));
  assert.ok(paths(docs((p) => {
    delete p.columns['Мероприятие'];
    delete p.defaultEventTypeKey;
  })).some((x) => x.includes('columns')));
});

test('bookings: вид только по defaultEventTypeKey без колонки вида допустим', () => {
  const r = check(docs((p) => void delete p.columns['Мероприятие']));
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.issues));
});

test('bookings: defaultEventTypeKey — только групповой вид; чужой ключ в карте видов — ошибка', () => {
  assert.ok(paths(docs((p) => void (p.defaultEventTypeKey = 'solo_a'))).some((x) => x.includes('defaultEventTypeKey')));
  assert.ok(paths(docs((p) => void (p.defaultEventTypeKey = 'nope'))).some((x) => x.includes('defaultEventTypeKey')));
  assert.ok(paths(docs((p) => void (p.valueMaps.eventType.Чужой = 'nope'))).some((x) => x.includes('eventType')));
});

test('bookings: слоты, fieldTargets, noteMarkers, карты итогов, приоритет и ownerBy ≠ column — ошибки', () => {
  assert.ok(paths(docs((p) => void (p.ownerBy = 'row_ranges'))).some((x) => x.includes('ownerBy')));
  assert.ok(paths(docs((p) => void (p.ownerSlots = [{ label: 'Синий', ranges: [[1, 2]] }]))).some((x) => x.includes('ownerSlots')));
  assert.ok(paths(docs((p) => void (p.noteMarkers = [{ code: 'x', words: ['y'] }]))).some((x) => x.includes('noteMarkers')));
  assert.ok(paths(docs((p) => void (p.valueMaps.outcome = { Подтвержден: 'agreed' }))).some((x) => x.includes('valueMaps')));
  assert.ok(paths(docs((p) => void (p.outcomePriority = ['agreed']))).some((x) => x.includes('outcomePriority')));
});

test('пределы maxRows и неизвестный kind — ошибки схемы; ключи bookings у профиля клиентов — ошибки', () => {
  assert.ok(paths(docs((p) => void (p.maxRows = 5001))).some((x) => x.includes('maxRows')));
  assert.ok(paths(docs((p) => void (p.maxRows = 0))).some((x) => x.includes('maxRows')));
  assert.ok(paths(docs((p) => void (p.kind = 'other'))).some((x) => x.includes('kind')));
  const d = importDocs();
  const prof = (d.spaces.sales as any).import.profiles[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
  prof.defaultEventTypeKey = 'group_a';
  prof.maxRows = 10;
  const p = paths(d);
  assert.ok(p.some((x) => x.includes('defaultEventTypeKey')) && p.some((x) => x.includes('maxRows')), JSON.stringify(p));
});
