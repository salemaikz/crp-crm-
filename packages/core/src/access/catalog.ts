// Закрытый каталог разрешений «ресурс.действие» (ARCHITECTURE §5.1 п. 1, D-016).
// Поведение — в коде, выдача — в ролях настроек. Новое разрешение не получает никто, пока его не
// добавит пресет. Охваты прав — закрытый список (CONFIG §9).

/** Все разрешения продукта. Порядок — для отчётов и тестов, смысла не несёт. */
export const PERMISSIONS = [
  'card.read',
  'card.outcome',
  'card.edit',
  'card.assign',
  'card.return',
  'card.unblock',
  'card.export',
  'client.read',
  'client.edit',
  'client.edit_identity',
  'client.merge',
  'client.transfer',
  'client.propose',
  'deal.read',
  'deal.edit',
  'deal.purchase',
  'deal.move_back',
  'booking.read',
  'booking.create',
  'booking.attend',
  'booking.manage',
  'booking.walk_in',
  'note.write',
  'task.read',
  'task.write',
  'task.assign_others',
  'handoff.read',
  'handoff.accept',
  'handoff.assign',
  'pool.read',
  'distribution.manage',
  'import.run',
  'report.view',
  'report.export',
  'data.export_all',
  'settings.sales',
  'settings.fields',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Охват выдачи: своё (владелец или временный владелец), команда, пространство, все пространства. */
export const SCOPES = ['own', 'team', 'space', 'all'] as const;
export type Scope = (typeof SCOPES)[number];

/** Порядок охватов: больше — шире. */
export const SCOPE_RANK: Readonly<Record<Scope, number>> = { own: 0, team: 1, space: 2, all: 3 };

/**
 * Вид разрешения:
 * - read — только чтение, разрешено ролям `readOnly`;
 * - export — выгрузка: из выгрузок `readOnly` разрешены только `report.export` и `data.export_all`;
 * - write — меняет данные: запрещено `readOnly` (423 в обёртке, FALSE в охвате).
 */
export type PermissionKind = 'read' | 'write' | 'export';

export type PermissionInfo = {
  kind: PermissionKind;
  /**
   * Минимальный охват. `space` — разрешение про пространство целиком (раздача, пул, импорт, полная
   * выгрузка, настройки): выдать его на «своё» или «команду» нельзя, это ошибка пресета.
   */
  minScope?: 'space';
};

export const PERMISSION_INFO: Readonly<Record<Permission, PermissionInfo>> = {
  'card.read': { kind: 'read' },
  'card.outcome': { kind: 'write' },
  'card.edit': { kind: 'write' },
  'card.assign': { kind: 'write', minScope: 'space' },
  'card.return': { kind: 'write', minScope: 'space' },
  'card.unblock': { kind: 'write', minScope: 'space' },
  'card.export': { kind: 'export' },
  'client.read': { kind: 'read' },
  'client.edit': { kind: 'write' },
  'client.edit_identity': { kind: 'write' },
  'client.merge': { kind: 'write', minScope: 'space' },
  'client.transfer': { kind: 'write', minScope: 'space' },
  'client.propose': { kind: 'write' },
  'deal.read': { kind: 'read' },
  'deal.edit': { kind: 'write' },
  'deal.purchase': { kind: 'write' },
  'deal.move_back': { kind: 'write' },
  'booking.read': { kind: 'read' },
  'booking.create': { kind: 'write' },
  'booking.attend': { kind: 'write' },
  'booking.manage': { kind: 'write', minScope: 'space' },
  'booking.walk_in': { kind: 'write' },
  'note.write': { kind: 'write' },
  'task.read': { kind: 'read' },
  'task.write': { kind: 'write' },
  'task.assign_others': { kind: 'write' },
  'handoff.read': { kind: 'read' },
  'handoff.accept': { kind: 'write' },
  'handoff.assign': { kind: 'write' },
  'pool.read': { kind: 'read', minScope: 'space' },
  'distribution.manage': { kind: 'write', minScope: 'space' },
  'import.run': { kind: 'write', minScope: 'space' },
  'report.view': { kind: 'read' },
  'report.export': { kind: 'export' },
  'data.export_all': { kind: 'export', minScope: 'space' },
  'settings.sales': { kind: 'write', minScope: 'space' },
  'settings.fields': { kind: 'write', minScope: 'space' },
};

/** Выгрузки, которые разрешены ролям «только чтение» (CONFIG §3.3, D-055). */
export const READ_ONLY_EXPORTS: ReadonlySet<Permission> = new Set<Permission>(['report.export', 'data.export_all']);

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(x: unknown): x is Permission {
  return typeof x === 'string' && PERMISSION_SET.has(x);
}

/** Меняет ли разрешение данные (для `readOnly` и лицензии «только чтение»). */
export function isWritePermission(p: Permission): boolean {
  return PERMISSION_INFO[p].kind === 'write';
}

/** Можно ли выдать разрешение роли `readOnly`. */
export function allowedForReadOnly(p: Permission): boolean {
  const { kind } = PERMISSION_INFO[p];
  return kind === 'read' || READ_ONLY_EXPORTS.has(p);
}

/**
 * Мутации безопасности (D-054): работают в любом состоянии лицензии и для роли «только чтение».
 * Закрытый список ядра, пресет его не меняет. Обёртка помечает действие ключом из этого списка.
 */
export const SECURITY_MUTATIONS = [
  'auth.login',
  'auth.logout',
  'auth.logout_all',
  'auth.change_own_password',
  'team.reset_password',
  'team.disable_user',
  'client.depersonalize',
  'ingest.revoke_key',
  'integration.revoke_webhook',
  'integration.disable',
  'license.upload',
  'data.export_all',
  // Итоги другого сотрудника со свободным текстом удаляются с общего телефона по сроку, сервер пишет потерю (D-308)
  'device.outbox_expire',
] as const;
export type SecurityMutation = (typeof SECURITY_MUTATIONS)[number];
