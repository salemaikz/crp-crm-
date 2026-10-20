// Статус участника на сегодня: пауза действует только в свой день, отсутствие сильнее паузы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { participantStatus } from '../../../src/server/domain/distribution/participants';

const TODAY = '2026-10-28';

test('нет паузы и отсутствия → работает', () => {
  assert.equal(participantStatus({ pausedOn: '', absentUntil: null }, TODAY), 'working');
});

test('пауза на сегодня → paused; пауза на вчера уже не действует', () => {
  assert.equal(participantStatus({ pausedOn: TODAY, absentUntil: null }, TODAY), 'paused');
  assert.equal(participantStatus({ pausedOn: '2026-10-27', absentUntil: null }, TODAY), 'working');
});

test('отсутствие на сегодня → absent, в том числе вместе с паузой', () => {
  assert.equal(participantStatus({ pausedOn: '', absentUntil: '2026-10-30' }, TODAY), 'absent');
  assert.equal(participantStatus({ pausedOn: TODAY, absentUntil: '2026-10-30' }, TODAY), 'absent');
});
