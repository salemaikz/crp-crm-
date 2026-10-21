// Типы модуля messenger (O7a, дизайн docs/reports-plugins-design.md §8). События приходят от плагина уже
// нормализованными (contract.ts); здесь — настройки применения и ответы окна чата.
import type { phone, time } from '@crm/core';
import type { IntegrationDeps } from '../integrations';

export type MessengerDeps = IntegrationDeps;

/** Срез настроек пространства для применения событий мессенджера. */
export interface MessengerSettings {
  spaceId: string;
  phoneRules: phone.PhoneRules;
  calendar: Pick<time.WorkCalendar, 'localDay' | 'isWorkingMoment' | 'timezone'>;
  /** `tasks.inboundReplyMinutes`: срок задачи «Ответить». */
  replyMinutes: number;
  /** `distribution.inbound.offHours`: роль, чей сотрудник получает задачи РОП (lead пространства). */
  leadRole: string;
  /** Ключи источников вида `messenger` (не в архиве), первый — по умолчанию. */
  messengerSources: readonly string[];
  /** Ключи полей клиента для search_norm. */
  searchable: readonly string[];
  /** Роли РОП-уровня (`pool.read`): получают тревоги по каналам. */
  managerRoles: readonly string[];
}

export type ChatWindowFailure = 'messenger_unavailable' | 'no_phone' | 'no_channel' | 'provider_error' | 'rate_limited' | 'consent_revoked';

/**
 * Ошибка окна чата и отметки «открыт WhatsApp» → 409 (502 для provider_error, 429 для rate_limited) с кодом; текста нет
 * (его строит интерфейс). `consent_revoked` — клиент отозвал согласие: провайдер не вызывается (D-297).
 */
export class ChatWindowError extends Error {
  override name = 'ChatWindowError';
  constructor(readonly code: ChatWindowFailure) {
    super(code);
  }
  get status(): number {
    return this.code === 'provider_error' ? 502 : this.code === 'rate_limited' ? 429 : 409;
  }
}

export interface ChatWindowResult {
  /** Одноразовая ссылка окна Wazzup: отдаётся только этому сотруднику, не кэшируется и не пишется в логи. */
  url: string;
}

export type ConsentAction = 'given' | 'revoked';
