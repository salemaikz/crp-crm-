// Формы данных экрана. Клиентским компонентам нельзя импортировать src/server/**, поэтому типы ответа API
// описаны здесь; page.tsx присваивает им форму из домена, и расхождение ловит typecheck.
export type OperatorStatus = 'working' | 'paused' | 'absent';

export type OperatorRow = {
  userId: string;
  name: string;
  status: OperatorStatus;
  absentUntil: string | null;
  issued: number;
  cap: number;
  outcomes: number;
  connects: number;
  lpr: number;
  groups: number;
  consults: number;
  skips: number;
  overdue: number;
  workedHours: number;
  callsPerHour: number | null;
  belowTarget: boolean;
  unsent: number;
  lastSeenAt: number | null;
  lastFlushAt: number | null;
};

export type BookingDayTile = { total: number; confirmed: number };

export type SummaryData = {
  generatedAt: number;
  day: string;
  timeZone: string;
  overdueAlertMinutes: number;
  callsPerHourTarget: number | null;
  eventLabels: { group: string; individual: string };
  board: { on: boolean; callbackTab: string | null };
  tiles: {
    pool: { ready: number; overCap: number; duplicates: number; disputed: number };
    issued: { issued: number; cap: number; operators: number };
    grey: { waiting: number };
    bookings: { today: BookingDayTile; tomorrow: BookingDayTile };
    overdue: { cards: number; operators: number };
    unsent: { pending: number; operators: number };
  };
  alarm: boolean;
  operators: OperatorRow[];
};
