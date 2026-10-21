// Блокировки применения «Записей» (D-251, docs/import-bookings-design.md §8.2 п. 6–7): пересчёт не должен видеть
// карточку или мероприятие, которых нет среди заблокированных до него. Только синтетические id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lockCovers, lockSetOf } from '../../../src/server/domain/import/bookingLocks';

const cand = (clientId: string, cardId: string) => ({ clientId, cardId }) as never;
const event = (id: string) => ({ id }) as never;

test('набор блокировок по первому чтению: карточки, мероприятия, клиенты', () => {
  const s = lockSetOf({ candidates: [cand('c1', 'k1'), cand('c2', 'k2')], events: [event('e1')] });
  assert.deepEqual(s, { cardIds: ['k1', 'k2'], eventIds: ['e1'], clientIds: ['c1', 'c2'] });
});

test('пересчёт увидел то же или меньше — покрыто; новую карточку, клиента или мероприятие — нет (preview_stale)', () => {
  const locked = lockSetOf({ candidates: [cand('c1', 'k1'), cand('c2', 'k2')], events: [event('e1'), event('e2')] });
  assert.equal(lockCovers(locked, { candidates: [cand('c1', 'k1')], events: [event('e2')] }), true);
  assert.equal(lockCovers(locked, { candidates: [cand('c1', 'k1'), cand('c2', 'k2')], events: [event('e1'), event('e2')] }), true);
  assert.equal(lockCovers(locked, { candidates: [cand('c1', 'k1'), cand('c3', 'k3')], events: [] }), false, 'карточка нового клиента пространства');
  assert.equal(lockCovers(locked, { candidates: [cand('c1', 'k9')], events: [] }), false, 'новая карточка того же клиента');
  assert.equal(lockCovers(locked, { candidates: [], events: [event('e3')] }), false, 'новое мероприятие');
});
