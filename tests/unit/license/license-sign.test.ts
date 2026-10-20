// Утилита владельца scripts/license-sign.ts (D-211): пара ключей, подпись под installId, срок и льгота,
// проверка подписанного ядром с открытым ключом из keygen. Ключи — во временном каталоге теста.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { license as core } from '@crm/core';
import { main, parseDate } from '../../../scripts/license-sign';

const INSTALL = '11111111-2222-3333-4444-555555555555';
const NOW = Date.UTC(2026, 9, 24, 6, 0, 0);

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

test('keygen → sign → проверка ядром: поля, срок по Астане, льгота, модули', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'license-sign-'));
  try {
    const keyFile = path.join(dir, 'owner.pem');
    const k = io();
    assert.equal(main(['keygen', '--out', keyFile, '--kid', 'prod-1'], k.io, NOW), 0);
    assert.equal(((await stat(keyFile)).mode & 0o777).toString(8), '600');
    const pub = k.out.find((l) => l.startsWith('открытый ключ: '))!.slice('открытый ключ: '.length);
    assert.equal(JSON.parse(k.out.find((l) => l.startsWith('для сборки ядра: '))!.slice('для сборки ядра: '.length))['prod-1'], pub);
    // Существующий ключ не перезаписывается
    assert.equal(main(['keygen', '--out', keyFile, '--kid', 'prod-1'], io().io, NOW), 1);

    const p = io();
    assert.equal(main(['pubkey', '--key', keyFile], p.io, NOW), 0);
    assert.equal(p.out[0], pub);

    const s = io();
    const outFile = path.join(dir, 'license.crm');
    const argv = ['sign', '--key', keyFile, '--kid', 'prod-1', '--customer', 'demo-co', '--install-id', INSTALL, '--expires', '2026-11-30'];
    assert.equal(main([...argv, '--grace-days', '30', '--features', 'telephony.zadarma, spaces.multi', '--seats', '25', '--out', outFile], s.io, NOW), 0);
    const raw = (await readFile(outFile, 'utf8')).trim();
    const v = core.verifyLicense(raw, { installId: INSTALL, keys: { 'prod-1': pub }, watermark: { customer: 'demo-co', buildId: null, builtAt: null } });
    assert.equal(v.ok, true);
    if (!v.ok) return;
    assert.equal(v.license.expiresAt, Date.parse('2026-11-30T23:59:59.999+05:00'));
    assert.equal(v.license.notBefore, NOW - 86_400_000);
    assert.equal(v.license.issuedAt, NOW);
    assert.equal(v.license.graceDays, 30);
    assert.deepEqual(v.license.features, ['telephony.zadarma', 'spaces.multi']);
    assert.equal(v.license.seats, 25);
    assert.match(s.err.join('\n'), /installId 11111111/);
    // Чужой установке не подходит
    assert.equal(core.verifyLicense(raw, { installId: '99999999-0000-4000-8000-000000000000', keys: { 'prod-1': pub }, watermark: { customer: null, buildId: null, builtAt: null } }).ok, false);
    // Без --out — печать в stdout
    const s2 = io();
    assert.equal(main([...argv, '--build-id', 'b-7'], s2.io, NOW), 0);
    assert.match(s2.out[0]!, /^CRM1\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ошибки ввода: нет ключа, нет обязательных полей, срок раньше начала, неизвестный флаг', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'license-sign-'));
  try {
    const keyFile = path.join(dir, 'k.pem');
    assert.equal(main(['keygen', '--out', keyFile, '--kid', 'prod-1'], io().io, NOW), 0);
    const base = ['sign', '--key', keyFile, '--kid', 'prod-1', '--customer', 'demo-co', '--install-id', INSTALL];
    const e1 = io();
    assert.equal(main(base, e1.io, NOW), 2);
    assert.match(e1.err[0]!, /--expires/);
    const e2 = io();
    assert.equal(main([...base, '--expires', '2026-10-01'], e2.io, NOW), 2);
    assert.match(e2.err[0]!, /поля лицензии/);
    assert.equal(main([...base, '--expires', '2026-12-01', '--bogus', 'x'], io().io, NOW), 2);
    assert.equal(main(['sign', '--key', path.join(dir, 'нет.pem'), '--kid', 'prod-1'], io().io, NOW), 1);
    assert.equal(main(['что-то'], io().io, NOW), 2);
    assert.equal(main(['keygen', '--out', path.join(dir, 'x.pem'), '--kid', 'Плохой kid'], io().io, NOW), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('даты: день — конец дня по Астане (UTC+5), ISO — только с поясом', () => {
  assert.equal(parseDate('2026-11-30', 'end'), Date.UTC(2026, 10, 30, 18, 59, 59, 999));
  assert.equal(parseDate('2026-11-30', 'start'), Date.UTC(2026, 10, 29, 19, 0, 0, 0));
  assert.equal(parseDate('2026-11-30T12:00:00Z', 'end'), Date.UTC(2026, 10, 30, 12));
  assert.throws(() => parseDate('2026-11-30T12:00:00', 'end'));
  assert.throws(() => parseDate('30.11.2026', 'end'));
});
