// Сборка настроек импорта (дизайн C4d §4): профиль из раздела import, карта итогов из importAliases, виды итогов,
// правила источника (ключи форм → коды), «личные» формы словаря, пределы.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, imports } from '@crm/core';
import { createHash } from 'node:crypto';
import { generateSyntheticSheets } from '../../../packages/core/src/import/syntheticSheets';
import { assembleChain } from '../config/helpers';
import { buildImportContext } from '../../../src/server/domain/import/settings';
import { FIELD_TARGETS, importDocs, PROFILE } from '../../integration/import/helpers';

const { validateConfigSet } = config;

type Opts = Parameters<typeof importDocs>[0];

function check(patch?: (docs: ReturnType<typeof importDocs>) => void, opts: Opts = {}) {
  const docs = importDocs(opts);
  patch?.(docs);
  return validateConfigSet({ global: docs.global, spaces: docs.spaces } as never);
}

function build(patch?: (docs: ReturnType<typeof importDocs>) => void, opts: Opts = {}) {
  const r = check(patch, opts);
  if (!r.ok) throw new Error(r.issues.map((i) => i.path).join(','));
  return buildImportContext({ spaceId: 's1', spaceKey: 'sales', rev: { global: 3, space: 4 }, global: r.value.global, space: r.value.spaces.sales as never });
}

test('профиль: колонки, карта итогов из importAliases, виды итогов, булевы карты ЛПР и статуса', () => {
  const ctx = build();
  const p = ctx.settings.profiles.find((x) => x.key === PROFILE)!;
  assert.equal(p.kind, 'clients');
  assert.equal(p.columns['Наименование'], 'name');
  assert.equal(p.valueMaps.outcome['Перезвонить'], 'callback');
  assert.equal(p.valueMaps.outcome['Недоступен'], 'bad_number');
  assert.equal(p.valueMaps.lpr['да'], 'yes');
  assert.equal(p.valueMaps.lpr['нет'], 'no');
  assert.equal(p.valueMaps.target['целевой'], 'target');
  assert.equal(p.valueMaps.target['не целевой'], 'non_target');
  assert.equal(p.outcomeKinds['do_not_call'], 'do_not_call');
  assert.deepEqual(p.ownerBy, { kind: 'row_ranges', slots: [] });
  assert.deepEqual(p.fieldTargets, {});
  assert.deepEqual(ctx.rev, { global: 3, space: 4 });
});

test('профиль поверх алиасов: своя карта профиля важнее importAliases', () => {
  const ctx = build((d) => {
    const sp = d.spaces.sales as { import: { profiles: { valueMaps: { outcome: Record<string, string> } }[] } };
    sp.import.profiles[0]!.valueMaps.outcome['Перезвонить'] = 'agreed';
  });
  assert.equal(ctx.settings.profiles[0]!.valueMaps.outcome['Перезвонить'], 'agreed');
  assert.equal(ctx.settings.profiles[0]!.valueMaps.outcome['Подтвержден'], 'agreed');
});

test('источник import: правило ИП переведено с ключа формы на код; пределы и ключ источника', () => {
  const ctx = build();
  assert.equal(ctx.settings.sourceKey, 'import');
  const hold = ctx.settings.rules.hold[0]!;
  assert.deepEqual([hold.code, hold.type], ['legal_review', 'legalFormIn']);
  assert.ok(hold.values.includes('ip') && hold.values.includes('ип'));
  assert.deepEqual([ctx.settings.maxFileMb, ctx.settings.maxRows, ctx.settings.rowsRetentionDays], [10, 20000, 14]);
  assert.equal(ctx.legalKeyByCode.get('ип'), 'ip');
});

test('«личные» формы словаря: ИП определяется по idIsPersonal, ИИН уходит в HMAC (D-141)', () => {
  const ctx = build();
  assert.deepEqual([...ctx.normalizers.personalFormCodes], ['ип']);
  assert.equal(ctx.normalizers.legalFormOf('ИП', '').code, 'ип');
});

test('нет источника kind=import — ключ по умолчанию, правил нет; архивный профиль не выбирается', () => {
  const ctx = build((d) => {
    const g = d.global as { sources: { kind: string }[] };
    g.sources = g.sources.filter((s) => s.kind !== 'import');
    const sp = d.spaces.sales as { import: { profiles: { archived?: boolean }[] } };
    sp.import.profiles[0]!.archived = true;
  });
  assert.equal(ctx.settings.sourceKey, 'import');
  assert.deepEqual(ctx.settings.rules, { reject: [], hold: [] });
  assert.equal(ctx.settings.profiles.length, 0);
});

test('участники раздачи, календарь и повторы берутся из настроек пространства', () => {
  const ctx = build();
  assert.deepEqual([...ctx.participantRoles], ['manager']);
  assert.equal(ctx.calling.retry.maxAttempts, 3);
  assert.equal(ctx.calling.returnDays.not_interested, 90);
  assert.equal(ctx.timeZone, 'UTC');
  assert.ok(ctx.searchable.includes('okved'));
});

// ---------- Слоты и fieldTargets из схемы настроек (D-191) ----------

const SLOTS = [
  { label: 'Синий', ranges: [[3, 102]] as [number, number][] },
  { label: 'Зелёный', ranges: [[103, 202], [303, 402]] as [number, number][] },
];
type Profile = { ownerBy: string; ownerSlots?: unknown[]; fieldTargets?: Record<string, unknown>; noteMarkers?: unknown[] };
const profileOf = (d: ReturnType<typeof importDocs>) => (d.spaces.sales as unknown as { import: { profiles: Profile[] } }).import.profiles[0]!;

test('слоты и fieldTargets читаются из настроек установки: ярлык — он же имя, цвета в настройках нет', () => {
  const ctx = build(undefined, { slots: SLOTS, fieldTargets: { ...FIELD_TARGETS } });
  const p = ctx.settings.profiles[0]!;
  assert.deepEqual(p.ownerBy, {
    kind: 'row_ranges',
    slots: [
      { label: 'Синий', name: 'Синий', color: '', ranges: [[3, 102]] },
      { label: 'Зелёный', name: 'Зелёный', color: '', ranges: [[103, 202], [303, 402]] },
    ],
  });
  assert.deepEqual(p.fieldTargets, FIELD_TARGETS);
});

test('noteMarkers из настроек попадают в профиль ядра', () => {
  const ctx = build((d) => {
    profileOf(d).noteMarkers = [{ code: 'dnc_request', words: ['не звонить', 'удалить'] }];
  });
  assert.deepEqual(ctx.settings.profiles[0]!.noteMarkers, [{ code: 'dnc_request', words: ['не звонить', 'удалить'] }]);
});

test('поле с ФИО (pii: person) не пишется, если источник импорта запрещает имена (D-052)', () => {
  const ctx = build(
    (d) => {
      const g = d.global as { sources: { kind: string; allowPersonNames: boolean }[] };
      for (const s of g.sources) if (s.kind === 'import') s.allowPersonNames = false;
    },
    { fieldTargets: { ...FIELD_TARGETS } },
  );
  const t = ctx.settings.profiles[0]!.fieldTargets;
  assert.equal(t.head, undefined);
  assert.deepEqual(t.activity, FIELD_TARGETS.activity);
  assert.deepEqual(t.niche, FIELD_TARGETS.niche);
});

test('проверка набора: слоты без row_ranges, повтор ярлыка, начало больше конца, чужое поле — ошибки', () => {
  const paths = (r: ReturnType<typeof check>) => (r.ok ? [] : r.issues.map((i) => i.path));
  const column = check((d) => {
    profileOf(d).ownerBy = 'column';
  }, { slots: SLOTS });
  assert.ok(paths(column).some((p) => p.includes('ownerSlots')), JSON.stringify(paths(column)));
  const dup = check(undefined, { slots: [SLOTS[0]!, { label: ' синий ', ranges: [[500, 600]] }] });
  assert.ok(paths(dup).some((p) => p.includes('ownerSlots') && p.includes('label')), JSON.stringify(paths(dup)));
  // Помощник importDocs приводит диапазоны генератора к допустимым — неверный пишем в документ напрямую
  const reversed = check((d) => {
    profileOf(d).ownerSlots = [{ label: 'Синий', ranges: [[200, 100]] }];
  });
  assert.ok(paths(reversed).some((p) => p.includes('ranges')), JSON.stringify(paths(reversed)));
  const badField = check(undefined, { fieldTargets: { head: { object: 'card', fieldKey: 'head_name' } } });
  assert.ok(paths(badField).some((p) => p.includes('fieldTargets')), JSON.stringify(paths(badField)));
  const noField = check(undefined, { fieldTargets: { head: { object: 'client', fieldKey: 'nope' } } });
  assert.ok(paths(noField).some((p) => p.includes('fieldTargets')), JSON.stringify(paths(noField)));
  assert.ok(check(undefined, { slots: SLOTS, fieldTargets: { ...FIELD_TARGETS } }).ok);
});

test('лишний ключ в слоте (ФИО, цвет) схема не принимает: слот — только ярлык и диапазоны', () => {
  const r = check((d) => {
    profileOf(d).ownerSlots = [{ label: 'Синий', name: 'Иванов', ranges: [[3, 10]] }];
  });
  assert.equal(r.ok, false);
});

test('пресет ЦРП: профиль «Таблицы операторов» разбирает синтетическую таблицу по README фикстур', () => {
  const a = assembleChain(['base', 'kz', 'consulting-sales', 'crp']);
  const r = validateConfigSet({ global: a.global, spaces: a.spaces });
  assert.ok(r.ok);
  const ctx = buildImportContext({ spaceId: 's1', spaceKey: 'sales', rev: { global: 1, space: 1 }, global: r.value.global, space: r.value.spaces.sales! });
  const p = ctx.settings.profiles.find((x) => x.key === 'operator_tables')!;
  // В пресете слотов нет: строки без владельца, пока установка не задаст слоты
  assert.deepEqual(p.ownerBy, { kind: 'row_ranges', slots: [] });
  const sheets = generateSyntheticSheets({ rows: 200, seed: 11 });
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const parsed = imports.parseSheet(sheets.main, imports.compileProfile(p), { normalizers: ctx.normalizers, hash });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.missing.join(','));
  if (!parsed.ok) return;
  assert.equal(parsed.headerRow, 2);
  assert.equal(parsed.unmappedHeaders.length, 0, parsed.unmappedHeaders.join(','));
  assert.ok(parsed.rows.some((row) => row.legalForm === 'ип'));
  assert.ok(parsed.rows.some((row) => row.answer.primary === 'agreed' || row.answer.primary === 'no_answer'));
  assert.ok(parsed.rows.every((row) => row.answer.unknown.every((u) => u === 'Не имеет отношение' || u === '')), 'неизвестные значения «Ответа»');
  assert.ok(parsed.rows.some((row) => (row.fields.head ?? '') !== ''));
});
