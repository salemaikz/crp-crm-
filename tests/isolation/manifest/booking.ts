// Манифест изоляции записи на мероприятия (B2): все маршруты /api/events/** и /api/bookings/**
// (docs/booking-design.md §4). Тела — синтетика; номера и имена в них не нужны.
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const OP_ID = '00000000-0000-4000-8000-0000000000a1';
const REQ_ID = '00000000-0000-4000-8000-0000000000b1';

const BOOKING_TABLES = ['bookings', 'booking_history', 'client_events', 'deals'] as const;

const entries: ManifestEntry[] = [
  // --- мероприятия ---
  { kind: 'route', path: '/api/events', method: 'GET', perm: 'booking.read', target: 'section', mutation: false },
  {
    kind: 'route',
    path: '/api/events',
    method: 'POST',
    perm: 'booking.manage',
    target: 'section',
    sampleBody: { requestId: REQ_ID, eventTypeKey: 'br', eventDate: '2026-11-12', startTime: '15:00' },
    mutation: true,
    touches: ['events', 'audit_log'],
  },
  { kind: 'route', path: '/api/events/offer', method: 'GET', perm: 'booking.create', target: 'section', mutation: false },
  // Мероприятие — общее расписание пространства (D-136, D-161): видят все с booking.read, клиентов в ответе нет.
  {
    kind: 'route',
    path: '/api/events/[id]',
    method: 'GET',
    perm: 'booking.read',
    target: 'object',
    idParam: { name: 'id', entity: 'event' },
    mutation: false,
    shared: { ownerSees: false },
  },
  {
    kind: 'route',
    path: '/api/events/[id]',
    method: 'PATCH',
    perm: 'booking.manage',
    target: 'object',
    idParam: { name: 'id', entity: 'event' },
    sampleBody: { seenUpdatedAt: 0, patch: { capacity: 25 } },
    mutation: true,
    touches: ['events', 'audit_log'],
  },
  {
    kind: 'route',
    path: '/api/events/[id]/cancel',
    method: 'POST',
    perm: 'booking.manage',
    target: 'object',
    idParam: { name: 'id', entity: 'event' },
    sampleBody: { opId: OP_ID },
    mutation: true,
    touches: ['events', ...BOOKING_TABLES, 'audit_log'],
  },
  {
    kind: 'route',
    path: '/api/events/[id]/duty',
    method: 'PUT',
    perm: 'booking.manage',
    target: 'object',
    idParam: { name: 'id', entity: 'event' },
    sampleBody: { userIds: [] },
    mutation: true,
    touches: ['event_duty', 'audit_log'],
  },
  // Гости — строки записей по охвату booking.read: оператор видит только своих, РОП — всех, дежурный — своё сегодня.
  {
    kind: 'route',
    path: '/api/events/[id]/guests',
    method: 'GET',
    perm: 'booking.read',
    target: 'object',
    idParam: { name: 'id', entity: 'event' },
    mutation: false,
    shared: { ownerSees: true },
  },

  // --- серии ---
  { kind: 'route', path: '/api/events/series', method: 'GET', perm: 'booking.manage', target: 'section', mutation: false },
  {
    kind: 'route',
    path: '/api/events/series',
    method: 'POST',
    perm: 'booking.manage',
    target: 'section',
    sampleBody: { requestId: REQ_ID, eventTypeKey: 'br', weekday: 4, startTime: '15:00', durationMin: 180, location: '', format: 'offline', capacity: 30 },
    mutation: true,
    touches: ['event_series', 'events', 'audit_log'],
  },
  {
    kind: 'route',
    path: '/api/events/series/[id]',
    method: 'PATCH',
    perm: 'booking.manage',
    target: 'section',
    sampleBody: { seenUpdatedAt: 0, patch: { active: false } },
    mutation: true,
    touches: ['event_series', 'events', 'audit_log'],
  },

  // --- мастер записи и «Записи» (B3a) ---
  {
    kind: 'route',
    path: '/api/bookings/wizard/[cardId]',
    method: 'GET',
    perm: 'booking.create',
    target: 'object',
    idParam: { name: 'cardId', entity: 'card' },
    mutation: false,
  },
  {
    kind: 'page',
    path: '/(op)/bookings/new/[cardId]',
    method: 'GET',
    perm: 'booking.create',
    target: 'object',
    idParam: { name: 'cardId', entity: 'card' },
    mutation: false,
  },
  { kind: 'page', path: '/(op)/bookings', method: 'GET', perm: 'booking.read', target: 'section', mutation: false },

  // --- записи ---
  { kind: 'route', path: '/api/bookings', method: 'GET', perm: 'booking.read', target: 'section', mutation: false },
  {
    kind: 'route',
    path: '/api/bookings',
    method: 'POST',
    perm: 'booking.create',
    target: 'section',
    sampleBody: { kind: 'group', requestId: REQ_ID, clientId: 'cl-b-1', eventId: 'ev-tomorrow', contactId: null },
    mutation: true,
    touches: [...BOOKING_TABLES],
  },
  { kind: 'route', path: '/api/bookings/[id]', method: 'GET', perm: 'booking.read', target: 'object', idParam: { name: 'id', entity: 'booking' }, mutation: false },
  {
    kind: 'route',
    path: '/api/bookings/[id]/confirm',
    method: 'POST',
    perm: 'booking.create',
    target: 'object',
    idParam: { name: 'id', entity: 'booking' },
    sampleBody: { opId: OP_ID, version: 0, to: 'confirmed' },
    mutation: true,
    touches: [...BOOKING_TABLES],
  },
  {
    kind: 'route',
    path: '/api/bookings/[id]/cancel',
    method: 'POST',
    perm: 'booking.create',
    target: 'object',
    idParam: { name: 'id', entity: 'booking' },
    sampleBody: { opId: OP_ID, version: 0, reason: 'client' },
    mutation: true,
    touches: [...BOOKING_TABLES],
  },
  {
    kind: 'route',
    path: '/api/bookings/[id]/move',
    method: 'POST',
    perm: 'booking.create',
    target: 'object',
    idParam: { name: 'id', entity: 'booking' },
    sampleBody: { requestId: REQ_ID, version: 0, eventId: 'ev-tomorrow' },
    mutation: true,
    touches: [...BOOKING_TABLES],
  },
  {
    kind: 'route',
    path: '/api/bookings/[id]/attendance',
    method: 'POST',
    perm: 'booking.attend',
    target: 'object',
    idParam: { name: 'id', entity: 'booking' },
    sampleBody: { opId: OP_ID, version: 0, to: 'attended' },
    mutation: true,
    touches: [...BOOKING_TABLES],
  },
];

export default defineManifest('booking', entries);
