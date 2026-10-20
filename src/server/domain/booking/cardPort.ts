// Порт карточки до C5: настоящий реализует calling (src/server/domain/cards/bookingPort.ts). Пока его нет,
// любое действие, которому нужно событие карточки, отвечает 503 `card_port_unavailable` (дизайн §12).
import { BookingDomainError } from './errors';
import type { CardPort } from './types';

export const unavailableCardPort: CardPort = {
  async applyBookingEvent() {
    throw new BookingDomainError('card_port_unavailable');
  },
};
