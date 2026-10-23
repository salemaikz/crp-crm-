// Связи между ключами набора настроек (CONFIG §3.3). Вызывается из superRefine схемы ConfigSetV1:
// документ, который не прошёл проверку, не записывается. Ссылка на архивный ключ допустима
// (данные с ним остаются читаемыми), но «живые» требования считают только неархивные элементы.
import { z } from 'zod';
import { OUTCOME_KINDS } from '../calling/spec/types.js';
import type { GlobalConfigV1, SpaceConfigV1 } from './schema/v1.js';
import { REMINDER_PLACEHOLDERS } from './schema/constants.js';
import { validateRoles } from '../access/roleValidator';
import { parseStep } from './steps.js';
import { checkPipelineV2 } from './integrityPipelineV2.js';

type SetInput = { global: GlobalConfigV1; spaces: Record<string, SpaceConfigV1> };
type P = (string | number)[];

const live = <T extends { archived?: boolean | undefined }>(xs: readonly T[]) => xs.filter((x) => !x.archived);
const keysOf = (xs: readonly { key: string }[]) => new Set(xs.map((x) => x.key));

/** Подстановки `{…}` в тексте шаблона. */
export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] as string);
}

export function checkConfigSet(set: SetInput, ctx: z.RefinementCtx): void {
  const issue = (path: P, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  const ref = (path: P, value: string, allowed: ReadonlySet<string>, what: string) => {
    if (!allowed.has(value)) issue(path, `нет ${what} «${value}»`);
  };
  const g = set.global;
  const roles = keysOf(g.roles);
  // Роли: опасные сочетания охватов, readOnly, действия отношений (roleValidator, ARCHITECTURE §5.1 п. 5)
  for (const ri of validateRoles(g.roles)) issue(['global', 'roles', ...ri.path], `${ri.code}: ${ri.message}`);

  // --- пространства: ровно одно по умолчанию, у каждого есть документ, лишних документов нет
  const defaults = g.spaces.filter((s) => s.default);
  if (defaults.length !== 1) issue(['global', 'spaces'], `пространство по умолчанию должно быть ровно одно (сейчас ${defaults.length})`);
  else if (!defaults[0]?.enabled) issue(['global', 'spaces'], 'пространство по умолчанию должно быть включено');
  const declared = keysOf(g.spaces);
  for (const k of declared) if (!set.spaces[k]) issue(['spaces', k], `нет документа пространства «${k}»`);
  for (const k of Object.keys(set.spaces)) if (!declared.has(k)) issue(['spaces', k], `пространство «${k}» не объявлено в global.spaces`);

  ref(['global', 'team', 'fallbackOwnerRole'], g.team.fallbackOwnerRole, roles, 'роли');

  // --- поля global: доступ по ролям, варианты; обязательность по итогу/этапу — ключи хоть одного пространства
  const allOutcomes = new Set<string>();
  const allStages = new Set<string>();
  for (const sp of Object.values(set.spaces)) {
    for (const o of sp.calling.outcomes) allOutcomes.add(o.key);
    for (const p of sp.pipelines) for (const s of p.stages) allStages.add(s.key);
  }
  const globalFieldKeys = keysOf(g.fields);
  g.fields.forEach((f, i) => checkField(f, ['global', 'fields', i], roles, allOutcomes, allStages, issue, ref));

  for (const [spaceKey, sp] of Object.entries(set.spaces)) {
    const base: P = ['spaces', spaceKey];
    const at = (...p: P): P => [...base, ...p];

    // поля пространства: ключи не пересекаются с полями global (на них ссылаются requires.fields)
    const outcomes = keysOf(sp.calling.outcomes);
    const stages = new Set(sp.pipelines.flatMap((p) => p.stages.map((s) => s.key)));
    sp.fields.forEach((f, i) => {
      if (globalFieldKeys.has(f.key)) issue(at('fields', i, 'key'), `ключ поля «${f.key}» уже занят полем global`);
      checkField(f, at('fields', i), roles, outcomes, stages, issue, ref);
    });
    const fieldKeys = new Set([...globalFieldKeys, ...keysOf(sp.fields)]);

    // итоги: каждый из 7 видов покрыт неархивным итогом; причины и поля существуют
    const liveKinds = new Set(live(sp.calling.outcomes).map((o) => o.kind));
    for (const k of OUTCOME_KINDS) if (!liveKinds.has(k)) issue(at('calling', 'outcomes'), `нет неархивного итога вида «${k}»`);
    const reasonGroups = new Set(Object.keys(sp.reasons));
    sp.calling.outcomes.forEach((o, i) => {
      if (o.reasonGroup !== null) ref(at('calling', 'outcomes', i, 'reasonGroup'), o.reasonGroup, reasonGroups, 'группы причин');
      else if (o.requires.reason) issue(at('calling', 'outcomes', i, 'reasonGroup'), 'итог требует причину, но группа причин не задана');
      o.requires.fields.forEach((fk, j) => ref(at('calling', 'outcomes', i, 'requires', 'fields', j), fk, fieldKeys, 'поля'));
    });

    // повторы: у каждой попытки до списания свой срок
    const { steps, maxAttempts } = sp.calling.retry;
    if (steps.length < maxAttempts - 1) issue(at('calling', 'retry', 'steps'), `шагов ${steps.length}, нужно не меньше maxAttempts − 1 = ${maxAttempts - 1}`);

    // шаги «до следующего мероприятия» ссылаются на тип мероприятия
    const eventTypes = keysOf(sp.booking.eventTypes);
    sp.calling.callbackPresets.forEach((s, i) => {
      const st = parseStep(s);
      if (st?.kind === 'nextEvent') ref(at('calling', 'callbackPresets', i), st.eventTypeKey, eventTypes, 'типа мероприятия');
    });

    checkPipelineV2(sp, at, issue, ref);

    // роли в настройках процесса
    sp.distribution.participantRoles.forEach((r, i) => ref(at('distribution', 'participantRoles', i), r, roles, 'роли'));
    ref(at('distribution', 'inbound', 'offHours'), sp.distribution.inbound.offHours, roles, 'роли');
    sp.handoff.alarmTo.forEach((r, i) => ref(at('handoff', 'alarmTo', i), r, roles, 'роли'));
    ref(at('booking', 'duty', 'defaultRole'), sp.booking.duty.defaultRole, roles, 'роли');
    sp.export.allowedRoles.forEach((r, i) => ref(at('export', 'allowedRoles', i), r, roles, 'роли'));
    for (const r of Object.keys(sp.tasks.askNextStep)) ref(at('tasks', 'askNextStep', r), r, roles, 'роли');

    // воронки: в каждой живой — ровно один won и хотя бы один lost
    if (live(sp.pipelines).length === 0) issue(at('pipelines'), 'нужна хотя бы одна неархивная воронка');
    sp.pipelines.forEach((p, i) => {
      if (p.archived) return;
      const ls = live(p.stages);
      const won = ls.filter((s) => s.kind === 'won').length;
      if (won !== 1) issue(at('pipelines', i, 'stages'), `этап вида won должен быть ровно один (сейчас ${won})`);
      if (!ls.some((s) => s.kind === 'lost')) issue(at('pipelines', i, 'stages'), 'нужен хотя бы один этап вида lost');
      p.stages.forEach((s, j) => s.requires.fields.forEach((fk, k) => ref(at('pipelines', i, 'stages', j, 'requires', 'fields', k), fk, fieldKeys, 'поля')));
    });

    // услуги → команды
    const teams = keysOf(sp.teams);
    sp.serviceTypes.forEach((s, i) => {
      if (s.routeToTeam !== null) ref(at('serviceTypes', i, 'routeToTeam'), s.routeToTeam, teams, 'команды');
    });

    // запись: типы мероприятий, направления, серии, окна
    const directions = keysOf(sp.booking.directions);
    sp.booking.eventTypes.forEach((e, i) => {
      e.directions.forEach((d, j) => ref(at('booking', 'eventTypes', i, 'directions', j), d, directions, 'направления'));
      if (e.behavior === 'group' && e.capacity === null) issue(at('booking', 'eventTypes', i, 'capacity'), 'у группового мероприятия нужно число мест');
      if (e.behavior === 'individual' && e.capacity !== null) issue(at('booking', 'eventTypes', i, 'capacity'), 'у индивидуального мероприятия мест нет (null)');
    });
    const groupTypes = new Set(sp.booking.eventTypes.filter((e) => e.behavior === 'group').map((e) => e.key));
    sp.booking.seedSeries.forEach((s, i) => ref(at('booking', 'seedSeries', i, 'eventTypeKey'), s.eventTypeKey, groupTypes, 'группового типа мероприятия'));
    const ch = sp.booking.consult.hours;
    if (ch.start >= ch.end) issue(at('booking', 'consult', 'hours', 'end'), 'start должен быть раньше end');
    const gs = sp.booking.grey.schedule;
    if (gs.first > gs.last) issue(at('booking', 'grey', 'schedule', 'last'), 'first не позже last');

    // напоминания: тип мероприятия и белый список подстановок
    sp.reminders.templates.forEach((t, i) => {
      if (t.eventTypeKey !== null) ref(at('reminders', 'templates', i, 'eventTypeKey'), t.eventTypeKey, eventTypes, 'типа мероприятия');
      for (const lang of ['ru', 'kk'] as const) {
        for (const ph of placeholdersOf(t.text[lang] ?? '')) {
          if (!REMINDER_PLACEHOLDER_SET.has(ph)) issue(at('reminders', 'templates', i, 'text', lang), `подстановка «{${ph}}» не из белого списка`);
        }
      }
    });

    // импорт: итоги в карте значений и приоритете; слоты владельцев; куда пишутся поля (D-191)
    const cardFields = new Set(sp.fields.filter((f) => f.object === 'card').map((f) => f.key));
    const clientFields = new Set(g.fields.filter((f) => f.object === 'client').map((f) => f.key));
    sp.import.profiles.forEach((p, i) => {
      const pp = (...x: P): P => at('import', 'profiles', i, ...x);
      for (const [col, ok] of Object.entries(p.valueMaps.outcome)) ref(pp('valueMaps', 'outcome', col), ok, outcomes, 'итога');
      p.outcomePriority.forEach((ok, j) => ref(pp('outcomePriority', j), ok, outcomes, 'итога'));
      const slots = p.ownerSlots ?? [];
      if (slots.length > 0 && p.ownerBy !== 'row_ranges') issue(pp('ownerSlots'), 'слоты владельцев — только при ownerBy = row_ranges');
      const labels = new Set<string>();
      slots.forEach((s, j) => {
        // Ярлыки сравниваются так же, как в карте владельцев: без регистра, ё = е, пробелы схлопнуты
        const norm = s.label.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
        if (labels.has(norm)) issue(pp('ownerSlots', j, 'label'), `ярлык слота «${s.label}» повторяется`);
        labels.add(norm);
        s.ranges.forEach(([from, to], k) => {
          if (from > to) issue(pp('ownerSlots', j, 'ranges', k), `диапазон ${from}–${to}: начало больше конца`);
        });
      });
      for (const [from, t] of Object.entries(p.fieldTargets ?? {})) {
        const allowed = t.object === 'client' ? clientFields : cardFields;
        ref(pp('fieldTargets', from, 'fieldKey'), t.fieldKey, allowed, t.object === 'client' ? 'поля клиента' : 'поля карточки');
      }
      if ((p.kind ?? 'clients') === 'bookings') checkBookingsProfile(p, pp, issue, ref, eventTypes, groupTypes);
      else {
        // Ключи профиля «Записи» у таблиц клиентов не используются: тихо оставленный ключ ввёл бы в заблуждение
        if (p.valueMaps.eventType !== undefined) issue(pp('valueMaps', 'eventType'), 'карта видов мероприятий — только у профиля bookings');
        if (p.defaultEventTypeKey !== undefined) issue(pp('defaultEventTypeKey'), 'вид по умолчанию — только у профиля bookings');
        if (p.maxRows !== undefined) issue(pp('maxRows'), 'предел строк профиля — только у bookings');
      }
    });
  }
}

type ImportProfileDoc = SpaceConfigV1['import']['profiles'][number];

/** Профиль «Записи» (D-324, import-bookings-design §3): колонка владельца, поля записи, виды мероприятий пространства. */
function checkBookingsProfile(
  p: ImportProfileDoc,
  pp: (...x: P) => P,
  issue: (p: P, m: string) => void,
  ref: (p: P, v: string, allowed: ReadonlySet<string>, what: string) => void,
  eventTypes: ReadonlySet<string>,
  groupTypes: ReadonlySet<string>,
): void {
  const fieldsSet = new Set(Object.values(p.columns));
  if (p.ownerBy !== 'column') issue(pp('ownerBy'), 'у профиля bookings автор берётся из колонки: ownerBy = column');
  if ((p.ownerSlots ?? []).length > 0) issue(pp('ownerSlots'), 'слоты владельцев не используются профилем bookings');
  if (Object.keys(p.fieldTargets ?? {}).length > 0) issue(pp('fieldTargets'), 'fieldTargets не используются профилем bookings');
  if ((p.noteMarkers ?? []).length > 0) issue(pp('noteMarkers'), 'noteMarkers не используются профилем bookings');
  if (Object.keys(p.valueMaps.outcome).length + Object.keys(p.valueMaps.lpr).length + Object.keys(p.valueMaps.target).length > 0) {
    issue(pp('valueMaps'), 'valueMaps.outcome, lpr и target не используются профилем bookings');
  }
  if (p.outcomePriority.length > 0) issue(pp('outcomePriority'), 'outcomePriority не используется профилем bookings');
  if (!fieldsSet.has('eventDate')) issue(pp('columns'), 'нужна колонка поля eventDate (дата мероприятия)');
  if (!fieldsSet.has('phones') && !fieldsSet.has('orgId')) issue(pp('columns'), 'нужна колонка phones или orgId: по чему искать клиента');
  if (!fieldsSet.has('eventType') && p.defaultEventTypeKey === undefined) issue(pp('columns'), 'нужна колонка eventType или defaultEventTypeKey');
  for (const [cell, key] of Object.entries(p.valueMaps.eventType ?? {})) ref(pp('valueMaps', 'eventType', cell), key, eventTypes, 'типа мероприятия');
  if (p.defaultEventTypeKey !== undefined) ref(pp('defaultEventTypeKey'), p.defaultEventTypeKey, groupTypes, 'группового типа мероприятия');
}

const REMINDER_PLACEHOLDER_SET: ReadonlySet<string> = new Set(REMINDER_PLACEHOLDERS);

type FieldLike = GlobalConfigV1['fields'][number] | SpaceConfigV1['fields'][number];

function checkField(
  f: FieldLike,
  path: P,
  roles: ReadonlySet<string>,
  outcomes: ReadonlySet<string>,
  stages: ReadonlySet<string>,
  issue: (p: P, m: string) => void,
  ref: (p: P, v: string, allowed: ReadonlySet<string>, what: string) => void,
): void {
  for (const r of Object.keys(f.access)) if (r !== '*' && !roles.has(r)) issue([...path, 'access', r], `нет роли «${r}»`);
  const withOptions = f.type === 'select' || f.type === 'multiselect';
  if (withOptions && live(f.options).length === 0) issue([...path, 'options'], 'у списка нужен хотя бы один неархивный вариант');
  if (!withOptions && f.options.length > 0) issue([...path, 'options'], `варианты есть только у select и multiselect, а тип — ${f.type}`);
  f.required.onOutcome.forEach((k, i) => ref([...path, 'required', 'onOutcome', i], k, outcomes, 'итога'));
  f.required.onStage.forEach((k, i) => ref([...path, 'required', 'onStage', i], k, stages, 'этапа'));
}
