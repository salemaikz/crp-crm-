// Манифест изоляции: оболочки по ролям (P9b). Layout требуют только сессию: меню строится по роли и
// правам зрителя, данных клиентов не читают. Заглушки «Скоро» без данных; владелец раздела при замене
// страницы переносит запись в свой манифест. Layout (mgr) описан в mgr.ts.
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const base = { kind: 'page', method: 'GET', perm: 'authenticated', target: 'section', mutation: false } as const;
const paths = ['/(op)/layout', '/(consultant)/layout', '/(duty)/layout', '/(op)/call', '/(mgr)/summary', '/(mgr)/handoffs', '/(consultant)/consultations', '/(duty)/duty'];

const entries: ManifestEntry[] = paths.map((path) => ({ ...base, path }));

export default defineManifest('shell', entries);
