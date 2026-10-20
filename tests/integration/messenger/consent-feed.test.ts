// Согласие на переписку, запись «открыт WhatsApp» и лента с текстом сообщений (дизайн §8.7, §8.9).
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getClientFeed } from '../../../src/server/domain/clients';
import { applyMessengerEvents, getMessengerConsent, recordLinkOpened, setMessengerConsent } from '../../../src/server/domain/messenger';
import { NotFoundError } from '../../../src/server/access';
import type { TestDb } from '../../../src/server/platform/db/testing';
import * as consentRoute from '../../../src/app/api/messenger/consent/route';
import * as openedRoute from '../../../src/app/api/messenger/opened/route';
import ruMessenger from '../../../messages/ru/messenger.json';
import { actAs, viewerOf } from '../../isolation/harness/actors';
import { U } from '../../isolation/harness/seed';
import { INTEGRATION, NOW, actor, closeMessengerWorld, msg, openMessengerWorld, worldDeps } from './world';

const ORIGIN = 'http://crm.test';
let db: TestDb;
before(async () => {
  db = await openMessengerWorld();
});
after(async () => {
  await closeMessengerWorld(db);
});

const hash = 'a'.repeat(64);

test('согласие: отметка и отзыв — новые строки; чужого клиента не видно', async () => {
  const v = await viewerOf(U.opA);
  assert.equal(await getMessengerConsent(v, 'cl-a-1'), null);
  await setMessengerConsent(v, { clientId: 'cl-a-1', action: 'given', textHash: hash, now: NOW });
  assert.equal(await getMessengerConsent(v, 'cl-a-1'), 'given');
  await setMessengerConsent(v, { clientId: 'cl-a-1', action: 'revoked', textHash: hash, now: NOW + 1000 });
  assert.equal(await getMessengerConsent(v, 'cl-a-1'), 'revoked');
  const rows = await db.sql<{ action: string; recordedBy: string; kind: string }>`SELECT action, recorded_by, kind FROM consents WHERE client_id = 'cl-a-1' ORDER BY at`;
  assert.deepEqual(rows, [{ action: 'given', recordedBy: U.opA, kind: 'messenger_crossborder' }, { action: 'revoked', recordedBy: U.opA, kind: 'messenger_crossborder' }]);
  await assert.rejects(setMessengerConsent(await viewerOf(U.opB), { clientId: 'cl-a-1', action: 'given', textHash: hash }), NotFoundError);
  assert.equal(await getMessengerConsent(await viewerOf(U.opB), 'cl-a-1'), null, 'чужое согласие не читается');
});

test('маршрут согласия: sha256 показанного текста; чужой клиент — 404; тело строгое', async () => {
  const post = async (as: string | null, body: unknown) => {
    actAs(as);
    return consentRoute.POST(new Request(`${ORIGIN}/api/messenger/consent`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({}) });
  };
  assert.equal((await post(U.opB, { clientId: 'cl-a-2', action: 'given' })).status, 404);
  assert.equal((await post(null, { clientId: 'cl-a-2', action: 'given' })).status, 401);
  assert.equal((await post(U.opA, { clientId: 'cl-a-2', action: 'maybe' })).status, 400);
  const ok = await post(U.opA, { clientId: 'cl-a-2', action: 'given' });
  assert.equal(ok.status, 200);
  const row = (await db.sql<{ textHash: string }>`SELECT text_hash FROM consents WHERE client_id = 'cl-a-2'`)[0];
  assert.equal(row?.textHash, createHash('sha256').update(ruMessenger.consent.text, 'utf8').digest('hex'));
});

test('«открыт WhatsApp»: событие ленты без текста переписки; чужая карточка — 404', async () => {
  const v = await viewerOf(U.opA);
  await recordLinkOpened(v, { cardId: 'cd-a-3', templateKey: 'first_contact' });
  await recordLinkOpened(v, { cardId: 'cd-a-3', templateKey: null });
  const ev = await db.sql<{ data: unknown; actorId: string }>`SELECT data, actor_id FROM client_events WHERE client_id = 'cl-a-3' AND kind = 'messenger.link_opened' ORDER BY id`;
  assert.equal(ev.length, 2);
  assert.ok(ev.every((e) => e.actorId === U.opA));
  assert.deepEqual(ev.map((e) => e.data).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [{ templateKey: 'first_contact' }, { templateKey: null }]);
  await assert.rejects(recordLinkOpened(await viewerOf(U.opB), { cardId: 'cd-a-3', templateKey: null }), NotFoundError);
  const post = async (as: string | null, body: unknown) => {
    actAs(as);
    return openedRoute.POST(new Request(`${ORIGIN}/api/messenger/opened`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({}) });
  };
  assert.equal((await post(U.opA, { cardId: 'cd-a-3', templateKey: null })).status, 200);
  assert.equal((await post(U.opA, { cardId: 'cd-a-3', templateKey: 'Плохой ключ' })).status, 400);
  assert.equal((await post(U.opB, { cardId: 'cd-a-3', templateKey: null })).status, 404);
});

test('лента клиента: сообщения с текстом, удалённое без текста, статус доставки; чужому оператору клиент недоступен', async () => {
  const number = (await db.sql<{ digits: string }>`SELECT digits FROM client_phones WHERE client_id = 'cl-a-4'`)[0]!.digits;
  const apply = (e: ReturnType<typeof msg>) => applyMessengerEvents(actor, worldDeps(), { integrationId: INTEGRATION, pluginId: 'messenger.wazzup', events: [e] });
  await apply(msg({ chatId: number, chatDigits: number, providerMessageId: 'f-1', text: 'Добрый день' }));
  await apply(msg({ chatId: number, chatDigits: number, providerMessageId: 'f-2', direction: 'out', authorRef: U.opA, text: 'Здравствуйте', status: 'read', sentAt: NOW + 1000 }));
  await apply(msg({ chatId: number, chatDigits: number, providerMessageId: 'f-3', text: null, isDeleted: true, sentAt: NOW + 2000 }));
  const v = await viewerOf(U.opA);
  const page = await getClientFeed(v, 'cl-a-4', { cursor: null, groups: 'messages' });
  const items = page.items.filter((i) => i.kind === 'message');
  assert.equal(items.length, 3);
  const byText = Object.fromEntries(items.map((i) => [i.message?.text ?? '(нет)', i]));
  assert.equal(byText['Добрый день']?.data.direction, 'in');
  assert.equal(byText['Здравствуйте']?.message?.status, 'read');
  assert.equal(byText['Здравствуйте']?.actor?.id, U.opA);
  const deleted = items.find((i) => i.message?.deleted);
  assert.equal(deleted?.message?.text, null);
  assert.ok(!JSON.stringify(page).includes('"body"'), 'сырое поле body наружу не уходит');
  await assert.rejects(getClientFeed(await viewerOf(U.opB), 'cl-a-4', { cursor: null, groups: 'messages' }), NotFoundError);
});
