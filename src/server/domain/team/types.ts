// Типы модуля «Сотрудники» (R2a). Наружу уходят только эти формы: хеш пароля и полный номер — нет.

/** Состояние сотрудника для администратора. */
export type StaffStatus = 'active' | 'invited' | 'disabled';

/** Приглашённый, но не принявший: ссылка жива или уже не действует (истекла/отозвана). */
export type InviteState = 'live' | 'inactive';

export type StaffRow = {
  id: string;
  name: string;
  /** Номер с маской: `+7 701 ••• •• 67`. Полный номер в список не отдаётся. */
  phoneMasked: string;
  status: StaffStatus;
  isAdmin: boolean;
  /** Ключ роли в текущем пространстве; у приглашённого — роль из приглашения; null — без роли. */
  roleKey: string | null;
  /** Только для status = invited. */
  inviteState: InviteState | null;
  lastLoginAt: number | null;
  /** Строка самого администратора: над собой действия закрыты. */
  isSelf: boolean;
};

/** Роль, которую можно назначить (архивные не предлагаются). */
export type RoleOption = { key: string; label: string };

export type StaffList = { staff: StaffRow[]; roles: RoleOption[] };

/** Ссылка показывается один раз: в БД хранится только sha256 токена. */
export type IssuedLink = { userId: string; link: string; expiresAt: number; ttlHours: number };
