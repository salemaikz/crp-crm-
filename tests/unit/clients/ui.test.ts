// Интерфейс клиентов: форматирование, подписи событий, ключи локали, правило «одна главная кнопка» не нарушено.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeEvent, makeContext, SYSTEM_LABEL_KEYS } from '../../../src/app/(op)/clients/_ui/feedLabels';
import { formatDateTime, formatDay, formatPhone, labelOf, telHref } from '../../../src/app/(op)/clients/_ui/format';
import { draftOf, payloadOf } from '../../../src/app/(op)/clients/_ui/FieldControl';
import { walk, read, ROOT } from '../../helpers/sourceFiles';

test('номер: красивый вид и tel-ссылка', () => {
  assert.equal(formatPhone('+77091234567'), '+7 709 123 45 67');
  assert.equal(formatPhone('+3312'), '+3312');
  assert.equal(telHref('+77091234567', ''), 'tel:+77091234567');
  assert.equal(telHref('+77091234567', '12'), 'tel:+77091234567;ext=12');
  assert.equal(telHref('+7 (709) 123-45-67', ''), 'tel:+77091234567');
});

test('даты в поясе установки', () => {
  const ms = Date.UTC(2026, 9, 28, 6, 0);
  assert.equal(formatDateTime(ms, 'Asia/Almaty'), '28.10.2026 11:00');
  assert.equal(formatDateTime(ms, 'UTC'), '28.10.2026 06:00');
  assert.equal(formatDay('2026-10-28'), '28.10.2026');
  assert.equal(formatDay('мусор'), 'мусор');
  assert.equal(labelOf({ ru: 'Да', kk: 'Иә' }), 'Да');
  assert.equal(labelOf({ ru: 'Да', kk: 'Иә' }, 'kk'), 'Иә');
  assert.equal(labelOf({ ru: 'Да' }, 'kk'), 'Да');
});

test('черновик формы: значение поля → строка/булево/список → значение для отправки', () => {
  const f = (type: string, value: unknown) => ({ key: 'k', type, value, label: { ru: 'k' }, access: 'edit', options: [], href: null, showOn: { card: true, kanban: false, list: false }, archived: false }) as never;
  assert.equal(draftOf(f('text', null)), '');
  assert.equal(draftOf(f('number', 5)), '5');
  assert.equal(draftOf(f('boolean', true)), true);
  assert.deepEqual(draftOf(f('multiselect', ['a'])), ['a']);
  assert.equal(payloadOf({ type: 'text' }, '  '), null);
  assert.equal(payloadOf({ type: 'text' }, ' а '), 'а');
  assert.equal(payloadOf({ type: 'multiselect' }, []), null);
  assert.equal(payloadOf({ type: 'boolean' }, false), false);
});

const labels = {
  fields: { 'client:industry': 'Отрасль', 'contact:mood': 'Настрой' },
  options: { 'client:industry:trade': 'Торговля', 'legal_form:llp': 'ТОО' },
  phones: { p1: '+7 709 555 01 01' },
  contacts: { c1: 'Иван' },
};
const ctx = makeContext(labels, {
  yes: 'Да',
  no: 'Нет',
  empty: 'пусто',
  system: (k) => `sys:${k}`,
  unknownField: 'поле',
  unknownPhone: 'номер',
  unknownContact: 'контакт',
});

test('подписи событий: поле было → стало', () => {
  const d = describeEvent({ kind: 'field.changed', data: { obj: 'client', sys: false, field: 'industry', before: null, after: 'trade' } }, ctx);
  assert.deepEqual(d, { key: 'feed.kinds.fieldChanged', values: { field: 'Отрасль', before: 'пусто', after: 'Торговля' } });
  const sys = describeEvent({ kind: 'field.changed', data: { obj: 'client', sys: true, field: 'legal_form', before: '', after: 'llp' } }, ctx);
  assert.deepEqual(sys.values, { field: 'sys:fields.legalForm', before: 'пусто', after: 'ТОО' });
  const c = describeEvent({ kind: 'field.changed', data: { obj: 'contact', sys: true, field: 'is_decision_maker', before: false, after: true, contactId: 'c1' } }, ctx);
  assert.equal(c.key, 'feed.kinds.contactFieldChanged');
  assert.deepEqual(c.values, { field: 'sys:contacts.isDecisionMaker', before: 'Нет', after: 'Да', contact: 'Иван' });
  // поле, которого нет в подписях (ключ убран из настроек), не ломает ленту
  assert.equal(describeEvent({ kind: 'field.changed', data: { obj: 'client', sys: false, field: 'gone', before: 1, after: 2 } }, ctx).values.field, 'поле');
});

test('подписи событий: номера, контакты, неизвестный вид', () => {
  assert.deepEqual(describeEvent({ kind: 'phone.added', data: { phoneId: 'p1' } }, ctx), { key: 'feed.kinds.phone_added', values: { phone: '+7 709 555 01 01' } });
  assert.deepEqual(describeEvent({ kind: 'phone.not_working', data: { phoneId: 'gone' } }, ctx).values, { phone: 'номер' });
  assert.deepEqual(describeEvent({ kind: 'contact.archived', data: { contactId: 'zz' } }, ctx), { key: 'feed.kinds.contact_archived', values: { contact: 'контакт' } });
  assert.equal(describeEvent({ kind: 'deal.stage', data: {} }, ctx).key, 'feed.kinds.unknown');
  assert.equal(describeEvent({ kind: 'call', data: {} }, ctx).key, 'feed.kinds.call');
});

test('все системные ключи подписей есть в локали', () => {
  const m = JSON.parse(readFileSync(join(ROOT, 'messages', 'ru', 'clients.json'), 'utf8')) as Record<string, unknown>;
  const get = (path: string) => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], m);
  for (const path of Object.values(SYSTEM_LABEL_KEYS)) assert.equal(typeof get(path), 'string', path);
});

test('ключи t(…) в интерфейсе клиентов есть в messages/ru/clients.json', () => {
  const m = JSON.parse(readFileSync(join(ROOT, 'messages', 'ru', 'clients.json'), 'utf8')) as Record<string, unknown>;
  const get = (path: string) => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], m);
  const files = walk('src/app/(op)/clients', ['.tsx', '.ts']);
  assert.ok(files.length > 5);
  const missing: string[] = [];
  for (const f of files) {
    for (const mt of read(f).matchAll(/\bt\('([A-Za-z0-9_.]+)'/g)) {
      if (typeof get(mt[1]!) !== 'string') missing.push(`${f}: ${mt[1]}`);
    }
  }
  assert.deepEqual(missing, []);
  // Динамические семейства ключей
  for (const state of ['new', 'retry', 'callback', 'agreed', 'client', 'not_interested', 'not_target', 'do_not_call', 'written_off']) assert.equal(typeof get(`states.${state}`), 'string');
  for (const r of ['dup_pair', 'import_conflict', 'no_working_phone', 'rule']) assert.equal(typeof get(`hold.${r}`), 'string');
  for (const k of ['conflict', 'forbidden', 'network', 'invalid']) assert.equal(typeof get(`form.failure.${k}`), 'string');
  for (const k of ['unknown_field', 'forbidden', 'archived', 'type', 'too_long', 'option', 'url', 'email', 'phone', 'range', 'date', 'required']) assert.equal(typeof get(`errors.${k}`), 'string');
  for (const k of ['mobile', 'landline', 'unknown']) assert.equal(typeof get(`phones.kind.${k}`), 'string');
});

test('кнопка «Позвонить» — ссылка tel: и единственная primary на странице карточки', () => {
  const call = read('src/app/(op)/clients/_ui/CallButton.tsx');
  assert.match(call, /telHref\(/);
  const page = read('src/app/(op)/clients/[id]/page.tsx');
  assert.doesNotMatch(page, /variant="primary"/);
  // панели страницы (вне форм в диалогах) не вводят вторую primary-кнопку
  for (const f of ['PhonesPanel', 'ContactsPanel', 'FieldsPanel', 'FeedPanel']) {
    const src = read(`src/app/(op)/clients/_ui/${f}.tsx`);
    assert.doesNotMatch(src, /variant="primary"/, f);
  }
});
