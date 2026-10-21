import { test, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { ACTION_SEPARATE, ActionBar, Alert, Badge, Button, Card, DataList, FilterBar, FormGrid, Page, PageHeader, Section, Segmented, StatGrid, Checkbox, Chip, ChipGroup, EmptyState, Field, Input, List, ListItem, ProgressBar, Stat, Table, TextLink, buttonClass, cn, initials } from '../../../src/ui/kit';
import { acquireLayer, openLayerCount, releaseLayer, resetLayers } from '../../../src/ui/kit/overlay';
import { statCols } from '../../../src/ui/kit/statCols';
import { DEFAULT_DURATION_MS, MAX_TOASTS, UNDO_DURATION_MS, durationFor, makeToast, toastReducer, type ToastItem } from '../../../src/ui/kit/toastState';

// Тесты без JSX: типы children в createElement слишком строги для таких вызовов.
const h = createElement as unknown as (type: unknown, props?: object | null, ...children: unknown[]) => ReactElement;

test('cn и buttonClass', () => {
  assert.equal(cn('a', false, null, undefined, '', 'b'), 'a b');
  assert.equal(buttonClass(), 'k-btn k-btn--primary');
  assert.equal(buttonClass({ variant: 'secondary', size: 'lg', block: true, iconOnly: true, className: 'x' }), 'k-btn k-btn--secondary k-btn--lg k-btn--block k-btn--icon x');
});

test('Button: кнопка по умолчанию type=button; href → ссылка; внешний → обычный <a>', () => {
  assert.match(render(h(Button, null, 'Позвонить')), /^<button type="button" class="k-btn k-btn--primary">Позвонить<\/button>$/);
  assert.match(render(h(Button, { type: 'submit' }, 'ОК')), /type="submit"/);
  assert.match(render(h(Button, { href: '/calling' }, 'Звонить')), /^<a class="k-btn k-btn--primary" href="\/calling"/);
  assert.match(render(h(Button, { href: 'tel:+77090000000' }, 'Набрать')), /^<a href="tel:\+77090000000"/);
});

test('Badge: значок и текст вместе, значок скрыт от скринридера', () => {
  const html = render(h(Badge, { tone: 'danger' }, 'Просрочено'));
  assert.match(html, /k-badge--danger/);
  assert.match(html, /<span class="k-badge__icon" aria-hidden="true"><svg/);
  assert.ok(html.endsWith('Просрочено</span>'));
  for (const tone of ['success', 'warning', 'info', 'danger', 'brand'] as const) {
    assert.match(render(h(Badge, { tone }, 'x')), /<svg/, `${tone}: есть значок`);
  }
  // нейтральный — точка, а не «минус», который читался как «минус 5»
  const neutral = render(h(Badge, null, 'x'));
  assert.match(neutral, /k-badge__dot/);
  assert.ok(!neutral.includes('<svg'));
});

test('Badge count: число без значка', () => {
  const html = render(h(Badge, { variant: 'count', tone: 'danger' }, '5'));
  assert.match(html, /k-badge--count/);
  assert.ok(!html.includes('<svg') && !html.includes('k-badge__icon'));
});

test('Chip: aria-pressed у кнопки, aria-current у ссылки, счётчик', () => {
  assert.match(render(h(Chip, { active: true }, 'Перезвоны')), /aria-pressed="true"/);
  assert.match(render(h(Chip, null, 'Новые')), /aria-pressed="false"/);
  const link = render(h(Chip, { href: '/calling?tab=new', active: true, count: 3 }, 'Новые'));
  assert.match(link, /aria-current="page"/);
  assert.match(link, /<span class="k-chip__count">3<\/span>/);
  assert.match(render(h(ChipGroup, { label: 'Фильтры' }, 'x')), /role="group" aria-label="Фильтры"/);
});

test('EmptyState: заголовок, пояснение, действие; без иконки ок', () => {
  const html = render(h(EmptyState, { title: 'Пока пусто', description: 'Импортируйте базу', action: h(Button, null, 'Импорт') }));
  assert.match(html, /<h2 class="k-empty__title">Пока пусто<\/h2>/);
  assert.match(html, /k-empty__text/);
  assert.match(html, /k-empty__actions/);
  assert.ok(!html.includes('k-empty__icon'));
});

test('List и ListItem: ссылка / кнопка / текст, текущая строка', () => {
  const html = render(h(List, null, h(ListItem, { title: 'ИП Айдар', meta: 'Алматы', href: '/clients/1', trailing: h(Badge, { tone: 'info' }, 'Новый'), selected: true }), h(ListItem, { title: 'Б', onClick: () => {} }), h(ListItem, { title: 'В' })));
  assert.match(html, /<ul class="k-list"/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /<a class="k-list__row" href="\/clients\/1"/);
  assert.match(html, /<button type="button" class="k-list__row"/);
  assert.match(html, /<div class="k-list__row"/);
});

test('Field: метка, aria-invalid, связь с подсказкой и ошибкой', () => {
  const html = render(h(Field, { label: 'Телефон', hint: 'С кодом', error: 'Неверный номер', required: true }, h(Input, { name: 'phone' })));
  assert.match(html, /<label for="field-phone" class="k-field__label">/);
  assert.match(html, /id="field-phone"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="field-phone-hint field-phone-error"/);
  assert.match(html, /<p id="field-phone-error" class="k-field__error"><svg/);
});

test('Checkbox, Alert, Stat, ProgressBar, Card, TextLink', () => {
  assert.match(render(h(Checkbox, { name: 'lpr', label: 'ЛПР', error: 'Нужно' })), /aria-invalid="true"[^>]*aria-describedby="check-lpr-error"|aria-describedby="check-lpr-error"/);
  assert.match(render(h(Alert, { tone: 'danger', title: 'Ошибка' }, 'x')), /role="alert"/);
  assert.match(render(h(Alert, null, 'x')), /role="status"/);
  assert.match(render(h(Stat, { value: 2, label: 'Просрочено', tone: 'danger' })), /k-stat--danger/);
  const pb = render(h(ProgressBar, { value: 140, label: 'План' }));
  assert.match(pb, /aria-valuenow="100"/);
  assert.match(render(h(ProgressBar, { value: Number.NaN, label: 'План' })), /aria-valuenow="0"/);
  assert.match(render(h(Card, { as: 'article', interactive: true }, 'x')), /^<article class="k-card k-card--p-md k-card--interactive">/);
  assert.match(render(h(TextLink, { href: '/a' }, 'Ссылка')), /class="k-link"/);
  assert.doesNotMatch(render(h(TextLink, { href: '/a' }, 'x')), /rel=/);
  assert.match(render(h(TextLink, { href: 'https://example.kz/x' }, 'x')), /rel="noopener noreferrer"/);
  assert.match(render(h(TextLink, { href: '//example.kz', target: '_blank', rel: 'author' }, 'x')), /rel="author noopener noreferrer"/);
  assert.doesNotMatch(render(h(TextLink, { href: 'mailto:a@example.kz' }, 'x')), /rel=/);
});

test('Table: подписи для мобильных карточек, пустое состояние', () => {
  type Row = { name: string; city: string };
  const columns = [
    { key: 'name', header: 'Название', primary: true, cell: (r: Row) => r.name },
    { key: 'city', header: 'Город', cell: (r: Row) => r.city },
  ];
  const html = render(h(Table<Row>, { columns, rows: [{ name: 'А', city: 'Б' }], rowKey: (r: Row) => r.name }));
  assert.match(html, /k-table--stack/);
  assert.match(html, /data-label="Город"/);
  assert.match(html, /data-primary/);
  const empty = render(h(Table<Row>, { columns, rows: [], rowKey: (r: Row) => r.name, empty: 'Нет строк' }));
  assert.match(empty, /k-table__empty[^>]*>Нет строк/);
});

test('initials', () => {
  assert.equal(initials('Айдар Тулеев'), 'АТ');
  assert.equal(initials('admin@example.com'), 'A');
  assert.equal(initials('  '), '?');
});

beforeEach(() => resetLayers());

test('слой модалок один: второй не открывается, повторный захват тем же — ок', () => {
  assert.equal(acquireLayer('sheet'), true);
  assert.equal(acquireLayer('sheet'), true);
  assert.equal(acquireLayer('modal'), false);
  assert.equal(openLayerCount(), 1);
  releaseLayer('sheet');
  assert.equal(openLayerCount(), 0);
  assert.equal(acquireLayer('modal'), true);
});

test('тосты: окно отмены 5 с, обычный 4 с, свой срок приоритетнее', () => {
  const undo = { label: 'Отменить', onUndo: () => {} };
  assert.equal(durationFor({}), DEFAULT_DURATION_MS);
  assert.equal(durationFor({ undo }), UNDO_DURATION_MS);
  assert.equal(durationFor({ undo, durationMs: 9000 }), 9000);
  assert.equal(durationFor({ durationMs: 0 }), DEFAULT_DURATION_MS);
});

test('тосты: редьюсер — добавить, закрыть, лимит видимых, очистка', () => {
  const mk = (n: number): ToastItem => makeToast({ message: `m${n}` });
  let s: ToastItem[] = [];
  const items = [mk(1), mk(2), mk(3), mk(4)];
  for (const t of items) s = toastReducer(s, { type: 'push', toast: t });
  assert.equal(s.length, MAX_TOASTS);
  assert.deepEqual(s.map((t) => t.message), ['m2', 'm3', 'm4']);
  assert.equal(new Set(items.map((t) => t.id)).size, 4, 'id уникальны');
  s = toastReducer(s, { type: 'dismiss', id: items[2]!.id });
  assert.deepEqual(s.map((t) => t.message), ['m2', 'm4']);
  assert.deepEqual(toastReducer(s, { type: 'dismiss', id: 'нет' }), s);
  assert.deepEqual(toastReducer(s, { type: 'clear' }), []);
  const t = makeToast({ message: 'Итог сохранён', tone: 'success', undo: { label: 'Отменить', onUndo: () => {} } });
  assert.equal(t.tone, 'success');
  assert.equal(t.durationMs, UNDO_DURATION_MS);
  assert.equal(makeToast({ message: 'x' }).tone, 'neutral');
});


test('Page: единственный <main> с шириной по предмету страницы', () => {
  assert.match(render(h(Page, { width: 'wide' }, 'x')), /^<main class="k-page k-page--wide">x<\/main>$/);
  assert.match(render(h(Page, null, 'x')), /k-page--list/);
  const withHeader = render(h(Page, { header: h(PageHeader, { title: 'Т' }), 'data-testid': 'p' }, 'x'));
  assert.match(withHeader, /data-testid="p"/);
  assert.match(withHeader, /<header class="k-page-header">/);
});

test('PageHeader: действия в одной строке с h1, пояснение и виды ниже, back и meta', () => {
  const html = render(h(PageHeader, { title: 'Сделки', lead: 'Пояснение', actions: h(Button, { size: 'sm' }, 'Обновить'), back: h('a', null, 'Назад'), meta: h(Badge, null, 'Открыта'), tabs: h('div', null, 'виды') }));
  const row = /<div class="k-page-header__row">([\s\S]*?)<\/div><p class="k-page-header__lead">/.exec(html)?.[1] ?? '';
  assert.match(row, /<h1 class="k-page-header__title">Сделки<\/h1>/);
  assert.match(row, /k-page-header__actions/);
  assert.ok(html.indexOf('Назад') < html.indexOf('<h1'));
  assert.ok(html.indexOf('k-page-header__tabs') > html.indexOf('k-page-header__lead'));
  assert.match(html, /Открыта/);
});

test('Section и шапка Card: заголовок слева, действия справа в одной строке', () => {
  const sec = render(h(Section, { title: 'Операторы', actions: h('b', null, 'A') }, 'тело'));
  assert.match(sec, /<h2 class="k-section__title">Операторы<\/h2><div class="k-section__actions"><b>A<\/b><\/div>/);
  const card = render(h(Card, { title: 'Записи', actions: h('b', null, 'B') }, 'x'));
  assert.match(card, /k-card__head/);
  assert.ok(!render(h(Card, null, 'x')).includes('k-card__head'));
});

test('ActionBar: equal, end, отделённое действие', () => {
  assert.match(render(h(ActionBar, { equal: true }, 'x')), /class="k-actionbar k-actionbar--equal"/);
  assert.match(render(h(ActionBar, { align: 'end' }, 'x')), /k-actionbar--end/);
  assert.equal(ACTION_SEPARATE, 'k-actionbar__separate');
});

test('Button: danger-quiet, flush; неактивная кнопка без opacity в CSS', () => {
  assert.equal(buttonClass({ variant: 'danger-quiet', flush: true }), 'k-btn k-btn--danger-quiet k-btn--flush');
  const css = readFileSync(join(import.meta.dirname, '..', '..', '..', 'src/ui/kit/kit.css'), 'utf8');
  const disabled = /\.k-btn:disabled,[\s\S]*?\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  assert.match(disabled, /--btn-bg: var\(--canvas\)/);
  assert.ok(!/opacity/.test(disabled));
  // тихие кнопки и ссылки берут цвет акцента, а не бренда
  assert.match(/\.k-btn--quiet \{([^}]*)\}/.exec(css)?.[1] ?? '', /--accent-ink/);
  assert.match(/\.k-link \{([^}]*)\}/.exec(css)?.[1] ?? '', /--accent-ink/);
});

test('Table: numeric и nowrap в th и td, итоговая строка, липкая колонка, скрытая подпись', () => {
  const html = render(
    h(Table, {
      columns: [
        { key: 'n', header: 'Имя', cell: (r: { n: string; v: string }) => r.n, nowrap: true },
        { key: 'v', header: 'Сумма', cell: (r: { n: string; v: string }) => r.v, numeric: true },
      ],
      rows: [{ n: 'А', v: '450 000 ₸' }],
      rowKey: (r: { n: string }) => r.n,
      footer: ['Итого', '450 000 ₸'],
      stickyFirst: true,
      caption: 'Операторы',
      captionHidden: true,
    }),
  );
  assert.match(html, /<th scope="col" data-align="right" data-numeric="">Сумма<\/th>/);
  assert.match(html, /<td data-align="right" data-numeric="" data-label="Сумма">450 000 ₸<\/td>/);
  assert.match(html, /<tfoot>/);
  assert.match(html, /k-table--sticky-first/);
  assert.match(html, /<caption class="k-visually-hidden">/);
});

test('StatGrid: колонок по числу плиток без дыры в последнем ряду (D-331)', () => {
  // до пяти — одним рядом; 6 → 3 + 3, 10 → 5 + 5; без делителя последний ряд заполнен хотя бы наполовину
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => statCols(n)), [1, 2, 3, 4, 5, 3, 4, 4, 3, 5, 4, 4]);
  for (let n = 1; n <= 40; n++) {
    const k = statCols(n);
    const last = n % k || k;
    assert.ok(n <= k || last * 2 >= k, `${n} плиток: последний ряд ${last} из ${k}`);
  }
  const tiles = (n: number) => Array.from({ length: n }, (_, i) => h(Stat, { key: i, value: i, label: `п${i}` }));
  assert.match(render(h(StatGrid, null, ...tiles(6))), /style="--stat-cols:3"/);
  assert.match(render(h(StatGrid, null, ...tiles(5))), /style="--stat-cols:5"/);
  // скрытая условием плитка не считается
  assert.match(render(h(StatGrid, null, h(Stat, { value: 1, label: 'a' }), false, h(Stat, { value: 2, label: 'b' }))), /style="--stat-cols:2"/);
  assert.match(render(h(StatGrid, { cols: 2 }, ...tiles(6))), /style="--stat-cols:2"/);
  const css = readFileSync(join(import.meta.dirname, '..', '..', '..', 'src/ui/kit/kit.css'), 'utf8');
  assert.match(css, /\.k-statgrid \{[^}]*grid-template-columns: repeat\(\s*auto-fit,\s*minmax\(max\(var\(--stat-min\), calc\(\(100% - \(var\(--stat-cols\) - 1\)/);
});

test('StatGrid, DataList, FormGrid, FilterBar, Field width, Segmented', () => {
  assert.match(render(h(StatGrid, { variant: 'strip' }, h(Stat, { value: 1, label: 'a' }))), /k-statgrid k-statgrid--strip/);
  const dl = render(h(DataList, { items: [{ label: 'Город', value: 'Астана' }, { label: 'ЛПР', value: '' }] }));
  assert.match(dl, /<dt>Город<\/dt><dd>Астана<\/dd>/);
  assert.match(dl, /<dd><span class="k-datalist__empty">—<\/span><\/dd>/);
  assert.match(render(h(FormGrid, null, 'x')), /k-formgrid/);
  assert.match(render(h(FilterBar, null, 'x')), /k-filterbar/);
  assert.match(render(h(Field, { label: 'Лимит', width: 'xs' }, h(Input, { name: 'a' }))), /k-field k-field--w-xs/);
  const seg = render(h(Segmented, { label: 'Виды', items: [{ id: 'a', label: 'Записи', href: '/bookings', active: true }, { id: 'b', label: 'Мероприятия', href: '/bookings/events' }] }));
  assert.match(seg, /role="group" aria-label="Виды"/);
  assert.match(seg, /aria-current="page"/);
});
