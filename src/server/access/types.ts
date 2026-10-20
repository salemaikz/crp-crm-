// Типы доступа: кто действует (Viewer — сотрудник, SystemActor — фоновая задача или CLI) и какие
// сущности умеет охватывать scopeSql. Нормативно: ARCHITECTURE §5, D-016, D-017.
import type { ActiveRelation, Permission, Scope } from '@crm/core/access';

export type { ActiveRelation, Permission, Scope };

/**
 * Состояние лицензии (ARCHITECTURE §8.4, D-211): свёртка подробного состояния ядра (`@crm/core` license),
 * считает license.ts. `grace` — истёк срок или лицензия перестала сходиться, идёт льгота: всё работает.
 * `read_only`, `invalid`, `missing` запрещают мутации (423), кроме мутаций безопасности (D-054).
 */
export type LicenseState = 'valid' | 'grace' | 'read_only' | 'invalid' | 'missing';
export const LOCKING_LICENSE_STATES: ReadonlySet<LicenseState> = new Set<LicenseState>(['read_only', 'invalid', 'missing']);

/**
 * Сотрудник в текущем запросе. Строится на каждом запросе из сессии, строки `users`, активного
 * членства и раздела ролей текущей ревизии настроек; кэша прав нет (§5.2 п. 1). Объект заморожен
 * и зарегистрирован: scopeSql не примет поддельный объект той же формы.
 */
export interface Viewer {
  readonly kind: 'user';
  readonly userId: string;
  /** Признак учётки: права установки, но не данные клиентов (§5.1 п. 4). */
  readonly isAdmin: boolean;
  /** Текущее пространство; null — нет активной роли ни в одном (например, администратор без роли). */
  readonly spaceId: string | null;
  /** Все пространства с активным членством (охват `all`). */
  readonly spaceIds: readonly string[];
  /** Роль в текущем пространстве; null — нет роли или роль не найдена в настройках. */
  readonly roleKey: string | null;
  /** Команда в текущем пространстве (охват `team`); null — нет команды, `team` сужается до `own`. */
  readonly teamId: string | null;
  /** Роль «только чтение»: мутации → 423, пишущие охваты → FALSE. */
  readonly readOnly: boolean;
  readonly grants: ReadonlyMap<Permission, Scope>;
  readonly relations: readonly ActiveRelation[];
  readonly license: LicenseState;
  /** Ревизия настроек, из которой взяты роли (если документ её сообщает). */
  readonly configRev: number | null;
  /** Время запроса, epoch-мс: одно на весь запрос (окна отношений считаются от него). */
  readonly now: number;
  /** Местная дата `now` в поясе установки, 'YYYY-MM-DD'. */
  readonly today: string;
  readonly timeZone: string;
}

/**
 * Фоновая задача или CLI: охват не ограничен. Создаётся только `systemActor()` из
 * `src/server/access/systemActor.ts`, импорт которого разрешён лишь scripts/** и src/server/jobs/**
 * (ESLint и tests/unit/layers.test.ts); домен может импортировать только тип.
 */
export interface SystemActor {
  readonly kind: 'system';
  /** Имя задачи или команды CLI — для аудита. */
  readonly job: string;
  readonly now: number;
}

export type Actor = Viewer | SystemActor;

/**
 * Сущности, к которым scopeSql выдаёт фильтр. Таблица и псевдоним по умолчанию — в scope.ts.
 * Клиент, контакты, номера, сделки, записи, звонки, заметки, лента видны через карточку (§5.2 п. 4).
 */
export const SCOPED_ENTITIES = [
  'card',
  'client',
  'contact',
  'client_phone',
  'deal',
  'booking',
  'call',
  'note',
  'client_event',
  'task',
  'handoff',
  'messenger_chat',
  'event',
] as const;
export type ScopedEntity = (typeof SCOPED_ENTITIES)[number];
