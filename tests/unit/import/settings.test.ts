// Сборка настроек импорта (дизайн C4d §4): профиль из раздела import, карта итогов из importAliases, виды итогов,
// правила источника (ключи форм → коды), «личные» формы словаря, пределы.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '@crm/core';
import { buildImportContext } from '../../../src/server/domain/import/settings';
import { importDocs, PROFILE } from '../../integration/import/helpers';

const { validateConfigSet } = config;

function build(patch?: (docs: ReturnType<typeof importDocs>) => void) {
  const docs = importDocs();
  patch?.(docs);
  const r = validateConfigSet({ global: docs.global, spaces: docs.spaces } as never);
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
