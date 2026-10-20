import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { Alert, Badge, Button, Card, Checkbox, Chip, ChipGroup, EmptyState, Field, Input, List, ListItem, ProgressBar, Stat, Table, TextLink, buttonClass, cn, initials } from '../../../src/ui/kit';
import { acquireLayer, openLayerCount, releaseLayer, resetLayers } from '../../../src/ui/kit/overlay';
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
  assert.match(render(h(Button, { href: 'tel:+77010000000' }, 'Набрать')), /^<a href="tel:\+77010000000"/);
});

test('Badge: значок и текст вместе, значок скрыт от скринридера', () => {
  const html = render(h(Badge, { tone: 'danger' }, 'Просрочено'));
  assert.match(html, /k-badge--danger/);
  assert.match(html, /<span class="k-badge__icon" aria-hidden="true"><svg/);
  assert.ok(html.endsWith('Просрочено</span>'));
  for (const tone of ['neutral', 'success', 'warning', 'info', 'danger', 'brand'] as const) {
    assert.match(render(h(Badge, { tone }, 'x')), /<svg/, `${tone}: есть значок`);
  }
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
