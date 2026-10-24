// Ссылки сводки на доску по контракту К1 (A7): колонка роли «перезвон», фильтр «на сегодня», при необходимости сотрудник.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bookingsHref, confirmHref, overdueHref } from '../../../src/app/(mgr)/summary/links';

test('просроченные перезвоны: tab колонки, f=today, owner по необходимости', () => {
  assert.equal(overdueHref('callback'), '/deals/calling?tab=callback&f=today');
  assert.equal(overdueHref('callback', 'u-1'), '/deals/calling?tab=callback&f=today&owner=u-1');
  // ключ колонки и id кодируются
  assert.equal(overdueHref('a b', 'x&y'), '/deals/calling?tab=a%20b&f=today&owner=x%26y');
});

test('без доски (OP_BOARD выключен или колонки нет) ссылок нет', () => {
  assert.equal(overdueHref(null), null);
  assert.equal(overdueHref(null, 'u-1'), null);
  assert.equal(bookingsHref(false), null);
  assert.equal(bookingsHref(true), '/bookings');
});

test('локаль сводки: заявки на {event}, ссылки названы без терминов клиента', () => {
  const ru = JSON.parse(readFileSync('messages/ru/reports.json', 'utf8')).summary;
  assert.match(ru.tiles.grey.title, /\{event\}/);
  assert.ok(ru.tiles.grey.titleFallback);
  assert.match(ru.operators.overdueLink, /\{name\}/);
});

test('«Подтвердить явку»: ссылка на доску с фильтром confirm только в день обзвона', () => {
  assert.equal(confirmHref({ on: true, confirm: true }), '/deals/calling?f=confirm');
  assert.equal(confirmHref({ on: true, confirm: false }), null);
  assert.equal(confirmHref({ on: false, confirm: true }), null);
});
