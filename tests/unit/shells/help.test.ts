// Справка «Как работать» (S3): подписи берутся из настроек, в локали только шаблоны; разделы зависят от роли.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHelpData, helpKindOf, sectionsFor, type HelpBoard, type HelpDoc } from '../../../src/app/(op)/help/helpData';
import { itemsFor, type HelpExt } from '../../../src/app/(op)/help/helpItems';

const ROOT = join(import.meta.dirname, '..', '..', '..');

const board: HelpBoard = {
  columns: [
    { key: 'a', label: 'Свежие', def: { states: ['new'] } },
    { key: 'b', label: 'Позже', def: { states: ['retry', 'callback'] } },
    { key: 'c', label: 'Встреча', def: { states: ['agreed'] } },
    { key: 'd', label: 'Купили', def: { states: ['client'] } },
    { key: 'e', label: null, def: { states: ['not_interested', 'written_off'], drop: [{ kind: 'not_target', reason: 'closed' }, { kind: 'not_interested', reason: 'later' }, { kind: 'not_interested', reason: 'gone' }] } },
  ],
  tones: [{ when: 'attendedIndividual', tone: 'warning' }, { when: 'attendedGroup', tone: 'success' }],
};
const doc: HelpDoc = {
  calling: { returnDays: { not_interested: 90, deal_lost_soft: 90 } },
  booking: {
    eventTypes: [
      { key: 'g', behavior: 'group', label: { ru: 'Групповая встреча' }, short: { ru: 'Группа' } },
      { key: 'i', behavior: 'individual', label: { ru: 'Личная консультация' } },
    ],
  },
  reasons: {
    not_target: [{ key: 'closed', label: { ru: 'Компания закрыта' } }],
    not_interested: [{ key: 'later', label: { ru: 'Позже' } }],
    callback: [
      { key: 'think', label: { ru: 'Подумает' } },
      { key: 'old', label: { ru: 'Старая' }, archived: true },
      { key: 'sys', label: { ru: 'Системная' }, system: 'repeat' },
      { key: 'hidden', label: { ru: 'Скрытая' }, manual: false },
    ],
  },
};
const data = buildHelpData(board, doc, (s) => `[${s}]`);

const ext: HelpExt = {
  sortHeat: 'По горячести',
  callNext: 'Подряд',
  moveTitle: 'Перенести в…',
  moreReasons: 'Другие причины…',
  owner: 'Сотрудник',
  badge: (e) => `Был: ${e}`,
  toneWord: (t) => ({ success: 'Зелёная', warning: 'Жёлтая' })[t] ?? '',
  nav: { purchases: 'Мои покупки', duty: 'Явка', consultations: 'Консультации', tasks: 'Задачи' },
  group: { work: 'Работа', analytics: 'Аналитика' },
  attended: 'Пришёл',
  noShow: 'Не пришёл',
};

test('подписи колонок и ролей берутся из настроек, пустая подпись — из состояния', () => {
  assert.deepEqual(data.columns, ['Свежие', 'Позже', 'Встреча', 'Купили', '[not_interested]']);
  assert.equal(data.byRole.callback, 'Позже');
  assert.equal(data.byRole.trash, '[not_interested]');
});

test('тоны по виду явки: слово тона и название мероприятия из настроек', () => {
  assert.deepEqual(data.tones.group, { tone: 'success', event: 'Группа' });
  assert.deepEqual(data.tones.individual, { tone: 'warning', event: 'Личная консультация' });
});

test('причины мусора — из drop колонки, причины перезвона — без архивных, системных и скрытых', () => {
  assert.deepEqual(data.trashReasons, ['Компания закрыта', 'Позже']);
  assert.deepEqual(data.callbackReasons, ['Подумает']);
});

test('нет правила тона или вида мероприятия — легенды тона нет', () => {
  const bare = buildHelpData({ ...board, tones: [] }, {}, (s) => s);
  assert.deepEqual(bare.tones, { group: null, individual: null });
  const items = itemsFor('board', 'operator', bare, ext, { callbackV2: false, canOutcome: true });
  assert.ok(!items.some((i) => i.key === 'tone'));
});

test('разделы по роли: оператор — доска и покупки; консультант — свои; руководитель без охвата — только отчёты', () => {
  assert.deepEqual(sectionsFor('operator', { wideCards: false, canReports: true, canTasks: true }), ['board', 'move', 'trash', 'callback', 'attend', 'purchases', 'duty']);
  assert.deepEqual(sectionsFor('consultant', { wideCards: false, canReports: true, canTasks: true }), ['consultations', 'attend', 'tasks']);
  assert.deepEqual(sectionsFor('manager', { wideCards: false, canReports: true, canTasks: true }), ['reports']);
  assert.ok(sectionsFor('manager', { wideCards: true, canReports: true, canTasks: true }).includes('board'));
  assert.equal(helpKindOf(['queue', 'tasks']), 'operator');
  assert.equal(helpKindOf(['consultations']), 'consultant');
  assert.equal(helpKindOf(['summary']), 'manager');
});

test('якоря контракта К4 есть у оператора и у руководителя с охватом', () => {
  const anchors = ['board', 'move', 'trash', 'callback', 'attend', 'purchases'];
  for (const ids of [sectionsFor('operator', { wideCards: false, canReports: true, canTasks: true }), sectionsFor('manager', { wideCards: true, canReports: true, canTasks: true })]) {
    for (const a of anchors) assert.ok(ids.includes(a as never), a);
  }
});

test('каждый пункт каждого раздела имеет шаблон в help.json и все его подстановки заданы', () => {
  const msgs = JSON.parse(readFileSync(join(ROOT, 'messages/ru/help.json'), 'utf8')) as { sections: Record<string, { items: Record<string, string> }> };
  for (const kind of ['operator', 'manager', 'consultant'] as const) {
    for (const id of sectionsFor(kind, { wideCards: true, canReports: true, canTasks: true })) {
      for (const flags of [{ callbackV2: false, canOutcome: true }, { callbackV2: true, canOutcome: true }]) {
        for (const item of itemsFor(id, kind, data, ext, flags)) {
          const tpl = msgs.sections[id]?.items[item.key];
          assert.ok(tpl, `${kind}/${id}/${item.key}: нет шаблона`);
          const used = [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
          for (const p of used) assert.ok(item.params[p] !== undefined && item.params[p] !== '', `${kind}/${id}/${item.key}: нет подстановки {${p}}`);
        }
      }
    }
  }
});

test('перезвон: причины и срок показываются только при CALLBACK_V2', () => {
  assert.deepEqual(itemsFor('callback', 'operator', data, ext, { callbackV2: false, canOutcome: true }).map((i) => i.key), ['what']);
  assert.deepEqual(itemsFor('callback', 'operator', data, ext, { callbackV2: true, canOutcome: true }).map((i) => i.key), ['what', 'reasons', 'term']);
});

test('страница справки открыта любому входу и внесена в манифест', () => {
  const src = readFileSync(join(ROOT, 'src/app/(op)/help/page.tsx'), 'utf8');
  assert.match(src, /perm: 'authenticated'/);
  assert.match(readFileSync(join(ROOT, 'tests/isolation/manifest/shell.ts'), 'utf8'), /\/\(op\)\/help/);
});

test('мусор: причины со сроком — «вернётся через N дн.» из настроек, остальные — только руководитель', () => {
  assert.deepEqual(data.trashReturns, [{ days: 90, reasons: ['Позже'] }]);
  assert.equal(data.trashHasManualReturn, true);
  const items = itemsFor('trash', 'operator', data, ext, { callbackV2: false, canOutcome: true });
  assert.deepEqual(items.map((i) => i.key), ['what', 'closed', 'returns', 'stays']);
  assert.deepEqual(items[2]!.params, { reasons: 'Позже', days: '90' });
  const msgs = JSON.parse(readFileSync(join(ROOT, 'messages/ru/help.json'), 'utf8')) as { sections: { trash: { items: Record<string, string> } } };
  assert.ok(!/только руководитель/.test(msgs.sections.trash.items.closed!), 'closed не утверждает «вернёт только руководитель»');
  // срок 90 дней другой установки — подставляется 45
  const other = buildHelpData(board, { ...doc, calling: { returnDays: { not_interested: 45 } } }, (s) => s);
  assert.deepEqual(other.trashReturns, [{ days: 45, reasons: ['Позже'] }]);
  // все причины возвращаются сами — строки «только руководитель» нет
  const all = buildHelpData({ ...board, columns: [{ key: 'e', label: 'М', def: { states: ['not_interested'], drop: [{ kind: 'not_interested', reason: 'later' }] } }] }, doc, (s) => s);
  assert.equal(all.trashHasManualReturn, false);
  assert.ok(!itemsFor('trash', 'operator', all, ext, { callbackV2: false, canOutcome: true }).some((i) => i.key === 'stays'));
});

test('справка по правам: без card.outcome нет «вносит итог»; без отчётов и доски — задачи, без отчётов нет раздела отчётов', () => {
  const manager = (canOutcome: boolean) => itemsFor('move', 'manager', data, ext, { callbackV2: false, canOutcome }).map((i) => i.key);
  assert.deepEqual(manager(true), ['manager', 'managerOutcome']);
  assert.deepEqual(manager(false), ['manager']);
  assert.deepEqual(sectionsFor('manager', { wideCards: false, canReports: false, canTasks: true }), ['tasks']);
  assert.deepEqual(sectionsFor('manager', { wideCards: false, canReports: false, canTasks: false }), []);
  assert.ok(!sectionsFor('manager', { wideCards: true, canReports: false, canTasks: true }).includes('reports'));
});
