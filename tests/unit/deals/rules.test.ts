// Чистые правила сделок (B6, §5.10): момент покупки (день → 12:00 местного, +36 ч, −400 дн.), сумма в целых тенге,
// направление переноса, требования этапа, этапы «Покупка» и «Проигран». Настройки разбираются в срез (settings.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAmount, isEmptyFieldValue, isForward, lostStageOf, purchaseMoment, stageFieldLabels, stageRequirements, wonStageOf } from '../../../src/server/domain/deals/rules';
import { parseDealsSettings } from '../../../src/server/domain/deals/settings';
import { DealDomainError } from '../../../src/server/domain/deals/errors';
import type { DealPipelineInfo, DealStageInfo } from '../../../src/server/domain/deals/types';

const TZ = 'Asia/Almaty';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Ср 28.10.2026 11:00 по Алматы (UTC+5)
const NOW = Date.UTC(2026, 9, 28, 6, 0);

const NO_REQ: DealStageInfo['requires'] = { fields: [], booking: false, attendance: false, nextTask: false, amount: false, serviceType: false, reason: false };
const stage = (key: string, kind: DealStageInfo['kind'], order: number, requires: Partial<DealStageInfo['requires']> = {}): DealStageInfo => ({
  key,
  label: { ru: key },
  kind,
  order,
  requires: { ...NO_REQ, ...requires },
  staleDays: null,
  auto: null,
});
const PIPE: DealPipelineInfo = {
  key: 'sales',
  label: { ru: 'Продажи' },
  createDealOn: 'agreed',
  stages: [stage('booked', 'open', 10), stage('attended', 'open', 20), stage('offer', 'open', 30, { nextTask: true, fields: ['budget'] }), stage('paid', 'won', 40), stage('lost', 'lost', 50)],
};

test('purchaseMoment: день → 12:00 местного времени; null — сейчас', () => {
  assert.equal(purchaseMoment('2026-10-28', TZ, NOW, 36), Date.UTC(2026, 9, 28, 7, 0));
  assert.equal(purchaseMoment('2026-10-20', TZ, NOW, 36), Date.UTC(2026, 9, 20, 7, 0));
  assert.equal(purchaseMoment(null, TZ, NOW, 36), NOW);
});

test('purchaseMoment: не позже «сейчас + N ч» и не раньше «сейчас − 400 дней»', () => {
  // 29.10 12:00 = сейчас + 25 ч — в пределах 36 ч; 30.10 12:00 = + 49 ч — нет; при лимите 0 завтра нельзя
  assert.equal(purchaseMoment('2026-10-29', TZ, NOW, 36), Date.UTC(2026, 9, 29, 7, 0));
  assert.equal(purchaseMoment('2026-10-30', TZ, NOW, 36), null);
  assert.equal(purchaseMoment('2026-10-29', TZ, NOW, 0), null);
  // ровно 400 дней назад в 12:00 — граница: 11:00 сейчас → 12:00 того дня позже границы на час
  const edge = new Date(NOW - 400 * DAY).toISOString().slice(0, 10);
  assert.notEqual(purchaseMoment(edge, TZ, NOW, 36), null);
  const tooOld = new Date(NOW - 401 * DAY).toISOString().slice(0, 10);
  assert.equal(purchaseMoment(tooOld, TZ, NOW, 36), null);
});

test('purchaseMoment: неверный формат дня — null', () => {
  for (const bad of ['28.10.2026', '2026-13-01', '2026-02-30', '']) assert.equal(purchaseMoment(bad, TZ, NOW, 36), null, bad);
});

test('checkAmount: целое число тенге от 0 до 1e12; строка, дробь, минус — нет', () => {
  for (const ok of [0, 1, 450_000, 1e12]) assert.equal(checkAmount(ok), true, String(ok));
  for (const bad of [-1, 1.5, 1e12 + 1, '450000', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(checkAmount(bad), false, String(bad));
});

test('isForward: по порядку этапов; неизвестный текущий — вперёд, неизвестная цель — нет', () => {
  assert.equal(isForward(PIPE, 'booked', 'offer'), true);
  assert.equal(isForward(PIPE, 'offer', 'attended'), false);
  assert.equal(isForward(PIPE, 'offer', 'offer'), false);
  assert.equal(isForward(PIPE, 'archived_stage', 'booked'), true);
  assert.equal(isForward(PIPE, 'booked', 'nope'), false);
});

test('stageRequirements и пустые значения полей', () => {
  assert.deepEqual(stageRequirements(PIPE.stages[2]!), { nextTask: true, fields: ['budget'], booking: false, attendance: false });
  assert.deepEqual(stageRequirements(PIPE.stages[0]!), { nextTask: false, fields: [], booking: false, attendance: false });
  for (const empty of [undefined, null, '', '  ', []]) assert.equal(isEmptyFieldValue(empty), true);
  for (const filled of ['x', 0, false, ['a'], { a: 1 }]) assert.equal(isEmptyFieldValue(filled), false);
});

test('wonStageOf / lostStageOf: первый этап своего вида; нет — null', () => {
  assert.equal(wonStageOf(PIPE)?.key, 'paid');
  assert.equal(lostStageOf(PIPE)?.key, 'lost');
  assert.equal(wonStageOf({ stages: PIPE.stages.filter((s) => s.kind !== 'won') }), null);
});

test('parseDealsSettings: архивные этапы, услуги и причины отброшены; ошибка схемы — invalid_settings', () => {
  const global = {
    org: { timezone: TZ },
    calendar: { workdays: [1, 2, 3, 4, 5], workHours: { start: '09:00', end: '18:00' }, callWindow: { start: '09:00', end: '18:00' }, holidays: [] },
  };
  const space = {
    pipelines: [
      {
        key: 'sales',
        label: { ru: 'Продажи' },
        createDealOn: 'agreed',
        stages: [
          { key: 'old', kind: 'open', order: 5, archived: true },
          { key: 'offer', kind: 'open', order: 30, requires: { nextTask: true }, staleDays: 14, auto: null },
          { key: 'paid', kind: 'won', order: 40 },
        ],
      },
    ],
    serviceTypes: [
      { key: 'svc_a', label: { ru: 'Услуга А' }, routeToTeam: 'team_x' },
      { key: 'svc_old', label: { ru: 'Старая' }, routeToTeam: null, archived: true },
    ],
    reasons: { deal_lost: [{ key: 'r1', label: { ru: 'Причина' }, softness: 'soft', needsText: false }, { key: 'r_old', softness: 'hard', needsText: true, archived: true }] },
    deals: { purchaseFutureLimitHours: 36 },
    handoff: { acceptSlaWorkdays: 1, alarmTo: [] },
    fields: [
      { key: 'budget', object: 'deal', label: { ru: 'Бюджет' } },
      { key: 'budget_old', object: 'deal', label: { ru: 'Бюджет (старый)' }, archived: true },
      { key: 'niche', object: 'card', label: { ru: 'Ниша' } },
    ],
  };
  const s = parseDealsSettings({ spaceId: 'sp', global, space });
  // подписи полей сделки для отказа требований этапа: и архивные, без полей карточки
  assert.deepEqual(s.fieldLabels, { budget: { ru: 'Бюджет' }, budget_old: { ru: 'Бюджет (старый)' } });
  assert.deepEqual(s.pipelines[0]!.stages.map((x) => x.key), ['offer', 'paid']);
  assert.equal(s.pipelines[0]!.stages[0]!.requires.nextTask, true);
  assert.equal(s.pipelines[0]!.stages[0]!.staleDays, 14);
  assert.deepEqual(s.serviceTypes.map((x) => [x.key, x.routeToTeam]), [['svc_a', 'team_x']]);
  assert.deepEqual(s.lostReasons.map((x) => x.key), ['r1']);
  assert.deepEqual([s.workHoursEnd, s.acceptSlaWorkdays, s.purchaseFutureLimitHours], ['18:00', 1, 36]);
  assert.throws(() => parseDealsSettings({ spaceId: 'sp', global, space: { ...space, deals: {} } }), (e: unknown) => e instanceof DealDomainError && e.code === 'invalid_settings');
});

test('stageFieldLabels: подписи только полей из требований указанных этапов и только видимых роли зрителя', () => {
  const pipe: DealPipelineInfo = {
    ...PIPE,
    stages: [
      stage('booked', 'open', 10, { fields: ['early'] }),
      stage('offer', 'open', 30, { fields: ['budget', 'secret'] }),
      stage('contract', 'open', 35, { fields: ['budget', 'gone'] }),
      stage('paid', 'won', 40, { fields: ['won_only'] }),
    ],
  };
  const labels = { early: 'Ранее', budget: 'Бюджет', secret: 'Скрытое', won_only: 'Победа', unused: 'Не нужное' };
  // `secret` скрыт роли зрителя, `gone` — без подписи, `unused` ни один этап не требует
  const visible = new Set(['early', 'budget', 'gone', 'won_only', 'unused']);
  assert.deepEqual(stageFieldLabels(pipe, ['offer', 'contract'], labels, visible), { budget: 'Бюджет' });
  // этап не из списка и чужая воронка — ничего
  assert.deepEqual(stageFieldLabels(pipe, ['nope'], labels, visible), {});
  assert.deepEqual(stageFieldLabels(undefined, ['offer'], labels, visible), {});
  // ничего не видно (роль без доступа) — пусто, даже если этап требует поле
  assert.deepEqual(stageFieldLabels(pipe, ['offer'], labels, new Set()), {});
  // прототипные ключи не подставляются
  assert.deepEqual(stageFieldLabels({ stages: [stage('x', 'open', 1, { fields: ['toString'] })] }, ['x'], labels, new Set(['toString'])), {});
});
