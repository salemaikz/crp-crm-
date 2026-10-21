// Настройки импорта пространства (дизайн C4d §4, CONFIG §6.13). Раздел `import` читается из активных
// настроек; профиль собирается из настроек: карта итогов — importAliases итогов поверх карты профиля,
// виды итогов — из calling.outcomes[], правила источника kind=import — из sources[]. Слоты «диапазон строк →
// оператор», fieldTargets и noteMarkers — ключи схемы ConfigV1 (D-191): слоты задаёт установка через CLI,
// в пресете их нет. Подмены настроек для тестов нет: тесты пишут настоящую ревизию.
import { calling, dedup, fields, imports, names, phone, time } from '@crm/core';
import type { GlobalConfigV1, SpaceConfigV1 } from '@crm/core/config';
import { NotFoundError } from '@/server/access/errors';
import { getActiveConfig } from '@/server/platform/config/active';
import { BOOKINGS_DEFAULT_MAX_ROWS, type ConfigRevPair, type FieldTarget, type ImportProfileSetting, type ImportSettings } from './types';

const DAY_STEP = 'nextWorkday@10:00';

/** Всё, что импорту нужно из настроек: профили, нормализаторы, дедуп, календарь, итоги, поля. */
export interface ImportContext {
  spaceId: string;
  spaceKey: string;
  rev: ConfigRevPair;
  settings: ImportSettings;
  normalizers: imports.ImportNormalizers;
  dedup: dedup.DedupSettings;
  calling: calling.CallingSettings;
  calendar: calling.WorkCalendar;
  timeZone: string;
  phoneRules: phone.PhoneRules;
  /** Роли, участвующие в раздаче: из них выбираются владельцы строк. */
  participantRoles: readonly string[];
  /** Код формы собственности (`ип`) → ключ из org.legalForms (`ip`): в clients.legal_form лежит ключ. */
  legalKeyByCode: ReadonlyMap<string, string>;
  fieldDefs: readonly fields.FieldDef[];
  searchable: readonly string[];
  /** Подписи итогов для экрана: ключ → ru. */
  outcomeLabels: Readonly<Record<string, string>>;
  /** Профиль «Записи» (D-324): виды мероприятий пространства — подписи для экрана и ключи групповых. */
  eventTypeLabels: Readonly<Record<string, string>>;
  groupTypeKeys: ReadonlySet<string>;
  /** Итог вида `agreed` для перехода «Договорились» (первый не архивный); нет — блокер `no_agreed_outcome`. */
  agreedOutcomeKey: string | null;
}

function lprOf(v: boolean | string): 'yes' | 'no' {
  return v === true || v === 'yes' ? 'yes' : 'no';
}
function targetOf(v: boolean | string): 'target' | 'non_target' {
  return v === true || v === 'target' ? 'target' : 'non_target';
}

/** Чистая сборка из документов настроек (тестируется без БД). */
export function buildImportContext(input: { spaceId: string; spaceKey: string; rev: ConfigRevPair; global: GlobalConfigV1; space: SpaceConfigV1 }): ImportContext {
  const { global, space } = input;
  const outcomes = space.calling.outcomes;
  const kinds: Record<string, string> = Object.fromEntries(outcomes.map((o) => [o.key, o.kind]));
  const aliasMap: Record<string, string> = {};
  for (const o of outcomes) if (!o.archived) for (const a of o.importAliases) aliasMap[a] = o.key;

  // Формы собственности: код (`ип`) ↔ ключ; признак «личный номер» словаря (D-141)
  const legal = global.org.legalForms;
  const coreForms: names.LegalForm[] = names.legalFormsFromConfig(legal);
  const legalKeyByCode = new Map<string, string>();
  const codeByKey = new Map<string, string>();
  for (const f of coreForms) {
    const code = names.legalFormCode(f.key, coreForms);
    if (code) {
      legalKeyByCode.set(code, f.key);
      codeByKey.set(f.key, code);
    }
  }
  // Правила источника ссылаются на ключи форм; в разборе форма — код: добавляем коды рядом с ключами
  const withCodes = (rules: readonly dedup.SourceRule[]): dedup.SourceRule[] =>
    rules.map((r) => (r.type === 'legalFormIn' ? { ...r, values: r.values.flatMap((v) => (codeByKey.has(v) ? [v, codeByKey.get(v) as string] : [v])) } : r));
  const importSource = global.sources.find((s) => s.kind === 'import' && !s.archived);

  // Поля с ФИО (pii: person) из таблицы пишутся, только если источник импорта это разрешает (D-052)
  const allowPersonNames = importSource?.allowPersonNames ?? false;
  const personFields = new Set([...global.fields, ...space.fields].filter((f) => f.pii === 'person').map((f) => `${f.object}:${f.key}`));
  const targetsOf = (raw: Readonly<Record<string, FieldTarget>> | undefined): Record<string, FieldTarget> =>
    Object.fromEntries(
      Object.entries(raw ?? {})
        .filter(([, t]) => allowPersonNames || !personFields.has(`${t.object}:${t.fieldKey}`))
        .map(([k, t]) => [k, { object: t.object, fieldKey: t.fieldKey }]),
    );

  const profiles: ImportProfileSetting[] = space.import.profiles
    .filter((p) => !p.archived)
    .map((p) => {
      // Ярлык слота — он же имя для экрана: ФИО в настройках не хранится (D-191), цвет — часть ярлыка
      const slots: imports.OperatorSlot[] = (p.ownerSlots ?? []).map((s) => ({
        label: s.label,
        name: s.label,
        color: '',
        ranges: s.ranges.map(([a, b]) => [a, b] as [number, number]),
      }));
      const lprMap: Record<string, 'yes' | 'no'> = {};
      for (const [k, v] of Object.entries(p.valueMaps.lpr)) lprMap[k] = lprOf(v);
      const targetMap: Record<string, 'target' | 'non_target'> = {};
      for (const [k, v] of Object.entries(p.valueMaps.target)) targetMap[k] = targetOf(v);
      return {
        key: p.key,
        label: p.label.ru,
        kind: p.kind ?? 'clients',
        ...(p.kind === 'bookings'
          ? {
              bookings: {
                eventTypeMap: p.valueMaps.eventType ?? {},
                ...(p.defaultEventTypeKey !== undefined ? { defaultEventTypeKey: p.defaultEventTypeKey } : {}),
                maxRows: p.maxRows ?? BOOKINGS_DEFAULT_MAX_ROWS,
              },
            }
          : {}),
        columns: p.columns,
        valueMaps: { outcome: { ...aliasMap, ...p.valueMaps.outcome }, lpr: lprMap, target: targetMap },
        ownerBy: p.ownerBy === 'row_ranges' ? { kind: 'row_ranges', slots } : { kind: 'column' },
        outcomePriority: p.outcomePriority,
        outcomeKinds: kinds,
        ...(p.snapshotDate ? { snapshotDate: p.snapshotDate } : {}),
        ...(p.noteMarkers ? { noteMarkers: p.noteMarkers.map((m) => ({ code: m.code, words: [...m.words] })) } : {}),
        fieldTargets: targetsOf(p.fieldTargets),
      } satisfies ImportProfileSetting;
    });

  const phoneRules: phone.PhoneRules = { ...global.phone, ...(phone.DEFAULT_PHONE_RULES.stubs ? { stubs: phone.DEFAULT_PHONE_RULES.stubs } : {}) };
  const cal = global.calendar;
  const timeZone = global.org.timezone;
  const calendar = time.createWorkCalendar({
    timezone: timeZone,
    workdays: cal.workdays,
    workHours: { start: cal.workHours.start, end: cal.workHours.end },
    callWindow: { start: cal.callWindow.start, end: cal.callWindow.end },
    holidays: cal.holidays.map((h) => ({ date: h.date, kind: h.kind, ...(h.note ? { note: h.note } : {}) })),
  });
  const c = space.calling;
  const callingSettings: calling.CallingSettings = {
    outcomes: outcomes.map((o) => ({ key: o.key, kind: o.kind, requires: { lpr: o.requires.lpr, reason: o.requires.reason, callbackAt: o.requires.callbackAt, contact: o.requires.contact, agreement: o.requires.agreement }, archived: o.archived === true, archivedAt: null })),
    lprRequiredOnContact: c.lprRequiredOnContact,
    lprNoRequiresInfo: c.lprNoRequiresInfo,
    callbackPastToleranceMin: c.callbackPastToleranceMin,
    offlineWindowHours: c.offlineWindowHours,
    retry: { steps: [...c.retry.steps] as string[], maxAttempts: c.retry.maxAttempts },
    returnDays: { not_interested: c.returnDays.not_interested, deal_lost_soft: c.returnDays.deal_lost_soft },
    skipLimit: space.queue.skipLimit,
    capIncludes: [...space.distribution.capIncludes],
    // Для импорта не используются, но тип ядра их требует
    noShowCallbackAt: '+1h',
    nextStepTaskAt: DAY_STEP,
    autoNoShowWorkdays: null,
    inboundReplyMinutes: space.tasks.inboundReplyMinutes,
  };
  const defs = [...global.fields, ...space.fields] as unknown as fields.FieldDef[];
  const roles: fields.FieldRole[] = (global.roles as unknown as { key: string; fieldAccessDefault?: string; archived?: boolean }[]).map((r) => ({
    key: r.key,
    fieldAccessDefault: r.fieldAccessDefault === 'edit' || r.fieldAccessDefault === 'read' ? r.fieldAccessDefault : 'hidden',
    archived: r.archived === true,
  }));
  return {
    spaceId: input.spaceId,
    spaceKey: input.spaceKey,
    rev: input.rev,
    settings: {
      profiles,
      maxFileMb: space.import.maxFileMb,
      maxRows: space.import.maxRows,
      rowsRetentionDays: space.import.rowsRetentionDays,
      sourceKey: importSource?.key ?? 'import',
      rules: { reject: withCodes(importSource?.rejectRules ?? []), hold: withCodes(importSource?.holdRules ?? []) },
    },
    normalizers: imports.createImportNormalizers(phoneRules, coreForms),
    dedup: { ...global.dedup, byOrgId: true },
    calling: callingSettings,
    calendar,
    timeZone,
    phoneRules,
    participantRoles: space.distribution.participantRoles,
    legalKeyByCode,
    fieldDefs: defs,
    searchable: fields.searchableKeys(defs, roles),
    outcomeLabels: Object.fromEntries(outcomes.map((o) => [o.key, o.label.ru])),
    eventTypeLabels: Object.fromEntries(space.booking.eventTypes.map((t) => [t.key, t.label.ru])),
    groupTypeKeys: new Set(space.booking.eventTypes.filter((t) => t.behavior === 'group' && !t.archived).map((t) => t.key)),
    agreedOutcomeKey: outcomes.find((o) => o.kind === 'agreed' && !o.archived)?.key ?? null,
  };
}

export async function loadImportContext(spaceId: string): Promise<ImportContext> {
  const cfg = await getActiveConfig();
  const entry = Object.entries(cfg.spaces).find(([, s]) => s.spaceId === spaceId);
  // Пространства нет в настройках: для пользователя это «нет такого» (404), как чужой импорт
  if (!entry) throw new NotFoundError();
  const [spaceKey, s] = entry;
  return buildImportContext({ spaceId, spaceKey, rev: { global: cfg.global.rev, space: s.rev }, global: cfg.global.doc, space: s.doc });
}
