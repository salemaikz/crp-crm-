// Минимальный полный набор настроек для тестов (синтетика, без специфики клиента). Это не пресет
// `base`: значения подобраны так, чтобы покрыть связи схемы, а не как умолчания продукта.
import type { JsonObject } from '../json.js';

const t = (ru: string): JsonObject => ({ ru });

const outcome = (key: string, kind: string, extra: JsonObject = {}): JsonObject => ({
  key,
  kind,
  label: t(key),
  color: '#336699',
  order: 0,
  reasonGroup: null,
  requires: { lpr: false, reason: false, callbackAt: false, contact: false, fields: [], agreement: false },
  importAliases: [],
  ...extra,
});

const stage = (key: string, kind: string, order: number): JsonObject => ({
  key,
  label: t(key),
  kind,
  order,
  requires: { fields: [], booking: false, attendance: false, nextTask: false, amount: false, serviceType: false, reason: false },
  staleDays: null,
  auto: null,
});

// Тело роли без прав: схема требует все поля, а права тестам настроек не нужны.
const roleBody: JsonObject = { readOnly: false, grants: [], relations: [], fieldAccessDefault: 'edit', menu: [] };

export function minimalGlobal(): JsonObject {
  return {
    org: {
      productName: t('CRM'),
      timezone: 'UTC',
      locales: ['ru'],
      defaultLocale: 'ru',
      currency: 'KZT',
      legalForms: [],
      idRule: 'none',
      personIdRule: 'none',
    },
    calendar: {
      workdays: [1, 2, 3, 4, 5],
      workHours: { start: '09:00', end: '18:00' },
      callWindow: { start: '09:00', end: '18:00' },
      holidays: [{ date: '2026-01-01', kind: 'holiday', note: '' }],
    },
    phone: { country: 'KZ', mobilePrefixes: ['700'], reviewPrefixes: [], landlinePrefixes: ['71'] },
    dedup: { byOrgId: true, byPhoneAndName: true, pairs: { sharedPhone: true, nameAndHead: true } },
    sources: [
      { key: 'manual', label: t('Вручную'), kind: 'manual', allowPersonNames: true, detailedReport: false, rejectRules: [], holdRules: [] },
    ],
    roles: [
      { key: 'manager', label: t('Менеджер'), ...roleBody },
      { key: 'lead', label: t('Руководитель'), ...roleBody },
    ],
    team: { fallbackOwnerRole: 'lead' },
    theme: {
      brandColor: '#123456',
      accentColor: '#654321',
      fontPreset: 'system',
      radius: 'md',
      density: 'normal',
      logo: 'logo.svg',
      statusStyle: 'color_text_icon',
    },
    spaces: [{ key: 'sales', label: t('Продажи'), enabled: true, default: true }],
    security: { sessionDays: 30, inviteTtlHours: 72, loginAttempts: { perPhone: 5, perIp: 20, windowMin: 15 }, phoneProbesPerDay: 20 },
    audit: { retentionDays: 1095 },
    fields: [],
  };
}

export function minimalSpace(): JsonObject {
  return {
    calling: {
      outcomes: [
        outcome('no_answer', 'no_answer'),
        outcome('bad_number', 'bad_number'),
        outcome('callback', 'callback', { requires: { lpr: false, reason: false, callbackAt: true, contact: false, fields: [], agreement: false } }),
        outcome('agreed', 'agreed'),
        outcome('not_interested', 'not_interested', {
          reasonGroup: 'not_interested',
          requires: { lpr: false, reason: true, callbackAt: false, contact: false, fields: [], agreement: false },
        }),
        outcome('not_target', 'not_target'),
        outcome('do_not_call', 'do_not_call'),
      ],
      lprRequiredOnContact: false,
      lprNoRequiresInfo: false,
      undoSeconds: 5,
      offlineWindowHours: 72,
      callbackPastToleranceMin: 5,
      callbackPresets: ['+2h', 'nextWorkday@10:00'],
      retry: { steps: ['+2h', 'nextWorkday@10:00'], maxAttempts: 3 },
      returnDays: { not_interested: 90, deal_lost_soft: 90 },
    },
    reasons: { not_interested: [{ key: 'expensive', label: t('Дорого'), needsText: false, softness: 'soft' }] },
    queue: { order: ['callbacks', 'retries', 'returns', 'new'], mobileFirst: true, skipLimit: 10 },
    distribution: {
      mode: 'manual',
      schedule: { from: '08:00', to: '18:00', everyMin: 60, workdaysOnly: true },
      dailyCap: 40,
      capIncludes: ['auto', 'manual', 'return'],
      capOverride: false,
      topUpKeep: 10,
      participantRoles: ['manager'],
      inbound: { rule: 'channel_owner_then_least_loaded', offHours: 'lead' },
    },
    intake: { demandWorkdays: 7, bufferDays: 0.5, maxBatch: 1000 },
    pipelines: [
      {
        key: 'sales',
        kind: 'sales',
        label: t('Продажи'),
        createDealOn: 'manual',
        stages: [stage('new_deal', 'open', 0), stage('paid', 'won', 1), stage('lost', 'lost', 2)],
      },
    ],
    serviceTypes: [{ key: 'service', label: t('Услуга'), routeToTeam: null }],
    deals: { purchaseFutureLimitHours: 36 },
    teams: [],
    handoff: { acceptSlaWorkdays: 1, alarmTo: ['lead'] },
    booking: {
      eventTypes: [],
      horizonDays: 28,
      groupOptions: 3,
      consultStripDays: 7,
      consult: { slotMinutes: 45, hours: { workdays: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' } },
      directions: [],
      grey: { mode: 'suggest', schedule: { first: '09:00', last: '18:00', stepMin: 30 } },
      duty: { defaultRole: 'lead' },
      noShow: { callbackAt: 'nextWorkday@10:00' },
      attendance: { autoNoShowWorkdays: 2 },
      nextStep: { taskAt: 'nextWorkday@10:00' },
      seedSeries: [],
    },
    reminders: { days: ['today', 'tomorrow'], templates: [{ key: 'default', eventTypeKey: null, text: t('{name}, ждём вас {date} в {time}') }] },
    fields: [],
    tasks: { overdueAlertMinutes: 60, inboundReplyMinutes: 15, askNextStep: {} },
    reports: { callsPerHourTarget: null, tiles: [], intakeTile: true },
    export: { allowedRoles: ['lead'] },
    notifications: { morningDigestAt: '09:00', callbackSoonMinutes: null, quietHours: 'outside_work_hours' },
    alerts: { intakeStaleHours: 26, stockMinDays: null },
    timeline: { crossSpace: 'none' },
    import: { profiles: [], maxFileMb: 10, maxRows: 20000, rowsRetentionDays: 14 },
  };
}

export function minimalSet(): { global: JsonObject; spaces: Record<string, JsonObject> } {
  return { global: minimalGlobal(), spaces: { sales: minimalSpace() } };
}
