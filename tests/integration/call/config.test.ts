// Настройки экрана «Звонить» из активной ревизии: кнопки итогов в порядке настроек, причины, поля шторки, сроки.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { loadCallConfig } from '../../../src/app/(op)/call/loadCallConfig';
import { U } from '../../isolation/harness/seed';
import { closeCallsWorld, openCallsWorld, viewerOf } from '../calls/world';

let db: TestDb;
let opA: Viewer;

before(async () => {
  db = await openCallsWorld();
  opA = await viewerOf(U.opA);
});
after(() => closeCallsWorld(db));

test('кнопки итогов: порядок настроек, без архивных; обязательные поля и причины подтянуты', async () => {
  const cfg = await loadCallConfig(opA);
  assert.ok(cfg);
  const keys = cfg.outcomes.map((o) => o.key);
  assert.ok(keys.includes('no_answer') && keys.includes('callback') && keys.includes('niche_asked'));
  assert.ok(!keys.includes('old_outcome'), 'архивный итог не показывается');
  assert.equal(keys.indexOf('no_answer') < keys.indexOf('niche_asked'), true);
  const niche = cfg.outcomes.find((o) => o.key === 'niche_asked');
  assert.deepEqual(niche?.requires.fields, ['niche']);
  assert.equal(cfg.outcomeFields.niche?.type, 'select');
  assert.deepEqual(cfg.outcomeFields.niche?.options.map((x) => x.key), ['trade', 'service']);
  assert.equal(cfg.userId, U.opA);
  assert.equal(cfg.timeZone.length > 0, true);
  assert.ok(cfg.undoMs >= 0 && cfg.undoMs <= 10_000);
  assert.ok(cfg.bookHref.startsWith('/'));
});

test('праздники отдаются не раньше сегодняшнего дня; цель «звонков в час» — число или null', async () => {
  const cfg = await loadCallConfig(opA);
  assert.ok(cfg);
  assert.ok(cfg.calendar.holidays.every((h) => h.date >= opA.today));
  assert.ok(cfg.callsPerHourTarget === null || cfg.callsPerHourTarget > 0);
  assert.ok(cfg.calendar.workdays.length > 0);
});
