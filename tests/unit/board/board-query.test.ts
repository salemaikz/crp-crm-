// Вид доски в адресе (контракт К1): разбор отбрасывает мусор по конфигу доски, запись не пишет умолчания.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeCount, defaultView, parseView, writeView, type ViewLimits } from '@/ui/board/boardQuery';

const OP: ViewLimits = { tabs: ['new', 'callback', 'br', 'trash'], filters: ['today', 'attendedGroup', 'noShow'], owners: null, reasons: null };
const MGR: ViewLimits = { ...OP, owners: ['u-1', 'u-2'], reasons: ['think', 'no_time'] };
const sp = (s: string) => new URLSearchParams(s);

test('пустой адрес — вид по умолчанию: первая колонка, без поиска и фильтров, порядок по горячести', () => {
  assert.deepEqual(parseView(sp(''), OP), defaultView(OP));
  assert.equal(writeView(defaultView(OP), OP), '');
});

test('разбор и запись обратимы для допустимого вида', () => {
  const view = parseView(sp('tab=br&q=%D0%A1%D0%B8%D0%BD&sort=due&f=today,noShow&owner=u-2&reason=think'), MGR);
  assert.deepEqual(view, { tab: 'br', q: 'Син', sort: 'due', filters: ['today', 'noShow'], extra: { owner: 'u-2', callbackReason: 'think' } });
  assert.deepEqual(parseView(sp(writeView(view, MGR)), MGR), view);
});

test('мусор в адресе молча отбрасывается: незнакомая колонка, сортировка, фильтры, длинный поиск', () => {
  const v = parseView(sp(`tab=zzz&sort=best&f=today,hack,,noShow,today&q=${'я'.repeat(101)}`), OP);
  assert.deepEqual(v, { tab: 'new', q: '', sort: 'heat', filters: ['today', 'noShow'], extra: { owner: '', callbackReason: '' } });
});

test('фильтр вне доступных зрителю (нет права на покупки) отбрасывается', () => {
  assert.deepEqual(parseView(sp('f=purchased,today'), OP).filters, ['today']);
});

test('сотрудник и причина: у доски оператора адрес их не принимает, у доски пространства — только из списка', () => {
  assert.deepEqual(parseView(sp('owner=u-1&reason=think'), OP).extra, { owner: '', callbackReason: '' });
  assert.deepEqual(parseView(sp('owner=u-9&reason=zzz'), MGR).extra, { owner: '', callbackReason: '' });
  assert.deepEqual(parseView(sp('owner=u-1'), MGR).extra, { owner: 'u-1', callbackReason: '' });
});

test('запись: значения по умолчанию (первая вкладка, горячесть) не попадают в адрес, вкладка — только не первая', () => {
  assert.equal(writeView({ ...defaultView(OP), tab: 'new', sort: 'heat' }, OP), '');
  assert.equal(writeView({ ...defaultView(OP), tab: 'callback' }, OP), 'tab=callback');
  assert.equal(writeView({ ...defaultView(OP), q: '  Альфа  ', filters: ['today'] }, OP), 'q=%D0%90%D0%BB%D1%8C%D1%84%D0%B0&f=today');
});

test('счётчик «Фильтры · N»: фильтры, сотрудник, причина и поиск', () => {
  assert.equal(activeCount(defaultView(MGR)), 0);
  assert.equal(activeCount({ q: 'а', filters: ['today', 'noShow'], extra: { owner: 'u-1', callbackReason: 'think' } }), 5);
});
