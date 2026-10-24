// Подписи ленты на сервере (контракт К2): одни и те же для «Истории» карточки и превью в шторке доски.
// Номера и контакты конкретного клиента сюда не входят: страница карточки добавляет их сама.
import { fields } from '@crm/core';
import type { Viewer } from '@/server/access';
import { fieldViewer, loadClientsConfig, loadFeedCatalog } from '@/server/domain/clients';
import { labelOf } from './format';
import type { FeedLabels } from './types';

/** Подписи полей (только видимых зрителю), вариантов, форм собственности, итогов, причин, видов записи, этапов и колонок. */
export async function feedLabelsFor(viewer: Viewer): Promise<FeedLabels> {
  const [cfg, catalog] = await Promise.all([loadClientsConfig(viewer), loadFeedCatalog(viewer)]);
  const visible = new Set(fields.visibleFieldRefs(fieldViewer(viewer, cfg), cfg.fields));
  const labels: FeedLabels = { fields: {}, options: {}, phones: {}, contacts: {}, ...catalog, timeZone: viewer.timeZone };
  for (const f of cfg.fields) {
    const ref = `${f.object}:${f.key}`;
    if (!visible.has(ref)) continue;
    labels.fields[ref] = labelOf(f.label);
    for (const o of f.options ?? []) labels.options[`${ref}:${o.key}`] = labelOf(o.label);
  }
  for (const f of cfg.legalFormOptions) labels.options[`legal_form:${f.key}`] = labelOf(f.label);
  return labels;
}
