// Сортировка на устройстве над колонкой больше страницы (pipeline-v2 §9.4): предел 200 и подсказка «уточните поиск».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SORT_LIMIT, sortCards, sortLimited } from '@/ui/board/order';
import { card } from './fixtures';

test('предел сортировки на устройстве — 200 карточек', () => {
  assert.equal(SORT_LIMIT, 200);
});

test('подсказка «уточните поиск»: сортировка не по горячести, рабочая колонка, загружено 200 и есть продолжение', () => {
  assert.equal(sortLimited('due', 'callback', 200, true), true);
  assert.equal(sortLimited('new', 'new', 250, true), true);
  assert.equal(sortLimited('due', 'callback', 200, false), false, 'колонка закончилась — всё видно');
  assert.equal(sortLimited('due', 'callback', 150, true), false, 'ещё догружается');
  assert.equal(sortLimited('heat', 'callback', 200, true), false, 'по горячести — обычное «Ещё»');
  assert.equal(sortLimited('due', 'trash', 200, true), false, 'остальные колонки не сортируются');
});

test('«По сроку» над колонкой больше страницы: ранний срок со второй страницы идёт первым', () => {
  const cards = Array.from({ length: 120 }, (_, i) => card({ id: `c${i}`, nextCallAt: i === 110 ? 1_000 : 10_000 + i }));
  const sorted = sortCards(cards, 'due', 'callback');
  assert.equal(sorted[0]!.id, 'c110');
  assert.equal(sorted.length, 120);
});
