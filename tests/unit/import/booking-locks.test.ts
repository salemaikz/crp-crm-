// Блокировки применения «Записей» (D-251, docs/import-bookings-design.md §8.2 п. 6–7): пересчёт не должен видеть
// карточку или мероприятие, которых нет среди заблокированных до него. Только синтетические id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lockCovers, lockSetOf } from '../../../src/server/domain/import/bookingLocks';

const cand = (clientId: string, cardId: string) => ({ clientId, cardId }) as never;
const event = (id: string) => ({ id }) as never;
const partner = (cardId: string) => ({ cardId }) as never;

test('набор блокировок по первому чтению: карточки, мероприятия, клиенты', () => {
  const s = lockSetOf({ candidates: [cand('c1', 'k1'), cand('c2', 'k2')], events: [event('e1')], partnerCards: [partner('p1')] });
  assert.deepEqual(s, { cardIds: ['k1', 'k2'], partnerCardIds: ['p1'], eventIds: ['e1'], clientIds: ['c1', 'c2'] });
});

test('пересчёт увидел то же или меньше — покрыто; новую карточку, клиента или мероприятие — нет (preview_stale)', () => {
  const locked = lockSetOf({ candidates: [cand('c1', 'k1'), cand('c2', 'k2')], events: [event('e1'), event('e2')], partnerCards: [partner('p1')] });
  const cover = (c: { candidates: never[]; events: never[]; partnerCards?: never[] }) => lockCovers(locked, { partnerCards: [], ...c });
  assert.equal(cover({ candidates: [cand('c1', 'k1')], events: [event('e2')] }), true);
  assert.equal(cover({ candidates: [cand('c1', 'k1'), cand('c2', 'k2')], events: [event('e1'), event('e2')] }), true);
  assert.equal(cover({ candidates: [cand('c1', 'k1'), cand('c3', 'k3')], events: [] }), false, 'карточка нового клиента пространства');
  assert.equal(cover({ candidates: [cand('c1', 'k9')], events: [] }), false, 'новая карточка того же клиента');
  assert.equal(cover({ candidates: [], events: [event('e3')] }), false, 'новое мероприятие');
});

test('напарники спорных пар: заблокированный напарник или кандидат-напарник покрыт; напарник новой пары — нет', () => {
  const locked = lockSetOf({ candidates: [cand('c1', 'k1'), cand('c2', 'k2')], events: [], partnerCards: [partner('p1')] });
  assert.equal(lockCovers(locked, { candidates: [cand('c1', 'k1')], events: [], partnerCards: [partner('p1'), partner('k2')] }), true);
  assert.equal(lockCovers(locked, { candidates: [cand('c1', 'k1')], events: [], partnerCards: [partner('p2')] }), false, 'пара появилась после первого чтения');
});
