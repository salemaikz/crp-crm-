// Сохранение одного поля из карточки обзвона: тело PATCH без версии, разбор 409 и прочих ответов.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveField } from '../../../src/ui/call/fieldApi';
import { draftOf, expectOf, isEmptyValue, payloadOf } from '../../../src/ui/fields/draft';

type Call = { url: string; init?: RequestInit | undefined };
function fake(responses: Array<Response | Error>): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r!;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const card = { object: 'card' as const, key: 'plan', cardId: 'cd-1', clientId: 'cl-1' };
const client = { object: 'client' as const, key: 'size', cardId: 'cd-1', clientId: 'cl-1' };

test('поле карточки: PATCH /api/cards/[id] без version, expect — прежнее значение', async () => {
  const { fetchFn, calls } = fake([json(200, {})]);
  assert.deepEqual(await saveField(card, null, 'новое', fetchFn), { ok: true });
  assert.equal(calls[0]?.url, '/api/cards/cd-1');
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.deepEqual(body, { set: { custom: { plan: 'новое' } }, expect: { custom: { plan: null } } });
  assert.equal('version' in body, false);
});

test('поле клиента: PATCH /api/clients/[id]; число в expect остаётся числом', async () => {
  const { fetchFn, calls } = fake([json(200, {})]);
  await saveField(client, 12, '15', fetchFn);
  assert.equal(calls[0]?.url, '/api/clients/cl-1');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)).expect, { custom: { size: 12 } });
});

test('409 по полю карточки несёт новое значение', async () => {
  const { fetchFn } = fake([json(409, { error: 'conflict', detail: 'card_changed', key: 'plan', current: 'чужое' })]);
  assert.deepEqual(await saveField(card, null, 'х', fetchFn), { ok: false, kind: 'conflict', current: 'чужое', known: true });
});

test('409 по полю клиента: новое значение читается из карточки клиента', async () => {
  const { fetchFn, calls } = fake([json(409, { error: 'conflict' }), json(200, { fields: { fields: [{ key: 'size', value: '20' }] } })]);
  assert.deepEqual(await saveField(client, '12', '15', fetchFn), { ok: false, kind: 'conflict', current: '20', known: true });
  assert.equal(calls[1]?.url, '/api/clients/cl-1');
});

test('коды ответов: 400 поля, 404 и 423 — нет права, сеть', async () => {
  const run = (r: Response | Error) => saveField(card, null, 'х', fake([r]).fetchFn);
  assert.deepEqual(await run(json(400, { error: 'bad_request', detail: 'fields', issues: [] })), { ok: false, kind: 'fields' });
  assert.deepEqual(await run(json(400, { error: 'bad_request' })), { ok: false, kind: 'invalid' });
  assert.deepEqual(await run(json(404, { error: 'not_found' })), { ok: false, kind: 'forbidden' });
  assert.deepEqual(await run(json(423, { error: 'read_only' })), { ok: false, kind: 'forbidden' });
  assert.deepEqual(await run(new Error('offline')), { ok: false, kind: 'network' });
});

test('черновик: пустое — null, список и флажок сохраняют вид', () => {
  assert.equal(payloadOf('  '), null);
  assert.equal(payloadOf(' а '), 'а');
  assert.equal(payloadOf([]), null);
  assert.deepEqual(payloadOf(['a']), ['a']);
  assert.equal(payloadOf(false), false);
  assert.equal(draftOf('boolean', true), true);
  assert.deepEqual(draftOf('multiselect', ['a']), ['a']);
  assert.equal(draftOf('number', 5), '5');
  assert.equal(draftOf('text', null), '');
  assert.equal(isEmptyValue(''), true);
  assert.equal(isEmptyValue(false), false);
  assert.equal(expectOf(''), null);
  assert.equal(expectOf(0), 0);
});
