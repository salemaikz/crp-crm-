// Полоса лицензии для оболочки (P10b, D-327): снимок из кэша процесса (currentLicenseSnapshot), без запросов на страницу.
import type { Viewer } from '@/server/access';
import { currentLicenseSnapshot } from '@/server/platform/license/current';
import { licenseBanner, type LicenseBanner } from './licenseBanner';

export async function loadLicenseBanner(viewer: Viewer): Promise<LicenseBanner | null> {
  const snap = await currentLicenseSnapshot();
  return licenseBanner(snap, { isAdmin: viewer.isAdmin, readOnlyRole: viewer.readOnly }, snap.now, viewer.timeZone);
}
