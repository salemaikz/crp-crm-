// Нормализация записи приёма: номера, формы собственности, БИН/ИИН (только HMAC), поля источника, D-051.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GlobalConfigV1 } from '@crm/core/config';
import { minimalGlobal } from '@crm/core/config/testing/minimal';
import { buildNormalizeCtx, cleanEmail, cleanText, cleanUrl, holdRuleOf, normalizeItem, SourceUnknownError, type NormalizeCtx, type Prepared } from '../../../src/server/domain/intake/normalize';
import { iinHmac } from '../../../src/server/domain/intake/hmac';

const t = (ru: string) => ({ ru });
const field = (key: string, type: string, o: Record<string, unknown> = {}) => ({
  key, object: 'client', type, label: t(key), options: [], access: { '*': 'edit' },
  required: { always: false, onOutcome: [], onStage: [] }, searchable: false, filterable: false, ingest: true, pii: 'none',
  showOn: { card: false, kanban: false, list: false }, ...o,
});

function ctxOf(patch: (g: Record<string, any>) => void = () => {}, source = 'src'): NormalizeCtx { // eslint-disable-line @typescript-eslint/no-explicit-any
  const g = minimalGlobal() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  g.org.legalForms = [
    { key: 'too', label: t('ТОО'), aliases: ['ТОО', 'LLP', 'Товарищество с ограниченной ответственностью'], idIsPersonal: false },
    { key: 'ip', label: t('ИП'), aliases: ['ИП', 'Индивидуальный предприниматель'], idIsPersonal: true },
  ];
  g.org.idRule = 'kz_bin';
  g.org.personIdRule = 'kz_iin_hmac';
  g.phone = { country: 'KZ', mobilePrefixes: ['709'], reviewPrefixes: [], landlinePrefixes: ['7172'] };
  g.sources = [{ key: 'src', label: t('S'), kind: 'ingest', allowPersonNames: false, detailedReport: true, rejectRules: [], holdRules: [] }];
  g.fields = [
    field('okved', 'text'),
    field('size', 'select', { options: [{ key: 'small', label: t('S') }, { key: 'old', label: t('O'), archived: true }] }),
    field('founded', 'date'),
    field('staff', 'number'),
    field('site', 'url'),
    field('head', 'text', { pii: 'person' }),
    field('closed', 'text', { ingest: false }),
    field('assignee', 'user'),
  ];
  patch(g);
  return buildNormalizeCtx(g as unknown as GlobalConfigV1, source, iinHmac);
}

const ok = (r: ReturnType<typeof normalizeItem>): Prepared => {
  assert.equal(r.status, 'ok', JSON.stringify(r));
  return (r as { item: Prepared }).item;
};

test('номера: разбор, нормализация, заглушки отбрасываются, без повторов', () => {
  const it = ok(normalizeItem({ name: 'ТОО «Пример»', phones: ['8 709 123 4567', '+7 709 123 45 67', '+7 (7172) 123-456 доб. 12', '7777777777', 'мусор'] }, ctxOf()));
  assert.deepEqual(it.phones.map((p) => [p.digits, p.kind]), [['77091234567', 'mobile'], ['77172123456', 'landline']]);
  assert.equal(it.phones[1]?.ext, '12');
  assert.equal(it.name, 'ТОО «Пример»');
  assert.equal(it.nameNorm, 'пример');
  assert.equal(it.legalForm, 'too');
});

test('имя обязательно; физлицо при allowPersonNames=false отклоняется целиком', () => {
  assert.deepEqual(normalizeItem({ name: '  \u0007 ' }, ctxOf()), { status: 'invalid', code: 'name_required' });
  assert.deepEqual(normalizeItem({}, ctxOf()), { status: 'invalid', code: 'name_required' });
  assert.deepEqual(normalizeItem({ kind: 'person', name: 'Иван' }, ctxOf()), { status: 'invalid', code: 'person_not_allowed' });
  const open = ctxOf((g) => (g.sources[0].allowPersonNames = true));
  const p = ok(normalizeItem({ kind: 'person', name: 'Иванов Иван', contactName: 'Иванов Иван' }, open));
  assert.equal(p.nameNorm, 'иванов иван');
  assert.equal(p.contactName, 'Иванов Иван');
  assert.equal(p.headNorm, 'иванов иван');
});

test('contactName без allowPersonNames отбрасывается и считается', () => {
  const it = ok(normalizeItem({ name: 'ТОО А', contactName: 'Иван' }, ctxOf()));
  assert.equal(it.contactName, '');
  assert.equal(it.dropped.contactName, 1);
});

test('БИН: 12 цифр принимается; плохой отбрасывается с счётчиком; idRule=none отбрасывает', () => {
  assert.equal(ok(normalizeItem({ name: 'ТОО А', orgId: '1234 5678 9012' }, ctxOf())).orgId, '123456789012');
  const bad = ok(normalizeItem({ name: 'ТОО А', orgId: '12345' }, ctxOf()));
  assert.equal(bad.orgId, '');
  assert.equal(bad.dropped.orgId, 1);
  assert.equal(ok(normalizeItem({ name: 'ТОО А', orgId: '123456789012' }, ctxOf((g) => (g.org.idRule = 'none')))).dropped.orgId, 1);
});

test('ИП: 12 цифр — это ИИН, только HMAC; открытых цифр нет нигде', () => {
  const it = ok(normalizeItem({ name: 'ИП Тестов', legalForm: 'ip', orgId: '990101300123', phones: ['+7 709 123 4567'] }, ctxOf()));
  assert.equal(it.legalForm, 'ip');
  assert.equal(it.orgId, '');
  assert.equal(it.iinHmac, iinHmac('990101300123'));
  assert.ok(!JSON.stringify(it).includes('990101300123'));
  // ИП, заявленный как ТОО, определяется по названию
  const sneaky = ok(normalizeItem({ name: 'Индивидуальный предприниматель Тестов', legalForm: 'too', orgId: '990101300123' }, ctxOf()));
  assert.equal(sneaky.legalForm, 'ip');
  assert.equal(sneaky.orgId, '');
  assert.ok(sneaky.iinHmac);
  // personIdRule=none: ИИН не принимаем вовсе
  const none = ok(normalizeItem({ name: 'ИП Тестов', orgId: '990101300123', iin: '990101300123' }, ctxOf((g) => (g.org.personIdRule = 'none'))));
  assert.equal(none.iinHmac, null);
  assert.deepEqual([none.dropped.orgId, none.dropped.iin], [1, 1]);
  // поле iin
  const viaIin = ok(normalizeItem({ name: 'ТОО А', iin: '990101300123' }, ctxOf()));
  assert.equal(viaIin.iinHmac, iinHmac('990101300123'));
});

test('rejectRules: ИП отклоняется до любой обработки ИИН; регион', () => {
  const ctx = ctxOf((g) => (g.sources[0].rejectRules = [{ code: 'legal_review', type: 'legalFormIn', values: ['ip'] }, { code: 'far', type: 'regionNotIn', values: ['Центр'] }]));
  assert.deepEqual(normalizeItem({ name: 'ИП Тестов', orgId: '990101300123' }, ctx), { status: 'rejected_rule', ruleCode: 'legal_review' });
  assert.deepEqual(normalizeItem({ name: 'ТОО А', legalForm: 'ip' }, ctx), { status: 'rejected_rule', ruleCode: 'legal_review' });
  assert.deepEqual(normalizeItem({ name: 'ТОО А', region: 'Юг' }, ctx), { status: 'rejected_rule', ruleCode: 'far' });
  assert.equal(normalizeItem({ name: 'ТОО А', region: 'Центр города' }, ctx).status, 'ok');
  assert.equal(normalizeItem({ name: 'ТОО А' }, ctx).status, 'ok', 'регион неизвестен — не отклоняем');
});

test('holdRules для нового клиента', () => {
  const ctx = ctxOf((g) => (g.sources[0].holdRules = [{ code: 'region', type: 'regionNotIn', values: ['Центр'] }]));
  const far = ok(normalizeItem({ name: 'ТОО А', region: 'Юг' }, ctx));
  assert.equal(holdRuleOf(far, ctx), 'region');
  assert.equal(holdRuleOf(ok(normalizeItem({ name: 'ТОО А', region: 'Центр' }, ctx)), ctx), null);
});

test('email и website: только адрес и http(s) (D-051)', () => {
  assert.deepEqual(cleanEmail('a@example.kz'), { value: 'a@example.kz', dropped: false });
  assert.deepEqual(cleanEmail(''), { value: '', dropped: false });
  for (const bad of ['javascript:alert(1)', 'не адрес', 'a@b', '<a@b.kz>', 'a b@c.kz', `${'a'.repeat(250)}@b.kz`]) assert.equal(cleanEmail(bad).dropped, true, bad);
  assert.deepEqual(cleanUrl('https://example.kz/a'), { value: 'https://example.kz/a', dropped: false });
  assert.deepEqual(cleanUrl('example.kz'), { value: 'https://example.kz', dropped: false });
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', 'ftp://example.kz', 'https://u:p@example.kz', 'не ссылка', 'ex ample.kz', '//example.kz']) {
    assert.equal(cleanUrl(bad).dropped, true, bad);
  }
});

test('custom: только поля с ingest, значения по типу, pii:person при запрете, лишнее считается', () => {
  const r = ok(
    normalizeItem(
      { name: 'ТОО А', custom: { okved: ' 41.20 ', size: 'small', founded: '2025-03-14', staff: '1 200,5', site: 'javascript:x', head: 'Иван', closed: 'x', assignee: 'u1', nope: 1 } },
      ctxOf(),
    ),
  );
  assert.deepEqual(r.custom, { okved: '41.20', size: 'small', founded: '2025-03-14', staff: 1200.5 });
  assert.equal(r.dropped.custom, 5, 'site, head (pii), closed (не ingest), assignee (user), nope');
  const bad = ok(normalizeItem({ name: 'ТОО А', custom: { size: 'old', founded: '2025-13-40', staff: 'много', okved: 5 } }, ctxOf()));
  assert.deepEqual(bad.custom, {});
  assert.equal(bad.dropped.custom, 4);
  const withPersons = ok(normalizeItem({ name: 'ТОО А', custom: { head: 'Иван' } }, ctxOf((g) => (g.sources[0].allowPersonNames = true))));
  assert.deepEqual(withPersons.custom, { head: 'Иван' });
});

test('источник не найден или в архиве — приём закрыт', () => {
  assert.throws(() => ctxOf(() => {}, 'нет'), SourceUnknownError);
  assert.throws(() => ctxOf((g) => (g.sources[0].archived = true)), SourceUnknownError);
});

test('cleanText: управляющие символы и пробелы', () => {
  assert.equal(cleanText('  а\u0000\u0007б \n в  '), 'а б в');
  assert.equal(cleanText(null), '');
});
