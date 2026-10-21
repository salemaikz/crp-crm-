// B9b (docs/tasks-team-design.md §7.3, §10): слияние клиентов спорной пары. Мир изоляции + настройки обзвона;
// номера и имена — синтетика (+7 709 …). «Сейчас» мира — среда 28.10.2026 11:00 (Алматы).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { getClientFeed, loadClientPage } from '../../../src/server/domain/clients';
import { applyMerge, MERGE_TABLES, MergeError, previewMerge, type MergeChoice } from '../../../src/server/domain/intake';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SPACE, U, phoneOf } from '../../isolation/harness/seed';
import { closeCallsWorld, openCallsWorld, setCard, viewerOf } from '../calls/world';

let db: TestDb;
let rop: Viewer;
let opA: Viewer;
let opB: Viewer;
const uuid = (): string => globalThis.crypto.randomUUID();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const local = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm}:00+05:00`);
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error);
const detail = (e: Error | null) => (e instanceof MergeError ? e.detail : e?.constructor.name ?? null);

async function pair(id: string, a: string, b: string, reason = 'shared_phone'): Promise<void> {
  await db.sql`INSERT INTO dup_pairs (id, a_client_id, b_client_id, reason, created_at) VALUES (${id}, ${a}, ${b}, ${reason}, ${SEED_NOW})`;
}

async function booking(id: string, client: string, card: string, day: string, over: { kind?: 'group' | 'individual'; eventId?: string | null; type?: string } = {}) {
  const kind = over.kind ?? 'individual';
  await db.sql`INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, resource_id, client_id, card_id, booking_date, start_time, starts_at,
                                     duration_min, booked_by_user_id, responsible_user_id, created_at, updated_at)
               VALUES (${id}, ${SPACE}, ${kind}, ${over.type ?? 'consult'}, ${over.eventId ?? null}, ${kind === 'individual' ? 'rs-cons' : null}, ${client}, ${card},
                       ${day}, '11:00', ${local(day, '11:00')}, 60, ${U.opB}, ${U.opB}, ${SEED_NOW}, ${SEED_NOW})`;
}

const choice = (over: Partial<MergeChoice> = {}): MergeChoice => ({ survivor: 'a', owner: 'auto', ...over });

before(async () => {
  process.env.FEATURE_MERGE = '1';
  db = await openCallsWorld();
  rop = await viewerOf(U.rop);
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
});
after(async () => {
  delete process.env.FEATURE_MERGE;
  await closeCallsWorld(db);
});

test('MERGE_TABLES совпадает со всеми внешними ключами на clients и cards (pg_constraint)', async () => {
  const fks = await db.sql<{ col: string }>`
    SELECT cl.relname || '.' || a.attname AS col
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_class ref ON ref.oid = c.confrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.contype = 'f' AND ref.relname IN ('clients', 'cards') AND c.connamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
     ORDER BY 1`;
  assert.ok(fks.length > 10, 'внешние ключи найдены');
  assert.deepEqual(fks.map((f) => f.col).sort(), Object.keys(MERGE_TABLES).sort());
});

test('слияние: всё переезжает, проигравшая карточка с задержкой merged, лента выжившего видит события слитого, повтор opId — тот же ответ', async () => {
  const S = 'cl-a-50';
  const L = 'cl-b-50';
  const t = SEED_NOW;
  // выживший: перезвон раньше; проигравший: перезвон позже → состояние и владелец (auto) — от проигравшего
  await setCard(db.sql, 'cd-a-50', { state: 'retry', lastOutcomeAt: t - 3 * DAY });
  await setCard(db.sql, 'cd-b-50', { state: 'callback', lastOutcomeAt: t - DAY, nextCallAt: t + DAY });
  await db.sql`UPDATE cards SET calls_total = 2 WHERE id = 'cd-a-50'`;
  await db.sql`UPDATE cards SET calls_total = 3 WHERE id = 'cd-b-50'`;
  await db.sql`UPDATE clients SET org_id = '770900000050', region = 'south' WHERE id = ${L}`;
  // общий номер (совпадёт — удалится) и свой номер проигравшего (переедет)
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, created_at) VALUES ('ph-mg-dup', ${L}, ${phoneOf('a', 50)}, 'mobile', ${t})`;
  await pair('pr-mg-50', S, L);
  await pair('pr-mg-50x', L, 'cl-b-51', 'name_and_head');
  // строки проигравшего в каждой таблице переноса
  await db.sql`INSERT INTO contacts (id, client_id, name, created_at) VALUES ('ct-mg-1', ${L}, 'Контакт Синтетик', ${t})`;
  await db.sql`INSERT INTO client_sources (id, client_id, source_kind, first_seen_at) VALUES ('cs-mg-1', ${L}, 'import', ${t})`;
  await db.sql`INSERT INTO imports (id, space_id, file_sha256, profile_key, created_at) VALUES ('im-mg', ${SPACE}, ${'0'.repeat(64)}, 'p', ${t})`;
  await db.sql`INSERT INTO import_rows (id, import_id, row_no, import_key, parsed, client_id, created_at) VALUES ('ir-mg-1', 'im-mg', 1, 'k', '{}', ${L}, ${t})`;
  await db.sql`INSERT INTO integrations (id, plugin_id, created_at, updated_at) VALUES ('int-mg', 'messenger.test', ${t}, ${t})`;
  await db.sql`INSERT INTO messenger_channels (id, integration_id, space_id, provider_channel_id, transport, created_at, updated_at)
               VALUES ('ch-mg', 'int-mg', ${SPACE}, 'pc-1', 'whatsapp', ${t}, ${t})`;
  await db.sql`INSERT INTO messenger_chats (id, channel_id, chat_type, chat_id, client_id, created_at) VALUES ('chat-mg-1', 'ch-mg', 'whatsapp', ${phoneOf('b', 50)}, ${L}, ${t})`;
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, created_by, created_at, updated_at)
               VALUES ('dl-mg-1', ${SPACE}, 'sales', 'booked', 'open', ${L}, 'cd-b-50', ${U.opB}, ${t}, ${U.opB}, ${t}, ${t})`;
  await db.sql`INSERT INTO handoffs (id, space_id_from, space_id_to, team_id, deal_id, client_id, due_at, created_at)
               VALUES ('ho-mg-1', ${SPACE}, ${SPACE}, 'team-mkt', 'dl-mg-1', ${L}, ${t + DAY}, ${t})`;
  await db.sql`INSERT INTO notes (id, client_id, space_id, author_id, body, created_at) VALUES ('nt-mg-1', ${L}, ${SPACE}, ${U.opB}, 'заметка', ${t})`;
  await db.sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, assignee_user_id, created_at)
               VALUES ('tk-mg-l', ${SPACE}, ${L}, 'call', 'manual', 'Задача проигравшего', ${U.opB}, ${t}),
                      ('tk-mg-s', ${SPACE}, ${S}, 'call', 'manual', 'Задача выжившего', ${U.opA}, ${t}),
                      ('tk-mg-rop', ${SPACE}, ${S}, 'check', 'manual', 'Задача РОП', NULL, ${t})`;
  await db.sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, applied, occurred_at, received_at, config_rev)
               VALUES ('call-mg-1', ${SPACE}, 'cd-b-50', ${L}, ${U.opB}, 'ui', ${phoneOf('b', 50)}, 'no_answer', 'no_answer', 'applied', ${t - DAY}, ${t - DAY}, 1)`;
  await booking('bk-mg-1', L, 'cd-b-50', '2026-10-30');
  await db.sql`INSERT INTO proposals (id, space_id, user_id, digits, name, status, matched_client_id, created_at)
               VALUES ('pp-mg-1', ${SPACE}, ${U.opA}, ${phoneOf('b', 50)}, 'ТОО Пример', 'review', ${L}, ${t})`;
  await db.sql`INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at) VALUES ('ce-mg-1', ${L}, ${SPACE}, 'call', ${U.opB}, ${t - DAY})`;
  await db.sql`INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, day, created_at)
               VALUES ('al-mg-1', ${SPACE}, 'cd-b-50', NULL, ${U.opB}, 'auto', TRUE, '2026-10-27', ${t - DAY})`;

  const preview = await previewMerge(rop, 'pr-mg-50', choice());
  assert.equal(preview.survivorClientId, S);
  assert.equal(preview.loserClientId, L);
  assert.deepEqual(preview.conflicts, []);
  assert.deepEqual(preview.result && [preview.result.state, preview.result.ownerUserId], ['callback', U.opB]);
  assert.deepEqual(preview.phones, { moved: 1, duplicates: 1 });
  assert.ok(preview.fills.includes('orgId') && preview.fills.includes('region'));
  assert.deepEqual(
    [preview.moves.contacts, preview.moves.deals, preview.moves.bookings, preview.moves.calls, preview.moves.tasks, preview.moves.proposals, preview.moves.cards],
    [1, 1, 1, 1, 1, 1, 1],
  );

  const opId = uuid();
  const r = await applyMerge(rop, 'pr-mg-50', { ...choice(), opId, fingerprint: preview.fingerprint });
  assert.equal(r.replayed, false);
  assert.equal(r.survivorClientId, S);

  // у проигравшего не осталось ссылок, кроме законных остатков
  for (const [key, rule] of Object.entries(MERGE_TABLES)) {
    if (rule.mode !== 'move') continue;
    const [table, col] = key.split('.') as [string, string];
    const target = col === 'card_id' ? 'cd-b-50' : L;
    const extra = 'leftover' in rule ? (rule.leftover === 'merged_card' ? " AND hold_reason <> 'merged'" : " AND status <> 'merged'") : '';
    // имя таблицы и колонки — из каталога ключей; запрос собирает сам Postgres (format %I), счёт — через query_to_xml
    const [row] = await db.sql<{ n: number }>`
      SELECT (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I WHERE %I = %L%s', ${table}::text, ${col}::text, ${target}::text, ${extra}::text), false, true, '')))[1]::text::int AS n`;
    assert.equal(row?.n, 0, `${key}: остались строки проигравшего`);
  }
  // номера: совпавший удалён, свой переехал не основным
  const phones = await db.sql<{ id: string; isPrimary: boolean }>`SELECT id, is_primary FROM client_phones WHERE client_id = ${S} ORDER BY id`;
  assert.deepEqual(phones.map((p) => [p.id, p.isPrimary]), [['ph-a-50', true], ['ph-b-50', false]]);
  // карточки: выжившая по ядру, проигравшая — строка с задержкой merged
  const cards = await db.sql<{ id: string; state: string; owner: string | null; hold: string; calls: number; version: number }>`
    SELECT id, state, owner_user_id AS owner, hold_reason AS hold, calls_total AS calls, version FROM cards WHERE id IN ('cd-a-50','cd-b-50') ORDER BY id`;
  assert.deepEqual(cards.map((c) => [c.id, c.state, c.owner, c.hold, c.calls]), [
    ['cd-a-50', 'callback', U.opB, '', 5],
    ['cd-b-50', 'callback', null, 'merged', 3],
  ]);
  // задачи: выжившего — новому владельцу, РОП без исполнителя не тронута
  const tasks = await db.sql<{ id: string; assignee: string | null }>`SELECT id, assignee_user_id AS assignee FROM tasks WHERE id LIKE 'tk-mg-%' ORDER BY id`;
  assert.deepEqual(tasks.map((x) => [x.id, x.assignee]), [['tk-mg-l', U.opB], ['tk-mg-rop', null], ['tk-mg-s', U.opB]]);
  // клиент: слит, уникальный БИН перешёл к выжившему, пустое поле заполнено
  const clients = await db.sql<{ id: string; merged: string | null; orgId: string; region: string }>`
    SELECT id, merged_into_id AS merged, org_id, region FROM clients WHERE id IN (${S}, ${L}) ORDER BY id`;
  assert.deepEqual(clients.map((c) => [c.id, c.merged, c.orgId, c.region]), [[S, null, '770900000050', 'south'], [L, S, '770900000050', 'south']]);
  // пары: эта и вторая пара проигравшего — merged, вместо второй — (выживший, X) открытая
  const pairs = await db.sql<{ a: string; b: string; status: string }>`
    SELECT a_client_id AS a, b_client_id AS b, status FROM dup_pairs WHERE ${S} IN (a_client_id, b_client_id) OR ${L} IN (a_client_id, b_client_id) ORDER BY a_client_id, b_client_id`;
  assert.deepEqual(pairs.map((p) => [p.a, p.b, p.status]), [[S, L, 'merged'], [S, 'cl-b-51', 'open'], [L, 'cl-b-51', 'merged']]);
  // снимок «до» той же операцией, включая удалённый номер
  const snaps = await db.sql<{ table: string; rowId: string }>`SELECT table_name AS table, row_id FROM change_snapshots WHERE operation_id = ${opId} AND kind = 'merge'`;
  assert.equal(snaps.length, r.counts.snapshots);
  assert.ok(snaps.some((s) => s.table === 'client_phones' && s.rowId === 'ph-mg-dup'));
  assert.ok(snaps.some((s) => s.table === 'clients' && s.rowId === L));
  // журналы: assign_log проигравшей карточки остался, лента выжившего показывает и события слитого
  assert.equal((await db.sql`SELECT 1 FROM assign_log WHERE id = 'al-mg-1' AND card_id = 'cd-b-50'`).length, 1);
  const feed = await getClientFeed(rop, S, { cursor: null, groups: null });
  const kinds = feed.items.map((i) => i.kind);
  assert.ok(kinds.includes('client.merged'));
  assert.ok(kinds.includes('card.merged'));
  assert.ok(feed.items.some((i) => i.id === 'ce-mg-1'), 'событие слитого клиента в ленте выжившего');
  // уведомление потерявшему владельцу — без названия клиента
  const notes = await db.sql<{ userId: string }>`SELECT user_id FROM notifications WHERE kind = 'card_merged'`;
  assert.deepEqual(notes.map((n) => n.userId), [U.opA]);
  assert.doesNotMatch(JSON.stringify(await db.sql`SELECT * FROM notifications WHERE kind = 'card_merged'`), /Синтетика|7709/);
  const audit = await db.sql<{ entityId: string; meta: Record<string, unknown> }>`SELECT entity_id, meta FROM audit_log WHERE action = 'client.merge'`;
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.entityId, S);
  assert.doesNotMatch(JSON.stringify(audit), /Синтетика|7709/);
  // страница слитого ведёт к выжившему; прежний владелец выжившей больше не видит
  assert.deepEqual(await loadClientPage(rop, L), { kind: 'redirect', to: `/clients/${S}` });
  assert.equal((await loadClientPage(opA, S)).kind, 'missing');
  assert.equal((await loadClientPage(opB, S)).kind, 'ok');

  // повтор opId — тот же ответ, ничего не двоится
  const again = await applyMerge(rop, 'pr-mg-50', { ...choice(), opId, fingerprint: preview.fingerprint });
  assert.deepEqual(again, { ...r, replayed: true });
  assert.equal((await db.sql`SELECT 1 FROM audit_log WHERE action = 'client.merge'`).length, 1);
  // новая операция по решённой паре — 409
  assert.equal(detail(await failure(applyMerge(rop, 'pr-mg-50', { ...choice(), opId: uuid(), fingerprint: preview.fingerprint }))), 'not_open');
});

test('«Не звонить» побеждает: выживший перезванивал позже, но проигравший просил не звонить', async () => {
  await setCard(db.sql, 'cd-a-52', { state: 'callback', lastOutcomeAt: SEED_NOW - HOUR, nextCallAt: SEED_NOW + DAY });
  await setCard(db.sql, 'cd-b-52', { state: 'do_not_call', lastOutcomeAt: SEED_NOW - 5 * DAY, nextCallAt: null });
  await pair('pr-mg-52', 'cl-a-52', 'cl-b-52');
  const p = await previewMerge(rop, 'pr-mg-52', choice({ owner: 'survivor' }));
  assert.deepEqual(p.result && [p.result.state, p.result.ownerUserId], ['do_not_call', U.opA]);
  await applyMerge(rop, 'pr-mg-52', { ...choice({ owner: 'survivor' }), opId: uuid(), fingerprint: p.fingerprint });
  const [c] = await db.sql<{ state: string; owner: string }>`SELECT state, owner_user_id AS owner FROM cards WHERE id = 'cd-a-52'`;
  assert.deepEqual([c?.state, c?.owner], ['do_not_call', U.opA]);
});

test('конфликт записей: будущие записи одного вида у обоих → предпросмотр показывает, применение 409', async () => {
  await booking('bk-mg-53a', 'cl-a-53', 'cd-a-53', '2026-10-30');
  await booking('bk-mg-53b', 'cl-b-53', 'cd-b-53', '2026-11-02');
  await pair('pr-mg-53', 'cl-a-53', 'cl-b-53');
  const p = await previewMerge(rop, 'pr-mg-53', choice());
  assert.deepEqual(p.conflicts, ['booking_conflict']);
  const e = await failure(applyMerge(rop, 'pr-mg-53', { ...choice(), opId: uuid(), fingerprint: p.fingerprint }));
  assert.equal(detail(e), 'booking_conflict');
  const [cl] = await db.sql<{ merged: string | null }>`SELECT merged_into_id AS merged FROM clients WHERE id = 'cl-b-53'`;
  assert.equal(cl?.merged, null);
});

test('устаревший отпечаток → 409 changed, ничего не записано', async () => {
  await pair('pr-mg-54', 'cl-a-54', 'cl-b-54');
  const p = await previewMerge(rop, 'pr-mg-54', choice());
  await db.sql`UPDATE cards SET version = version + 1 WHERE id = 'cd-b-54'`;
  const opId = uuid();
  assert.equal(detail(await failure(applyMerge(rop, 'pr-mg-54', { ...choice(), opId, fingerprint: p.fingerprint }))), 'changed');
  assert.equal((await db.sql`SELECT 1 FROM change_snapshots WHERE operation_id = ${opId}`).length, 0);
  // другой выбор владельца — тоже другой отпечаток
  const fresh = await previewMerge(rop, 'pr-mg-54', choice());
  assert.equal(detail(await failure(applyMerge(rop, 'pr-mg-54', { ...choice({ owner: 'other' }), opId, fingerprint: fresh.fingerprint }))), 'changed');
});

test('карточка в пространстве без права слияния → other_space', async () => {
  const t = SEED_NOW;
  await db.sql`INSERT INTO spaces (id, key, is_default, created_at) VALUES ('sp-mg-2', 'mg2', FALSE, ${t}) ON CONFLICT DO NOTHING`;
  await db.sql`INSERT INTO cards (id, space_id, client_id, state, created_at, updated_at) VALUES ('cd-mg-55x', 'sp-mg-2', 'cl-b-55', 'new', ${t}, ${t})`;
  await pair('pr-mg-55', 'cl-a-55', 'cl-b-55');
  const p = await previewMerge(rop, 'pr-mg-55', choice());
  assert.deepEqual(p.conflicts, ['other_space']);
  assert.equal(detail(await failure(applyMerge(rop, 'pr-mg-55', { ...choice(), opId: uuid(), fingerprint: p.fingerprint }))), 'other_space');
});

test('только у проигравшего есть карточка в пространстве — она переходит выжившему целиком', async () => {
  const t = SEED_NOW;
  // выживший — клиент без карточки в пространстве: заводим его с карточкой в другом пространстве нельзя (other_space),
  // поэтому берём нового клиента только с номером
  await db.sql`INSERT INTO clients (id, kind, name, name_norm, source_kind, created_at, updated_at)
               VALUES ('cl-mg-56', 'company', 'ТОО Пример 56', 'пример 56', 'manual', ${t}, ${t})`;
  await pair('pr-mg-56', 'cl-b-56', 'cl-mg-56');
  // пара видна по карточке cl-b-56; остаётся сторона Б (cl-mg-56), карточка А переходит к нему
  const p = await previewMerge(rop, 'pr-mg-56', choice({ survivor: 'b' }));
  assert.deepEqual(p.conflicts, []);
  await applyMerge(rop, 'pr-mg-56', { ...choice({ survivor: 'b' }), opId: uuid(), fingerprint: p.fingerprint });
  const [c] = await db.sql<{ client: string; hold: string; owner: string }>`SELECT client_id AS client, hold_reason AS hold, owner_user_id AS owner FROM cards WHERE id = 'cd-b-56'`;
  assert.deepEqual([c?.client, c?.hold, c?.owner], ['cl-mg-56', '', U.opB]);
});

test('без флага и без права — раздела нет (404)', async () => {
  await pair('pr-mg-57', 'cl-a-57', 'cl-b-57');
  assert.ok((await failure(previewMerge(opA, 'pr-mg-57', choice()))) instanceof NotFoundError);
  assert.ok((await failure(previewMerge(rop, 'pr-mg-zz', choice()))) instanceof NotFoundError);
  process.env.FEATURE_MERGE = '0';
  try {
    assert.ok((await failure(previewMerge(rop, 'pr-mg-57', choice()))) instanceof NotFoundError);
    assert.ok((await failure(applyMerge(rop, 'pr-mg-57', { ...choice(), opId: uuid(), fingerprint: '0'.repeat(64) }))) instanceof NotFoundError);
  } finally {
    process.env.FEATURE_MERGE = '1';
  }
});
