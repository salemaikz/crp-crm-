// Полоса состояния лицензии над страницей (P10b, D-327). Чистая функция: из снимка лицензии, зрителя и «сейчас»
// получает вид полосы или null. Внутренних кодов (wrong_build, error, id лицензии и установки) в ответе нет —
// только ключ текста и числа/даты. Администратор видит всё, остальные — коротко «только просмотр».
import { localDay } from '../call/zoned';

const DAY_MS = 86_400_000;

/** Что нужно от снимка лицензии (подмножество LicenseSnapshot — ядро и сервер в браузер не тянем). */
export type BannerSnapshot = {
  status: string;
  access: 'valid' | 'grace' | 'read_only' | 'invalid' | 'missing';
  reason: string;
  graceUntil: number | null;
  license: { expiresAt: number } | null;
};

export type BannerWho = { isAdmin: boolean; readOnlyRole: boolean };

export type BannerKey = 'expiring' | 'grace' | 'wrongBuild' | 'clock' | 'readOnly' | 'readOnlyShort';

export type LicenseBanner = {
  tone: 'info' | 'warn' | 'danger';
  key: BannerKey;
  /** Только числа и даты `ДД.ММ.ГГГГ` в поясе установки. */
  params: { days?: number; date?: string };
};

/** `2026-10-28` → `28.10.2026`. */
function ruDate(ms: number, tz: string): string {
  const [y, m, d] = localDay(ms, tz).split('-');
  return `${d}.${m}.${y}`;
}

export function licenseBanner(snap: BannerSnapshot, who: BannerWho, now: number, tz: string): LicenseBanner | null {
  if (snap.access === 'valid' && snap.status !== 'expiring') return null;

  if (snap.access === 'valid') {
    if (!who.isAdmin || !snap.license) return null;
    const days = Math.max(1, Math.ceil((snap.license.expiresAt - now) / DAY_MS));
    return { tone: 'warn', key: 'expiring', params: { days, date: ruDate(snap.license.expiresAt, tz) } };
  }

  if (snap.access === 'grace') {
    if (!who.isAdmin || snap.graceUntil === null) return null;
    const key = snap.status === 'invalid' ? 'wrongBuild' : 'grace';
    return { tone: 'danger', key, params: { date: ruDate(snap.graceUntil, tz) } };
  }

  // read_only, invalid, missing: мутации закрыты
  if (who.isAdmin) return { tone: 'danger', key: snap.reason === 'clock' ? 'clock' : 'readOnly', params: {} };
  // Директор и роль «только чтение» и так только читают
  return who.readOnlyRole ? null : { tone: 'info', key: 'readOnlyShort', params: {} };
}
