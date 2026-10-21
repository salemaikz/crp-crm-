// DTO заметок, итогового отчёта и истории сделок (C8, docs/tasks-team-design.md §3.3–3.5).
// Сервер отдаёт структуру без текста: фразы строит интерфейс из локали.
import type { booking } from '@crm/core';

export type NoteDto = {
  id: string;
  body: string;
  pinned: boolean;
  dealId: string | null;
  authorName: string | null;
  createdAt: number;
};

/** Максимум закреплённых заметок клиента (сверх — 409 `pin_limit`). */
export const PIN_LIMIT = 3;
export const NOTE_MAX = 4000;

export type NextStepKind = 'callback' | 'retry' | 'booking' | 'task' | 'none';

export type ClientSummaryDto = {
  period: { from: number; to: number } | null;
  calls: { total: number; connects: number; noAnswer: number };
  lprFoundAt: number | null;
  bookings: Array<{
    kind: 'group' | 'individual';
    eventTypeKey: string;
    date: string;
    time: string;
    status: booking.BookingStatus;
    consultantName: string | null;
  }>;
  /** Сумма `null` — зритель видит сделки только как отдел передачи (D-300). */
  purchases: Array<{ serviceTypeKey: string; amountKzt: number | null; wonAt: number }>;
  handoffs: Array<{ teamKey: string; status: string; createdAt: number; acceptedAt: number | null }>;
  ownerName: string | null;
  actingName: string | null;
  nextStep: { kind: NextStepKind; at: number | null; taskSource?: string };
};

export type DealRowDto = {
  id: string;
  pipelineKey: string;
  stageKey: string;
  status: 'open' | 'won' | 'lost';
  serviceTypeKey: string;
  /** `null` — зритель видит сделки только как отдел передачи (D-300). */
  amountKzt: number | null;
  createdAt: number;
  wonAt: number | null;
  lostAt: number | null;
  lostReasonCode: string;
  ownerName: string | null;
};
