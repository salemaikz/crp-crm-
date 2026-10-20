// Плагин messenger.wazzup на фикстурах (сеть не используется): verify, split (ключи, чистка payload, форматы id),
// parse (направление, тип, цифры номера, время), нормализация каналов.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx, InboxItem, MessengerMessageEvent, RawRequest } from '../../../src/integrations/contract';
import { createHttp } from '../../../src/integrations/http';
import { wazzupMessenger as p } from '../../../src/integrations/messenger/wazzup';
import { toEpochMs } from '../../../src/integrations/messenger/wazzup/parse';

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../integrations/messenger.wazzup/fixtures/${name}.json`, import.meta.url), 'utf8'));
const req = (json: unknown, method = 'POST'): RawRequest => ({ method, headers: { get: () => null }, body: new Uint8Array(), json });
const ctx = { integrationId: 'i1', spaceId: 's1', config: {}, secrets: async () => ({ apiKey: 'synthetic-key-0001' }), http: createHttp([]), appOrigin: '', now: 0 } as Ctx<never, never>;
const hook = p.webhook!;
const split = (name: string): InboxItem[] => hook.split(ctx, req(fx(name)));
const parseOne = (name: string): MessengerMessageEvent => {
  const [item] = split(name);
  const [ev] = hook.parse(item!.kind, item!.payload);
  assert.equal(ev?.type, 'message');
  return ev as MessengerMessageEvent;
};

test('verify: тест провайдера, обычное тело, не POST и не объект', () => {
  assert.deepEqual(hook.verify(ctx, req(fx('test'))), { ok: true, test: true });
  assert.deepEqual(hook.verify(ctx, req(fx('message-in'))), { ok: true, test: false });
  assert.deepEqual(hook.verify(ctx, req({}, 'GET')), { ok: false, code: 'bad_body' });
  assert.deepEqual(hook.verify(ctx, req(undefined)), { ok: false, code: 'bad_body' });
  assert.deepEqual(hook.verify(ctx, req([1])), { ok: false, code: 'bad_body' });
});

test('split: тест, неизвестные ключи и плохие id дают пусто', () => {
  assert.deepEqual(split('test'), []);
  assert.deepEqual(split('unknown-keys'), []);
  assert.deepEqual(split('bad-ids'), []);
  assert.deepEqual(hook.split(ctx, req('строка')), []);
});

test('split: входящее — ключ сообщения, выброшены avatarUri, contentUri, quotedMessage, oldInfo, qr', () => {
  const [m] = split('message-in');
  assert.equal(m!.kind, 'message');
  assert.equal(m!.dedupeKey, 'm:aaaaaaaa-0000-4000-8000-000000000001:0:0');
  const json = JSON.stringify(m!.payload);
  for (const gone of ['avatarUri', 'quotedMessage', 'contentUri', 'oldInfo', 'example.invalid']) assert.ok(!json.includes(gone), gone);
  assert.equal((m!.payload as { contactName: string }).contactName, 'Клиент Синтетика');
  const [img] = split('message-image');
  assert.ok(!JSON.stringify(img!.payload).includes('secret.jpg'));
  assert.equal((img!.payload as { hasContent: boolean }).hasContent, true);
  assert.ok(!JSON.stringify(split('channels-qr')).includes('base64'));
});

test('split: правка и удаление — разные ключи; статусы и каналы — свои ключи; чужой статус-мусор пропущен', () => {
  assert.equal(split('message-edited')[0]!.dedupeKey, 'm:aaaaaaaa-0000-4000-8000-000000000001:1:0');
  assert.equal(split('message-deleted')[0]!.dedupeKey, 'm:aaaaaaaa-0000-4000-8000-000000000001:0:1');
  assert.deepEqual(split('statuses').map((i) => [i.kind, i.dedupeKey]), [
    ['status', 's:aaaaaaaa-0000-4000-8000-000000000002:delivered'],
    ['status', 's:aaaaaaaa-0000-4000-8000-000000000002:read'],
  ]);
  assert.deepEqual(split('channels-qr').map((i) => i.dedupeKey), [
    'c:11111111-1111-4111-8111-111111111111:qr:1793180860000',
    'c:11111111-1111-4111-8111-111111111111:active:1793180960000',
  ]);
  for (const i of [...split('message-in'), ...split('statuses'), ...split('channels-qr')]) assert.match(i.dedupeKey, /^[\x21-\x7e]{1,200}$/);
});

test('parse: входящее текстовое — направление, цифры номера, время, имя контакта', () => {
  const e = parseOne('message-in');
  assert.equal(e.direction, 'in');
  assert.equal(e.msgType, 'text');
  assert.equal(e.chatDigits, '77090009001');
  assert.equal(e.channelRef, '11111111-1111-4111-8111-111111111111');
  assert.equal(e.sentAt, Date.parse('2026-10-28T09:42:55.000Z'));
  assert.equal(e.text, 'Здравствуйте, это синтетика');
  assert.equal(e.authorRef, null);
  assert.equal(e.contactName, 'Клиент Синтетика');
  assert.equal(e.hasAttachment, false);
});

test('parse: эхо — исходящее, автор и статус; время без пояса — UTC; номер 8… приводится к 7…', () => {
  const e = parseOne('message-echo');
  assert.equal(e.direction, 'out');
  assert.equal(e.chatDigits, '77090009001');
  assert.equal(e.authorRef, 'u-op-a');
  assert.equal(e.status, 'sent');
  assert.equal(e.sentAt, Date.parse('2026-10-28T09:45:00Z'));
  const eight = hook.parse('message', { messageId: 'm-8', channelId: 'c-1', dateTime: '2026-10-28T09:00:00Z', chatType: 'whatsapp', chatId: '87090009001' })[0] as MessengerMessageEvent;
  assert.equal(eight.chatDigits, '77090009001');
});

test('parse: правка, удаление (текст обнулён), пропущенный звонок, картинка с вложением', () => {
  const edited = parseOne('message-edited');
  assert.equal(edited.isEdited, true);
  assert.equal(edited.text, 'Исправленный текст');
  const deleted = parseOne('message-deleted');
  assert.equal(deleted.isDeleted, true);
  assert.equal(deleted.text, null);
  assert.equal(parseOne('missing-call').msgType, 'missing_call');
  const img = parseOne('message-image');
  assert.equal(img.msgType, 'image');
  assert.equal(img.hasAttachment, true);
});

test('parse: статусы (секунды и миллисекунды) и каналы в нижнем регистре; мусор — пусто', () => {
  const st = split('statuses').flatMap((i) => hook.parse(i.kind, i.payload));
  assert.deepEqual(st.map((e) => e.type === 'status' && [e.status, e.at]), [['delivered', 1793180760000], ['read', 1793180820000]]);
  const ch = split('channels-qr').flatMap((i) => hook.parse(i.kind, i.payload));
  assert.deepEqual(ch.map((e) => e.type === 'channel' && [e.state, e.at]), [['qr', 1793180860000], ['active', 1793180960000]]);
  assert.deepEqual(hook.parse('message', { nonsense: true }), []);
  assert.deepEqual(hook.parse('call', {}), []);
  assert.deepEqual(hook.parse('channel', null), []);
});

test('parse: чат не WhatsApp — без цифр номера; короткий номер — без цифр', () => {
  const base = { messageId: 'm-1', channelId: 'c-1', dateTime: '2026-10-28T09:00:00Z' };
  const tg = hook.parse('message', { ...base, chatType: 'telegram', chatId: '77090009001' })[0] as MessengerMessageEvent;
  assert.equal(tg.chatDigits, '');
  const short = hook.parse('message', { ...base, chatType: 'whatsapp', chatId: '12345' })[0] as MessengerMessageEvent;
  assert.equal(short.chatDigits, '');
  assert.deepEqual(hook.parse('message', { ...base, dateTime: 'вчера', chatType: 'whatsapp', chatId: '77090009001' }), []);
});

test('toEpochMs: секунды, миллисекунды, ISO с поясом и без', () => {
  assert.equal(toEpochMs(1792000000), 1792000000000);
  assert.equal(toEpochMs(1792000000123), 1792000000123);
  assert.equal(toEpochMs('2026-10-28T12:00:00+05:00'), Date.parse('2026-10-28T07:00:00Z'));
  assert.equal(toEpochMs('2026-10-28 12:00:00'), Date.parse('2026-10-28T12:00:00Z'));
  assert.equal(toEpochMs(undefined), null);
  assert.equal(toEpochMs('abc'), null);
});
