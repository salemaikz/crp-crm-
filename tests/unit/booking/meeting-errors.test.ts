// Текст ошибки итога встречи (B5c, D-301): отказ требований этапа приходит кодом модуля сделок, панель консультанта
// показывает подсказку сделок, а не «данные изменились»; для полей — их подписи из настроек.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import { meetingErrorText, type Translate } from '../../../src/app/(consultant)/consultations/_meeting/errorText';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const load = (ns: string) => JSON.parse(readFileSync(join(ROOT, 'messages', 'ru', `${ns}.json`), 'utf8')) as Record<string, unknown>;
const messages = { booking: load('booking'), deals: load('deals') };
const tb = createTranslator({ locale: 'ru', messages, namespace: 'booking.errors' }) as unknown as Translate;
const td = createTranslator({ locale: 'ru', messages, namespace: 'deals' }) as unknown as Translate;
const text = (code: string, fields?: string[], labels: Record<string, string> = {}) => meetingErrorText(code, fields, tb, td, labels);

test('этап требует шаг: подсказка «Добавьте следующий шаг с датой», а не «данные изменились»', () => {
  assert.equal(text('next_step_required'), 'Добавьте следующий шаг с датой');
  assert.notEqual(text('next_step_required'), tb('conflict'));
});

test('этап требует поля: перечислены подписи полей сделки, записи и явки', () => {
  assert.equal(text('stage_fields_required', ['budget', 'attendance'], { budget: 'Бюджет' }), 'Для этого этапа не хватает: Бюджет, отметка «Пришёл»');
  // поле без подписи в настройках — ключ как есть; список пуст — общий текст сделок
  assert.equal(text('stage_fields_required', ['x_old', 'booking']), 'Для этого этапа не хватает: x_old, запись на мероприятие');
  assert.equal(text('stage_fields_required', []), 'Заполните поля этапа');
});

test('коды записи — из booking.errors, незнакомый код — «данные изменились»', () => {
  assert.equal(text('not_attended'), 'Сначала отметьте «Пришёл»');
  assert.equal(text('deal_version'), 'Сделка изменилась. Обновите страницу');
  assert.equal(text('something_new'), tb('conflict'));
});
