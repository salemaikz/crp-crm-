/* eslint-disable @typescript-eslint/no-explicit-any -- ответы API и строки БД в тестах читаются по путям */
// Приём партии на Postgres: статусы записей, идемпотентность, дедуп, стоп-лист, правила источника, ИИН только HMAC.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { iinHmac, phoneHmac } from '../../../src/server/platform/hmac';
import { systemActor } from '../../../src/server/access/systemActor';
import { revokeKey, createKey } from '../../../src/server/domain/intake';
import { newId } from '../../../src/server/platform/db';
import { batch, counts, digitsOf, installIntakeConfig, mkKey, ph, post, spaceIdOf, T0 } from './helpers';

let db: TestDb;
let rules: string; // источник с rejectRules и holdRules, полный отчёт
let open: string; // без правил, полный отчёт
let brief: string; // краткий отчёт, имена людей разрешены

before(async () => {
  db = await createTestDb();
  await installIntakeConfig();
  rules = (await mkKey('rules')).key;
  open = (await mkKey('open')).key;
  brief = (await mkKey('brief')).key;
});
after(async () => {
  await db.close();
});

const json = (r: Response) => r.json() as Promise<any>;

async function client(name: string) {
  const [c] = await db.sql<any>`SELECT * FROM clients WHERE name = ${name}`;
  return c;
}

test('новая запись: клиент, номера, карточка в пуле без владельца, источник; раздачи нет', async () => {
  const res = await post(open, batch([{ externalId: 'e-1', name: 'ТОО «Пример Строй»', phones: [ph(1), ph(2)], region: 'Центр', email: 'a@example.kz', website: 'example.kz', custom: { okved: '41.20' } }]));
  assert.equal(res.status, 200);
  const rep = await json(res);
  assert.equal(rep.replayed, false);
  assert.equal(rep.counts.created, 1);
  assert.deepEqual(rep.items, [{ index: 0, externalId: 'e-1', status: 'created' }]);
  assert.equal(rep.poolReady, 1);
  const c = await client('ТОО «Пример Строй»');
  assert.equal(c.sourceKind, 'ingest');
  assert.equal(c.sourceKey, 'open');
  assert.equal(c.legalForm, 'too');
  assert.equal(c.nameNorm, 'пример строй');
  assert.equal(c.website, 'https://example.kz');
  assert.deepEqual(c.custom, { okved: '41.20' });
  // search_norm — как у правки в карточке (D-123): свёртка, части через « | »
  assert.equal(c.searchNorm, `тоо пример строй | ${digitsOf(1)} | ${digitsOf(2)} | 41 20`);
  const phones = await db.sql<any>`SELECT digits, is_primary FROM client_phones WHERE client_id = ${c.id} ORDER BY digits`;
  assert.deepEqual(phones.map((p: any) => p.digits), [digitsOf(1), digitsOf(2)]);
  assert.equal(phones.filter((p: any) => p.isPrimary).length, 1);
  const [card] = await db.sql<any>`SELECT * FROM cards WHERE client_id = ${c.id}`;
  assert.equal(card.state, 'new');
  assert.equal(card.ownerUserId, null);
  assert.equal(card.holdReason, '');
  const [src] = await db.sql<any>`SELECT * FROM client_sources WHERE client_id = ${c.id}`;
  assert.equal(src.externalId, 'e-1');
  assert.equal((await db.sql`SELECT 1 FROM assign_log`).length, 0);
});

test('идемпотентность: повтор партии даёт тот же отчёт без новых записей; другое тело с тем же batchId — 409', async () => {
  const b = batch([{ externalId: 'idem-1', name: 'ТОО Идемпотент', phones: [ph(10)] }]);
  const first = await json(await post(open, b));
  const before = await counts(db);
  const res = await post(open, b);
  assert.equal(res.status, 200);
  const again = await json(res);
  assert.equal(again.replayed, true);
  assert.deepEqual({ ...again, replayed: false }, first);
  assert.deepEqual(await counts(db), before);
  // порядок полей в теле не меняет хэш
  const reordered = { items: [{ phones: [ph(10)], name: 'ТОО Идемпотент', externalId: 'idem-1' }], batchId: b.batchId };
  assert.equal((await json(await post(open, reordered))).replayed, true);
  const other = await post(open, batch([{ name: 'ТОО Другое', phones: [ph(11)] }], b.batchId));
  assert.equal(other.status, 409);
  assert.equal((await json(other)).error.code, 'idempotency_conflict');
  assert.deepEqual(await counts(db), before);
});

test('ротация ключа: повтор партии и тот же externalId узнаются по источнику', async () => {
  const k1 = await mkKey('open');
  const b = batch([{ externalId: 'rot-1', name: 'ТОО Ротация', phones: [ph(20)] }]);
  assert.equal((await json(await post(k1.key, b))).counts.created, 1);
  assert.equal(await revokeKey(systemActor('test', T0), k1.prefix), true);
  const k2 = await mkKey('open');
  const before = await counts(db);
  assert.equal((await json(await post(k2.key, b))).replayed, true);
  // новая партия с тем же externalId и другим номером: тот же клиент, номер дописан
  const rep = await json(await post(k2.key, batch([{ externalId: 'rot-1', name: 'Совсем другое название', phones: [ph(21)] }])));
  assert.equal(rep.items[0].status, 'merged');
  const after = await counts(db);
  assert.equal(after.clients, before.clients);
  assert.equal(after.phones, before.phones + 1);
});

test('дедуп по БИН: дописываются только пустые поля и новые номера, карточка не меняется', async () => {
  const bin = '123456789012';
  await post(open, batch([{ externalId: 'bin-1', name: 'ТОО Бин', orgId: bin, phones: [ph(30)] }]));
  const c = await client('ТОО Бин');
  assert.equal(c.orgId, bin);
  const owner = await (async () => {
    const id = newId();
    await db.sql`INSERT INTO users (id, phone_digits, name, created_at) VALUES (${id}, ${'77012223030'}, 'Сотрудник', ${T0})`;
    return id;
  })();
  await db.sql`UPDATE cards SET state = 'agreed', owner_user_id = ${owner}, attempts = 2, calls_total = 5, version = 7 WHERE client_id = ${c.id}`;
  const rep = await json(await post(open, batch([{ name: 'Другое название', orgId: '123 456 789 012', phones: [ph(31)], region: 'Город', address: 'ул. Тестовая' }])));
  assert.equal(rep.items[0].status, 'merged');
  const after = await client('ТОО Бин');
  assert.equal(after.name, 'ТОО Бин', 'название не перезаписывается');
  assert.equal(after.region, 'Город');
  assert.equal(after.address, 'ул. Тестовая');
  const [card] = await db.sql<any>`SELECT * FROM cards WHERE client_id = ${c.id}`;
  assert.equal(card.state, 'agreed');
  assert.equal(card.ownerUserId, owner);
  assert.equal(card.attempts, 2);
  assert.equal(card.callsTotal, 5);
  assert.equal(card.version, 7);
  // повтор с заполненным полем не затирает его
  await post(open, batch([{ name: 'Бин снова', orgId: bin, phones: [ph(30)], region: 'Иной' }]));
  assert.equal((await client('ТОО Бин')).region, 'Город');
});

test('дедуп по номеру и названию → merged; общий номер при другом названии → новый клиент и спорная пара', async () => {
  await post(open, batch([{ name: 'ТОО Альфа', phones: [ph(40)] }]));
  const alpha = await client('ТОО Альфа');
  // то же название другой формы записи, тот же номер
  const same = await json(await post(open, batch([{ name: 'Альфа ТОО', phones: [ph(40), ph(41)] }])));
  assert.equal(same.items[0].status, 'merged');
  const added = await db.sql`SELECT 1 FROM client_phones WHERE client_id = ${alpha.id}`;
  assert.equal(added.length, 2);
  // общий номер, другое название
  const disputed = await json(await post(open, batch([{ name: 'ТОО Бета', phones: [ph(40)] }])));
  assert.equal(disputed.items[0].status, 'held_pair');
  assert.equal(disputed.counts.heldPair, 1);
  const beta = await client('ТОО Бета');
  const pairs = await db.sql<any>`SELECT * FROM dup_pairs WHERE a_client_id = ${alpha.id < beta.id ? alpha.id : beta.id} AND b_client_id = ${alpha.id < beta.id ? beta.id : alpha.id}`;
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].reason, 'shared_phone');
  assert.equal(pairs[0].status, 'open');
  const [card] = await db.sql<any>`SELECT hold_reason FROM cards WHERE client_id = ${beta.id}`;
  assert.equal(card.holdReason, 'dup_pair');
  // в раздачу (пул) такая карточка не идёт
  const ready = await db.sql<any>`SELECT 1 FROM cards WHERE client_id = ${beta.id} AND owner_user_id IS NULL AND state = 'new' AND hold_reason = ''`;
  assert.equal(ready.length, 0);
});

test('дедуп внутри партии: вторая такая же запись склеивается с первой', async () => {
  const rep = await json(await post(open, batch([{ name: 'ТОО Дубль', phones: [ph(50)] }, { name: 'ТОО Дубль', phones: [ph(50)] }])));
  assert.deepEqual(rep.items.map((i: any) => i.status), ['created', 'merged']);
});

test('стоп-лист: все номера в стоп-листе — запись не сохраняется; один из двух — номер отбрасывается', async () => {
  for (const n of [60, 61]) {
    await db.sql`INSERT INTO stop_list (phone_hmac, reason_code, source, created_at) VALUES (${phoneHmac(digitsOf(n))}, 'do_not_call', 'manual', ${T0})`;
  }
  const before = await counts(db);
  const rep = await json(await post(open, batch([{ name: 'ТОО Стоп', phones: [ph(60), ph(61)] }])));
  assert.equal(rep.items[0].status, 'stop_list');
  assert.equal(rep.counts.stopList, 1);
  assert.equal((await counts(db)).clients, before.clients);
  assert.equal(await client('ТОО Стоп'), undefined);

  const mixed = await json(await post(open, batch([{ name: 'ТОО Частично', phones: [ph(60), ph(62)] }])));
  assert.equal(mixed.items[0].status, 'created');
  const c = await client('ТОО Частично');
  const phones = await db.sql<any>`SELECT digits FROM client_phones WHERE client_id = ${c.id}`;
  assert.deepEqual(phones.map((p: any) => p.digits), [digitsOf(62)]);
  // стоп-лист хранит только hex
  assert.equal((await db.sql<any>`SELECT count(*)::int AS n FROM stop_list WHERE phone_hmac ~ '^[0-9a-f]{64}$'`)[0].n, 2);
});

test('rejectRules: ИП (по форме и по названию) не сохраняется, ничего не пишется', async () => {
  const before = await counts(db);
  const rep = await json(
    await post(rules, batch([
      { name: 'Иванов Иван', legalForm: 'ip', orgId: '990101300123', phones: [ph(70)] },
      { name: 'ИП Петров', legalForm: 'too', phones: [ph(71)] },
      { name: 'Индивидуальный предприниматель Сидоров', phones: [ph(72)], iin: '900101300456' },
    ])),
  );
  assert.deepEqual(rep.items.map((i: any) => i.status), ['rejected_rule', 'rejected_rule', 'rejected_rule']);
  assert.equal(rep.counts.rejectedRule, 3);
  assert.deepEqual(await counts(db), { ...before, batches: before.batches + 1 });
  // ни имён, ни цифр ИИН нигде в БД
  const dump = JSON.stringify(await db.sql`SELECT * FROM ingest_batches`);
  for (const secret of ['990101300123', '900101300456', 'Петров', 'Сидоров', 'Иванов']) assert.ok(!dump.includes(secret), `в отчёте партии нет ${secret}`);
});

test('ИП без правила отклонения: ИИН только HMAC, открыто нигде не хранится', async () => {
  const iin = '990101300789';
  const rep = await json(await post(open, batch([{ name: 'ИП Тестов', legalForm: 'ip', orgId: iin, phones: [ph(80)] }])));
  assert.equal(rep.items[0].status, 'created');
  const c = await client('ИП Тестов');
  assert.equal(c.orgId, '');
  assert.equal(c.iinHmac, iinHmac(iin));
  assert.ok(!JSON.stringify(c).includes(iin));
  // повтор с тем же ИИН — тот же клиент (уникальный индекс iin_hmac не нарушается)
  const again = await json(await post(open, batch([{ name: 'ИП Тестов Иван', legalForm: 'ip', iin, phones: [ph(81)] }])));
  assert.equal(again.items[0].status, 'merged');
  assert.ok(!JSON.stringify(await db.sql`SELECT * FROM ingest_batches`).includes(iin));
});

test('holdRules: клиент создаётся, но в раздачу не идёт', async () => {
  const rep = await json(await post(rules, batch([{ name: 'ТОО Регион', region: 'Другой город', phones: [ph(90)] }, { name: 'ТОО Центр', region: 'Центр города', phones: [ph(91)] }])));
  assert.deepEqual(rep.items.map((i: any) => i.status), ['held_rule', 'created']);
  const [card] = await db.sql<any>`SELECT hold_reason, hold_code FROM cards WHERE client_id = ${(await client('ТОО Регион')).id}`;
  assert.deepEqual({ ...card }, { holdReason: 'rule', holdCode: 'region' });
});

test('невалидные записи и отброшенные поля', async () => {
  const rep = await json(
    await post(rules, batch([
      { name: '   ', phones: [ph(100)] },
      { kind: 'person', name: 'Физлицо', phones: [ph(101)] },
      { name: 'ТОО Без номера', phones: ['12345', '+7 709 000 0000'] },
      { externalId: 'drop-1', name: 'ТОО Отброс', region: 'Центр', phones: [ph(102)], orgId: 'abc', contactName: 'Иван Иванов', email: 'javascript:alert(1)', website: 'javascript:alert(1)', custom: { okved: '62', head_name: 'Пётр', unknown: 1 } },
    ])),
  );
  assert.deepEqual(rep.items.map((i: any) => [i.status, i.code]), [['invalid', 'name_required'], ['invalid', 'person_not_allowed'], ['no_working_phone', undefined], ['created', undefined]]);
  assert.deepEqual(rep.droppedFields, { contactName: 1, iin: 0, custom: 2, orgId: 1, email: 1, website: 1 });
  const c = await client('ТОО Отброс');
  assert.equal(c.email, '');
  assert.equal(c.website, '');
  assert.deepEqual(c.custom, { okved: '62' });
  assert.equal((await db.sql`SELECT 1 FROM contacts WHERE client_id = ${c.id}`).length, 0);
});

test('источник без detailedReport видит только accepted и invalid, без poolReady', async () => {
  const rep = await json(await post(brief, batch([{ name: 'ТОО Краткий', phones: [ph(110)], contactName: 'Мария' }, { name: '', phones: [ph(111)] }, { name: 'ТОО Нет номера' }])));
  assert.deepEqual(rep.counts, { received: 3, accepted: 2, invalid: 1 });
  assert.deepEqual(rep.items.map((i: any) => i.status), ['accepted', 'invalid', 'accepted']);
  assert.equal('poolReady' in rep, false);
  // имя человека у источника с allowPersonNames сохраняется как контакт
  assert.equal((await db.sql`SELECT 1 FROM contacts WHERE client_id = ${(await client('ТОО Краткий')).id} AND name = 'Мария'`).length, 1);
});

test('один и тот же batchId у разных источников независим', async () => {
  // одинаковый batchId у разных источников независим
  const id = newId();
  assert.equal((await json(await post(open, batch([{ name: 'ТОО Источник А', phones: [ph(120)] }], id)))).replayed, false);
  assert.equal((await json(await post(brief, batch([{ name: 'ТОО Источник Б', phones: [ph(121)] }], id)))).replayed, false);
});

test('ключ создаётся в нужном пространстве, карточка — в его пространстве', async () => {
  const [c] = await db.sql<any>`SELECT cards.space_id FROM cards JOIN clients ON clients.id = cards.client_id WHERE clients.name = 'ТОО Источник А'`;
  assert.equal(c.spaceId, await spaceIdOf(db));
  await assert.rejects(createKey(systemActor('test', T0), { spaceKey: 'sales', sourceKey: 'manual', scopes: ['leads:write'], managed: 'cli' }), /не принимает лиды/);
});

// ---------- Ревью дня 2: ИИН, конфликт уникальности, форма в дедупе, строка поиска ----------

/** Открытых 12 цифр нет ни в строке клиента, ни в отчётах партий. */
async function assertNoOpen(digits: string) {
  const dump = JSON.stringify([await db.sql`SELECT * FROM clients`, await db.sql`SELECT * FROM ingest_batches`, await db.sql`SELECT * FROM client_events`]);
  assert.ok(!dump.includes(digits), `открытый номер ${digits} в БД`);
}

test('неизвестная форма или kind=person: 12 цифр только как HMAC, не в org_id и не в search_norm (D-141, D-181)', async () => {
  const unknown = '880101300123';
  const rep = await json(await post(brief, batch([{ name: 'Иванов Иван Иванович', orgId: unknown, phones: [ph(300)] }])));
  assert.equal(rep.items[0].status, 'accepted');
  const c = await client('Иванов Иван Иванович');
  assert.equal(c.orgId, '');
  assert.equal(c.iinHmac, iinHmac(unknown));
  assert.ok(!c.searchNorm.includes(unknown));
  const person = '880101300127';
  await post(brief, batch([{ kind: 'person', name: 'Петров Пётр', legalForm: 'too', orgId: person, phones: [ph(301)] }]));
  const p = await client('Петров Пётр');
  assert.equal(p.kind, 'person');
  assert.equal(p.orgId, '');
  assert.equal(p.iinHmac, iinHmac(person));
  await assertNoOpen(unknown);
  await assertNoOpen(person);
});

test('неуверенный номер совпал с открытым БИН клиента базы — тот же клиент, второй раз номер не хранится (D-141)', async () => {
  const bin = '123456789055';
  await post(open, batch([{ name: 'ТОО Сигма', orgId: bin, phones: [ph(310)] }]));
  const sigma = await client('ТОО Сигма');
  const rep = await json(await post(open, batch([{ name: 'Совсем другое', orgId: bin, phones: [ph(311)], region: 'Город' }])));
  assert.equal(rep.items[0].status, 'merged');
  const after = await client('ТОО Сигма');
  assert.equal(after.orgId, bin);
  assert.equal(after.iinHmac, null);
  assert.equal(after.region, 'Город');
  assert.equal((await db.sql`SELECT 1 FROM client_phones WHERE client_id = ${sigma.id}`).length, 2);
  // и наоборот: клиент, скрытый «по неуверенности», находится открытым БИН той же записи
  const hidden = '123456789066';
  await post(open, batch([{ name: 'Тау', orgId: hidden, phones: [ph(312)] }]));
  const tau = await client('Тау');
  assert.equal(tau.iinHmac, iinHmac(hidden));
  const again = await json(await post(open, batch([{ name: 'ТОО Ипсилон', orgId: hidden, phones: [ph(313)] }])));
  assert.equal(again.items[0].status, 'merged');
});

test('ТОО с ИИН, занятым ИП: партия не падает, клиент без iin_hmac с замечанием, соседняя запись принята (D-182)', async () => {
  const iin = '770101300456';
  await post(open, batch([{ name: 'ИП Кайратов', legalForm: 'ip', orgId: iin, phones: [ph(320)] }]));
  const ip = await client('ИП Кайратов');
  assert.equal(ip.iinHmac, iinHmac(iin));
  const res = await post(open, batch([
    { name: 'ТОО Гамма', orgId: '123456789077', iin, phones: [ph(321)] },
    { name: 'ТОО Другая', phones: [ph(322)] },
  ]));
  assert.equal(res.status, 200);
  const rep = await json(res);
  assert.deepEqual(rep.items.map((i: any) => i.status), ['created', 'created']);
  assert.equal(rep.droppedFields.iin, 1);
  const gamma = await client('ТОО Гамма');
  assert.equal(gamma.orgId, '123456789077');
  assert.equal(gamma.iinHmac, null);
  assert.ok(await client('ТОО Другая'));
  // у ИП ничего не поменялось
  assert.equal((await client('ИП Кайратов')).iinHmac, iinHmac(iin));
  await assertNoOpen(iin);
});

test('«ТОО Омега» и «ИП Омега» с одним номером — спорная пара, а не склейка (D-142)', async () => {
  await post(open, batch([{ name: 'ТОО Омега', phones: [ph(330)] }]));
  const rep = await json(await post(open, batch([{ name: 'ИП Омега', phones: [ph(330)] }])));
  assert.equal(rep.items[0].status, 'held_pair');
  const too = await client('ТОО Омега');
  const ip = await client('ИП Омега');
  assert.equal(too.legalForm, 'too');
  assert.equal(ip.legalForm, 'ip');
  const [a, b] = too.id < ip.id ? [too.id, ip.id] : [ip.id, too.id];
  assert.equal((await db.sql`SELECT 1 FROM dup_pairs WHERE a_client_id = ${a} AND b_client_id = ${b}`).length, 1);
  // внутри одной партии — так же
  const same = await json(await post(open, batch([{ name: 'ТОО Дзета', phones: [ph(331)] }, { name: 'ИП Дзета', phones: [ph(331)] }])));
  assert.deepEqual(same.items.map((i: any) => i.status), ['created', 'held_pair']);
});

test('search_norm приёма: БИН ищется, дописывание пересчитывает строку той же функцией, что правка (D-123)', async () => {
  const bin = '123456789088';
  await post(open, batch([{ name: 'ТОО «Қазына»', orgId: bin, phones: [ph(340)] }]));
  const c = await client('ТОО «Қазына»');
  assert.equal(c.searchNorm, `тоо казына | ${bin} | ${digitsOf(340)}`);
  await post(open, batch([{ name: 'Казына', orgId: bin, phones: [ph(341)], custom: { okved: 'Строительство' } }]));
  assert.equal((await client('ТОО «Қазына»')).searchNorm, `тоо казына | ${bin} | ${digitsOf(340)} | ${digitsOf(341)} | строительство`);
});
