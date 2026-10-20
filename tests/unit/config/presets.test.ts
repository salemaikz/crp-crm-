/* eslint-disable @typescript-eslint/no-explicit-any -- документы настроек в тестах читаются по путям, схема уже проверена */
// Пресеты: каждый слой разбирается, цепочки собираются и проходят схему, значения накладки — как в CONFIG §6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, walk } from '../../helpers/sourceFiles';
import { assembleChain, loadLayer, validChain, LAYER_FILES } from './helpers';

type Doc = Record<string, any>;

function crp() {
  const a = assembleChain(['base', 'kz', 'consulting-sales', 'crp']);
  return { g: a.global as Doc, s: a.spaces.sales as Doc, a };
}
const byKey = (xs: Doc[], key: string): Doc => {
  const x = xs.find((e) => e.key === key);
  assert.ok(x, `нет элемента «${key}»`);
  return x;
};

test('каждый слой разбирается; ключ и версия слоя на месте', () => {
  for (const k of Object.keys(LAYER_FILES) as (keyof typeof LAYER_FILES)[]) {
    const l = loadLayer(k);
    assert.equal(l.meta.schemaVersion, 1);
    assert.match(l.meta.version, /^\d+\.\d+\.\d+$/);
  }
  assert.deepEqual(loadLayer('crp').meta.extends, ['base', 'kz', 'consulting-sales']);
});

test('цепочки слоёв собираются и проходят схему', () => {
  for (const chain of [['base'], ['base', 'kz'], ['base', 'consulting-sales'], ['base', 'kz', 'consulting-sales']] as const) {
    const r = validChain([...chain]);
    assert.ok(r.ok, `${chain.join(' → ')}: ${r.ok ? '' : JSON.stringify(r.issues)}`);
  }
  const full = validChain(['base', 'kz', 'consulting-sales', 'crp']);
  assert.ok(full.ok, full.ok ? '' : JSON.stringify(full.issues));
});

test('роли: base даёт lead, manager, observer с правами; накладка ЦРП архивирует их и добавляет свои', () => {
  const b = loadLayer('base').global as Doc;
  assert.deepEqual(b.roles.map((r: Doc) => r.key), ['lead', 'manager', 'observer']);
  assert.ok(b.roles.every((r: Doc) => r.grants.length > 0));
  assert.equal(byKey(b.roles, 'observer').readOnly, true);
  const { g } = crp();
  const active = g.roles.filter((r: Doc) => !r.archived).map((r: Doc) => r.key);
  assert.deepEqual(active, ['operator', 'rop', 'consultant', 'director', 'marketing_head', 'marketer']);
  assert.ok(g.roles.filter((r: Doc) => r.archived).every((r: Doc) => ['lead', 'manager', 'observer'].includes(r.key)));
});

test('сборка детерминирована: два прогона дают один документ', () => {
  const a = JSON.stringify(assembleChain(['base', 'kz', 'consulting-sales', 'crp']));
  const b = JSON.stringify(assembleChain(['base', 'kz', 'consulting-sales', 'crp']));
  assert.equal(a, b);
});

test('слои base, kz, consulting-sales не содержат специфики клиента', () => {
  const words = [/(?<![\p{L}\p{N}_])ЦРП(?![\p{L}\p{N}_])/u, /(?<![\p{L}\p{N}_])Б[РК](?![\p{L}\p{N}_])/u, /Астан/iu, /crp/i, /бизнес-(разбор|консультация)/iu];
  for (const k of ['base', 'kz', 'consulting-sales'] as const) {
    const text = readFileSync(path.join(ROOT, 'presets', LAYER_FILES[k]), 'utf8');
    for (const w of words) assert.ok(!w.test(text), `${k}: ${w}`);
  }
});

test('снимок ЦРП: компания, язык, пояс, номера, формы собственности', () => {
  const { g } = crp();
  assert.deepEqual(g.org.productName, { ru: 'CRM ЦРП' });
  assert.equal(g.org.timezone, 'Asia/Almaty');
  assert.deepEqual(g.org.locales, ['ru']);
  assert.equal(g.org.idRule, 'kz_bin');
  assert.equal(g.org.personIdRule, 'kz_iin_hmac');
  assert.equal(byKey(g.org.legalForms, 'ip').idIsPersonal, true);
  assert.deepEqual(g.org.legalForms.map((f: Doc) => f.key), ['too', 'ip', 'ao', 'gkp', 'kh', 'gu', 'oo', 'pk']);
  // КХ — форма ИП: номер — ИИН главы (D-141).
  assert.deepEqual(g.org.legalForms.filter((f: Doc) => f.idIsPersonal).map((f: Doc) => f.key), ['ip', 'kh']);
  assert.ok(g.org.legalForms[0].aliases.includes('ЖШС') && g.org.legalForms[0].aliases.includes('LLP'));
  assert.deepEqual(g.phone.reviewPrefixes, ['770', '774']);
  assert.equal(g.phone.mobilePrefixes.length, 23);
  assert.deepEqual(g.phone.landlinePrefixes, ['71', '72']);
  assert.deepEqual(g.calendar.workdays, [1, 2, 3, 4, 5]);
  assert.deepEqual(g.calendar.callWindow, { start: '09:00', end: '18:00' });
});

test('снимок ЦРП: источники и правила', () => {
  const { g } = crp();
  const nb = byKey(g.sources, 'new_base');
  assert.equal(nb.kind, 'ingest');
  assert.equal(nb.allowPersonNames, false);
  assert.equal(nb.detailedReport, true);
  assert.deepEqual(nb.rejectRules, [{ code: 'legal_review', type: 'legalFormIn', values: ['ip'] }]);
  assert.deepEqual(nb.holdRules, [{ code: 'region', type: 'regionNotIn', values: ['Астана'] }]);
  assert.deepEqual(byKey(g.sources, 'import').holdRules, [{ code: 'legal_review', type: 'legalFormIn', values: ['ip'] }]);
  for (const k of ['manual', 'import', 'new_base', 'whatsapp_in', 'walk_in']) byKey(g.sources, k);
});

test('снимок ЦРП: итоги, причины, повторы', () => {
  const { s } = crp();
  assert.deepEqual(s.calling.outcomes.map((o: Doc) => o.label.ru), ['Не берёт', 'Номер не работает', 'Перезвонить', 'Договорились — записать', 'Не интересует', 'Не целевой', 'Полный отказ']);
  assert.equal(s.calling.lprRequiredOnContact, true);
  assert.equal(s.calling.lprNoRequiresInfo, true);
  assert.equal(s.calling.undoSeconds, 5);
  assert.deepEqual(s.calling.callbackPresets, ['+2h', 'nextWorkday@10:00', 'nextEvent:br@10:00']);
  assert.deepEqual(s.calling.retry, { steps: ['+2h', 'nextWorkday@10:00'], maxAttempts: 3 });
  assert.deepEqual(s.calling.returnDays, { not_interested: 90, deal_lost_soft: 90 });
  const agreed = byKey(s.calling.outcomes, 'agreed');
  assert.deepEqual(agreed.requires, { lpr: true, reason: false, callbackAt: false, contact: true, fields: ['niche'], agreement: true });
  assert.ok(byKey(s.calling.outcomes, 'bad_number').importAliases.includes('Недоступен'));
  assert.deepEqual(Object.keys(s.reasons).sort(), ['bad_number', 'deal_lost', 'do_not_call', 'not_interested', 'not_target']);
  assert.equal(s.reasons.not_interested.length, 6);
  assert.ok(byKey(s.reasons.deal_lost, 'refund'));
  assert.equal(byKey(s.reasons.not_interested, 'other').needsText, true);
});

test('снимок ЦРП: раздача, лимит 40, часы 08–18 по будням, приём', () => {
  const { s } = crp();
  assert.equal(s.distribution.mode, 'auto_even');
  assert.deepEqual(s.distribution.schedule, { from: '08:00', to: '18:00', everyMin: 60, workdaysOnly: true });
  assert.equal(s.distribution.dailyCap, 40);
  assert.deepEqual(s.distribution.capIncludes, ['auto', 'manual', 'return']);
  assert.equal(s.distribution.capOverride, false);
  assert.deepEqual(s.distribution.participantRoles, ['operator']);
  assert.equal(s.distribution.inbound.offHours, 'rop');
  assert.deepEqual(s.intake, { demandWorkdays: 7, bufferDays: 0.5, maxBatch: 1000 });
  assert.deepEqual(s.queue.order, ['callbacks', 'retries', 'returns', 'new']);
  assert.equal(s.queue.skipLimit, 10);
});

test('снимок ЦРП: воронка продаж', () => {
  const { s } = crp();
  const p = byKey(s.pipelines, 'sales');
  assert.equal(p.label.ru, 'Продажи ЦРП');
  assert.equal(p.createDealOn, 'agreed');
  const live = p.stages.filter((x: Doc) => !x.archived).sort((a: Doc, b: Doc) => a.order - b.order);
  assert.deepEqual(live.map((x: Doc) => [x.key, x.label.ru, x.kind, x.staleDays]), [
    ['booked', 'Записан', 'open', 14],
    ['attended', 'Пришёл', 'open', 7],
    ['offer', 'Переговоры / КП', 'open', 14],
    ['paid', 'Покупка', 'won', null],
    ['lost', 'Проигран', 'lost', null],
  ]);
  assert.equal(byKey(p.stages, 'booked').auto, 'on_agreed');
  assert.equal(byKey(p.stages, 'attended').auto, 'on_attended');
  assert.deepEqual([byKey(p.stages, 'new').archived, byKey(p.stages, 'invoice').archived], [true, true]);
  assert.equal(byKey(p.stages, 'paid').requires.amount, true);
  assert.equal(byKey(p.stages, 'lost').requires.reason, true);
  assert.equal(s.deals.purchaseFutureLimitHours, 36);
});

test('снимок ЦРП: типы мероприятий, серия, консультации, направления', () => {
  const { s, g } = crp();
  const b = s.booking;
  const br = byKey(b.eventTypes, 'br');
  assert.deepEqual([br.behavior, br.short.ru, br.capacity, br.durationMin], ['group', 'БР', 30, 180]);
  const bk = byKey(b.eventTypes, 'bk');
  assert.deepEqual([bk.behavior, bk.short.ru, bk.capacity, bk.durationMin], ['individual', 'БК', null, 45]);
  assert.deepEqual(b.seedSeries, [{ key: 'br_thursday', eventTypeKey: 'br', weekday: 4, startTime: '15:00', durationMin: 180, location: '', format: 'offline', capacity: 30 }]);
  assert.deepEqual(b.consult, { slotMinutes: 45, hours: { workdays: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' } });
  assert.deepEqual(b.directions.map((d: Doc) => d.key), ['program', 'consulting', 'marketing', 'automation', 'training', 'other']);
  assert.equal(b.grey.mode, 'assign');
  assert.equal(b.duty.defaultRole, 'rop');
  assert.deepEqual([b.horizonDays, b.groupOptions, b.consultStripDays], [28, 3, 7]);
  assert.equal(b.attendance.autoNoShowWorkdays, 2);
  assert.equal(s.access, undefined, 'окно консультанта задано параметрами отношения booked_with_me, не ключом пространства');
  const win = byKey(g.roles, 'consultant').relations.find((r: Doc) => r.key === 'booked_with_me');
  assert.deepEqual(win.params, { fromDays: -1, toDays: 30 });
});

test('снимок ЦРП: напоминания, услуги, команды, передачи', () => {
  const { s } = crp();
  assert.deepEqual(s.reminders.days, ['today', 'tomorrow']);
  const t = byKey(s.reminders.templates, 'br_reminder');
  assert.equal(t.eventTypeKey, 'br');
  assert.equal(t.text.ru, 'Здравствуйте, {name}! Напоминаем: бизнес-разбор {date} в {time}, {place}. Подтверждаете участие?');
  assert.deepEqual(s.teams, [{ key: 'marketing', label: { ru: 'Маркетинг' } }]);
  assert.equal(byKey(s.serviceTypes, 'smm').routeToTeam, 'marketing');
  assert.equal(byKey(s.serviceTypes, 'ads').routeToTeam, 'marketing');
  assert.equal(byKey(s.serviceTypes, 'master_group').routeToTeam, null);
  assert.deepEqual(s.handoff, { acceptSlaWorkdays: 1, alarmTo: ['rop'] });
});

test('снимок ЦРП: отчёты, выгрузка, уведомления, импорт', () => {
  const { s } = crp();
  assert.equal(s.reports.callsPerHourTarget, 10);
  assert.equal(s.reports.intakeTile, false);
  assert.ok(s.reports.tiles.length > 0);
  assert.deepEqual(s.export.allowedRoles, ['rop', 'director']);
  assert.deepEqual(s.tasks.askNextStep, { consultant: true });
  assert.equal(s.tasks.overdueAlertMinutes, 60);
  assert.deepEqual(s.notifications, { morningDigestAt: '09:00', callbackSoonMinutes: null, quietHours: 'outside_work_hours' });
  assert.deepEqual(s.alerts, { intakeStaleHours: null, stockMinDays: null });
  const prof = byKey(s.import.profiles, 'operator_tables');
  assert.equal(prof.ownerBy, 'row_ranges');
  assert.equal(prof.valueMaps.outcome['Недоступен'], 'bad_number');
  assert.equal(prof.outcomePriority[0], 'do_not_call');
  assert.equal(prof.outcomePriority.at(-1), 'no_answer');
  assert.equal(s.import.maxRows, 20000);
});

test('снимок ЦРП: тема бренда и поля', () => {
  const { g } = crp();
  assert.deepEqual(g.theme, {
    brandColor: '#e31e24',
    accentColor: '#0e1726',
    fontPreset: 'geologica_onest',
    radius: 'md',
    density: 'normal',
    logo: 'crp-logo.svg',
    statusStyle: 'color_text_icon',
  });
  assert.deepEqual(g.security, { sessionDays: 30, inviteTtlHours: 72, loginAttempts: { perPhone: 5, perIp: 20, windowMin: 15 }, phoneProbesPerDay: 20 });
  assert.equal(g.team.fallbackOwnerRole, 'rop');
  const niche = byKey(g.fields, 'niche');
  assert.equal(niche.type, 'select');
  assert.deepEqual(niche.required.onOutcome, ['agreed']);
  assert.ok(byKey(niche.options, 'other'));
  assert.equal(byKey(g.fields, 'head_name').pii, 'person');
  assert.deepEqual(g.spaces, [{ key: 'sales', label: { ru: 'Продажи' }, enabled: true, default: true }]);
});

test('логотип темы ЦРП лежит в ассетах накладки, логотип base — в ассетах base', () => {
  const crpLogo = walk('presets/clients/crp/assets', ['.svg']);
  assert.deepEqual(crpLogo, ['presets/clients/crp/assets/crp-logo.svg']);
  assert.deepEqual(walk('presets/base/assets', ['.svg']), ['presets/base/assets/logo.svg']);
});
