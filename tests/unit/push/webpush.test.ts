// Web-push без пакета (D-329): шифрование сверяется с примером RFC 8291 §5 и Appendix A байт в байт; VAPID — подпись
// ES256 проверяется открытым ключом; ключи окружения сверяются парой; адреса — только push-сервисы браузеров.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { b64u, checkPushEndpoint, encryptPushPayload, generateVapidKeys, PushFormatError, readVapidKeys, vapidAuthorization } from '../../../src/server/platform/push';

const d = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');

// RFC 8291 §5: ключи, соль и итоговое тело примера
const RFC = {
  auth: d('BTBZMqHH6r4Tts7J_aSIgg'),
  uaPublic: d('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
  senderPrivate: d('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
  salt: d('DGv6ra1nlYgDCS1FRnbzlw'),
  plaintext: Buffer.from('When I grow up, I want to be a watermelon'),
  body: d(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
           mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
           pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`),
};

test('шифрование aes128gcm совпадает с примером RFC 8291 байт в байт', () => {
  const out = encryptPushPayload({ uaPublic: RFC.uaPublic, authSecret: RFC.auth, plaintext: RFC.plaintext, senderPrivate: RFC.senderPrivate, salt: RFC.salt });
  // В тексте RFC Content-Length 145, но само тело примера — 144 байта (86 заголовок + 42 + 16 тег)
  assert.equal(out.length, RFC.body.length);
  assert.equal(b64u.encode(out), b64u.encode(RFC.body));
});

test('без тестовых ключей: новая соль и ключ отправителя на каждое сообщение', () => {
  const a = encryptPushPayload({ uaPublic: RFC.uaPublic, authSecret: RFC.auth, plaintext: RFC.plaintext });
  const b = encryptPushPayload({ uaPublic: RFC.uaPublic, authSecret: RFC.auth, plaintext: RFC.plaintext });
  assert.notEqual(b64u.encode(a.subarray(0, 16)), b64u.encode(b.subarray(0, 16)));
  assert.notEqual(b64u.encode(a.subarray(21, 86)), b64u.encode(b.subarray(21, 86)));
});

test('неверные ключи устройства и длинный текст — код ошибки, без значений', () => {
  const bad = (f: () => unknown, code: string) => assert.throws(f, (e: unknown) => e instanceof PushFormatError && e.code === code && !e.message.includes('BCVx'));
  bad(() => encryptPushPayload({ uaPublic: RFC.uaPublic.subarray(1), authSecret: RFC.auth, plaintext: RFC.plaintext }), 'bad_p256dh');
  const offCurve = Buffer.from(RFC.uaPublic);
  offCurve[64] = (offCurve[64] ?? 0) ^ 1;
  bad(() => encryptPushPayload({ uaPublic: offCurve, authSecret: RFC.auth, plaintext: RFC.plaintext }), 'bad_p256dh');
  bad(() => encryptPushPayload({ uaPublic: RFC.uaPublic, authSecret: RFC.auth.subarray(1), plaintext: RFC.plaintext }), 'bad_auth');
  bad(() => encryptPushPayload({ uaPublic: RFC.uaPublic, authSecret: RFC.auth, plaintext: Buffer.alloc(3994) }), 'too_large');
});

const env = (k: { publicKey: string; privateKey: string }, subject = 'mailto:support@example.invalid') => ({
  VAPID_PUBLIC_KEY: k.publicKey,
  VAPID_PRIVATE_KEY: k.privateKey,
  VAPID_SUBJECT: subject,
});

test('VAPID: подпись ES256 проверяется открытым ключом, aud — источник адреса, срок ≤ 24 ч', () => {
  const pair = generateVapidKeys();
  const r = readVapidKeys(env(pair));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const now = Date.UTC(2026, 9, 28, 6, 0);
  const h = vapidAuthorization('https://fcm.googleapis.com/fcm/send/synthetic-1', r.keys, now);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h);
  assert.ok(m, h);
  const [, head, claims, sig, k] = m;
  assert.equal(k, pair.publicKey);
  const c = JSON.parse(b64u.decode(claims!)!.toString()) as { aud: string; exp: number; sub: string };
  assert.equal(c.aud, 'https://fcm.googleapis.com');
  assert.equal(c.sub, 'mailto:support@example.invalid');
  assert.ok(c.exp > now / 1000 && c.exp <= now / 1000 + 86_400);
  const pub = b64u.decode(pair.publicKey)!;
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u.encode(pub.subarray(1, 33)), y: b64u.encode(pub.subarray(33)) }, format: 'jwk' });
  assert.equal(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, b64u.decode(sig!)!), true);
});

test('VAPID: нет ключей, чужая пара, неверный адрес связи — отказ кодом', () => {
  const a = generateVapidKeys();
  const b = generateVapidKeys();
  assert.deepEqual(readVapidKeys({}), { ok: false, code: 'missing' });
  assert.deepEqual(readVapidKeys({ ...env(a), VAPID_PRIVATE_KEY: b.privateKey }), { ok: false, code: 'mismatch' });
  assert.deepEqual(readVapidKeys(env(a, 'support@example.invalid')), { ok: false, code: 'bad_subject' });
  assert.deepEqual(readVapidKeys({ ...env(a), VAPID_PUBLIC_KEY: 'AAAA' }), { ok: false, code: 'bad_public' });
  assert.deepEqual(readVapidKeys({ ...env(a), VAPID_PRIVATE_KEY: 'AAAA' }), { ok: false, code: 'bad_private' });
  assert.equal(readVapidKeys(env(a, 'https://example.invalid/contact')).ok, true);
});

test('адрес подписки: только https push-сервисов браузеров, без порта и учётки', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://web.push.apple.com/QF0abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ]) assert.ok(checkPushEndpoint(ok), ok);
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://user:pw@fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/x',
    'https://notify.windows.com/x',
    'https://127.0.0.1/x',
    'https://localhost/x',
    'https://example.invalid/x',
    'not a url',
    `https://fcm.googleapis.com/${'a'.repeat(1100)}`,
  ]) assert.equal(checkPushEndpoint(bad), null, bad);
});
