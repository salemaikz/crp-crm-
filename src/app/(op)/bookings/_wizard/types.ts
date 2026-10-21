// Типы мастера записи для клиентских файлов: только типы (стираются при сборке), сервер в бандл не попадает.
export type {
  BookingDomainErrorCode,
  BookingView,
  BookingWizardView,
  ConsultOffer,
  EventOption,
  OfferResult,
  WizardEventType,
} from '@/server/domain/booking';
export type { ConsultSlotOption, ConsultStripDay, SuggestedConsultant } from '@/server/domain/booking';
