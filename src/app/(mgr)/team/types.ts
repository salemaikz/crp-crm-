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
export type DisableResult = { alreadyDisabled: boolean; handover: { status: 'done' | 'not_implemented'; movedCards: number } };
