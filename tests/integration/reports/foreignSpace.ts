// Второе пространство с данными для проверок «чужое не попадает в отчёты и выгрузку». Все id и тексты содержат
// метку FOREIGN_MARK, чтобы тест искал её подстрокой в каждом файле архива и в ответах отчётов. Только синтетика.
import type { Sql } from '../../../src/server/platform/db';
import { SEED_NOW, SEED_TODAY } from '../../isolation/harness/seed';

export const FOREIGN_SPACE = 'sp-foreign';
/** Метка в id и текстах чужого пространства. */
export const FOREIGN_MARK = 'ЧУЖОЕ-ПРОСТРАНСТВО';
export const FOREIGN_ID = 'zz-foreign';
export const FOREIGN_AMOUNT = 7_777_777;

export const FOREIGN_USERS = ['zz-foreign-u1', 'zz-foreign-u2'] as const;

/** Что вставлено: id по таблицам и тексты, которых не должно быть у владельца другого пространства. */
export interface ForeignWorld {
  ids: string[];
  texts: string[];
  phones: string[];
}

/** Вставить пространство `sp-foreign` со всем набором: сотрудники, клиенты, карточки, звонки, записи, сделки, лента. */
export async function seedForeignSpace(sql: Sql, n = 5): Promise<ForeignWorld> {
  const t = SEED_NOW - 86_400_000;
  const at = SEED_NOW - 3 * 3_600_000; // сегодня, внутри любого недельного периода
  const ids: string[] = [FOREIGN_SPACE];
  const texts: string[] = [];
  const phones: string[] = [];
  await sql`INSERT INTO spaces (id, key, is_default, created_at) VALUES (${FOREIGN_SPACE}, 'foreign', FALSE, ${t})`;
  await sql`INSERT INTO teams (id, space_id, key, lead_user_id, created_at) VALUES ('zz-foreign-team', ${FOREIGN_SPACE}, 'foreign-team', NULL, ${t})`;
  ids.push('zz-foreign-team');

  for (const [i, uid] of FOREIGN_USERS.entries()) {
    const name = `Сотрудник ${FOREIGN_MARK} ${i + 1}`;
    const phone = `7709800${String(i).padStart(4, '0')}`;
    await sql`INSERT INTO users (id, phone_digits, name, is_admin, status, created_at) VALUES (${uid}, ${phone}, ${name}, FALSE, 'active', ${t})`;
    await sql`INSERT INTO memberships (user_id, space_id, role_key, team_id, in_distribution, created_at, updated_at)
              VALUES (${uid}, ${FOREIGN_SPACE}, ${i === 0 ? 'operator' : 'rop'}, NULL, ${i === 0}, ${t}, ${t})`;
    ids.push(uid);
    texts.push(name);
    phones.push(phone);
  }
  const [op] = FOREIGN_USERS;

  await sql`INSERT INTO resources (id, space_id, user_id, slot_min, created_at, updated_at) VALUES ('zz-foreign-rs', ${FOREIGN_SPACE}, ${FOREIGN_USERS[1]}, 60, ${t}, ${t})`;
  await sql`INSERT INTO events (id, space_id, event_type_key, event_date, start_time, starts_at, duration_min, capacity, created_at, updated_at)
            VALUES ('zz-foreign-ev', ${FOREIGN_SPACE}, 'group', ${SEED_TODAY}, '15:00', ${at}, 180, 30, ${t}, ${t})`;
  ids.push('zz-foreign-rs', 'zz-foreign-ev');

  for (let i = 1; i <= n; i++) {
    const client = `zz-foreign-cl-${i}`;
    const card = `zz-foreign-cd-${i}`;
    const name = `ТОО ${FOREIGN_MARK} ${i}`;
    const phone = `7709500${String(i).padStart(4, '0')}`;
    await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
              VALUES (${client}, 'company', ${name}, ${name.toLowerCase()}, ${`${name.toLowerCase()} ${phone}`}, 'import', ${t}, ${t})`;
    await sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at) VALUES (${`zz-foreign-ph-${i}`}, ${client}, ${phone}, 'mobile', TRUE, ${t})`;
    await sql`INSERT INTO client_sources (id, client_id, source_kind, source_key, first_seen_at) VALUES (${`zz-foreign-src-${i}`}, ${client}, 'import', '', ${t})`;
    await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, assigned_at, created_at, updated_at)
              VALUES (${card}, ${FOREIGN_SPACE}, ${client}, ${op}, 'retry', ${t}, ${t}, ${t})`;
    const note = `Заметка ${FOREIGN_MARK} ${i}`;
    await sql`INSERT INTO notes (id, client_id, space_id, author_id, body, created_at) VALUES (${`zz-foreign-nt-${i}`}, ${client}, ${FOREIGN_SPACE}, ${op}, ${note}, ${at})`;
    await sql`INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at) VALUES (${`zz-foreign-ce-${i}`}, ${client}, ${FOREIGN_SPACE}, 'call', ${op}, ${at})`;
    // дозвон «договорились»: попадает в воронку и явку, если пространство не отсечено
    await sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, applied, occurred_at, received_at, config_rev)
              VALUES (${`zz-foreign-call-${i}`}, ${FOREIGN_SPACE}, ${card}, ${client}, ${op}, 'ui', ${phone}, 'agreed', 'agreed', 'applied', ${at}, ${at}, 1)`;
    await sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, assignee_user_id, created_at)
              VALUES (${`zz-foreign-tk-${i}`}, ${FOREIGN_SPACE}, ${client}, 'call', 'callback', ${`Перезвонить ${FOREIGN_MARK} ${i}`}, ${op}, ${t})`;
    await sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt, won_at,
                                 stage_changed_at, created_by, created_at, updated_at)
              VALUES (${`zz-foreign-dl-${i}`}, ${FOREIGN_SPACE}, 'sales', 'won', 'won', ${client}, ${card}, ${op}, 'consult', ${FOREIGN_AMOUNT}, ${at}, ${at}, ${op}, ${t}, ${t})`;
    await sql`INSERT INTO bookings (id, space_id, kind, event_type_key, resource_id, client_id, card_id, deal_id, booking_date, start_time, starts_at,
                                    duration_min, status, booked_by_user_id, responsible_user_id, created_at, updated_at)
              VALUES (${`zz-foreign-bk-${i}`}, ${FOREIGN_SPACE}, 'individual', 'consult', 'zz-foreign-rs', ${client}, ${card}, ${`zz-foreign-dl-${i}`}, ${SEED_TODAY}, '11:00', ${at},
                      60, 'attended', ${op}, ${op}, ${t}, ${t})`;
    await sql`INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, day, actor_id, created_at)
              VALUES (${`zz-foreign-al-${i}`}, ${FOREIGN_SPACE}, ${card}, NULL, ${op}, 'auto', TRUE, ${SEED_TODAY}, NULL, ${at})`;
    ids.push(client, card, `zz-foreign-ph-${i}`, `zz-foreign-nt-${i}`, `zz-foreign-ce-${i}`, `zz-foreign-call-${i}`, `zz-foreign-tk-${i}`, `zz-foreign-dl-${i}`, `zz-foreign-bk-${i}`, `zz-foreign-al-${i}`);
    texts.push(name, note, `Перезвонить ${FOREIGN_MARK} ${i}`);
    phones.push(phone);
  }
  // передача внутри чужого пространства
  await sql`INSERT INTO handoffs (id, space_id_from, space_id_to, team_id, deal_id, client_id, status, assignee_user_id, due_at, created_at)
            VALUES ('zz-foreign-ho', ${FOREIGN_SPACE}, ${FOREIGN_SPACE}, 'zz-foreign-team', 'zz-foreign-dl-1', 'zz-foreign-cl-1', 'pending', ${FOREIGN_USERS[1]}, ${t + 86_400_000}, ${t})`;
  ids.push('zz-foreign-ho');
  return { ids, texts, phones };
}

/** Набор настроек с чужим пространством: активные настройки требуют ревизию каждого пространства из таблицы spaces. */
export function withForeignSpace<T extends { global: Record<string, unknown>; spaces: Record<string, unknown> }>(cfg: T): T {
  const g = cfg.global as { spaces: Array<Record<string, unknown>> };
  g.spaces = [...g.spaces, { key: 'foreign', label: { ru: 'Чужое' }, enabled: true, default: false }];
  cfg.spaces.foreign = structuredClone(cfg.spaces.sales);
  return cfg;
}
