import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAllocation, planDistribution } from './plan';
import { capRemaining, capUsed, checkManualIssue } from './cap';
import { isDistributionOver, isInDistributionWindow, isTickTime, lastTickMinutes, parseHHMM, workdaysAfter } from './schedule';
import type { DistributionSettings, Participant, PoolLead } from './types';
import { at, TEST_CALENDAR } from './testCalendar';

// Пример настроек «поровну, 40 в день, 08:00–18:00 раз в час» — это входные данные теста, не константы ядра.
const S: DistributionSettings = {
  mode: 'auto_even',
  schedule: { from: '08:00', to: '18:00', everyMin: 60, workdaysOnly: true },
  dailyCap: 40,
  capIncludes: ['auto', 'manual', 'return'],
  capOverride: false,
  topUpKeep: 10,
};

const op = (userId: string, open = 0, issuedToday: Participant['issuedToday'] = {}, status: Participant['status'] = 'working'): Participant => ({
  userId,
  status,
  open,
  issuedToday,
});
const leads = (n: number, prefix = 'l'): PoolLead[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i).padStart(4, '0')}` }));
const sizes = (plan: { byOperator: Record<string, string[]> }) => Object.fromEntries(Object.entries(plan.byOperator).map(([u, ids]) => [u, ids.length]));

// --- лимит ---

test('лимит включает авто, ручную раздачу и возвраты (исправление SalemAI: считал только авто)', () => {
  const issued = { auto: 10, manual: 12, return: 5, inbound: 3, proposal: 2 };
  assert.equal(capUsed(issued, S.capIncludes), 27, 'входящие и предложенные не входят');
  assert.equal(capRemaining({ issuedToday: issued }, S), 13);
  assert.equal(capRemaining({ issuedToday: { manual: 60 } }, S), 0, 'остаток не бывает отрицательным');
  assert.equal(capUsed(issued, ['auto', 'auto']), 10, 'повтор вида не удваивает');
});

test('авто-план учитывает ручную раздачу и возвраты при остатке лимита', () => {
  const plan = planAllocation([op('a', 0, { manual: 30, return: 8 })], leads(10), S);
  assert.deepEqual(sizes(plan), { a: 2 });
  assert.equal(plan.overCap.length, 8);
});

test('ручная раздача: сверх остатка не проходит; capOverride разрешает', () => {
  const p = op('a', 0, { auto: 35 });
  assert.deepEqual(checkManualIssue(p, 5, S), { ok: true, remaining: 5, cap: 40 });
  assert.deepEqual(checkManualIssue(p, 6, S), { ok: false, remaining: 5, cap: 40, reason: 'over_cap' });
  assert.equal(checkManualIssue(p, 6, { ...S, capOverride: true }).ok, true);
  assert.equal(checkManualIssue(p, 99, { ...S, capIncludes: ['auto'] }).ok, true, 'ручная не входит в лимит — не ограничивается');
  assert.equal(checkManualIssue(op('a', 0, {}, 'paused'), 1, S).reason, 'not_working');
  assert.equal(checkManualIssue(op('a', 0, {}, 'absent'), 1, S).reason, 'not_working');
});

// --- поровну ---

test('поровну: 720 карточек на 11 операторов — по 65 или 66, каждая ровно одному', () => {
  const ops = Array.from({ length: 11 }, (_, i) => op(`u${String(i).padStart(2, '0')}`));
  const plan = planAllocation(ops, leads(720), { ...S, dailyCap: 100 });
  const counts = Object.values(sizes(plan));
  assert.equal(counts.reduce((a, b) => a + b, 0), 720);
  assert.ok(counts.every((n) => n === 65 || n === 66), JSON.stringify(counts));
  assert.equal(new Set(Object.values(plan.byOperator).flat()).size, 720);
  assert.deepEqual([plan.heldBack.length, plan.overCap.length], [0, 0]);
});

test('следующая карточка — тому, у кого меньше открытых; при равенстве — меньше выдано, затем id', () => {
  const plan = planAllocation([op('a', 30), op('b', 10), op('c', 0)], leads(50), S);
  assert.deepEqual(sizes(plan), { a: 0, b: 20, c: 30 });
  assert.equal(plan.byOperator.c?.[0], 'l0000');
  const ties = planAllocation([op('b', 5, { auto: 3 }), op('a', 5, { auto: 3 }), op('c', 5, { auto: 1 })], leads(3), S);
  assert.equal(ties.byOperator.c?.[0], 'l0000', 'меньше выдано сегодня');
  assert.equal(ties.byOperator.a?.[0], 'l0001', 'затем меньший id');
  assert.equal(ties.byOperator.b?.[0], 'l0002');
});

test('детерминизм: те же входы — тот же план', () => {
  const ops = [op('b', 5), op('a', 5), op('c', 2)];
  assert.deepEqual(planAllocation(ops, leads(30), S), planAllocation(ops, leads(30), S));
});

test('лимит 40: на 3 оператора 130 карточек — 120 розданы, 10 «Сверх лимита»', () => {
  const plan = planAllocation([op('a'), op('b'), op('c')], leads(130), S);
  assert.deepEqual(sizes(plan), { a: 40, b: 40, c: 40 });
  assert.equal(plan.overCap.length, 10);
});

test('«Пауза» и «Отсутствует» новых не получают', () => {
  const plan = planAllocation([op('a'), op('b', 0, {}, 'paused'), op('c', 0, {}, 'absent')], leads(5), S);
  assert.deepEqual(sizes(plan), { a: 5 });
  assert.equal('b' in plan.byOperator, false);
});

test('нет участников — всё «Сверх лимита»', () => {
  const plan = planAllocation([], leads(4), S);
  assert.deepEqual(plan.byOperator, {});
  assert.equal(plan.overCap.length, 4);
});

test('мобильные раньше городских, когда карточек больше места', () => {
  const pool: PoolLead[] = [
    { id: 'city1', hasMobile: false },
    { id: 'mob1', hasMobile: true },
    { id: 'city2', hasMobile: false },
    { id: 'mob2' },
  ];
  const plan = planAllocation([op('a')], pool, { ...S, dailyCap: 2 });
  assert.deepEqual(plan.byOperator.a, ['mob1', 'mob2']);
  assert.deepEqual(plan.overCap, ['city1', 'city2']);
  assert.deepEqual(planAllocation([op('a')], pool, { ...S, dailyCap: 2 }, { mobileFirst: false }).byOperator.a, ['city1', 'mob1']);
});

// --- пары ---

test('пара не делится: двойник у оператора из БД, двойник в плане, нельзя — ждёт РОП', () => {
  const pool: PoolLead[] = [
    { id: 'x1', heldBy: 'b' },
    { id: 'x2', heldBy: 'gone' },
    { id: 'x3' },
    { id: 'x4', twins: ['x3'] },
    { id: 'x5', heldBy: 'a' },
  ];
  const plan = planAllocation([op('a', 0, { auto: 40 }), op('b', 50)], pool, S);
  assert.deepEqual(plan.byOperator, { a: [], b: ['x1', 'x3', 'x4'] });
  assert.deepEqual(plan.heldBack, ['x2', 'x5']);
});

test('связь двойников симметрична, даже если мобильный переставил порядок', () => {
  const pool: PoolLead[] = [
    { id: 'p1', hasMobile: false, twins: ['p2'] },
    { id: 'p2', hasMobile: true },
    { id: 'p3', hasMobile: true },
  ];
  const plan = planAllocation([op('a', 0), op('b', 5)], pool, S);
  const owner = (id: string) => Object.entries(plan.byOperator).find(([, ids]) => ids.includes(id))?.[0];
  assert.equal(owner('p1'), owner('p2'));
});

test('двойник у оператора на паузе: ждёт РОП, не уходит другому', () => {
  const plan = planAllocation([op('a'), op('b', 0, {}, 'paused')], [{ id: 'x', heldBy: 'b' }], S);
  assert.deepEqual(plan.heldBack, ['x']);
  assert.deepEqual(plan.byOperator, { a: [] });
});

test('цепочка трёх ТОО одного директора уходит одному оператору', () => {
  const pool: PoolLead[] = [{ id: 't1', twins: ['t2'] }, { id: 't2', twins: ['t3'] }, { id: 't3' }, { id: 'other' }];
  const plan = planAllocation([op('a'), op('b')], pool, S);
  const owners = new Set(['t1', 't2', 't3'].map((id) => Object.entries(plan.byOperator).find(([, ids]) => ids.includes(id))?.[0]));
  assert.equal(owners.size, 1);
});

test('заблокированная карточка (пара с «Не звонить») не раздаётся', () => {
  const plan = planAllocation([op('a')], [{ id: 'b1', blocked: true }, { id: 'b2' }], S);
  assert.deepEqual(plan.blocked, ['b1']);
  assert.deepEqual(plan.byOperator.a, ['b2']);
});

// --- top_up ---

test('top_up: держим не больше K открытых, в пределах лимита', () => {
  const plan = planAllocation([op('a', 8), op('b', 10), op('c', 0)], leads(50), S, { topUpKeep: 10 });
  assert.deepEqual(sizes(plan), { a: 2, b: 0, c: 10 });
  assert.equal(plan.overCap.length, 38);
  const capped = planAllocation([op('a', 0, { auto: 38 })], leads(10), S, { topUpKeep: 10 });
  assert.deepEqual(sizes(capped), { a: 2 });
});

// --- расписание ---

test('расписание: ночью, в выходной и в праздник раздачи нет (исправление SalemAI)', () => {
  const run = (local: string) => planDistribution({ now: at(local), calendar: TEST_CALENDAR, settings: S, participants: [op('a')], pool: leads(3) });
  assert.equal(run('2026-10-27 10:00').status, 'planned');
  assert.deepEqual(run('2026-10-27 03:00'), { status: 'skipped', reason: 'not_workday_or_window' });
  assert.deepEqual(run('2026-10-27 18:01'), { status: 'skipped', reason: 'not_workday_or_window' });
  assert.deepEqual(run('2026-10-24 10:00'), { status: 'skipped', reason: 'not_workday_or_window' }, 'суббота');
  assert.deepEqual(run('2026-10-26 10:00'), { status: 'skipped', reason: 'not_workday_or_window' }, 'перенос 26.10');
  assert.equal(run('2026-10-27 08:00').status, 'planned', 'граница окна включена');
  assert.equal(run('2026-10-27 18:00').status, 'planned');
});

test('режимы manual и off ничего не раздают', () => {
  const base = { now: at('2026-10-27 10:00'), calendar: TEST_CALENDAR, participants: [op('a')], pool: leads(3) };
  assert.deepEqual(planDistribution({ ...base, settings: { ...S, mode: 'manual' } }), { status: 'skipped', reason: 'mode_manual' });
  assert.deepEqual(planDistribution({ ...base, settings: { ...S, mode: 'off' } }), { status: 'skipped', reason: 'mode_off' });
});

test('workdaysOnly=false: раздача и в выходной, но не ночью', () => {
  const sch = { ...S.schedule, workdaysOnly: false };
  assert.equal(isInDistributionWindow(at('2026-10-24 10:00'), TEST_CALENDAR, sch), true);
  assert.equal(isInDistributionWindow(at('2026-10-24 22:00'), TEST_CALENDAR, sch), false);
});

test('top_up в планировщике берёт topUpKeep из настроек', () => {
  const plan = planDistribution({
    now: at('2026-10-27 09:00'),
    calendar: TEST_CALENDAR,
    settings: { ...S, mode: 'top_up', topUpKeep: 3 },
    participants: [op('a', 1)],
    pool: leads(10),
  });
  assert.equal(plan.status === 'planned' && plan.byOperator.a?.length, 2);
});

test('сетка тиков и конец раздачи', () => {
  assert.equal(isTickTime(at('2026-10-27 09:00'), TEST_CALENDAR, S.schedule), true);
  assert.equal(isTickTime(at('2026-10-27 09:30'), TEST_CALENDAR, S.schedule), false);
  assert.equal(lastTickMinutes(S.schedule), 18 * 60);
  assert.equal(lastTickMinutes({ ...S.schedule, to: '18:30' }), 18 * 60);
  assert.equal(lastTickMinutes({ ...S.schedule, to: '17:30' }), 17 * 60);
  assert.equal(isDistributionOver(at('2026-10-27 18:00'), TEST_CALENDAR, S.schedule), false);
  assert.equal(isDistributionOver(at('2026-10-27 18:01'), TEST_CALENDAR, S.schedule), true);
  assert.equal(isDistributionOver(at('2026-10-24 09:00'), TEST_CALENDAR, S.schedule), true);
  assert.throws(() => parseHHMM('25:00'));
  assert.throws(() => parseHHMM('9'));
});

test('workdaysAfter пропускает выходные и перенос', () => {
  assert.deepEqual(workdaysAfter('2026-10-23', 3, TEST_CALENDAR), ['2026-10-27', '2026-10-28', '2026-10-29']);
});

test('top_up ограничивает по новым, а не по всем открытым (CONFIG 7.1)', () => {
  // 8 открытых, из них 2 новых и 6 перезвонов: до K=10 не хватает 8 новых
  const p: Participant = { userId: 'a', status: 'working', open: 8, openNew: 2, issuedToday: {} };
  const plan = planAllocation([p], leads(20), S, { topUpKeep: 10 });
  assert.equal(plan.byOperator.a?.length, 8);
  // без openNew — все открытые считаются новыми
  assert.equal(planAllocation([{ ...p, openNew: undefined }], leads(20), S, { topUpKeep: 10 }).byOperator.a?.length, 2);
});

test('группа двойников раздаётся целиком или не раздаётся', () => {
  const pool: PoolLead[] = [{ id: 'g1', twins: ['g2', 'g3'] }, { id: 'g2' }, { id: 'g3' }, { id: 'solo' }];
  // у a места на 2 — группа из 3 не помещается ни к кому, одиночная уходит
  const none = planAllocation([op('a', 0, { auto: 38 })], pool, S);
  assert.deepEqual(none.byOperator, { a: ['solo'] });
  assert.deepEqual(none.overCap, ['g1', 'g2', 'g3']);
  // у b места хватает на всю группу — группа уходит к нему целиком
  const fit = planAllocation([op('a', 0, { auto: 38 }), op('b', 5)], pool, S);
  assert.deepEqual(fit.byOperator, { a: ['solo'], b: ['g1', 'g2', 'g3'] });
});

test('владелец двойника с местом не на всю группу: вся группа ждёт РОП, а не делится', () => {
  const pool: PoolLead[] = [{ id: 'h1', heldBy: 'a', twins: ['h2'] }, { id: 'h2' }];
  const plan = planAllocation([op('a', 0, { auto: 39 }), op('b')], pool, S);
  assert.deepEqual(plan.heldBack, ['h1', 'h2']);
  assert.deepEqual(plan.byOperator, { a: [], b: [] });
});
