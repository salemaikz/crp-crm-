import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCompany, createCompanyIndex } from './match';
import { DEFAULT_DEDUP_SETTINGS, type CompanyKeys, type DedupSettings, type KnownCompany } from './types';

// Все данные синтетические: номера +7 709 …, названия выдуманы.
const co = (id: string, o: Partial<KnownCompany> = {}): KnownCompany => ({
  id,
  createdAt: Number(id.replace(/\D/g, '')) || 1,
  orgId: null,
  phones: [],
  nameNorm: '',
  headNorm: '',
  ...o,
});
const who = (o: Partial<CompanyKeys> = {}): CompanyKeys => ({ orgId: null, phones: [], nameNorm: '', headNorm: '', ...o });
const settings = (o: Partial<DedupSettings> = {}): DedupSettings => ({ ...DEFAULT_DEDUP_SETTINGS, ...o });

test('БИН совпал — тот же клиент, даже если номер и название другие', () => {
  const known = [co('c1', { orgId: '123456789012', nameNorm: 'альфа', phones: ['77091110001'] })];
  const r = classifyCompany(who({ orgId: '123456789012', nameNorm: 'бета', phones: ['77092220002'] }), known, settings());
  assert.deepEqual(r, { kind: 'duplicate', matchId: 'c1', basis: 'org_id' });
});

test('флаг byOrgId выключен: БИН не склеивает', () => {
  const known = [co('c1', { orgId: '123456789012', nameNorm: 'альфа' })];
  const r = classifyCompany(who({ orgId: '123456789012', nameNorm: 'бета' }), known, settings({ byOrgId: false }));
  assert.equal(r.kind, 'new');
});

test('общий рабочий номер и то же название — точный дубль', () => {
  const known = [co('c1', { nameNorm: 'пример строй', phones: ['77091110001', '77091110002'] })];
  const r = classifyCompany(who({ nameNorm: 'пример строй', phones: ['77091110002', '77093330003'] }), known, settings());
  assert.deepEqual(r, { kind: 'duplicate', matchId: 'c1', basis: 'phone_and_name' });
});

test('у одной из сторон нет названия — номер склеивает', () => {
  const known = [co('c1', { nameNorm: '', phones: ['77091110001'] })];
  assert.equal(classifyCompany(who({ nameNorm: 'альфа', phones: ['77091110001'] }), known, settings()).kind, 'duplicate');
  const known2 = [co('c2', { nameNorm: 'альфа', phones: ['77091110001'] })];
  assert.equal(classifyCompany(who({ phones: ['77091110001'] }), known2, settings()).kind, 'duplicate');
});

test('общий номер при другом названии — спорная пара, не склейка (бухгалтер на две фирмы)', () => {
  const known = [co('c1', { nameNorm: 'альфа', phones: ['77091110001'] })];
  const r = classifyCompany(who({ nameNorm: 'бета', phones: ['77091110001'] }), known, settings());
  assert.deepEqual(r, { kind: 'disputed', pairs: [{ id: 'c1', reason: 'shared_phone' }] });
});

test('три ТОО с одним номером: пара со всеми, старые первыми', () => {
  const known = [
    co('c3', { nameNorm: 'гамма', phones: ['77091110001'] }),
    co('c1', { nameNorm: 'альфа', phones: ['77091110001'] }),
    co('c2', { nameNorm: 'бета', phones: ['77091110001'] }),
  ];
  const r = classifyCompany(who({ nameNorm: 'дельта', phones: ['77091110001'] }), known, settings());
  assert.equal(r.kind, 'disputed');
  assert.deepEqual(r.kind === 'disputed' && r.pairs.map((p) => p.id), ['c1', 'c2', 'c3']);
});

test('pairs.sharedPhone выключен: общий номер при другом названии — просто новый', () => {
  const known = [co('c1', { nameNorm: 'альфа', phones: ['77091110001'] })];
  const r = classifyCompany(
    who({ nameNorm: 'бета', phones: ['77091110001'] }),
    known,
    settings({ pairs: { sharedPhone: false, nameAndHead: true } }),
  );
  assert.equal(r.kind, 'new');
});

test('byPhoneAndName выключен: номер даёт только пару, даже при том же названии', () => {
  const known = [co('c1', { nameNorm: 'альфа', phones: ['77091110001'] })];
  const r = classifyCompany(who({ nameNorm: 'альфа', phones: ['77091110001'] }), known, settings({ byPhoneAndName: false }));
  assert.deepEqual(r, { kind: 'disputed', pairs: [{ id: 'c1', reason: 'shared_phone' }] });
});

test('то же название и тот же руководитель без общего номера — спорная пара', () => {
  const known = [co('c1', { nameNorm: 'альфа', headNorm: 'иванов иван иванович', phones: ['77091110001'] })];
  const r = classifyCompany(who({ nameNorm: 'альфа', headNorm: 'иванов иван иванович', phones: ['77092220002'] }), known, settings());
  assert.deepEqual(r, { kind: 'disputed', pairs: [{ id: 'c1', reason: 'name_and_head' }] });
});

test('одно название без совпадения по руководителю — новый клиент (PROCESS 2.3 п. 4), не пара', () => {
  const known = [co('c1', { nameNorm: 'альфа', headNorm: 'иванов иван иванович', phones: ['77091110001'] })];
  assert.equal(classifyCompany(who({ nameNorm: 'альфа', headNorm: 'петров пётр', phones: ['77092220002'] }), known, settings()).kind, 'new');
  assert.equal(classifyCompany(who({ nameNorm: 'альфа', headNorm: '', phones: ['77092220002'] }), known, settings()).kind, 'new');
});

test('pairs.nameAndHead выключен — пары по названию и руководителю нет', () => {
  const known = [co('c1', { nameNorm: 'альфа', headNorm: 'иванов иван', phones: ['77091110001'] })];
  const r = classifyCompany(
    who({ nameNorm: 'альфа', headNorm: 'иванов иван', phones: ['77092220002'] }),
    known,
    settings({ pairs: { sharedPhone: true, nameAndHead: false } }),
  );
  assert.equal(r.kind, 'new');
});

test('без рабочего номера: то же название + тот же руководитель — тот же клиент', () => {
  const known = [co('c1', { nameNorm: 'альфа', headNorm: 'иванов иван', phones: ['77091110001'] })];
  const r = classifyCompany(who({ nameNorm: 'альфа', headNorm: 'иванов иван' }), known, settings());
  assert.deepEqual(r, { kind: 'duplicate', matchId: 'c1', basis: 'stub_name_head' });
});

test('без рабочего номера: то же название + та же записанная заглушка — тот же клиент', () => {
  const known = [co('c1', { nameNorm: 'альфа', headNorm: 'иванов иван', stubPhones: ['77777777777'] })];
  const r = classifyCompany(who({ nameNorm: 'альфа', headNorm: 'сидоров сидор', stubPhones: ['77777777777'] }), known, settings());
  assert.deepEqual(r, { kind: 'duplicate', matchId: 'c1', basis: 'stub_name_head' });
});

test('без рабочего номера и без общего руководителя — новый клиент', () => {
  const known = [co('c1', { nameNorm: 'альфа', headNorm: 'иванов иван' })];
  assert.equal(classifyCompany(who({ nameNorm: 'альфа', headNorm: 'сидоров сидор' }), known, settings()).kind, 'new');
});

test('БИН важнее номера: побеждает самая старая запись', () => {
  const known = [
    co('c5', { orgId: '123456789012', nameNorm: 'альфа' }),
    co('c2', { orgId: '123456789012', nameNorm: 'альфа' }),
  ];
  const r = classifyCompany(who({ orgId: '123456789012' }), known, settings());
  assert.equal(r.kind === 'duplicate' && r.matchId, 'c2');
});

test('индекс видит добавленные в процессе записи (дубль внутри одной партии)', () => {
  const idx = createCompanyIndex([], settings());
  const a = who({ nameNorm: 'альфа', phones: ['77091110001'] });
  assert.equal(idx.match(a).kind, 'new');
  idx.add({ ...a, id: 'row:3', createdAt: 1 });
  assert.equal(idx.size, 1);
  assert.deepEqual(idx.match(a), { kind: 'duplicate', matchId: 'row:3', basis: 'phone_and_name' });
  assert.equal(idx.match(who({ nameNorm: 'бета', phones: ['77091110001'] })).kind, 'disputed');
});

test('пустая запись без ключей — новая; пустые поля не склеивают друг с другом', () => {
  const known = [co('c1')];
  assert.equal(classifyCompany(who(), known, settings()).kind, 'new');
});
