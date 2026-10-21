// Полоса лицензии (P10b, D-327): таблица «состояние × кто смотрит» и отсутствие внутренних кодов в ответе.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import messages from '../../../messages/ru/shell.json';
import { licenseBanner, type BannerSnapshot, type BannerWho } from '../../../src/ui/shells/licenseBanner';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28, 10, 0); // 28.10.2026 15:00 Алматы
const TZ = 'Asia/Almaty';
const admin: BannerWho = { isAdmin: true, readOnlyRole: false };
const staff: BannerWho = { isAdmin: false, readOnlyRole: false };
const viewerOnly: BannerWho = { isAdmin: false, readOnlyRole: true };

const snap = (p: Partial<BannerSnapshot>): BannerSnapshot => ({
  status: 'valid',
  access: 'valid',
  reason: '',
  graceUntil: null,
  license: { expiresAt: NOW + 90 * DAY },
  ...p,
});
const b = (s: BannerSnapshot, who: BannerWho) => licenseBanner(s, who, NOW, TZ);

test('valid: полосы нет ни у кого', () => {
  for (const w of [admin, staff, viewerOnly]) assert.equal(b(snap({}), w), null);
});

test('expiring: только администратор, срок и дни', () => {
  const s = snap({ status: 'expiring', license: { expiresAt: NOW + 5 * DAY + 3600_000 } });
  assert.deepEqual(b(s, admin), { tone: 'warn', key: 'expiring', params: { days: 6, date: '02.11.2026' } });
  assert.equal(b(s, staff), null);
  assert.equal(b(s, viewerOnly), null);
});

test('льгота: expired и wrong_build — danger с датой конца льготы, только администратору', () => {
  const until = NOW + 3 * DAY;
  const expired = snap({ status: 'expired', access: 'grace', reason: 'expired', graceUntil: until });
  assert.deepEqual(b(expired, admin), { tone: 'danger', key: 'grace', params: { date: '31.10.2026' } });
  const wrong = snap({ status: 'invalid', access: 'grace', reason: 'wrong_build', graceUntil: until });
  assert.deepEqual(b(wrong, admin), { tone: 'danger', key: 'wrongBuild', params: { date: '31.10.2026' } });
  assert.equal(b(expired, staff), null);
  assert.equal(b(wrong, staff), null);
});

test('только просмотр: администратору подробно, остальным коротко, роль «только чтение» — ничего', () => {
  const cases: BannerSnapshot[] = [
    snap({ status: 'read_only', access: 'read_only', reason: 'expired' }),
    snap({ status: 'invalid', access: 'invalid', reason: 'bad_signature', license: null }),
    snap({ status: 'missing', access: 'missing', reason: 'missing', license: null }),
    snap({ status: 'read_only', access: 'read_only', reason: 'error', license: null }),
  ];
  for (const s of cases) {
    assert.deepEqual(b(s, admin), { tone: 'danger', key: 'readOnly', params: {} });
    assert.deepEqual(b(s, staff), { tone: 'info', key: 'readOnlyShort', params: {} });
    assert.equal(b(s, viewerOnly), null);
  }
});

test('часы позади: администратору своя подсказка, остальным коротко', () => {
  const s = snap({ status: 'read_only', access: 'read_only', reason: 'clock' });
  assert.deepEqual(b(s, admin), { tone: 'danger', key: 'clock', params: {} });
  assert.equal(b(s, staff)?.key, 'readOnlyShort');
});

test('в params только числа и даты ДД.ММ.ГГГГ; внутренних кодов нет', () => {
  const all = [
    snap({ status: 'expiring' }),
    snap({ status: 'invalid', access: 'grace', reason: 'wrong_build', graceUntil: NOW + DAY }),
    snap({ status: 'read_only', access: 'read_only', reason: 'clock' }),
    snap({ status: 'read_only', access: 'read_only', reason: 'error' }),
  ];
  for (const s of all) {
    const r = b(s, admin);
    assert.ok(r);
    for (const v of Object.values(r.params)) assert.match(String(v), /^(\d+|\d{2}\.\d{2}\.\d{4})$/);
    assert.doesNotMatch(JSON.stringify(r), /wrong_build|error|bad_signature|installId|lid/);
  }
});

test('у каждого ключа полосы есть текст в shell.json', () => {
  for (const k of ['expiring', 'grace', 'wrongBuild', 'clock', 'readOnly', 'readOnlyShort', 'dismiss']) {
    assert.ok((messages.license as Record<string, string>)[k], k);
  }
});
