// Полная выгрузка (R3b §2.5, D-055, D-264): пароль → одноразовый билет → потоковый ZIP. Неверный пароль — 403 без
// билета и журнала; билет одноразовый, 60 с, только свой; архив: manifest.json, таблицы, настройки; ни хэшей паролей,
// ни HMAC, ни секретов, ни скрытого поля (и в ленте тоже); уведомления директору, РОП и администраторам; журнал; лимит
// 3 в сутки; администратор без роли и оператор — 403; лицензия «только чтение» не мешает. Только синтетика (+7 709 …).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import * as fullRoute from '../../../src/app/api/export/full/route';
import * as ticketRoute from '../../../src/app/api/export/full/ticket/route';
import { fullExportRunning } from '../../../src/server/domain/reports/fullExport';
import { resetTicketsForTests } from '../../../src/server/domain/reports/tickets';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import { inflateEntry, newBudget, readZipDirectory } from '../../../src/server/platform/files/zip';
import { resetRateLimit } from '../../../src/server/platform/ratelimit';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { actAs, enterSeedWorld } from '../../isolation/harness/actors';
import { SEED_NOW, SPACE, U } from '../../isolation/harness/seed';
import { closeWorld, openWorld } from '../access/world';
import { WORLD_FIELDS, worldConfig } from '../clients/world';

let db: TestDb;
const PASSWORD = 'Синтетика-пароль-77';
const SECRET = 'Скрытое-значение-4242';
const VISIBLE = 'Видимый-сегмент-17';
const IIN_HMAC = 'ab'.repeat(32);
const ORIGIN = 'http://crm.test';

before(async () => {
  db = await openWorld();
  // поле vault скрыто от директора и РОП: его значения не должно быть ни в clients.csv, ни в ленте
  const cfg = worldConfig();
  (cfg.global as Record<string, unknown>).fields = [
    ...WORLD_FIELDS,
    {
      key: 'vault',
      object: 'client',
      type: 'text',
      label: { ru: 'Поле vault' },
      options: [],
      access: { director: 'hidden', rop: 'hidden', '*': 'read' },
      required: { always: false, onOutcome: [], onStage: [] },
      searchable: false,
      filterable: false,
      ingest: false,
      pii: 'none',
      showOn: { card: true, kanban: false, list: false },
    },
  ];
  resetConfigCache();
  await writeConfig({ docs: cfg, source: 'cli', authorId: null, project: true, note: 'полная выгрузка: мир тестов' });
  const hash = bcrypt.hashSync(PASSWORD, 4);
  await db.sql`UPDATE users SET password_hash = ${hash} WHERE id = ANY(${[U.director, U.rop, U.admin, U.opA]}::text[])`;
  await db.sql`UPDATE clients SET custom = ${db.json({ segment: VISIBLE, vault: SECRET })}, iin_hmac = ${IIN_HMAC} WHERE id = 'cl-b-1'`;
  await db.sql`INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, data) VALUES
               ('ev-vault', 'cl-b-1', ${SPACE}, 'field.changed', ${U.rop}, ${SEED_NOW - 1000}, ${db.json({ obj: 'client', sys: false, field: 'vault', before: null, after: SECRET })}),
               ('ev-seg', 'cl-b-1', ${SPACE}, 'field.changed', ${U.rop}, ${SEED_NOW - 900}, ${db.json({ obj: 'client', sys: false, field: 'segment', before: null, after: VISIBLE })})`;
  await db.sql`INSERT INTO notes (id, client_id, space_id, author_id, body, created_at) VALUES ('nt-1', 'cl-b-1', ${SPACE}, ${U.opB}, '=HYPERLINK("x")', ${SEED_NOW - 500})`;
});
after(async () => {
  resetTicketsForTests();
  resetConfigCache();
  await closeWorld(db);
});

async function ticket(as: string | null, password = PASSWORD): Promise<Response> {
  actAs(as);
  const req = new Request(`${ORIGIN}/api/export/full/ticket`, {
    method: 'POST',
    headers: { host: 'crm.test', origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return ticketRoute.POST(req, { params: Promise.resolve({}) });
}

async function download(as: string | null, t: string): Promise<Response> {
  actAs(as);
  const req = new Request(`${ORIGIN}/api/export/full`, {
    method: 'POST',
    headers: { host: 'crm.test', origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket: t }).toString(),
  });
  return fullRoute.POST(req, { params: Promise.resolve({}) });
}

async function idle(): Promise<void> {
  for (let i = 0; i < 100 && fullExportRunning(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fullExportRunning(), false, 'выгрузка не завершилась');
}

async function exportAs(as: string): Promise<{ res: Response; files: Map<string, string> }> {
  const tr = await ticket(as);
  assert.equal(tr.status, 200);
  const { ticket: t, expiresAt } = (await tr.json()) as { ticket: string; expiresAt: number };
  assert.equal(expiresAt, SEED_NOW + 60_000);
  const res = await download(as, t);
  assert.equal(res.status, 200);
  const buf = new Uint8Array(await res.arrayBuffer());
  await idle();
  const files = new Map<string, string>();
  const budget = newBudget(1 << 28);
  const dec = new TextDecoder('utf-8', { ignoreBOM: true }); // BOM оставляем: проверяем, что он есть
  for (const e of readZipDirectory(buf, { zipMaxEntries: 100, zipMaxCentralDirBytes: 1 << 20 })) files.set(e.name, dec.decode(inflateEntry(buf, e, 1 << 27, budget)));
  return { res, files };
}

const resetLimits = () => {
  for (const u of [U.director, U.rop, U.admin, U.opA]) resetRateLimit(`fullexport:pw:${u}`);
};

test('неверный пароль: 403 password_invalid, билета нет, журнал не пишется', async () => {
  resetLimits();
  const before = await db.sql`SELECT id FROM audit_log WHERE action LIKE 'export.%'`;
  const res = await ticket(U.director, 'неверный-пароль');
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'forbidden', detail: 'password_invalid' });
  assert.equal((await db.sql`SELECT id FROM audit_log WHERE action LIKE 'export.%'`).length, before.length);
});

test('архив директора: состав, настройки, манифест; без хэшей, HMAC, номеров сотрудников и скрытого поля', async () => {
  resetLimits();
  const { res, files } = await exportAs(U.director);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="crm-full-20261028-1100\.zip"$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const names = [...files.keys()];
  for (const n of ['manifest.json', 'config/global.json', 'config/space-sales.json', 'users.csv', 'clients.csv', 'contacts.csv', 'client_phones.csv', 'client_sources.csv', 'consents.csv', 'cards.csv', 'calls.csv', 'bookings.csv', 'events.csv', 'deals.csv', 'handoffs.csv', 'tasks.csv', 'task_comments.csv', 'notes.csv', 'timeline.csv']) {
    assert.ok(names.includes(n), `нет ${n}`);
  }
  assert.ok(!names.includes('messages.csv'), 'сообщений нет — файла нет');
  const manifest = JSON.parse(files.get('manifest.json')!) as { format: string; version: number; timeZone: string; space: string; tables: Record<string, number> };
  assert.equal(manifest.format, 'crm-full-export');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.timeZone, 'Asia/Almaty');
  assert.equal(manifest.space, 'sales');
  assert.equal(manifest.tables.clients, (await db.sql`SELECT id FROM clients`).length - (await db.sql`SELECT cl.id FROM clients cl WHERE NOT EXISTS (SELECT 1 FROM cards c WHERE c.client_id = cl.id AND c.space_id = ${SPACE})`).length);
  const clients = files.get('clients.csv')!;
  assert.ok(clients.startsWith('﻿id;kind;name;'), 'BOM и заголовок');
  assert.ok(clients.includes('ТОО Синтетика Бета 1'));
  assert.ok(clients.includes(VISIBLE), 'видимое поле есть');
  const all = [...files.values()].join('\n');
  assert.ok(!all.includes(SECRET), 'скрытое поле не выгружается — ни в клиентах, ни в ленте');
  assert.ok(!all.includes(IIN_HMAC), 'HMAC ИИН не выгружается');
  assert.ok(!/\$2[aby]\$/.test(all), 'хэшей паролей нет');
  // колонок с хэшами и служебными id нет (настройки упоминают правило kz_iin_hmac — это не данные)
  const csv = [...files].filter(([n]) => n.endsWith('.csv')).map(([, v]) => v).join('\n');
  for (const col of ['password_hash', 'iin_hmac', 'external_id', 'fields_patch', 'phone_digits;name']) assert.ok(!csv.includes(col), col);
  assert.ok(!all.includes('77099000'), 'номеров сотрудников нет');
  assert.ok(files.get('client_phones.csv')!.includes('7709100'), 'номера клиентов есть');
  assert.ok(files.get('timeline.csv')!.includes('ev-seg') && !files.get('timeline.csv')!.includes('ev-vault'));
  // формула в заметке обезврежена
  assert.ok(files.get('notes.csv')!.includes(`"'=HYPERLINK(""x"")"`));
  assert.match(files.get('config/global.json')!, /"area": "global"/);
});

test('журнал и уведомления: export.full до первого байта; директору, РОП и администратору — без ПДн', async () => {
  const rows = await db.sql<{ actorId: string; meta: Record<string, unknown> }>`SELECT actor_id, meta FROM audit_log WHERE action = 'export.full'`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actorId, U.director);
  assert.deepEqual(Object.keys(rows[0]!.meta).sort(), ['filterKeys', 'format', 'kind', 'periodDays', 'reportKey', 'rows']);
  assert.equal(rows[0]!.meta.format, 'zip');
  assert.ok((rows[0]!.meta.rows as number) > 200);
  const notes = await db.sql<{ userId: string; params: unknown }>`SELECT user_id, params FROM notifications WHERE kind = 'export_full_done' ORDER BY user_id`;
  assert.deepEqual(notes.map((n) => n.userId).sort(), [U.admin, U.director, U.rop].sort());
  for (const n of notes) assert.deepEqual(n.params, {});
});

test('билет одноразовый, только свой, живёт 60 с', async () => {
  resetLimits();
  resetTicketsForTests();
  const t1 = ((await (await ticket(U.rop)).json()) as { ticket: string }).ticket;
  // чужой: директор с билетом РОП — 404, и билет сгорел
  assert.equal((await download(U.director, t1)).status, 404);
  assert.equal((await download(U.rop, t1)).status, 404);
  const t2 = ((await (await ticket(U.rop)).json()) as { ticket: string }).ticket;
  enterSeedWorld({ now: SEED_NOW + 60_000 });
  try {
    assert.equal((await download(U.rop, t2)).status, 404, 'просрочен');
  } finally {
    enterSeedWorld();
  }
  assert.equal((await download(U.rop, 'zz-no-such-ticket')).status, 404);
  const empty = await download(U.rop, '');
  assert.equal(empty.status, 400);
  // повторное использование действующего: первый раз — архив, второй — 404
  const { res } = await exportAs(U.rop);
  assert.equal(res.status, 200);
});

test('права: администратор без роли и оператор — 403; гость — 401', async () => {
  resetLimits();
  assert.equal((await ticket(U.admin)).status, 403);
  assert.equal((await ticket(U.opA)).status, 403);
  assert.equal((await ticket(null)).status, 401);
  assert.equal((await download(U.admin, 'x'.repeat(43))).status, 403);
});

test('лицензия «только чтение»: полная выгрузка работает (D-054)', async () => {
  resetLimits();
  enterSeedWorld({ license: 'read_only' });
  try {
    const { files } = await exportAs(U.director);
    assert.ok(files.has('clients.csv'));
  } finally {
    enterSeedWorld();
  }
});

test('лимит: 3 полные выгрузки за местные сутки, четвёртая — 429 export_limit; попытки пароля — 429 rate_limited', async () => {
  resetLimits();
  // у директора уже две выгрузки сегодня (архив и «только чтение»): третья проходит, четвёртая — нет
  await exportAs(U.director);
  resetLimits();
  const over = await ticket(U.director);
  assert.equal(over.status, 429);
  assert.deepEqual(await over.json(), { error: 'rate_limited', detail: 'export_limit' });
  // выгрузка вчера в счёт не идёт: сутки — местные
  await db.sql`UPDATE audit_log SET created_at = ${SEED_NOW - 12 * 3_600_000} WHERE action = 'export.full' AND actor_id = ${U.director}`;
  assert.equal((await ticket(U.director)).status, 200);
  // пять попыток пароля за 15 минут, шестая — 429 с Retry-After
  resetLimits();
  for (let i = 0; i < 5; i++) assert.equal((await ticket(U.rop, 'неверный')).status, 403);
  const limited = await ticket(U.rop);
  assert.equal(limited.status, 429);
  assert.equal(((await limited.json()) as { detail: string }).detail, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('одна полная выгрузка одновременно: вторая — 429 busy; оборванное скачивание освобождает семафор', async () => {
  resetLimits();
  resetTicketsForTests();
  const t1 = ((await (await ticket(U.rop)).json()) as { ticket: string }).ticket;
  const t2 = ((await (await ticket(U.rop)).json()) as { ticket: string }).ticket;
  const first = await download(U.rop, t1);
  assert.equal(first.status, 200);
  assert.equal(fullExportRunning(), true);
  // пока идёт первая, новый билет не выдаётся, а второй билет получает 429 busy
  const busyTicket = await ticket(U.rop);
  assert.equal(busyTicket.status, 429);
  assert.equal(((await busyTicket.json()) as { detail: string }).detail, 'busy');
  const second = await download(U.rop, t2);
  assert.equal(second.status, 429);
  assert.deepEqual(await second.json(), { error: 'rate_limited', detail: 'busy' });
  // получатель закрыл соединение: запись прекращается, семафор свободен
  await first.body!.cancel();
  await idle();
  // билет, погашенный ответом busy, повторно не годится
  assert.equal((await download(U.rop, t2)).status, 404);
});
