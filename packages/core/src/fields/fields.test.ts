import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GlobalConfigV1, SpaceConfigV1 } from '../config/schema/v1.js';
import {
  buildFieldValidator,
  buildSearchNorm,
  canSeeFieldChange,
  coerceValue,
  filterableField,
  hiddenKeys,
  normalizeEmail,
  parseSearchQuery,
  projectFor,
  projectValues,
  reservedKeyIssues,
  resolveAccess,
  safeHttpUrl,
  searchableKeys,
  validateSystemPatch,
  visibleFieldRefs,
  type FieldDef,
  type FieldViewer,
} from './index.js';

// Совместимость: поле из схемы настроек подходит движку без приведения типов.
const _globalField: FieldDef = {} as GlobalConfigV1['fields'][number];
const _spaceField: FieldDef = {} as SpaceConfigV1['fields'][number];
void _globalField;
void _spaceField;

function field(key: string, extra: Partial<FieldDef> = {}): FieldDef {
  return {
    key,
    object: 'client',
    type: 'text',
    label: { ru: key },
    options: [],
    access: { '*': 'read', operator: 'edit', manager: 'edit' },
    required: { always: false, onOutcome: [], onStage: [] },
    searchable: false,
    filterable: false,
    ingest: true,
    pii: 'none',
    showOn: { card: true, kanban: false, list: false },
    ...extra,
  };
}

const operator: FieldViewer = { roleKey: 'operator', fieldAccessDefault: 'edit', canEdit: true };
const watcher: FieldViewer = { roleKey: 'watcher', fieldAccessDefault: 'read', canEdit: false };

const FIELDS: FieldDef[] = [
  field('niche', { type: 'select', options: [{ key: 'retail', label: { ru: 'Розница' } }, { key: 'old', label: { ru: 'Старое' }, archived: true }, { key: 'other', label: { ru: 'Другое' } }], required: { always: false, onOutcome: ['agreed'], onStage: [] }, filterable: true }),
  field('site', { type: 'url' }),
  field('mail', { type: 'email' }),
  field('secret', { access: { '*': 'hidden', manager: 'edit' } }),
  field('head', { pii: 'person', searchable: true }),
  field('tags', { type: 'multiselect', options: [{ key: 'a', label: { ru: 'А' } }, { key: 'b', label: { ru: 'Б' } }] }),
  field('legacy', { archived: true }),
  field('size', { type: 'money', ingest: false }),
  field('extra', { object: 'contact' }),
];

test('доступ: роль → * → по умолчанию; edit без права — read; без роли — hidden', () => {
  const f = FIELDS[0]!;
  assert.equal(resolveAccess(f, operator), 'edit');
  assert.equal(resolveAccess(f, { ...operator, canEdit: false }), 'read');
  assert.equal(resolveAccess(f, watcher), 'read');
  assert.equal(resolveAccess(field('x', { access: {} }), watcher), 'read');
  assert.equal(resolveAccess(field('x', { access: {} }), { ...watcher, fieldAccessDefault: 'hidden' }), 'hidden');
  assert.equal(resolveAccess(f, { ...operator, roleKey: null }), 'hidden');
  assert.equal(resolveAccess(FIELDS.find((x) => x.key === 'legacy')!, operator), 'read');
  // ключи прототипа не считаются ролями
  assert.equal(resolveAccess(field('x', { access: {} }), { ...watcher, roleKey: 'constructor', fieldAccessDefault: 'hidden' }), 'hidden');
  assert.deepEqual(hiddenKeys(FIELDS, 'client', operator), ['secret']);
});

test('ссылки: только http(s); javascript, data, vbscript и обходы отбрасываются (D-051)', () => {
  for (const bad of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ftp://example.kz',
    'mailto:a@example.kz',
    'https://user:pass@example.kz',
    'https://example.kz@evil.example',
    '//evil.example',
    'http://',
    'не ссылка',
  ]) {
    assert.equal(safeHttpUrl(bad), null, bad);
  }
  assert.equal(safeHttpUrl('https://example.kz/a?b=1'), 'https://example.kz/a?b=1');
  assert.equal(safeHttpUrl('HTTP://Example.kz'), 'http://example.kz/');
  assert.equal(safeHttpUrl('example.kz/page'), 'https://example.kz/page');
});

test('почта: только адрес', () => {
  assert.equal(normalizeEmail(' Info@Example.KZ '), 'info@example.kz');
  for (const bad of ['mailto:info@example.kz', 'Имя <info@example.kz>', 'info@example', 'a@b@example.kz', 'info@example.kz, x@example.kz', 'javascript:alert(1)//@example.kz']) {
    assert.equal(normalizeEmail(bad), null, bad);
  }
});

test('значения по типам', () => {
  const t = (type: FieldDef['type'], raw: unknown, extra: Partial<FieldDef> = {}) => coerceValue(field('f', { type, ...extra }), raw);
  assert.deepEqual(t('text', '  а\nб  '), { ok: true, value: 'а б' });
  assert.deepEqual(t('textarea', 'а\r\nб'), { ok: true, value: 'а\nб' });
  assert.deepEqual(t('text', 'x'.repeat(501)), { ok: false, code: 'too_long' });
  assert.deepEqual(t('text', 'a\u0000'), { ok: false, code: 'type' });
  assert.deepEqual(t('text', ''), { ok: true, value: null });
  assert.deepEqual(t('money', '450 000'), { ok: true, value: 450000 });
  assert.deepEqual(t('money', 1.5), { ok: false, code: 'type' });
  assert.deepEqual(t('money', -1), { ok: false, code: 'range' });
  assert.deepEqual(t('number', '1,5'), { ok: true, value: 1.5 });
  assert.deepEqual(t('date', '2026-02-30'), { ok: false, code: 'date' });
  assert.deepEqual(t('date', '2026-10-28'), { ok: true, value: '2026-10-28' });
  assert.deepEqual(t('datetime', 1_800_000_000_000), { ok: true, value: 1_800_000_000_000 });
  assert.deepEqual(t('boolean', 'true'), { ok: true, value: true });
  assert.deepEqual(t('phone', '8 709 000 11 22'), { ok: true, value: '77090001122' });
  assert.deepEqual(t('phone', '111'), { ok: false, code: 'phone' });
  assert.deepEqual(t('user', 'u-1'), { ok: true, value: 'u-1' });
  assert.deepEqual(coerceValue(field('f', { type: 'user' }), 'u-2', { isUser: (id) => id === 'u-1' }), { ok: false, code: 'user' });
  const niche = FIELDS[0]!;
  assert.deepEqual(coerceValue(niche, 'old'), { ok: false, code: 'option' });
  assert.deepEqual(coerceValue(niche, 'old', {}, 'old'), { ok: true, value: 'old' });
  const tags = FIELDS.find((f) => f.key === 'tags')!;
  assert.deepEqual(coerceValue(tags, ['b', 'a', 'b']), { ok: true, value: ['a', 'b'] });
  assert.deepEqual(coerceValue(tags, ['z']), { ok: false, code: 'option' });
});

test('проверка от сотрудника: скрытое = нет поля, read = forbidden, плохое значение блокирует', () => {
  const v = buildFieldValidator({ fields: FIELDS, object: 'client', mode: 'user', viewer: operator });
  const r = v.validate({ secret: 'x', nope: 1, legacy: 'y', site: 'javascript:alert(1)', niche: 'retail', extra: 'z' }, {});
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.errors.sort((a, b) => a.key.localeCompare(b.key)),
    [
      { key: 'extra', code: 'unknown_field' },
      { key: 'legacy', code: 'archived' },
      { key: 'nope', code: 'unknown_field' },
      { key: 'secret', code: 'unknown_field' },
      { key: 'site', code: 'url' },
    ],
  );
  const w = buildFieldValidator({ fields: FIELDS, object: 'client', mode: 'user', viewer: watcher });
  assert.deepEqual(w.validate({ niche: 'retail' }, {}).errors, [{ key: 'niche', code: 'forbidden' }]);
  assert.throws(() => buildFieldValidator({ fields: FIELDS, object: 'client', mode: 'user' }), /viewer/);
});

test('изменения: только реальные, было → стало, очистка = null', () => {
  const v = buildFieldValidator({ fields: FIELDS, object: 'client', mode: 'user', viewer: operator });
  const r = v.validate({ niche: 'retail', site: 'example.kz', head: '' }, { niche: 'retail', head: 'Иванов', orphan: 'x' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch, { site: 'https://example.kz/', head: null });
  assert.deepEqual(r.changes, [
    { key: 'site', before: null, after: 'https://example.kz/' },
    { key: 'head', before: 'Иванов', after: null },
  ]);
  assert.deepEqual(r.next, { niche: 'retail', orphan: 'x', site: 'https://example.kz/' });
});

test('обязательность: очистить нельзя; итог требует заполнения; недоступное роли не требуется', () => {
  const always = [...FIELDS, field('must', { required: { always: true, onOutcome: [], onStage: [] } })];
  const edit = buildFieldValidator({ fields: always, object: 'client', mode: 'user', viewer: operator });
  assert.deepEqual(edit.validate({ must: '' }, { must: 'x' }).errors, [{ key: 'must', code: 'required' }]);
  assert.equal(edit.validate({ site: 'https://example.kz' }, {}).ok, true, 'правка другого поля не требует заполнить must');

  const agreed = buildFieldValidator({ fields: FIELDS, object: 'client', mode: 'user', viewer: operator, transition: { kind: 'outcome', outcome: 'agreed' } });
  assert.deepEqual(agreed.validate({}, {}).errors, [{ key: 'niche', code: 'required' }]);
  assert.equal(agreed.validate({ niche: 'other' }, {}).ok, true);
  const other = buildFieldValidator({ fields: FIELDS, object: 'client', mode: 'user', viewer: operator, transition: { kind: 'outcome', outcome: 'callback' } });
  assert.equal(other.validate({}, {}).ok, true);

  const hiddenReq = [field('h', { access: { '*': 'hidden' }, required: { always: false, onOutcome: ['agreed'], onStage: [] } })];
  const hv = buildFieldValidator({ fields: hiddenReq, object: 'client', mode: 'user', viewer: operator, transition: { kind: 'outcome', outcome: 'agreed' } });
  assert.equal(hv.validate({}, {}).ok, true);
  const sys = buildFieldValidator({ fields: hiddenReq, object: 'client', mode: 'system', transition: { kind: 'outcome', outcome: 'agreed' } });
  assert.deepEqual(sys.missingRequired({}), [{ key: 'h', code: 'required' }]);
});

test('приём: лишнее и плохое отбрасывается с предупреждением; ФИО — по источнику; только пустые', () => {
  const v = buildFieldValidator({ fields: FIELDS, object: 'client', mode: 'ingest', allowPersonNames: false });
  const r = v.validate({ site: 'javascript:alert(1)', mail: 'info@example.kz', head: 'Иванов', size: 5, nope: 1, legacy: 'x' }, {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch, { mail: 'info@example.kz' });
  assert.deepEqual(
    r.warnings.map((w) => `${w.key}:${w.code}`).sort(),
    ['head:person_dropped', 'legacy:archived', 'nope:not_ingest', 'site:url', 'size:not_ingest'],
  );
  const fill = buildFieldValidator({ fields: FIELDS, object: 'client', mode: 'ingest', allowPersonNames: true, onlyEmpty: true });
  assert.deepEqual(fill.validate({ mail: 'new@example.kz', head: 'Петров' }, { mail: 'old@example.kz' }).patch, { head: 'Петров' });
});

test('системный путь: без ролей, но ошибки блокируют', () => {
  const v = buildFieldValidator({ fields: FIELDS, object: 'client', mode: 'system' });
  assert.equal(v.validate({ secret: 'x', size: 10 }, {}).ok, true);
  assert.deepEqual(v.validate({ legacy: 'x' }, {}).errors, [{ key: 'legacy', code: 'archived' }]);
  assert.deepEqual(v.validate({ site: 'data:x' }, {}).errors, [{ key: 'site', code: 'url' }]);
});

test('проекция: скрытые и неизвестные ключи не выходят; ссылки перепроверены', () => {
  const values = { secret: 's', orphan: 'o', site: 'javascript:alert(1)', mail: 'info@example.kz', niche: 'old', legacy: 'l' };
  const p = projectFor(operator, 'client', FIELDS, values);
  const keys = p.fields.map((f) => f.key);
  assert.ok(!keys.includes('secret'));
  assert.ok(!('secret' in p.values) && !('orphan' in p.values));
  assert.ok(!keys.includes('extra'), 'поле контакта не входит в клиента');
  const site = p.fields.find((f) => f.key === 'site')!;
  assert.equal(site.href, null, 'плохая ссылка из старых данных не становится href');
  assert.equal(p.fields.find((f) => f.key === 'mail')!.href, 'mailto:info@example.kz');
  const niche = p.fields.find((f) => f.key === 'niche')!;
  assert.deepEqual(niche.options.map((o) => o.key), ['retail', 'old', 'other'], 'выбранный архивный вариант виден');
  assert.equal(p.fields.find((f) => f.key === 'legacy')!.access, 'read');
  assert.ok(!projectFor(operator, 'client', FIELDS, {}).fields.some((f) => f.key === 'legacy'), 'пустое архивное поле не показывается');
  assert.deepEqual(projectValues(operator, 'client', FIELDS, values), { niche: 'old', site: 'javascript:alert(1)', mail: 'info@example.kz', legacy: 'l' });
  const mgr: FieldViewer = { roleKey: 'manager', fieldAccessDefault: 'edit', canEdit: true };
  assert.equal(projectValues(mgr, 'client', FIELDS, values).secret, 's');
});

test('лента: событие скрытого поля скрыто; белый список obj:key', () => {
  assert.equal(canSeeFieldChange(operator, FIELDS, { obj: 'client', sys: false, field: 'secret' }), false);
  assert.equal(canSeeFieldChange(operator, FIELDS, { obj: 'client', sys: false, field: 'gone' }), false);
  assert.equal(canSeeFieldChange(operator, FIELDS, { obj: 'client', sys: false, field: 'niche' }), true);
  assert.equal(canSeeFieldChange(operator, FIELDS, { obj: 'client', sys: true, field: 'name' }), true);
  const refs = visibleFieldRefs(operator, FIELDS);
  assert.ok(refs.includes('client:niche') && refs.includes('contact:extra') && !refs.includes('client:secret'));
});

test('фильтр: только filterable и видимое', () => {
  assert.equal(filterableField(FIELDS, 'client', operator, 'niche')?.key, 'niche');
  assert.equal(filterableField(FIELDS, 'client', operator, 'site'), null);
  assert.equal(filterableField([field('s', { filterable: true, access: { '*': 'hidden' } })], 'client', operator, 's'), null);
});

test('поиск: search_norm и разбор запроса', () => {
  const roles = [
    { key: 'operator', fieldAccessDefault: 'edit' as const },
    { key: 'watcher', fieldAccessDefault: 'read' as const },
  ];
  const defs = [
    field('head', { searchable: true }),
    field('secret', { searchable: true, access: { '*': 'read', watcher: 'hidden' } }),
    field('tags', { searchable: true, type: 'multiselect', options: [{ key: 'a', label: { ru: 'А' } }] }),
  ];
  assert.deepEqual(searchableKeys(defs, roles), ['head']);
  assert.deepEqual(searchableKeys(defs, [...roles.slice(0, 1), { key: 'watcher', fieldAccessDefault: 'read', archived: true }]), ['head', 'secret']);
  const norm = buildSearchNorm({
    name: 'ТОО «Қазақ Строй-Сервис»',
    orgId: '123456789012',
    phones: ['77090001122', '77090001122'],
    custom: { head: 'Иванов Ёжик', secret: 'тайна' },
    searchable: ['head'],
  });
  assert.equal(norm, 'тоо казак строй сервис | 123456789012 | 77090001122 | иванов ежик');
  assert.deepEqual(parseSearchQuery(''), { kind: 'none' });
  assert.deepEqual(parseSearchQuery('ка'), { kind: 'short' });
  assert.deepEqual(parseSearchQuery('Қазақ'), { kind: 'text', patterns: ['%казак%'] });
  assert.deepEqual(parseSearchQuery('100%_x'), { kind: 'text', patterns: ['%100 x%'] });
  assert.deepEqual(parseSearchQuery('+7 709'), { kind: 'short' });
  assert.deepEqual(parseSearchQuery('8 (709) 000-11'), { kind: 'digits', patterns: ['%870900011%', '%770900011%'] });
  assert.deepEqual(parseSearchQuery('00011'), { kind: 'digits', patterns: ['%00011%'] });
});

test('системные поля: права, БИН, форма с личным номером, обязательное название', () => {
  const forms = [
    { key: 'llp', idIsPersonal: false },
    { key: 'sole', idIsPersonal: true },
  ];
  const current = { name: 'ТОО Альфа', legal_form: 'llp', org_id: '123456789012', email: '', website: '' };
  const op = validateSystemPatch({ object: 'client', patch: { name: 'Бета', email: 'A@Example.kz' }, current, can: { identity: false, edit: true }, legalForms: forms });
  assert.deepEqual(op.errors, [{ key: 'name', code: 'forbidden' }]);
  assert.deepEqual(op.columns, {});
  const ok = validateSystemPatch({ object: 'client', patch: { email: 'A@Example.kz', website: 'javascript:x' }, current, can: { identity: false, edit: true }, legalForms: forms });
  assert.deepEqual(ok.errors, [{ key: 'website', code: 'url' }]);
  const good = validateSystemPatch({ object: 'client', patch: { email: 'A@Example.kz', region: '' }, current, can: { identity: false, edit: true }, legalForms: forms });
  assert.deepEqual(good.columns, { email: 'a@example.kz' });
  assert.deepEqual(good.changes, [{ key: 'email', before: null, after: 'a@example.kz' }]);
  const rop = validateSystemPatch({ object: 'client', patch: { org_id: '1234 5678 9013', name: '' }, current, can: { identity: true, edit: true }, legalForms: forms });
  assert.deepEqual(rop.errors, [{ key: 'name', code: 'required' }]);
  const bin = validateSystemPatch({ object: 'client', patch: { org_id: '1234 5678 9013' }, current, can: { identity: true, edit: true }, legalForms: forms });
  assert.deepEqual(bin.columns, { org_id: '123456789013' });
  assert.deepEqual(validateSystemPatch({ object: 'client', patch: { org_id: '123' }, current, can: { identity: true, edit: true }, legalForms: forms }).errors, [{ key: 'org_id', code: 'type' }]);
  const sole = validateSystemPatch({ object: 'client', patch: { legal_form: 'sole' }, current, can: { identity: true, edit: true }, legalForms: forms });
  assert.deepEqual(sole.columns, { legal_form: 'sole', org_id: '' });
  assert.deepEqual(validateSystemPatch({ object: 'client', patch: { legal_form: 'sole', org_id: '123456789012' }, current, can: { identity: true, edit: true }, legalForms: forms }).errors, [{ key: 'org_id', code: 'type' }]);
  assert.deepEqual(validateSystemPatch({ object: 'client', patch: { legal_form: 'nope' }, current, can: { identity: true, edit: true }, legalForms: forms }).errors, [{ key: 'legal_form', code: 'option' }]);
  assert.deepEqual(validateSystemPatch({ object: 'client', patch: { custom: 1 }, current, can: { identity: true, edit: true } }).errors, [{ key: 'custom', code: 'unknown_field' }]);
  const ct = validateSystemPatch({ object: 'contact', patch: { is_decision_maker: true, name: 'Иванов' }, current: { is_decision_maker: false, name: '' }, can: { identity: false, edit: true } });
  assert.deepEqual(ct.columns, { is_decision_maker: true, name: 'Иванов' });
  assert.deepEqual(reservedKeyIssues([field('email'), field('niche'), field('name', { object: 'contact' })]).map((i) => i.key), ['email', 'name']);
});
