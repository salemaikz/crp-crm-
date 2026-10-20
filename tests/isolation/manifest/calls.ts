// Манифест изоляции обзвона (C5): /api/calls/** (docs/calls-design.md §11). Идентификаторы объектов — в теле,
// поэтому записи раздельные: оператор A шлёт итог и пропуск по карточке оператора B (cd-b-1) и не должен
// ни изменить таблицы, ни увидеть чужие данные. Тела — синтетика; номера и имена в них не нужны.
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const OP_ID = '00000000-0000-4000-8000-0000000000c1';
const SKIP_ID = '00000000-0000-4000-8000-0000000000c2';

const CALL_TABLES = ['calls', 'cards', 'skips', 'tasks', 'client_events', 'stop_list'] as const;

const entries: ManifestEntry[] = [
  {
    kind: 'route',
    path: '/api/calls/outcomes',
    method: 'POST',
    perm: 'card.outcome',
    target: 'section',
    sampleBody: {
      opId: OP_ID,
      cardId: 'cd-b-1',
      outcomeKey: 'no_answer',
      via: 'ui',
      occurredAt: 1_793_000_000_000,
      tappedAt: null,
      phoneId: null,
      reasonCode: '',
      note: '',
      lpr: '',
      lprInfo: null,
      callbackAt: null,
      markTarget: false,
      alsoDncPhoneIds: [],
      fields: {},
      durationSec: null,
      agreement: null,
    },
    mutation: true,
    touches: [...CALL_TABLES],
  },
  {
    kind: 'route',
    path: '/api/calls/skips',
    method: 'POST',
    perm: 'card.outcome',
    target: 'section',
    sampleBody: { opId: SKIP_ID, cardId: 'cd-b-1' },
    mutation: true,
    touches: ['skips', 'cards'],
  },
  { kind: 'route', path: '/api/calls/queue', method: 'GET', perm: 'card.outcome', target: 'section', mutation: false },
  // Сводка «Сегодня»: только свои числа за сутки, чужих карточек и клиентов в ответе нет
  { kind: 'route', path: '/api/calls/today', method: 'GET', perm: 'card.outcome', target: 'section', mutation: false },
];

export default defineManifest('calls', entries);
