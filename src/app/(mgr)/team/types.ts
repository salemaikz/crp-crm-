// Формы данных экрана. Клиентским компонентам нельзя импортировать src/server/**, поэтому типы ответа API
// описаны здесь; сервер отдаёт совместимые формы (src/server/domain/team/types.ts), page.tsx это проверяет.
export type StaffStatus = 'active' | 'invited' | 'disabled';

export type StaffRow = {
  id: string;
  name: string;
  phoneMasked: string;
  status: StaffStatus;
  isAdmin: boolean;
  roleKey: string | null;
  inviteState: 'live' | 'inactive' | null;
  lastLoginAt: number | null;
  isSelf: boolean;
};

export type RoleOption = { key: string; label: string };
export type StaffList = { staff: StaffRow[]; roles: RoleOption[] };
export type IssuedLink = { userId: string; link: string; expiresAt: number; ttlHours: number };
export type DisableResult = {
  alreadyDisabled: boolean;
  handover: { status: 'done' | 'no_recipient'; movedCards: number; releasedCards: number; actingCards: number };
};

/** Сводка для диалога «Отключить…» (GET /api/team/staff/[id]/handover-preview). */
export type HandoverPreview = {
  cards: Record<string, number>;
  working: number;
  untouched: number;
  actingCards: number;
  tasks: number;
  deals: number;
  bookings: number;
  recipient: { userId: string } | null;
  candidates: Array<{ userId: string; name: string }>;
};

/** Получатели передачи и источники массовой передачи (GET /api/team/transfers/staff). */
export type TransferStaffItem = { userId: string; name: string; roleKey: string; active: boolean };
export type TransferPreview = { cards: Record<string, number>; total: number; families: number; tasks: number; deals: number; bookings: number; tooMany: boolean };
export type TransferResult = { moved: number; byRecipient: Record<string, number>; replayed: boolean };
