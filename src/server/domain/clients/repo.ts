// Весь SQL клиентов, контактов, номеров и проверок номера (ARCHITECTURE §4.2, D-124, D-126).
// Любой доступ к строкам клиентов — через scopeSql; в шаблон вставляется только `scoped(sql)`.
// Порядок в мутациях: сначала блокировка строки с охватом, потом всё остальное — иначе чужой id
// оставит след (строку проверки номера, задачу).
import { ForbiddenError, NotFoundError, type Viewer } from '@/server/access';
import { scopeSql, scoped } from '@/server/access/scope';
import { newId, type Row, type Sql } from '@/server/platform/db';
import { jsonParam } from '@/server/platform/db/core';
import { INTAKE_LOCK_KEY } from '@/server/platform/db/locks';

type Json = Record<string, unknown>;

// ---------- Чтение карточки ----------

export type ClientRowDb = {
  id: string;
  kind: 'company' | 'person';
  name: string;
  legalForm: string;
  orgId: string;
  region: string;
  address: string;
  email: string;
  website: string;
  custom: Json;
  sourceKind: string;
  mergedIntoId: string | null;
  createdAt: number;
  updatedAt: number;
  canEdit: boolean;
  canIdentity: boolean;
};

/** 4.1. Клиент для карточки (включая слитого: страница ведёт к выжившему). */
export async function selectClient(sql: Sql, viewer: Viewer, id: string): Promise<ClientRowDb | null> {
  const rows = await scoped(sql)<ClientRowDb>`
    SELECT cl.id, cl.kind, cl.name, cl.legal_form, cl.org_id, cl.region, cl.address, cl.email, cl.website,
           cl.custom, cl.source_kind, cl.merged_into_id, cl.created_at, cl.updated_at,
           (${scopeSql(viewer, 'client', 'client.edit')}) AS can_edit,
           (${scopeSql(viewer, 'client', 'client.edit_identity')}) AS can_identity
      FROM clients cl
     WHERE cl.id = ${id} AND ${scopeSql(viewer, 'client', 'client.read')}`;
  return rows[0] ?? null;
}

export type CardHeadDb = {
  id: string;
  state: string;
  holdReason: string;
  nextCallAt: number | null;
  attempts: number;
  lpr: string;
  isTarget: string;
  lastOutcomeCode: string;
  callsTotal: number;
  noAnswerTotal: number;
  connectsTotal: number;
  firstConnectAt: number | null;
  lastConnectAt: number | null;
  lastTouchAt: number | null;
  ownerName: string | null;
  actingName: string | null;
};

/** 4.2. Карточка обзвона текущего пространства. */
export async function selectCardHead(sql: Sql, viewer: Viewer, clientId: string): Promise<CardHeadDb | null> {
  if (viewer.spaceId === null) return null;
  const rows = await scoped(sql)<CardHeadDb>`
    SELECT c.id, c.state, c.hold_reason, c.next_call_at, c.attempts, c.lpr, c.is_target, c.last_outcome_code,
           c.calls_total, c.no_answer_total, c.connects_total, c.first_connect_at, c.last_connect_at, c.last_touch_at,
           ou.name AS owner_name, au.name AS acting_name
      FROM cards c
      LEFT JOIN users ou ON ou.id = c.owner_user_id
      LEFT JOIN users au ON au.id = c.acting_user_id
     WHERE c.client_id = ${clientId} AND c.space_id = ${viewer.spaceId} AND ${scopeSql(viewer, 'card', 'card.read')}`;
  return rows[0] ?? null;
}

export type PhoneRowDb = {
  id: string;
  digits: string;
  ext: string;
  kind: 'mobile' | 'landline' | 'unknown';
  isWorking: boolean;
  isPrimary: boolean;
  hasWhatsapp: 'yes' | 'no' | 'unknown';
  contactId: string | null;
  createdAt: number;
};

/** 4.3. Номера клиента. */
export async function selectPhones(sql: Sql, viewer: Viewer, clientId: string): Promise<PhoneRowDb[]> {
  return scoped(sql)<PhoneRowDb>`
    SELECT cp.id, cp.digits, cp.ext, cp.kind, cp.is_working, cp.is_primary, cp.has_whatsapp, cp.contact_id, cp.created_at
      FROM client_phones cp
     WHERE cp.client_id = ${clientId} AND ${scopeSql(viewer, 'client_phone', 'client.read')}
     ORDER BY cp.is_primary DESC, cp.is_working DESC, cp.created_at, cp.id`;
}

export type ContactRowDb = {
  id: string;
  name: string;
  position: string;
  isDecisionMaker: boolean;
  callHint: string;
  note: string;
  custom: Json;
  createdAt: number;
};

/** 4.4. Контакты клиента (не в архиве). */
export async function selectContacts(sql: Sql, viewer: Viewer, clientId: string): Promise<ContactRowDb[]> {
  return scoped(sql)<ContactRowDb>`
    SELECT ct.id, ct.name, ct.position, ct.is_decision_maker, ct.call_hint, ct.note, ct.custom, ct.created_at
      FROM contacts ct
     WHERE ct.client_id = ${clientId} AND ct.archived_at IS NULL AND ${scopeSql(viewer, 'contact', 'client.read')}
     ORDER BY ct.is_decision_maker DESC, ct.created_at, ct.id`;
}

/** Один контакт клиента (не в архиве) с охватом чтения. */
export async function selectContact(sql: Sql, viewer: Viewer, id: string): Promise<(ContactRowDb & { clientId: string }) | null> {
  const rows = await scoped(sql)<ContactRowDb & { clientId: string }>`
    SELECT ct.id, ct.client_id, ct.name, ct.position, ct.is_decision_maker, ct.call_hint, ct.note, ct.custom, ct.created_at
      FROM contacts ct
     WHERE ct.id = ${id} AND ct.archived_at IS NULL AND ${scopeSql(viewer, 'contact', 'client.read')}`;
  return rows[0] ?? null;
}

/** Выживший при слиянии: подъём по цепочке не глубже 8 звеньев, охват чтения — у выжившего. */
export async function selectSurvivor(sql: Sql, viewer: Viewer, id: string): Promise<string | null> {
  const rows = await scoped(sql)<{ id: string }>`
    WITH RECURSIVE up(id, merged_into_id, depth) AS (
      SELECT m.id, m.merged_into_id, 0 FROM clients m WHERE m.id = ${id}
      UNION ALL
      SELECT n.id, n.merged_into_id, up.depth + 1 FROM clients n JOIN up ON n.id = up.merged_into_id WHERE up.depth < 8
    )
    SELECT cl.id FROM clients cl
     WHERE cl.id IN (SELECT up.id FROM up WHERE up.merged_into_id IS NULL)
       AND ${scopeSql(viewer, 'client', 'client.read')}`;
  return rows[0]?.id ?? null;
}

// ---------- Список ----------

export type ListRowDb = {
  cardId: string;
  id: string;
  name: string;
  custom: Json;
  state: string;
  holdReason: string;
  nextCallAt: number | null;
  lastTouchAt: number | null;
  sortAt: number;
};

export type ListParams = {
  states: string[] | null;
  /** Шаблоны LIKE для поиска (p2 = p1, если шаблон один) или null без поиска. */
  p1: string | null;
  p2: string | null;
  /** Фильтр полей: JSON-объект для `custom @>`. */
  filter: Json;
  cursor: { at: number; id: string } | null;
  limit: number;
};

/** 4.5. Список клиентов текущего пространства: охват по карточке, поиск по trgm, фильтр полей по GIN. */
export async function selectClientList(sql: Sql, viewer: Viewer, p: ListParams): Promise<ListRowDb[]> {
  if (viewer.spaceId === null) return [];
  const curAt = p.cursor?.at ?? null;
  const curId = p.cursor?.id ?? null;
  return scoped(sql)<ListRowDb>`
    SELECT c.id AS card_id, cl.id, cl.name, cl.custom, c.state, c.hold_reason, c.next_call_at, c.last_touch_at,
           COALESCE(c.last_touch_at, c.created_at) AS sort_at
      FROM cards c JOIN clients cl ON cl.id = c.client_id
     WHERE c.space_id = ${viewer.spaceId}
       AND ${scopeSql(viewer, 'card', 'client.read', { alias: 'c' })}
       AND cl.merged_into_id IS NULL
       AND (${p.states}::text[] IS NULL OR c.state = ANY(${p.states}::text[]))
       AND (${p.p1}::text IS NULL OR cl.search_norm LIKE ${p.p1}::text OR cl.search_norm LIKE ${p.p2}::text)
       AND cl.custom @> ${jsonParam(p.filter)}
       AND (${curAt}::bigint IS NULL OR (COALESCE(c.last_touch_at, c.created_at), c.id) < (${curAt}::bigint, ${curId}::text))
     ORDER BY sort_at DESC, c.id DESC
     LIMIT ${p.limit + 1}`;
}

/** Рабочие номера строк списка: главный выбирает сервис. */
export async function selectWorkingPhones(
  sql: Sql,
  viewer: Viewer,
  clientIds: string[],
): Promise<Array<{ clientId: string; digits: string; isPrimary: boolean }>> {
  if (clientIds.length === 0) return [];
  return scoped(sql)<{ clientId: string; digits: string; isPrimary: boolean }>`
    SELECT cp.client_id, cp.digits, cp.is_primary
      FROM client_phones cp
     WHERE cp.client_id = ANY(${clientIds}::text[]) AND cp.is_working AND ${scopeSql(viewer, 'client_phone', 'client.read')}
     ORDER BY cp.is_primary DESC, cp.created_at, cp.id`;
}

// ---------- Блокировки для правки ----------

export type LockedClient = {
  id: string;
  kind: 'company' | 'person';
  name: string;
  legalForm: string;
  orgId: string;
  region: string;
  address: string;
  email: string;
  website: string;
  custom: Json;
  canIdentity: boolean;
};

/** 4.6. Клиент под блокировкой с охватом `client.edit`. Нет строки — вызывающий зовёт throwNotFoundOrForbidden. */
export async function lockClientForEdit(sql: Sql, viewer: Viewer, id: string): Promise<LockedClient | null> {
  const rows = await scoped(sql)<LockedClient>`
    SELECT cl.id, cl.kind, cl.name, cl.legal_form, cl.org_id, cl.region, cl.address, cl.email, cl.website, cl.custom,
           (${scopeSql(viewer, 'client', 'client.edit_identity')}) AS can_identity
      FROM clients cl
     WHERE cl.id = ${id} AND cl.merged_into_id IS NULL AND ${scopeSql(viewer, 'client', 'client.edit')}
       FOR UPDATE OF cl`;
  return rows[0] ?? null;
}

export type SystemColumns = {
  name: string | null;
  legalForm: string | null;
  orgId: string | null;
  region: string | null;
  address: string | null;
  email: string | null;
  website: string | null;
  nameNorm: string | null;
  /** HMAC ИИН (D-181): null — не менять. Открытый ИИН в `org_id` не пишется никогда. */
  iinHmac: string | null;
};

/** UPDATE клиента с тем же охватом; null в колонке — не менять. `custom` пишется целиком. */
export async function updateClient(sql: Sql, viewer: Viewer, id: string, c: SystemColumns, custom: Json): Promise<boolean> {
  const rows = await scoped(sql)<{ id: string }>`
    UPDATE clients cl SET
           name = COALESCE(${c.name}::text, cl.name),
           legal_form = COALESCE(${c.legalForm}::text, cl.legal_form),
           org_id = COALESCE(${c.orgId}::text, cl.org_id),
           region = COALESCE(${c.region}::text, cl.region),
           address = COALESCE(${c.address}::text, cl.address),
           email = COALESCE(${c.email}::text, cl.email),
           website = COALESCE(${c.website}::text, cl.website),
           name_norm = COALESCE(${c.nameNorm}::text, cl.name_norm),
           iin_hmac = COALESCE(${c.iinHmac}::text, cl.iin_hmac),
           custom = ${jsonParam(custom)},
           updated_at = ${viewer.now}
     WHERE cl.id = ${id} AND ${scopeSql(viewer, 'client', 'client.edit')}
     RETURNING cl.id`;
  return rows.length > 0;
}

export async function setSearchNorm(sql: Sql, viewer: Viewer, id: string, searchNorm: string): Promise<void> {
  await scoped(sql)`
    UPDATE clients cl SET search_norm = ${searchNorm}
     WHERE cl.id = ${id} AND ${scopeSql(viewer, 'client', 'client.edit')}`;
}

/** Данные для пересчёта search_norm: название, БИН, значения полей. */
export async function selectSearchSource(sql: Sql, viewer: Viewer, id: string): Promise<{ name: string; orgId: string; custom: Json } | null> {
  const rows = await scoped(sql)<{ name: string; orgId: string; custom: Json }>`
    SELECT cl.name, cl.org_id, cl.custom FROM clients cl
     WHERE cl.id = ${id} AND ${scopeSql(viewer, 'client', 'client.edit')}`;
  return rows[0] ?? null;
}

export async function selectAllPhoneDigits(sql: Sql, viewer: Viewer, clientId: string): Promise<string[]> {
  const rows = await scoped(sql)<{ digits: string }>`
    SELECT cp.digits FROM client_phones cp
     WHERE cp.client_id = ${clientId} AND ${scopeSql(viewer, 'client_phone', 'client.read')}
     ORDER BY cp.created_at, cp.id`;
  return rows.map((r) => r.digits);
}

export type LockedContact = {
  id: string;
  clientId: string;
  name: string;
  position: string;
  isDecisionMaker: boolean;
  callHint: string;
  note: string;
  custom: Json;
};

/** Контакт под блокировкой с охватом `client.edit`. */
export async function lockContactForEdit(sql: Sql, viewer: Viewer, id: string): Promise<LockedContact | null> {
  const rows = await scoped(sql)<LockedContact>`
    SELECT ct.id, ct.client_id, ct.name, ct.position, ct.is_decision_maker, ct.call_hint, ct.note, ct.custom
      FROM contacts ct
     WHERE ct.id = ${id} AND ct.archived_at IS NULL AND ${scopeSql(viewer, 'contact', 'client.edit')}
       FOR UPDATE OF ct`;
  return rows[0] ?? null;
}

export type ContactColumns = {
  name: string | null;
  position: string | null;
  isDecisionMaker: boolean | null;
  callHint: string | null;
  note: string | null;
};

export async function updateContact(sql: Sql, viewer: Viewer, id: string, c: ContactColumns, custom: Json): Promise<boolean> {
  const rows = await scoped(sql)<{ id: string }>`
    UPDATE contacts ct SET
           name = COALESCE(${c.name}::text, ct.name),
           position = COALESCE(${c.position}::text, ct.position),
           is_decision_maker = COALESCE(${c.isDecisionMaker}::boolean, ct.is_decision_maker),
           call_hint = COALESCE(${c.callHint}::text, ct.call_hint),
           note = COALESCE(${c.note}::text, ct.note),
           custom = ${jsonParam(custom)}
     WHERE ct.id = ${id} AND ${scopeSql(viewer, 'contact', 'client.edit')}
     RETURNING ct.id`;
  return rows.length > 0;
}

export async function archiveContact(sql: Sql, viewer: Viewer, id: string): Promise<boolean> {
  const rows = await scoped(sql)<{ id: string }>`
    UPDATE contacts ct SET archived_at = ${viewer.now}
     WHERE ct.id = ${id} AND ct.archived_at IS NULL AND ${scopeSql(viewer, 'contact', 'client.edit')}
     RETURNING ct.id`;
  return rows.length > 0;
}

/** Вставка контакта: id = opId, повтор — пусто (ON CONFLICT DO NOTHING). Клиент уже заблокирован с охватом. */
export async function insertContact(
  sql: Sql,
  viewer: Viewer,
  v: { id: string; clientId: string; name: string; position: string; isDecisionMaker: boolean; callHint: string; note: string; custom: Json },
): Promise<boolean> {
  const rows = await scoped(sql)<{ id: string }>`
    INSERT INTO contacts (id, client_id, name, position, is_decision_maker, call_hint, note, custom, created_at)
    SELECT ${v.id}, cl.id, ${v.name}, ${v.position}, ${v.isDecisionMaker}, ${v.callHint}, ${v.note}, ${jsonParam(v.custom)}, ${viewer.now}
      FROM clients cl
     WHERE cl.id = ${v.clientId} AND ${scopeSql(viewer, 'client', 'client.edit')}
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** Контакт этого клиента, не в архиве, с охватом правки (для привязки номера). */
export async function contactBelongsToClient(sql: Sql, viewer: Viewer, contactId: string, clientId: string): Promise<boolean> {
  const rows = await scoped(sql)<{ hit: number }>`
    SELECT 1 AS hit FROM contacts ct
     WHERE ct.id = ${contactId} AND ct.client_id = ${clientId} AND ct.archived_at IS NULL
       AND ${scopeSql(viewer, 'contact', 'client.edit')}`;
  return rows.length > 0;
}

// ---------- Номера ----------

export type LockedPhone = { id: string; clientId: string; digits: string; isWorking: boolean; isPrimary: boolean };

/** Клиент номера (для блокировки клиента первым) с охватом `client.edit`; без блокировки. */
export async function phoneClientId(sql: Sql, viewer: Viewer, phoneId: string): Promise<string | null> {
  const rows = await scoped(sql)<{ clientId: string }>`
    SELECT cp.client_id FROM client_phones cp
     WHERE cp.id = ${phoneId} AND ${scopeSql(viewer, 'client_phone', 'client.edit')}`;
  return rows[0]?.clientId ?? null;
}

/** Номер под блокировкой; клиент уже заблокирован. */
export async function lockPhone(sql: Sql, viewer: Viewer, phoneId: string, clientId: string): Promise<LockedPhone | null> {
  const rows = await scoped(sql)<LockedPhone>`
    SELECT cp.id, cp.client_id, cp.digits, cp.is_working, cp.is_primary
      FROM client_phones cp
     WHERE cp.id = ${phoneId} AND cp.client_id = ${clientId} AND ${scopeSql(viewer, 'client_phone', 'client.edit')}
       FOR UPDATE OF cp`;
  return rows[0] ?? null;
}

export async function selectPhoneByDigits(sql: Sql, viewer: Viewer, clientId: string, digits: string): Promise<PhoneRowDb | null> {
  const rows = await scoped(sql)<PhoneRowDb>`
    SELECT cp.id, cp.digits, cp.ext, cp.kind, cp.is_working, cp.is_primary, cp.has_whatsapp, cp.contact_id, cp.created_at
      FROM client_phones cp
     WHERE cp.client_id = ${clientId} AND cp.digits = ${digits} AND ${scopeSql(viewer, 'client_phone', 'client.read')}`;
  return rows[0] ?? null;
}

export async function selectPhoneById(sql: Sql, viewer: Viewer, clientId: string, id: string): Promise<PhoneRowDb | null> {
  const rows = await scoped(sql)<PhoneRowDb>`
    SELECT cp.id, cp.digits, cp.ext, cp.kind, cp.is_working, cp.is_primary, cp.has_whatsapp, cp.contact_id, cp.created_at
      FROM client_phones cp
     WHERE cp.client_id = ${clientId} AND cp.id = ${id} AND ${scopeSql(viewer, 'client_phone', 'client.read')}`;
  return rows[0] ?? null;
}

/**
 * Вставка номера: id = opId, повтор — пусто. Основным становится, если у клиента нет основного
 * (частичный уникальный индекс client_phones_one_primary). Клиент заблокирован вызывающим.
 */
export async function insertPhone(
  sql: Sql,
  viewer: Viewer,
  v: { id: string; clientId: string; contactId: string | null; digits: string; ext: string; kind: string },
): Promise<boolean> {
  const rows = await scoped(sql)<{ id: string }>`
    INSERT INTO client_phones (id, client_id, contact_id, digits, ext, kind, is_working, is_primary, created_at)
    SELECT ${v.id}, cl.id, ${v.contactId}, ${v.digits}, ${v.ext}, ${v.kind}, TRUE,
           NOT EXISTS (SELECT 1 FROM client_phones p0 WHERE p0.client_id = cl.id AND p0.is_primary), ${viewer.now}
      FROM clients cl
     WHERE cl.id = ${v.clientId} AND ${scopeSql(viewer, 'client', 'client.edit')}
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** «Номер не работает»: снимает рабочий и основной признаки. */
export async function markPhoneNotWorking(sql: Sql, viewer: Viewer, phoneId: string): Promise<void> {
  await scoped(sql)`
    UPDATE client_phones cp SET is_working = FALSE, is_primary = FALSE
     WHERE cp.id = ${phoneId} AND ${scopeSql(viewer, 'client_phone', 'client.edit')}`;
}

export async function clearPrimary(sql: Sql, viewer: Viewer, clientId: string): Promise<void> {
  await scoped(sql)`
    UPDATE client_phones cp SET is_primary = FALSE
     WHERE cp.client_id = ${clientId} AND cp.is_primary AND ${scopeSql(viewer, 'client_phone', 'client.edit')}`;
}

export async function setPrimary(sql: Sql, viewer: Viewer, phoneId: string): Promise<void> {
  await scoped(sql)`
    UPDATE client_phones cp SET is_primary = TRUE
     WHERE cp.id = ${phoneId} AND cp.is_working AND ${scopeSql(viewer, 'client_phone', 'client.edit')}`;
}

/** Самый ранний рабочий номер клиента — он становится основным после «не работает». */
export async function earliestWorkingPhone(sql: Sql, viewer: Viewer, clientId: string): Promise<string | null> {
  const rows = await scoped(sql)<{ id: string }>`
    SELECT cp.id FROM client_phones cp
     WHERE cp.client_id = ${clientId} AND cp.is_working AND ${scopeSql(viewer, 'client_phone', 'client.edit')}
     ORDER BY cp.created_at, cp.id LIMIT 1`;
  return rows[0]?.id ?? null;
}

// ---------- Проверка номера (D-126) ----------

/** Общая блокировка приёма (D-022): проверка и добавление номеров идут по одной. Клиент уже заблокирован. */
export async function lockIntake(sql: Sql): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${INTAKE_LOCK_KEY})`;
}

export async function countProbesToday(sql: Sql, viewer: Viewer): Promise<number> {
  const rows = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM phone_probes WHERE user_id = ${viewer.userId} AND day = ${viewer.today}`;
  return rows[0]?.n ?? 0;
}

export async function isStopListed(sql: Sql, phoneHmac: string): Promise<boolean> {
  const rows = await sql<{ hit: number }>`SELECT 1 AS hit FROM stop_list WHERE phone_hmac = ${phoneHmac}`;
  return rows.length > 0;
}

/**
 * D-126. Единственное место модуля без scopeSql: глобальная проверка «номер есть у другого клиента»
 * возвращает только булево и наружу уходит одинаковым ответом («отправлено на проверку») — чужой
 * клиент, его название и принадлежность не раскрываются. Слитые клиенты не считаются.
 */
export async function phoneTakenElsewhere(sql: Sql, digits: string, clientId: string): Promise<boolean> {
  const rows = await sql<{ taken: boolean }>`
    SELECT EXISTS (SELECT 1 FROM client_phones cp JOIN clients o ON o.id = cp.client_id
                    WHERE cp.digits = ${digits} AND cp.client_id <> ${clientId} AND o.merged_into_id IS NULL) AS taken`;
  return rows[0]?.taken === true;
}

export async function insertProbe(sql: Sql, viewer: Viewer, matched: boolean): Promise<void> {
  await sql`INSERT INTO phone_probes (id, user_id, day, path, matched, created_at)
            VALUES (${newId()}, ${viewer.userId}, ${viewer.today}, 'add_phone', ${matched}, ${viewer.now})`;
}

/** Задача РОП «проверить номер»; повтор того же opId задачу не дублирует (tasks_source_uq). */
export async function insertReviewTask(sql: Sql, viewer: Viewer, v: { clientId: string; opId: string; title: string }): Promise<void> {
  if (viewer.spaceId === null) throw new Error('insertReviewTask: у сотрудника нет пространства');
  await sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, assignee_user_id, source_key, created_by, created_at)
            VALUES (${newId()}, ${viewer.spaceId}, ${v.clientId}, 'check', 'review', ${v.title}, NULL,
                    ${`add_phone:${v.opId}`}, ${viewer.userId}, ${viewer.now})
            ON CONFLICT DO NOTHING`;
}

// ---------- Отказ 404 или 403 ----------

export type DeniedEntity = 'client' | 'contact' | 'client_phone';

/**
 * Мутация не нашла строку с охватом правки: повторное чтение охватом `client.read`. Не видна —
 * NotFoundError (404, одинаково с несуществующим id), видна — ForbiddenError (403, D-124). Всегда бросает.
 */
export async function throwNotFoundOrForbidden(viewer: Viewer, sql: Sql, entity: DeniedEntity, id: string): Promise<never> {
  const q = scoped(sql);
  let rows: Row[];
  if (entity === 'client') {
    rows = await q`SELECT 1 AS hit FROM clients cl WHERE cl.id = ${id} AND cl.merged_into_id IS NULL AND ${scopeSql(viewer, 'client', 'client.read')}`;
  } else if (entity === 'contact') {
    rows = await q`SELECT 1 AS hit FROM contacts ct WHERE ct.id = ${id} AND ct.archived_at IS NULL AND ${scopeSql(viewer, 'contact', 'client.read')}`;
  } else {
    rows = await q`SELECT 1 AS hit FROM client_phones cp WHERE cp.id = ${id} AND ${scopeSql(viewer, 'client_phone', 'client.read')}`;
  }
  throw rows.length > 0 ? new ForbiddenError() : new NotFoundError();
}
