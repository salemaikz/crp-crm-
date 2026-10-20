// Типы дедупа (PROCESS 2.3, 7.6; CONFIG global.dedup). Чистое ядро: нормализацию номеров, названий и
// ФИО делает `core/phone` и `core/names` (K1a); сюда приходят уже нормализованные значения.
import type { PhoneKind } from '../phone';

export type { PhoneKind };

/**
 * Номер из ячейки или поля после нормализации: проекция `ParsedPhone` из `core/phone`
 * (`digits` заполнен только у рабочего номера, `review` = `needsReview`).
 */
export interface NormalizedPhone {
  /** Как было в источнике (для отчёта; в журнал и логи не пишется). */
  raw: string;
  /** Канон `7XXXXXXXXXX`, если номер рабочий; `null` — неверный или заглушка. */
  digits: string | null;
  kind: PhoneKind;
  /** Мобильный с отметкой «проверить номер» (`phone.reviewPrefixes`). */
  review?: boolean;
}

/** Настройки дедупа: `global.dedup` (CONFIG 6.4). */
export interface DedupSettings {
  /** Совпал БИН (идентификатор организации) — тот же клиент. */
  byOrgId: boolean;
  /** Совпал рабочий номер и название — тот же клиент. */
  byPhoneAndName: boolean;
  pairs: {
    /** Общий номер при разных названиях — спорная пара. */
    sharedPhone: boolean;
    /** Совпали название и руководитель без общего номера — спорная пара. */
    nameAndHead: boolean;
  };
}

/** Значения по умолчанию: все правила включены (CONFIG 6.4). */
export const DEFAULT_DEDUP_SETTINGS: DedupSettings = {
  byOrgId: true,
  byPhoneAndName: true,
  pairs: { sharedPhone: true, nameAndHead: true },
};

/** Префикс скрытого ключа ИИН (`iin:<HMAC>`, D-052). Прочие непустые `orgId` — открытые БИН. */
export const HIDDEN_ORG_ID_PREFIX = 'iin:';

/** Опознающие ключи компании — уже нормализованные. */
export interface CompanyKeys {
  /**
   * БИН (12 цифр) или `null`. Для форм с «личным» номером (ИП) — только ключ `iin:<HMAC>`, открытый
   * ИИН сюда не попадает (D-052). Разные непустые значения у двух сторон — разные лица: не склеиваем
   * (кроме `orgIdUncertain` против открытого БИН, D-141).
   */
  orgId: string | null;
  /**
   * Тот же номер в другом виде: у открытого БИН — `iin:<HMAC>` от тех же 12 цифр. Совпадение `orgId`
   * одной стороны с псевдонимом другой — тот же номер (D-141): так строка с неизвестной формой, скрытая
   * «на всякий случай», находит то же юрлицо с открытым БИН.
   */
  orgIdAliases?: readonly string[];
  /**
   * `orgId` скрыт «по неуверенности»: форма не определена, а 12 цифр могли быть и БИН (D-141). Такой
   * ключ не считается конфликтом с другим открытым БИН: склейка по номеру и названию разрешена.
   */
  orgIdUncertain?: boolean;
  /**
   * Код формы собственности (`тоо`, `ип`…), пусто — неизвестна. Разные известные формы («ТОО Альфа»
   * и «ИП Альфа» — названия после нормализации совпали) — разные лица: только спорная пара.
   */
  legalForm?: string;
  /** Только рабочие номера, канон `7XXXXXXXXXX`, без повторов. */
  phones: readonly string[];
  /** Цифры нерабочих номеров (заглушки): учитываются, только если рабочих нет. */
  stubPhones?: readonly string[];
  /** Название без формы собственности, кавычек и регистра; пусто, если названия нет. */
  nameNorm: string;
  /** ФИО руководителя в нормализованном виде; пусто, если нет. */
  headNorm: string;
}

/** Компания, уже лежащая в базе (или ранее принятая в этой же партии). */
export interface KnownCompany extends CompanyKeys {
  id: string;
  /** epoch-мс: при нескольких совпадениях побеждает самая старая. */
  createdAt: number;
}

/** Основание, по которому запись признана тем же клиентом. */
export type MatchBasis =
  | 'org_id'
  | 'phone_and_name'
  /** Без рабочего номера: то же название и та же записанная заглушка. */
  | 'stub_name_head';

/** Причина спорной пары (`dup_pairs.reason`). */
export type PairReason = 'shared_phone' | 'name_and_head';

export interface DupPair {
  /** Id существующего клиента, с которым пара. */
  id: string;
  reason: PairReason;
}

/**
 * Классификация записи.
 * - `new` — нет совпадений: новый клиент.
 * - `duplicate` — точный дубль: дописать пустые поля и новые номера, состояние не менять никогда.
 * - `disputed` — новый клиент + пары «на проверку»; пара не делится между операторами (7.6).
 */
export type DedupResult =
  | { kind: 'new' }
  | { kind: 'duplicate'; matchId: string; basis: MatchBasis }
  | { kind: 'disputed'; pairs: DupPair[] };
