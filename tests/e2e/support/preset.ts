// Значения установки из пресета клиента: e2e не зашивает пояс и подписи видов мероприятий строками.
import { readFileSync } from 'node:fs';

type Ru = { ru: string };
interface PresetShape {
  global?: { org?: { timezone?: string } };
  spaces: { sales: { booking: { eventTypes: { key: string; label: Ru; short: Ru }[] } } };
}

const read = (path: string): PresetShape => JSON.parse(readFileSync(path, 'utf8')) as PresetShape;

/** Пояс установки: пресет клиента, а если он не задан, то базовый пресет страны (клиентский его наследует). */
export function installTimezone(): string {
  return read('presets/clients/crp/preset.json').global?.org?.timezone ?? read('presets/kz/preset.json').global?.org?.timezone ?? 'UTC';
}

/** Виды мероприятий из пресета: ключ, полная подпись и короткая. */
export function eventKinds(): { key: string; label: Ru; short: Ru }[] {
  return read('presets/clients/crp/preset.json').spaces.sales.booking.eventTypes;
}
