// Правка полей клиента (5.1): события «было → стало», expect, права на поля, ссылки, название и поиск.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FieldIssuesError, getClientCard, listClients, parseListQuery, updateClient, type PatchBody } from '../../../src/server/domain/clients';
import { iinHmac } from '../../../src/server/platform/hmac';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { FX, U, clientOf, phoneOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
});
after(() => closeClientsWorld(db));

const body = (set: PatchBody['set'], expect: PatchBody['expect']): PatchBody => ({ set, expect });

async function events(clientId: string) {
  return db.sql<{ kind: string; data: Record<string, unknown>; actorId: string }>`
    SELECT kind, data, actor_id FROM client_events WHERE client_id = ${clientId} AND kind = 'field.changed' ORDER BY id`;
}

async function issuesOf(p: Promise<unknown>): Promise<Array<{ key: string; code: string }>> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FieldIssuesError) return e.issues.map((i) => ({ key: i.key, code: i.code }));
    throw e;
  }
  assert.fail('ожидалась ошибка полей');
}

test('правка двух полей пишет по событию «было → стало» на каждое и обновляет карточку', async () => {
  const id = clientOf('a', 10);
  const v = await viewerOf(U.opA);
  const card = await updateClient(
    v,
    id,
    body({ system: { region: 'Алматы' }, custom: { segment: 'малый бизнес', industry: 'trade' } }, { system: { region: '' }, custom: { segment: null, industry: null } }),
  );
  assert.equal(card.region, 'Алматы');
  assert.equal(card.fields.values.segment, 'малый бизнес');
  assert.equal(card.fields.values.industry, 'trade');
  const ev = await events(id);
  assert.equal(ev.length, 3);
  const byField = Object.fromEntries(ev.map((e) => [e.data.field as string, e.data]));
  assert.deepEqual(byField.region, { obj: 'client', sys: true, field: 'region', before: null, after: 'Алматы' });
  assert.deepEqual(byField.segment, { obj: 'client', sys: false, field: 'segment', before: null, after: 'малый бизнес' });
  assert.deepEqual(byField.industry, { obj: 'client', sys: false, field: 'industry', before: null, after: 'trade' });
  assert.ok(ev.every((e) => e.actorId === U.opA));
  // второй раз: было → стало с реальным прежним значением
  await updateClient(v, id, body({ system: {}, custom: { segment: 'средний' } }, { system: {}, custom: { segment: 'малый бизнес' } }));
  const last = (await events(id)).filter((e) => e.data.field === 'segment');
  assert.equal(last.length, 2);
  assert.ok(last.some((e) => e.data.before === 'малый бизнес' && e.data.after === 'средний'));
});

test('без изменений — ни записи, ни событий', async () => {
  const id = clientOf('a', 11);
  const v = await viewerOf(U.opA);
  await updateClient(v, id, body({ system: {}, custom: { segment: 'x' } }, { system: {}, custom: { segment: null } }));
  const before = (await events(id)).length;
  const t0 = (await db.sql<{ updatedAt: number }>`SELECT updated_at FROM clients WHERE id = ${id}`)[0]?.updatedAt;
  await updateClient(v, id, body({ system: { region: '' }, custom: { segment: 'x' } }, { system: { region: '' }, custom: { segment: 'x' } }));
  await updateClient(v, id, body({ system: {}, custom: {} }, { system: {}, custom: {} }));
  assert.equal((await events(id)).length, before);
  const t1 = (await db.sql<{ updatedAt: number }>`SELECT updated_at FROM clients WHERE id = ${id}`)[0]?.updatedAt;
  assert.equal(t1, t0);
});

test('expect не совпал — 409, ничего не записано', async () => {
  const id = clientOf('a', 12);
  const v = await viewerOf(U.opA);
  await updateClient(v, id, body({ system: {}, custom: { segment: 'один' } }, { system: {}, custom: { segment: null } }));
  await assert.rejects(
    updateClient(v, id, body({ system: { region: 'Астана' }, custom: { segment: 'два' } }, { system: { region: '' }, custom: { segment: 'устарело' } })),
    { code: 'conflict' },
  );
  const c = await getClientCard(v, id);
  assert.equal(c.region, '');
  assert.equal(c.fields.values.segment, 'один');
  // системное поле тоже сверяется
  await db.sql`UPDATE clients SET region = 'Шымкент' WHERE id = ${id}`;
  await assert.rejects(updateClient(v, id, body({ system: { region: 'Атырау' }, custom: {} }, { system: { region: '' }, custom: {} })), { code: 'conflict' });
});

test('оператор не меняет название и БИН: forbidden; РОП может', async () => {
  const id = clientOf('a', 13);
  const op = await viewerOf(U.opA);
  const issues = await issuesOf(updateClient(op, id, body({ system: { name: 'Другое', org_id: '123456789012' }, custom: {} }, { system: { name: 'ТОО Синтетика Альфа 13', org_id: '' }, custom: {} })));
  assert.deepEqual(issues.sort((a, b) => a.key.localeCompare(b.key)), [
    { key: 'name', code: 'forbidden' },
    { key: 'org_id', code: 'forbidden' },
  ]);
  const rop = await viewerOf(U.rop);
  const c = await updateClient(rop, id, body({ system: { name: 'ТОО Новая Сова', legal_form: 'llp', org_id: '123456789012' }, custom: {} }, { system: { name: 'ТОО Синтетика Альфа 13', legal_form: '', org_id: '' }, custom: {} }));
  assert.equal(c.name, 'ТОО Новая Сова');
  assert.equal(c.orgId, '123456789012');
});

test('переименование обновляет name_norm и search_norm (название, БИН, номера, видимые всем поля)', async () => {
  const id = clientOf('a', 14);
  const rop = await viewerOf(U.rop);
  // secret — «только чтение» даже для РОП: значение пришло из приёма или импорта
  await db.sql`UPDATE clients SET custom = custom || ${db.json({ secret: 'скрытое слово' }) as never} WHERE id = ${id}`;
  await updateClient(rop, id, body({ system: { name: 'ТОО «Қазына Ай»', legal_form: 'llp', org_id: '210987654321' }, custom: { segment: 'Оптовик' } }, { system: { name: 'ТОО Синтетика Альфа 14', legal_form: '', org_id: '' }, custom: { segment: null } }));
  const [row] = await db.sql<{ nameNorm: string; searchNorm: string }>`SELECT name_norm, search_norm FROM clients WHERE id = ${id}`;
  assert.equal(row?.nameNorm, 'казына ай');
  assert.ok(row?.searchNorm.includes('казына ай'), row?.searchNorm);
  assert.ok(row?.searchNorm.includes('210987654321'));
  assert.ok(row?.searchNorm.includes(phoneOf('a', 14)));
  assert.ok(row?.searchNorm.includes('оптовик'));
  // secret скрыт от оператора — в общий поиск не попадает
  assert.ok(!row?.searchNorm.includes('скрытое'));
});

test('скрытое поле и несуществующее — одинаковая ошибка unknown_field', async () => {
  const op = await viewerOf(U.opA);
  const id = clientOf('a', 15);
  const hidden = await issuesOf(updateClient(op, id, body({ system: {}, custom: { secret: 'x' } }, { system: {}, custom: { secret: null } })));
  const none = await issuesOf(updateClient(op, id, body({ system: {}, custom: { nope: 'x' } }, { system: {}, custom: { nope: null } })));
  assert.deepEqual(hidden, [{ key: 'secret', code: 'unknown_field' }]);
  assert.deepEqual(none, [{ key: 'nope', code: 'unknown_field' }]);
  // у РОП то же поле — только чтение, а не «нет такого»
  const rop = await viewerOf(U.rop);
  assert.deepEqual(await issuesOf(updateClient(rop, id, body({ system: {}, custom: { secret: 'x' } }, { system: {}, custom: { secret: null } }))), [{ key: 'secret', code: 'forbidden' }]);
});

test('поле «только чтение» для оператора — forbidden; для РОП правится (деньги — целые тенге)', async () => {
  const id = clientOf('a', 16);
  const op = await viewerOf(U.opA);
  assert.deepEqual(await issuesOf(updateClient(op, id, body({ system: {}, custom: { credit: 1000 } }, { system: {}, custom: { credit: null } }))), [{ key: 'credit', code: 'forbidden' }]);
  const rop = await viewerOf(U.rop);
  assert.deepEqual(await issuesOf(updateClient(rop, id, body({ system: {}, custom: { credit: 10.5 } }, { system: {}, custom: { credit: null } }))), [{ key: 'credit', code: 'type' }]);
  const c = await updateClient(rop, id, body({ system: {}, custom: { credit: '1 500 000' } }, { system: {}, custom: { credit: null } }));
  assert.equal(c.fields.values.credit, 1500000);
  // оператор видит поле, но не правит
  const seen = (await getClientCard(op, id)).fields.fields.find((f) => f.key === 'credit');
  assert.equal(seen?.access, 'read');
  assert.equal(seen?.value, 1500000);
});

test('ссылки: javascript: и прочие схемы отвергаются в системном и пользовательском поле', async () => {
  const id = clientOf('a', 17);
  const op = await viewerOf(U.opA);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.kz', 'https://user:pw@example.kz']) {
    assert.deepEqual(await issuesOf(updateClient(op, id, body({ system: { website: bad }, custom: { link: bad } }, { system: { website: '' }, custom: { link: null } }))), [
      { key: 'website', code: 'url' },
      { key: 'link', code: 'url' },
    ]);
  }
  const c = await updateClient(op, id, body({ system: { website: 'example.kz/about' }, custom: { link: 'HTTPS://Example.kz' } }, { system: { website: '' }, custom: { link: null } }));
  assert.equal(c.websiteHref, 'https://example.kz/about');
  assert.equal(c.fields.fields.find((f) => f.key === 'link')?.href, 'https://example.kz/');
  // почта
  assert.deepEqual(await issuesOf(updateClient(op, id, body({ system: { email: 'не почта' }, custom: {} }, { system: { email: '' }, custom: {} }))), [{ key: 'email', code: 'email' }]);
  const m = await updateClient(op, id, body({ system: { email: ' Info@Example.KZ ' }, custom: {} }, { system: { email: '' }, custom: {} }));
  assert.equal(m.email, 'info@example.kz');
  assert.equal(m.emailHref, 'mailto:info@example.kz');
});

test('варианты списков: архивный вариант нельзя выбрать заново; неизвестный отвергается', async () => {
  const id = clientOf('a', 18);
  const op = await viewerOf(U.opA);
  assert.deepEqual(await issuesOf(updateClient(op, id, body({ system: {}, custom: { industry: 'old' } }, { system: {}, custom: { industry: null } }))), [{ key: 'industry', code: 'option' }]);
  assert.deepEqual(await issuesOf(updateClient(op, id, body({ system: {}, custom: { industry: 'zzz' } }, { system: {}, custom: { industry: null } }))), [{ key: 'industry', code: 'option' }]);
  const c = await updateClient(op, id, body({ system: {}, custom: { tags: ['new', 'vip'] } }, { system: {}, custom: { tags: null } }));
  assert.deepEqual(c.fields.values.tags, ['vip', 'new']);
});

test('форма собственности: неизвестная отвергается, смена на ИП очищает БИН', async () => {
  const id = clientOf('a', 19);
  const rop = await viewerOf(U.rop);
  assert.deepEqual(await issuesOf(updateClient(rop, id, body({ system: { legal_form: 'nope' }, custom: {} }, { system: { legal_form: '' }, custom: {} }))), [{ key: 'legal_form', code: 'option' }]);
  await updateClient(rop, id, body({ system: { legal_form: 'llp', org_id: '111122223333' }, custom: {} }, { system: { legal_form: '', org_id: '' }, custom: {} }));
  const c = await updateClient(rop, id, body({ system: { legal_form: 'sole' }, custom: {} }, { system: { legal_form: 'llp' }, custom: {} }));
  assert.equal(c.legalForm, 'sole');
  assert.equal(c.orgId, '');
});

/** Строка клиента, события и поиск: открытого ИИН нигде нет, HMAC — только в iin_hmac (D-181). */
async function assertIinHidden(id: string, iin: string) {
  const [row] = await db.sql<{ orgId: string; iinHmac: string | null; searchNorm: string }>`SELECT org_id, iin_hmac, search_norm FROM clients WHERE id = ${id}`;
  assert.equal(row?.orgId, '');
  assert.equal(row?.iinHmac, iinHmac(iin));
  assert.ok(!row?.searchNorm.includes(iin), row?.searchNorm);
  const all = await db.sql<{ data: unknown }>`SELECT data FROM client_events WHERE client_id = ${id}`;
  for (const e of all) {
    assert.ok(!JSON.stringify(e.data).includes(iin), 'ИИН в ленте');
    assert.ok(!JSON.stringify(e.data).includes(iinHmac(iin)), 'HMAC ИИН в ленте');
  }
  const rop = await viewerOf(U.rop);
  assert.deepEqual((await listClients(rop, parseListQuery(new URLSearchParams(`q=${iin}`)))).items, []);
  assert.equal((await getClientCard(rop, id)).orgId, '');
}

test('12 цифр при пустой форме, форме ИП и у физлица — только HMAC: не в org_id, не в поиске, не в ленте (D-181)', async () => {
  const rop = await viewerOf(U.rop);
  // пустая форма: номер мог быть ИИН — скрыт «по неуверенности»
  const empty = clientOf('a', 23);
  await updateClient(rop, empty, body({ system: { org_id: '880101300123' }, custom: {} }, { system: { org_id: '' }, custom: {} }));
  await assertIinHidden(empty, '880101300123');
  // явная очистка формы у ТОО с БИН: БИН очищается (событие с прежним БИН), новый номер скрыт
  const cleared = clientOf('a', 24);
  await updateClient(rop, cleared, body({ system: { legal_form: 'llp', org_id: '444455556666' }, custom: {} }, { system: { legal_form: '', org_id: '' }, custom: {} }));
  await updateClient(rop, cleared, body({ system: { legal_form: '', org_id: '880101300124' }, custom: {} }, { system: { legal_form: 'llp', org_id: '444455556666' }, custom: {} }));
  await assertIinHidden(cleared, '880101300124');
  // форма ИП
  const sole = clientOf('a', 25);
  await updateClient(rop, sole, body({ system: { legal_form: 'sole', org_id: '880101300125' }, custom: {} }, { system: { legal_form: '', org_id: '' }, custom: {} }));
  await assertIinHidden(sole, '880101300125');
  // физлицо: даже с формой без личного номера
  const person = clientOf('a', 26);
  await db.sql`UPDATE clients SET kind = 'person', legal_form = 'llp' WHERE id = ${person}`;
  await updateClient(rop, person, body({ system: { org_id: '880101300126' }, custom: {} }, { system: { org_id: '' }, custom: {} }));
  await assertIinHidden(person, '880101300126');
  // тот же ИИН у другого клиента — не второй клиент с этим ИИН; ответ без 409 (D-192, отдельный тест ниже)
  await updateClient(rop, clientOf('a', 27), body({ system: { org_id: '880101300123' }, custom: {} }, { system: { org_id: '' }, custom: {} }));
  const [twin] = await db.sql<{ iinHmac: string | null }>`SELECT iin_hmac FROM clients WHERE id = ${clientOf('a', 27)}`;
  assert.equal(twin?.iinHmac, null);
});

async function hiddenOf(id: string): Promise<string | null> {
  const [row] = await db.sql<{ iinHmac: string | null }>`SELECT iin_hmac FROM clients WHERE id = ${id}`;
  return row?.iinHmac ?? null;
}

async function allEvents(id: string) {
  return db.sql<{ kind: string; data: Record<string, unknown> }>`SELECT kind, data FROM client_events WHERE client_id = ${id} ORDER BY id`;
}

test('занятый ИИН (D-192): ответ как при записи, без 409; HMAC не пишется, РОП получает задачу без ИИН', async () => {
  const rop = await viewerOf(U.rop);
  const iin = '880101300140';
  const owner = clientOf('a', 39);
  await updateClient(rop, owner, body({ system: { legal_form: 'sole', org_id: iin }, custom: {} }, { system: { legal_form: '', org_id: '' }, custom: {} }));
  assert.equal(await hiddenOf(owner), iinHmac(iin));

  const id = clientOf('a', 40);
  const free = clientOf('a', 48);
  const patch = (cid: string, number: string) =>
    updateClient(rop, cid, body({ system: { legal_form: 'sole', org_id: number, region: 'Павлодар' }, custom: {} }, { system: { legal_form: '', org_id: '', region: '' }, custom: {} }));
  const taken = await patch(id, iin);
  const ok = await patch(free, '880101300148');
  // Наружу одинаково: остальные поля записаны, номер скрыт в обоих случаях
  assert.deepEqual([taken.legalForm, taken.orgId, taken.region], ['sole', '', 'Павлодар']);
  assert.deepEqual([ok.legalForm, ok.orgId, ok.region], ['sole', '', 'Павлодар']);
  const kinds = async (cid: string) => (await allEvents(cid)).map((e) => `${e.kind}:${String(e.data.field)}`).sort();
  assert.deepEqual(await kinds(id), await kinds(free));
  // Внутри: у занятого HMAC не записан, у владельца ИИН он прежний
  assert.equal(await hiddenOf(id), null);
  assert.equal(await hiddenOf(free), iinHmac('880101300148'));
  assert.equal(await hiddenOf(owner), iinHmac(iin));

  const tasks = await db.sql<{ kind: string; source: string; title: string; assigneeUserId: string | null; sourceKey: string; status: string }>`
    SELECT kind, source, title, assignee_user_id, source_key, status FROM tasks WHERE client_id = ${id}`;
  assert.deepEqual(tasks, [{ kind: 'check', source: 'review', title: '', assigneeUserId: null, sourceKey: `iin_taken:${id}:${owner}`, status: 'open' }]);
  assert.ok(!JSON.stringify(tasks).includes(iin) && !JSON.stringify(tasks).includes(iinHmac(iin)));
  assert.equal((await db.sql`SELECT 1 FROM tasks WHERE client_id = ${free}`).length, 0);

  // Повтор той же правки — задача не задваивается
  await updateClient(rop, id, body({ system: { org_id: iin }, custom: {} }, { system: {}, custom: {} }));
  assert.equal((await db.sql`SELECT 1 FROM tasks WHERE client_id = ${id}`).length, 1);
});

test('скрытый номер сбрасывается очисткой org_id и сменой формы на «не личную»; событий о нём нет (D-192)', async () => {
  const rop = await viewerOf(U.rop);
  // очистка номера у ИП: org_id и так пуст, но HMAC сбрасывается
  const sole = clientOf('a', 28);
  await updateClient(rop, sole, body({ system: { legal_form: 'sole', org_id: '880101300128' }, custom: {} }, { system: { legal_form: '', org_id: '' }, custom: {} }));
  const before = (await allEvents(sole)).length;
  await updateClient(rop, sole, body({ system: { org_id: null }, custom: {} }, { system: { org_id: '' }, custom: {} }));
  assert.equal(await hiddenOf(sole), null);
  assert.equal((await allEvents(sole)).length, before, 'очистка скрытого номера не пишет событие');

  // неопределённая форма: очистка пустой строкой
  const uncertain = clientOf('a', 29);
  await updateClient(rop, uncertain, body({ system: { org_id: '880101300129' }, custom: {} }, { system: { org_id: '' }, custom: {} }));
  assert.equal(await hiddenOf(uncertain), iinHmac('880101300129'));
  await updateClient(rop, uncertain, body({ system: { org_id: '' }, custom: {} }, { system: {}, custom: {} }));
  assert.equal(await hiddenOf(uncertain), null);

  // смена формы ИП → ТОО: HMAC сброшен, в ленте только смена формы
  const toLlp = clientOf('a', 49);
  await updateClient(rop, toLlp, body({ system: { legal_form: 'sole', org_id: '880101300149' }, custom: {} }, { system: { legal_form: '', org_id: '' }, custom: {} }));
  const n = (await allEvents(toLlp)).length;
  const card = await updateClient(rop, toLlp, body({ system: { legal_form: 'llp' }, custom: {} }, { system: { legal_form: 'sole' }, custom: {} }));
  assert.equal(card.legalForm, 'llp');
  assert.equal(await hiddenOf(toLlp), null);
  const added = (await allEvents(toLlp)).slice(n);
  assert.deepEqual(added.map((e) => e.data.field), ['legal_form']);

  // форма убрана (стала неопределённой) — номер мог быть ИИН: HMAC остаётся
  await updateClient(rop, sole, body({ system: { org_id: '880101300128' }, custom: {} }, { system: {}, custom: {} }));
  await updateClient(rop, sole, body({ system: { legal_form: '' }, custom: {} }, { system: { legal_form: 'sole' }, custom: {} }));
  assert.equal(await hiddenOf(sole), iinHmac('880101300128'));
});

test('занятый БИН — 409, транзакция откачена: ни полей, ни событий', async () => {
  const rop = await viewerOf(U.rop);
  await updateClient(rop, clientOf('a', 20), body({ system: { legal_form: 'llp', org_id: '555566667777' }, custom: {} }, { system: { legal_form: '', org_id: '' }, custom: {} }));
  const id = clientOf('a', 21);
  await assert.rejects(
    updateClient(rop, id, body({ system: { legal_form: 'llp', org_id: '555566667777', region: 'Павлодар' }, custom: { segment: 'не запишется' } }, { system: { legal_form: '', org_id: '', region: '' }, custom: { segment: null } })),
    { code: 'conflict' },
  );
  const c = await getClientCard(rop, id);
  assert.equal(c.region, '');
  assert.equal(c.fields.values.segment, undefined);
  assert.equal((await events(id)).length, 0);
});

test('название не может быть пустым', async () => {
  const rop = await viewerOf(U.rop);
  assert.deepEqual(await issuesOf(updateClient(rop, clientOf('a', 22), body({ system: { name: '  ' }, custom: {} }, { system: { name: 'ТОО Синтетика Альфа 22' }, custom: {} }))), [{ key: 'name', code: 'required' }]);
});

test('клиент виден, но не правится — 403; чужой и несуществующий — 404 (без следов)', async () => {
  // консультант в окне записи: читает клиента B2, но права client.edit у роли нет
  const cons = await viewerOf(U.consultant);
  const target = FX.bkInWindow.client;
  const snap = async () => (await db.sql`SELECT count(*)::int AS n FROM client_events`)[0]?.n;
  const n0 = await snap();
  await assert.rejects(updateClient(cons, target, body({ system: { region: 'x' }, custom: {} }, { system: { region: '' }, custom: {} })), { code: 'forbidden' });
  const op = await viewerOf(U.opA);
  await assert.rejects(updateClient(op, clientOf('b', 1), body({ system: { region: 'x' }, custom: {} }, { system: { region: '' }, custom: {} })), { code: 'not_found' });
  await assert.rejects(updateClient(op, 'cl-nope', body({ system: { region: 'x' }, custom: {} }, { system: { region: '' }, custom: {} })), { code: 'not_found' });
  assert.equal(await snap(), n0);
});
