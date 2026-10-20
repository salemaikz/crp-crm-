import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfigSet, assertConfigSet, ConfigInvalidError } from './validate.js';
import { minimalSet } from './testing/minimal.js';
import { parseStep } from './steps.js';
import { parsePath, setAt } from './paths.js';
import type { Json, JsonObject } from './json.js';

type Set = ReturnType<typeof minimalSet>;

/** Правка набора по пути (`global.…` или `spaces.sales.…`) и список путей ошибок. */
function issuesAfter(edit: (s: Set) => Json): string[] {
  const r = validateConfigSet(edit(minimalSet()));
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
}
const at = (path: string, value: Json) => (s: Set) => setAt(s as unknown as JsonObject, parsePath(path), value);
const expectIssue = (edit: (s: Set) => Json, needle: string) => {
  const iss = issuesAfter(edit);
  assert.ok(iss.some((i) => i.includes(needle)), `ожидалась ошибка «${needle}», получили: ${JSON.stringify(iss)}`);
};

test('минимальный набор проходит проверку', () => {
  const r = validateConfigSet(minimalSet());
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.issues, null, 2));
});

test('схема без умолчаний: пропущенный ключ — ошибка', () => {
  expectIssue((s) => {
    delete (s.spaces.sales!.distribution as JsonObject).dailyCap;
    return s as unknown as Json;
  }, 'spaces.sales.distribution.dailyCap');
});

test('неизвестный ключ — ошибка (strict, D-060)', () => {
  expectIssue(at('spaces.sales.distribution.dailyCapp', 40), 'dailyCapp');
  expectIssue(at('global.org.extra', 1), 'extra');
});

test('диапазоны и форматы', () => {
  expectIssue(at('spaces.sales.distribution.dailyCap', 501), 'dailyCap');
  expectIssue(at('spaces.sales.calling.undoSeconds', 11), 'undoSeconds');
  expectIssue(at('global.calendar.workHours.start', '25:00'), 'workHours.start');
  expectIssue(at('global.calendar.workHours', { start: '18:00', end: '09:00' }), 'workHours.end');
  expectIssue(at('global.calendar.holidays', [{ date: '2026-02-30', kind: 'holiday', note: '' }]), 'несуществующая дата');
  expectIssue(at('global.org.timezone', 'Mars/Base'), 'org.timezone');
  expectIssue(at('global.theme.logo', '../etc/passwd'), 'theme.logo');
  expectIssue(at('global.org.defaultLocale', 'kk'), 'defaultLocale');
  expectIssue(at('spaces.sales.queue.order', ['callbacks', 'retries', 'new']), 'queue.order');
  expectIssue(at('spaces.sales.distribution.capIncludes', ['auto', 'merge']), 'capIncludes');
  expectIssue(at('spaces.sales.serviceTypes', [{ key: 'Bad-Key', label: { ru: 'x' }, routeToTeam: null }]), 'serviceTypes.0.key');
});

test('повтор ключа и даты в списке', () => {
  expectIssue(at('spaces.sales.serviceTypes', [
    { key: 'svc', label: { ru: 'a' }, routeToTeam: null },
    { key: 'svc', label: { ru: 'b' }, routeToTeam: null },
  ]), 'повтор ключа');
  expectIssue(at('global.calendar.holidays', [
    { date: '2026-01-01', kind: 'holiday', note: '' },
    { date: '2026-01-01', kind: 'workday', note: '' },
  ]), 'не должны повторяться');
});

test('каждый из 7 видов итога покрыт неархивным итогом', () => {
  expectIssue(at('spaces.sales.calling.outcomes[key=do_not_call].archived', true), 'вида «do_not_call»');
});

test('ссылки: группа причин, поле, роль, команда, тип мероприятия', () => {
  expectIssue(at('spaces.sales.calling.outcomes[key=not_interested].reasonGroup', 'nope'), 'группы причин «nope»');
  expectIssue(at('spaces.sales.calling.outcomes[key=agreed].requires.reason', true), 'группа причин не задана');
  expectIssue(at('spaces.sales.calling.outcomes[key=agreed].requires.fields', ['niche']), 'поля «niche»');
  expectIssue(at('spaces.sales.distribution.participantRoles', ['ghost']), 'роли «ghost»');
  expectIssue(at('spaces.sales.tasks.askNextStep', { ghost: true }), 'роли «ghost»');
  expectIssue(at('global.team.fallbackOwnerRole', 'ghost'), 'роли «ghost»');
  expectIssue(at('spaces.sales.serviceTypes[key=service].routeToTeam', 'marketing'), 'команды «marketing»');
  expectIssue(at('spaces.sales.calling.callbackPresets', ['nextEvent:group_session@10:00']), 'типа мероприятия «group_session»');
});

test('повторы: шагов не меньше maxAttempts − 1; шаги разбираются', () => {
  expectIssue(at('spaces.sales.calling.retry.maxAttempts', 5), 'maxAttempts − 1 = 4');
  expectIssue(at('spaces.sales.calling.retry.steps', ['+2h', 'tomorrow']), 'retry.steps.1');
  expectIssue(at('spaces.sales.calling.retry.steps', ['+2h', 'nextEvent:x_y@10:00']), 'retry.steps.1');
});

test('воронка: ровно один won и хотя бы один lost', () => {
  expectIssue(at('spaces.sales.pipelines[key=sales].stages[key=paid].kind', 'open'), 'won должен быть ровно один (сейчас 0)');
  expectIssue(at('spaces.sales.pipelines[key=sales].stages[key=lost].archived', true), 'хотя бы один этап вида lost');
});

test('пространства: ровно одно по умолчанию, документ на каждое объявленное', () => {
  expectIssue(at('global.spaces[key=sales].default', false), 'ровно одно');
  expectIssue((s) => {
    s.spaces.extra = s.spaces.sales!;
    return s as unknown as Json;
  }, 'не объявлено в global.spaces');
  expectIssue(at('global.spaces[key=service]', { key: 'service', label: { ru: 'Сервис' }, enabled: true, default: false }), 'нет документа пространства «service»');
});

test('мероприятия, серии, направления, напоминания', () => {
  const group = { key: 'group_session', behavior: 'group', label: { ru: 'Групповое' }, short: { ru: 'ГС' }, capacity: null, durationMin: 180, directions: ['other'] };
  expectIssue(at('spaces.sales.booking.eventTypes', [group]), 'нужно число мест');
  expectIssue(at('spaces.sales.booking.eventTypes', [group]), 'направления «other»');
  const indiv = { key: 'consult', behavior: 'individual', label: { ru: 'Консультация' }, short: { ru: 'К' }, capacity: null, durationMin: 45, directions: [] };
  expectIssue(
    (s) => setAt(at('spaces.sales.booking.eventTypes', [indiv])(s), parsePath('spaces.sales.booking.seedSeries'), [
      { key: 's1', eventTypeKey: 'consult', weekday: 4, startTime: '15:00', durationMin: 180, location: '', format: 'offline', capacity: 30 },
    ]),
    'группового типа мероприятия «consult»',
  );
  expectIssue(at('spaces.sales.reminders.templates[key=default].text.ru', 'Привет, {name}! {phone}'), '«{phone}» не из белого списка');
});

test('поля: роли в доступе, варианты только у списков, ключи не пересекаются с global', () => {
  const field = (extra: JsonObject): JsonObject => ({
    key: 'niche',
    object: 'card',
    type: 'text',
    label: { ru: 'Ниша' },
    options: [],
    access: { '*': 'edit' },
    required: { always: false, onOutcome: [], onStage: [] },
    searchable: false,
    filterable: false,
    ingest: false,
    pii: 'none',
    showOn: { card: true, kanban: false, list: false },
    ...extra,
  });
  assert.deepEqual(issuesAfter(at('spaces.sales.fields', [field({ required: { always: false, onOutcome: ['agreed'], onStage: ['paid'] } })])), []);
  expectIssue(at('spaces.sales.fields', [field({ access: { ghost: 'read' } })]), 'роли «ghost»');
  expectIssue(at('spaces.sales.fields', [field({ type: 'select' })]), 'хотя бы один неархивный вариант');
  expectIssue(at('spaces.sales.fields', [field({ options: [{ key: 'a', label: { ru: 'А' } }] })]), 'варианты есть только');
  expectIssue(at('spaces.sales.fields', [field({ object: 'client' })]), 'spaces.sales.fields.0.object');
  expectIssue(
    (s) => setAt(at('spaces.sales.fields', [field({})])(s), parsePath('global.fields'), [field({ object: 'client' })]),
    'уже занят полем global',
  );
  // поле с обязательностью по итогу ссылается на существующий итог; поле итога — существует
  expectIssue(at('spaces.sales.fields', [field({ required: { always: false, onOutcome: ['ghost'], onStage: [] } })]), 'итога «ghost»');
  assert.deepEqual(
    issuesAfter((s) => setAt(at('spaces.sales.fields', [field({})])(s), parsePath('spaces.sales.calling.outcomes[key=agreed].requires.fields'), ['niche'])),
    [],
  );
});

test('роли: полная схема роли и roleValidator с путём в наборе', () => {
  assert.deepEqual(issuesAfter(at('global.roles[key=manager].grants', [{ perm: 'card.read', scope: 'own' }])), []);
  expectIssue(at('global.roles[key=manager].label', 'строка'), 'roles.0.label');
  expectIssue(at('global.roles[key=manager].grants', [{ perm: 'nope.read', scope: 'own' }]), 'roles.0.grants.0.perm');
  expectIssue(at('global.roles[key=manager].grants', [{ perm: 'card.assign', scope: 'own' }]), 'scope_too_narrow');
  expectIssue(at('global.roles[key=manager].grants', [{ perm: 'card.read', scope: 'own' }, { perm: 'card.read', scope: 'space' }]), 'duplicate_grant');
});

test('assertConfigSet бросает ConfigInvalidError со списком', () => {
  const s = minimalSet();
  (s.spaces.sales!.distribution as JsonObject).dailyCap = -1;
  assert.throws(() => assertConfigSet(s), (e: unknown) => e instanceof ConfigInvalidError && e.issues.length > 0 && /dailyCap/.test(e.message));
});

test('parseStep', () => {
  assert.deepEqual(parseStep('+2h'), { kind: 'plus', minutes: 120 });
  assert.deepEqual(parseStep('+30m'), { kind: 'plus', minutes: 30 });
  assert.deepEqual(parseStep('nextWorkday@10:00'), { kind: 'nextWorkday', time: '10:00' });
  assert.deepEqual(parseStep('nextEvent:group_session@09:30'), { kind: 'nextEvent', eventTypeKey: 'group_session', time: '09:30' });
  for (const bad of ['+0h', '2h', '+2d', '+721h', 'nextWorkday@24:00', 'nextEvent:Bad@10:00', 'nextEvent:x@10:00']) assert.equal(parseStep(bad), null, bad);
});
