// Сохранение поля на месте с карточки клиента: адрес, тело и разбор ответов (D-356).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveInline, saveRequest } from '../../../src/app/(op)/clients/_ui/inlineSave';

const json = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

const client = { object: 'client', scope: 'custom', key: 'district', clientId: 'cl-1' } as const;
const sysT = { object: 'client', scope: 'system', key: 'region', clientId: 'cl-1' } as const;
const card = { object: 'card', key: 'plan', cardId: 'cd-1' } as const;

test('поле клиента — PATCH /api/clients/[id] с set и expect по одному ключу', () => {
  assert.deepEqual(saveRequest(client, 'Есиль', null), {
    url: '/api/clients/cl-1',
    body: { set: { custom: { district: 'Есиль' }, system: {} }, expect: { custom: { district: null }, system: {} } },
  });
  assert.deepEqual(saveRequest(sysT, 'Астана', '').body, { set: { system: { region: 'Астана' }, custom: {} }, expect: { system: { region: null }, custom: {} } });
});

test('поле карточки — PATCH /api/cards/[id] без version', () => {
  const r = saveRequest(card, 'два', 'один');
  assert.equal(r.url, '/api/cards/cd-1');
  assert.deepEqual(r.body, { set: { custom: { plan: 'два' } }, expect: { custom: { plan: 'один' } } });
});

test('409 клиента: новое значение берётся из current своего раздела', async () => {
  const r = await saveInline(client, 'x', null, json(409, { error: 'conflict', current: { system: {}, custom: { district: 'Алмалы' } } }));
  assert.deepEqual(r, { ok: false, kind: 'conflict', current: 'Алмалы', known: true });
  const s = await saveInline(sysT, 'x', null, json(409, { error: 'conflict', current: { system: { region: 'Алматы' }, custom: {} } }));
  assert.deepEqual(s, { ok: false, kind: 'conflict', current: 'Алматы', known: true });
});

test('409 без значения: известно, что изменено, но не что', async () => {
  const r = await saveInline(client, 'x', null, json(409, { error: 'conflict' }));
  assert.deepEqual(r, { ok: false, kind: 'conflict', current: null, known: false });
  const c = await saveInline(card, 'x', null, json(409, { error: 'conflict', current: 'чужое', key: 'plan' }));
  assert.deepEqual(c, { ok: false, kind: 'conflict', current: 'чужое', known: true });
});

test('400 по полю несёт код проверки, 403/404 — нет права, 423 — только чтение, сеть', async () => {
  assert.deepEqual(await saveInline(client, 'x', null, json(400, { detail: 'fields', issues: [{ key: 'district', code: 'too_long' }] })), { ok: false, kind: 'fields', code: 'too_long' });
  assert.deepEqual(await saveInline(client, 'x', null, json(400, { error: 'bad_request' })), { ok: false, kind: 'invalid' });
  assert.deepEqual(await saveInline(client, 'x', null, json(403, {})), { ok: false, kind: 'forbidden' });
  assert.deepEqual(await saveInline(client, 'x', null, json(404, {})), { ok: false, kind: 'forbidden' });
  assert.deepEqual(await saveInline(client, 'x', null, json(423, {})), { ok: false, kind: 'readonly' });
  assert.deepEqual(await saveInline(client, 'x', null, (async () => { throw new Error('offline'); }) as unknown as typeof fetch), { ok: false, kind: 'network' });
  assert.deepEqual(await saveInline(client, 'x', null, json(200, {})), { ok: true });
});
