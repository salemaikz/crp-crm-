// Пересчёт clients.search_norm: название, БИН, все номера и значения полей `searchable`, видимых всем
// ролям (D-123). Вызывается внутри транзакции мутации после блокировки клиента.
import { fields } from '@crm/core';
import type { Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';
import type { ClientsConfig } from './config';
import { selectAllPhoneDigits, selectSearchSource, setSearchNorm } from './repo';

export async function refreshSearchNorm(sql: Sql, viewer: Viewer, clientId: string, cfg: ClientsConfig): Promise<void> {
  const src = await selectSearchSource(sql, viewer, clientId);
  if (!src) return;
  const phones = await selectAllPhoneDigits(sql, viewer, clientId);
  const norm = fields.buildSearchNorm({
    name: src.name,
    orgId: src.orgId,
    phones,
    custom: src.custom as fields.CustomValues,
    searchable: cfg.searchable,
  });
  await setSearchNorm(sql, viewer, clientId, norm);
}
