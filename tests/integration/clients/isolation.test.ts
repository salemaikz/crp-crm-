// Изоляция клиентов (D-017, D-124): чужой объект отвечает как несуществующий, мутации не оставляют следов,
// окно консультанта читает, но не пишет, «только чтение» — 423, поля ошибок — только ключи и коды.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { ManifestEntry } from '../../isolation/harness/manifest';
import manifest from '../../isolation/manifest/clients';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { actAs } from '../../isolation/harness/actors';
import { FX, U, clientOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from './world';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const ORIGIN = 'http://crm.test';
const NONE = 'zz-none';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
  await db.sql`INSERT INTO contacts (id, client_id, name, created_at) VALUES ('ct-b-iso', ${clientOf('b', 1)}, 'Контакт Б', 1)`;
});
after(() => closeClientsWorld(db));

type Handler = (req: Request, ctx: { params: Promise<unknown> }) => Promise<Response>;

async function handlerOf(e: ManifestEntry): Promise<Handler> {
  const file = join(ROOT, 'src', 'app', `${e.path}`, 'route.ts');
  const mod = (await import(pathToFileURL(file).href)) as Record<string, Handler | undefined>;
  const h = mod[e.method];
  assert.equal(typeof h, 'function', `${e.method} ${e.path}: нет обработчика`);
  return h as Handler;
}

function request(e: ManifestEntry, id: string | null, body?: unknown): { req: Request; params: Record<string, string> } {
  const path = e.path.replace('[id]', id ?? NONE);
  const init: RequestInit = { method: e.method, headers: { origin: ORIGIN, 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return { req: new Request(`${ORIGIN}${path}`, init), params: id ? { id } : {} };
}

async function call(e: ManifestEntry, id: string | null, body: unknown = e.sampleBody): Promise<{ status: number; text: string }> {
  const h = await handlerOf(e);
  const { req, params } = request(e, id, body);
  const res = await h(req, { params: Promise.resolve(params) });
  return { status: res.status, text: await res.text() };
}

/** Отпечаток таблиц, которые могут менять мутации клиентов: «до» и «после» чужого запроса совпадают. */
async function snapshot(): Promise<string> {
  const h = async (rows: Promise<{ h: string | null }[]>) => (await rows)[0]?.h ?? '';
  return [
    await h(db.sql`SELECT md5(string_agg(x::text, '' ORDER BY x::text)) AS h FROM clients x`),
    await h(db.sql`SELECT md5(string_agg(x::text, '' ORDER BY x::text)) AS h FROM client_phones x`),
    await h(db.sql`SELECT md5(string_agg(x::text, '' ORDER BY x::text)) AS h FROM contacts x`),
    await h(db.sql`SELECT md5(string_agg(x::text, '' ORDER BY x::text)) AS h FROM client_events x`),
    await h(db.sql`SELECT md5(string_agg(x::text, '' ORDER BY x::text)) AS h FROM phone_probes x`),
    await h(db.sql`SELECT md5(string_agg(x::text, '' ORDER BY x::text)) AS h FROM tasks x`),
    await h(db.sql`SELECT md5(string_agg(x::text, '' ORDER BY x::text)) AS h FROM stop_list x`),
  ].join('|');
}

/** Объект оператора B для каждой сущности манифеста. */
const THEIRS: Record<string, string | undefined> = { client: clientOf('b', 1), client_phone: 'ph-b-1', contact: 'ct-b-iso' };

test('манифест и маршруты совпадают: у каждой записи есть обработчик', async () => {
  for (const e of manifest.entries.filter((x) => x.kind === 'route')) await handlerOf(e);
  const routes = manifest.entries.filter((x) => x.kind === 'route').length;
  assert.equal(routes, 8);
});

test('оператор A: объект оператора B отвечает байт в байт как несуществующий id, следов нет', async () => {
  actAs(U.opA);
  for (const e of manifest.entries.filter((x) => x.kind === 'route' && x.idParam)) {
    const theirs = THEIRS[e.idParam!.entity];
    assert.ok(theirs, e.path);
    const before = await snapshot();
    const a = await call(e, theirs);
    const b = await call(e, NONE);
    assert.equal(a.status, 404, `${e.method} ${e.path}`);
    assert.deepEqual(a, b, `${e.method} ${e.path}: чужой и несуществующий отличаются`);
    assert.equal(a.text, '{"error":"not_found"}');
    assert.equal(await snapshot(), before, `${e.method} ${e.path}: чужой запрос оставил след`);
  }
});

test('оператор A: свои объекты — 200; ошибки полей — 400 с ключами и кодами без значений', async () => {
  actAs(U.opA);
  const mine = clientOf('a', 90);
  const get = manifest.entries.find((e) => e.method === 'GET' && e.path === '/api/clients/[id]')!;
  const r = await call(get, mine);
  assert.equal(r.status, 200);
  assert.equal((JSON.parse(r.text) as { id: string }).id, mine);

  const patch = manifest.entries.find((e) => e.method === 'PATCH' && e.path === '/api/clients/[id]')!;
  const bad = await call(patch, mine, { set: { system: { website: 'javascript:alert(\'секрет\')' }, custom: { secret: 'x' } }, expect: { system: { website: '' }, custom: { secret: null } } });
  assert.equal(bad.status, 400);
  const body = JSON.parse(bad.text) as { error: string; detail: string; issues: Array<{ key: string; code: string }> };
  assert.equal(body.error, 'bad_request');
  assert.equal(body.detail, 'fields');
  assert.deepEqual(body.issues, [
    { key: 'website', code: 'url' },
    { key: 'secret', code: 'unknown_field' },
  ]);
  assert.ok(!bad.text.includes('секрет') && !bad.text.includes('javascript'), 'в ответе нет значений');

  const ok = await call(patch, mine, { set: { system: { region: 'Тараз' }, custom: {} }, expect: { system: { region: '' }, custom: {} } });
  assert.equal(ok.status, 200);
  assert.equal((JSON.parse(ok.text) as { region: string }).region, 'Тараз');
  const stale = await call(patch, mine, { set: { system: { region: 'Орал' }, custom: {} }, expect: { system: { region: '' }, custom: {} } });
  assert.equal(stale.status, 409);
});

test('мусор в теле и чужой Origin не доходят до данных', async () => {
  actAs(U.opA);
  const patch = manifest.entries.find((e) => e.method === 'PATCH' && e.path === '/api/clients/[id]')!;
  const h = await handlerOf(patch);
  const mine = clientOf('a', 91);
  const raw = (body: string, origin = ORIGIN) => h(new Request(`${ORIGIN}/api/clients/${mine}`, { method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body }), { params: Promise.resolve({ id: mine }) });
  assert.equal((await raw('{не json')).status, 400);
  assert.equal((await raw('{"set":{},"expect":{},"лишний":1}')).status, 400);
  assert.equal((await raw('{"set":{"custom":{"a":1}},"expect":{}}')).status, 400);
  assert.equal((await raw('{"set":{},"expect":{}}', 'http://evil.test')).status, 403);
});

test('номер: свободный — added, чужой — review (оба как для своего клиента), чужого клиента — 404', async () => {
  actAs(U.opA);
  const post = manifest.entries.find((e) => e.method === 'POST' && e.path === '/api/clients/[id]/phones')!;
  const mine = clientOf('a', 92);
  const free = await call(post, mine, { opId: '00000000-0000-4000-8000-0000000000a1', phone: '+7 709 555 11 11' });
  assert.equal(free.status, 200);
  assert.equal((JSON.parse(free.text) as { status: string }).status, 'added');
  const taken = await call(post, mine, { opId: '00000000-0000-4000-8000-0000000000a2', phone: '+7 709 100 00 02' });
  assert.equal(taken.status, 200);
  assert.deepEqual(JSON.parse(taken.text), { status: 'review' });
});

test('консультант в окне записи: читает карточку и ленту, пишет — нет (404 по праву, 403 по сервису)', async () => {
  actAs(U.consultant);
  const get = manifest.entries.find((e) => e.method === 'GET' && e.path === '/api/clients/[id]')!;
  const feed = manifest.entries.find((e) => e.path === '/api/clients/[id]/feed')!;
  const patch = manifest.entries.find((e) => e.method === 'PATCH' && e.path === '/api/clients/[id]')!;
  const inWin = FX.bkInWindow.client;
  assert.equal((await call(get, inWin)).status, 200);
  assert.equal((await call(feed, inWin)).status, 200);
  const before = await snapshot();
  assert.equal((await call(patch, inWin)).status, 404);
  assert.equal(await snapshot(), before);
  // окно ещё не открылось или уже закрылось
  for (const out of [FX.bkFuture.client, FX.bkPast.client, clientOf('b', 30)]) {
    assert.equal((await call(get, out)).status, 404, out);
    assert.equal((await call(feed, out)).status, 404, out);
  }
});

test('директор (только чтение): чтение 200, любая мутация 423', async () => {
  actAs(U.director);
  const get = manifest.entries.find((e) => e.method === 'GET' && e.path === '/api/clients/[id]')!;
  assert.equal((await call(get, clientOf('a', 93))).status, 200);
  const before = await snapshot();
  for (const e of manifest.entries.filter((x) => x.kind === 'route' && x.mutation)) {
    const own: Record<string, string> = { client: clientOf('a', 93), client_phone: 'ph-a-93', contact: 'ct-b-iso' };
    const id = e.idParam ? (own[e.idParam.entity] ?? NONE) : null;
    assert.equal((await call(e, id)).status, 423, `${e.method} ${e.path}`);
  }
  assert.equal(await snapshot(), before);
});

test('без сессии: 401 у всех маршрутов', async () => {
  actAs(null);
  for (const e of manifest.entries.filter((x) => x.kind === 'route')) {
    const id = e.idParam ? clientOf('a', 1) : null;
    assert.equal((await call(e, id)).status, 401, `${e.method} ${e.path}`);
  }
});

test('список: оператор A получает только свои карточки', async () => {
  actAs(U.opA);
  const list = manifest.entries.find((e) => e.path === '/api/clients')!;
  const h = await handlerOf(list);
  const res = await h(new Request(`${ORIGIN}/api/clients?q=${encodeURIComponent('бета')}`), { params: Promise.resolve({}) });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, { items: [], next: null });
  const bad = await h(new Request(`${ORIGIN}/api/clients?state=nope`), { params: Promise.resolve({}) });
  assert.equal(bad.status, 400);
});

test('страница карточки: чужой клиент — notFound без данных, без сессии — переход на вход', async () => {
  const page = (await import('../../../src/app/(op)/clients/[id]/page')).default;
  actAs(U.opA);
  await assert.rejects(page({ params: Promise.resolve({ id: clientOf('b', 1) }) }), (e: { digest?: string }) => String(e.digest).includes('404'));
  await assert.rejects(page({ params: Promise.resolve({ id: NONE }) }), (e: { digest?: string }) => String(e.digest).includes('404'));
  // нет права client.read: оператор без членства / маркетолог без отношений
  actAs(U.marketer);
  await assert.rejects(page({ params: Promise.resolve({ id: clientOf('a', 1) }) }), (e: { digest?: string }) => String(e.digest).includes('404'));
  actAs(null);
  await assert.rejects(page({ params: Promise.resolve({ id: clientOf('a', 1) }) }), (e: { digest?: string }) => String(e.digest).includes('REDIRECT'));
});
