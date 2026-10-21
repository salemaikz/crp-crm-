// Строки таблиц из плана: время, id и ссылки. Без обращений к БД — всё нужное приходит в BuildCtx.
import { fields, names, time } from '@crm/core';
import { DISTRICTS, MANUAL_TASK_TITLES, NOTE_BODIES } from './data';
import type { ClientPlan, OutcomeKind } from './plan';
import { uuidFor } from './rng';

const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface EventRef {
  id: string;
  date: string;
  startTime: string;
  startsAt: number;
  durationMin: number;
}

export interface ResourceDef {
  key: string;
  userKey: string;
  directions: string[];
  slotMin: number;
}

export interface BuildCtx {
  seed: string;
  tz: string;
  now: number;
  spaceId: string;
  /** Ключ сотрудника стенда → id в БД. */
  users: Record<string, string>;
  operatorKeys: string[];
  teams: Record<string, string>;
  configRev: number;
  /** Ключи причин по виду итога (без «Другое (текст)»). */
  reasons: Record<string, string[]>;
  fieldDefs: fields.FieldDef[];
  searchable: string[];
  legalForms: names.LegalForm[];
  pipelineKey: string;
  stageBooked: string;
  stageWon: string;
  serviceTypes: { key: string; routeToTeam: string | null }[];
  directions: string[];
  groupTypeKey: string;
  individualTypeKey: string;
  importProfile: string;
  seriesId: string;
  futureEvents: EventRef[];
  /** Прошедшие мероприятия, ближайшее прошедшее — первым. */
  pastEvents: EventRef[];
  resources: ResourceDef[];
  phoneHmac: (digits: string) => string;
}

export type Rows = Record<string, unknown>[];

export interface SeedRows {
  imports: Rows;
  clients: Rows;
  contacts: Rows;
  phones: Rows;
  clientSources: Rows;
  cards: Rows;
  calls: Rows;
  assignLog: Rows;
  clientEvents: Rows;
  stopList: Rows;
  notes: Rows;
  deals: Rows;
  bookings: Rows;
  bookingHistory: Rows;
  tasks: Rows;
  handoffs: Rows;
  duty: Rows;
}

const emptyRows = (): SeedRows => ({
  imports: [], clients: [], contacts: [], phones: [], clientSources: [], cards: [], calls: [], assignLog: [], clientEvents: [], stopList: [],
  notes: [], deals: [], bookings: [], bookingHistory: [], tasks: [], handoffs: [], duty: [],
});

const CONNECTED: ReadonlySet<OutcomeKind> = new Set(['callback', 'agreed', 'not_interested', 'not_target', 'do_not_call']);

const optionKeys = (defs: fields.FieldDef[], key: string): string[] => {
  const d = defs.find((f) => f.key === key && f.object === 'client');
  return d && Array.isArray(d.options) ? d.options.map((o) => o.key) : [];
};

/** Ближайшие рабочие дни после сегодняшнего (пн–пт), без учёта праздников: для записей на консультантов. */
function nextWorkdays(today: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 1; out.length < count; i++) {
    const d = time.addLocalDays(today, i);
    if (time.isoWeekday(d) <= 5) out.push(d);
  }
  return out;
}

export function buildRows(plans: readonly ClientPlan[], c: BuildCtx): SeedRows {
  const rows = emptyRows();
  const today = time.localDayOf(c.now, c.tz);
  const at = (day: string, hhmm: string): number => time.fromLocalTime(day, hhmm, c.tz);
  const hhmm = (h: number, m: number): string => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const dayAt = (daysAgo: number, h: number, m: number): number => at(time.addLocalDays(today, -daysAgo), hhmm(h, m));
  const id = (kind: string, key: string | number): string => uuidFor(c.seed, kind, key);
  const uid = (key: string): string => c.users[key] as string;
  const importedAt = dayAt(45, 12, 0);
  const importId = id('import', 'stand');
  const opKey = (p: ClientPlan): string | null => (p.owner === null ? null : (c.operatorKeys[p.owner] as string));

  const niches = optionKeys(c.fieldDefs, 'niche');
  const sizes = optionKeys(c.fieldDefs, 'company_size');
  const defOf = (key: string) => c.fieldDefs.some((f) => f.key === key && f.object === 'client');

  rows.imports.push({
    id: importId,
    space_id: c.spaceId,
    file_name: 'stand-demo.xlsx',
    file_sha256: uuidFor(c.seed, 'sha', 'import').replace(/-/g, '').repeat(2),
    profile_key: c.importProfile,
    // Форма ImportReportV1 (src/server/domain/import/types.ts): страница /import читает input и parse
    report: {
      v: 1,
      input: {
        kind: 'xlsx',
        encoding: null,
        bytes: 0,
        sheetIndex: 0,
        snapshotDay: time.localDayOf(importedAt, c.tz),
        parseConfigRev: { global: c.configRev, space: c.configRev },
        buildId: 'stand-seed',
      },
      parse: {
        headerRow: 1,
        rows: plans.length,
        skippedBlank: 0,
        unmappedHeaders: 0,
        truncatedCells: 0,
        droppedColumns: 0,
        formulaWithoutValue: 0,
        errorCells: 0,
        issues: {},
      },
    },
    created_at: importedAt,
  });

  const individualBookings: { plan: ClientPlan; cardId: string; clientId: string; dealId: string; callAt: number; grey: boolean }[] = [];
  let groupN = 0;
  const poolClients: string[] = [];

  for (const p of plans) {
    const clientId = id('client', p.index);
    const cardId = id('card', p.index);
    const created = importedAt + p.index * 1000;
    const ownerKey = opKey(p);
    const owner = ownerKey ? uid(ownerKey) : null;

    // --- клиент ---
    const custom: Record<string, string> = {};
    if (p.rand.withNiche && niches.length > 0) custom.niche = niches[p.rand.niche % niches.length] as string;
    if (defOf('company_size') && sizes.length > 0) custom.company_size = sizes[p.rand.size % sizes.length] as string;
    if (defOf('district')) custom.district = DISTRICTS[p.rand.district] as string;
    if (defOf('oked')) custom.oked = p.rand.oked;
    if (defOf('head_name') && p.clientKind === 'company') custom.head_name = p.headName;
    const digitsAll = p.phones.map((x) => x.digits);
    rows.clients.push({
      id: clientId,
      kind: p.clientKind,
      name: p.name,
      name_norm: p.clientKind === 'person' ? names.normalizePersonName(p.name) : names.normalizeCompanyName(p.name, c.legalForms),
      legal_form: p.legalForm,
      region: p.region,
      address: p.address,
      custom,
      search_norm: fields.buildSearchNorm({ name: p.name, orgId: '', phones: digitsAll, custom: custom as fields.CustomValues, searchable: c.searchable }),
      source_key: 'import',
      created_at: created,
    });
    rows.clientSources.push({ id: id('csrc', p.index), client_id: clientId, source_key: 'import', import_id: importId, first_seen_at: created });

    // --- контакты и номера ---
    const contactIds = p.contacts.map((ct, k) => {
      const cid = id('contact', `${p.index}-${k}`);
      rows.contacts.push({ id: cid, client_id: clientId, name: ct.name, position: ct.position, is_decision_maker: ct.decisionMaker, created_at: created });
      return cid;
    });
    p.phones.forEach((ph, k) => {
      rows.phones.push({
        id: id('phone', `${p.index}-${k}`),
        client_id: clientId,
        contact_id: ph.ofContact ? contactIds[0] : null,
        digits: ph.digits,
        is_working: ph.working,
        is_primary: ph.primary,
        has_whatsapp: ph.whatsapp,
        created_at: created,
      });
    });
    const primary = p.phones[0]?.digits ?? '';

    // --- звонки ---
    const calls = [...p.calls]
      .map((cl, k) => ({ cl, k, t: dayAt(cl.daysAgo, cl.hour, cl.minute) }))
      .sort((a, b) => a.t - b.t);
    const reasonFor = (kind: OutcomeKind): string => {
      const list = c.reasons[kind] ?? [];
      return list.length > 0 ? (list[p.reasonPick % list.length] as string) : '';
    };
    let callbackAt: number | null = null;
    if (p.nextCall) callbackAt = at(time.addLocalDays(today, p.nextCall.dayOffset), hhmm(p.nextCall.hour, p.nextCall.minute));
    const callIds: string[] = [];
    for (const { cl, k, t } of calls) {
      const callId = id('call', `${p.index}-${k}`);
      callIds.push(callId);
      const withReason = cl.kind === 'not_interested' || cl.kind === 'not_target' || cl.kind === 'do_not_call' || cl.kind === 'bad_number';
      rows.calls.push({
        id: callId,
        space_id: c.spaceId,
        card_id: cardId,
        client_id: clientId,
        user_id: owner,
        phone_digits: primary,
        outcome_code: cl.kind,
        outcome_kind: cl.kind,
        reason_code: withReason ? reasonFor(cl.kind) : '',
        lpr: cl.lpr,
        callback_at: cl.kind === 'callback' ? (p.kind === 'callback' ? callbackAt : t + DAY) : null,
        occurred_at: t,
        duration_sec: cl.durationSec,
        config_rev: c.configRev,
      });
      rows.clientEvents.push({
        id: id('cev', callId),
        client_id: clientId,
        space_id: c.spaceId,
        kind: 'call',
        actor_id: owner,
        at: t,
        ref_type: 'call',
        ref_id: callId,
        data: { outcome: cl.kind, kind: cl.kind, ...(cl.durationSec !== null ? { durationSec: cl.durationSec } : {}) },
      });
    }
    const last = calls[calls.length - 1];
    const lastKind = last?.cl.kind ?? '';
    const lastAt = last?.t ?? null;

    // --- карточка ---
    const state = p.kind === 'new_owned' || p.kind === 'new_pool' ? 'new' : p.kind;
    let attempts = 0;
    let nextCallAt: number | null = null;
    if (p.kind === 'retry' && last) {
      attempts = calls.length;
      const day = time.localDayOf(last.t, c.tz);
      const minutes = last.cl.hour * 60 + last.cl.minute + 120;
      // PROCESS 3.4: 1-й недозвон — через 2 часа в окне до 18:00, иначе 10:00 следующего дня; 2-й — 10:00 следующего дня
      nextCallAt = attempts === 1 && minutes < 18 * 60 ? last.t + 2 * HOUR : at(time.addLocalDays(day, 1), '10:00');
    } else if (p.kind === 'callback') nextCallAt = callbackAt;
    else if (p.kind === 'written_off' && p.closeReason === 'no_answer_limit') attempts = 3;
    const closed = ['not_interested', 'not_target', 'do_not_call', 'written_off'].includes(state);
    const closeReason = p.closeReason === 'reason' ? reasonFor(lastKind as OutcomeKind) : p.closeReason;
    const connects = calls.filter((x) => CONNECTED.has(x.cl.kind));
    const assignedAt = owner === null ? null : last ? at(time.addLocalDays(time.localDayOf(calls[0]?.t ?? c.now, c.tz), -1), '08:00') : at(today, '08:00');
    const lprLast = [...calls].reverse().find((x) => x.cl.lpr !== '')?.cl.lpr ?? '';
    rows.cards.push({
      id: cardId,
      space_id: c.spaceId,
      client_id: clientId,
      owner_user_id: owner,
      state,
      attempts,
      next_call_at: nextCallAt,
      return_at: p.kind === 'not_interested' && lastAt !== null ? lastAt + (p.returnAfterDays ?? 30) * DAY : null,
      lpr: lprLast,
      is_target: state === 'agreed' || state === 'client' ? 'yes' : state === 'not_target' ? 'no' : '',
      last_outcome_code: lastKind,
      last_outcome_kind: lastKind,
      last_outcome_at: lastAt,
      close_reason_code: closed ? closeReason : '',
      closed_at: closed ? lastAt : null,
      assigned_at: assignedAt,
      touched_in_crm: owner !== null,
      calls_total: calls.length,
      connects_total: connects.length,
      no_answer_total: calls.filter((x) => x.cl.kind === 'no_answer').length,
      first_connect_at: connects[0]?.t ?? null,
      last_connect_at: connects[connects.length - 1]?.t ?? null,
      last_touch_at: lastAt ?? assignedAt,
      created_at: created,
      updated_at: lastAt ?? assignedAt ?? created,
    });
    if (owner !== null && assignedAt !== null) {
      rows.assignLog.push({ id: id('assign', p.index), space_id: c.spaceId, card_id: cardId, to_user_id: owner, run_id: `seed:${c.seed}`, day: time.localDayOf(assignedAt, c.tz), created_at: assignedAt });
    } else poolClients.push(clientId);

    if (p.kind === 'do_not_call' && last) {
      rows.stopList.push({ phone_hmac: c.phoneHmac(primary), reason_code: closeReason, created_at: last.t });
    }

    // --- перезвон: задача-проекция (D-050) ---
    if (p.kind === 'callback' && nextCallAt !== null) {
      rows.tasks.push({
        id: id('task', `cb-${p.index}`),
        space_id: c.spaceId,
        client_id: clientId,
        deal_id: null,
        kind: 'call',
        source: 'callback',
        title: `Перезвонить: ${p.name}`,
        due_at: nextCallAt,
        assignee_user_id: owner,
        team_id: null,
        source_key: `callback:${callIds[callIds.length - 1]}`,
        created_at: lastAt ?? created,
      });
    }

    // --- заметки ---
    if ((p.kind === 'callback' && p.ordinal % 3 === 0) || (p.kind === 'agreed' && p.ordinal % 5 === 0)) {
      const noteId = id('note', p.index);
      const noteAt = (lastAt ?? created) + 5 * 60_000;
      rows.notes.push({ id: noteId, client_id: clientId, space_id: c.spaceId, author_id: owner, body: NOTE_BODIES[p.index % NOTE_BODIES.length], pinned: p.kind === 'agreed', created_at: noteAt });
      rows.clientEvents.push({ id: id('cev', noteId), client_id: clientId, space_id: c.spaceId, kind: 'note.created', actor_id: owner, at: noteAt, ref_type: 'note', ref_id: noteId, data: { noteId } });
    }

    // --- договорённость: запись, сделка или задача ---
    if (p.kind === 'agreed' && last && owner) {
      const dealId = id('deal', p.index);
      const bookingFor = (key: string): string => id('booking', `${key}-${p.index}`);
      const pushDeal = (stage: string, status: 'open' | 'won', wonAt: number | null, svc: string, amount: number, sc: number): void => {
        rows.deals.push({
          id: dealId,
          space_id: c.spaceId,
          pipeline_key: c.pipelineKey,
          stage_key: stage,
          status,
          client_id: clientId,
          card_id: cardId,
          owner_user_id: owner,
          service_type_key: svc,
          amount_kzt: amount,
          won_at: wonAt,
          stage_changed_at: sc,
          request_id: `seed:${c.seed}:deal:${p.index}`,
          created_at: last.t,
        });
      };
      if (p.agreement === 'group' && c.futureEvents.length > 0) {
        const ev = c.futureEvents[groupN++ % c.futureEvents.length] as EventRef;
        pushDeal(c.stageBooked, 'open', null, '', 0, last.t);
        const bid = bookingFor('g');
        rows.bookings.push({
          id: bid, space_id: c.spaceId, kind: 'group', event_type_key: c.groupTypeKey, event_id: ev.id, resource_id: null, client_id: clientId, card_id: cardId,
          deal_id: dealId, booking_date: ev.date, start_time: ev.startTime, starts_at: ev.startsAt, duration_min: ev.durationMin, direction_key: '',
          status: p.ordinal % 2 === 0 ? 'confirmed' : 'registered', user_id: owner, request_id: `seed:${c.seed}:booking:${p.index}`, created_at: last.t,
        });
        rows.bookingHistory.push({ id: id('bh', `${bid}-0`), booking_id: bid, action: 'created', from_status: '', to_status: 'registered', actor_id: owner, created_at: last.t });
      } else if (p.agreement === 'individual' || p.agreement === 'grey') {
        pushDeal(c.stageBooked, 'open', null, '', 0, last.t);
        individualBookings.push({ plan: p, cardId, clientId, dealId, callAt: last.t, grey: p.agreement === 'grey' });
      } else {
        // «Договорились» без записи: открытая задача владельцу со сроком (инвариант D-049)
        rows.tasks.push({
          id: id('task', `ag-${p.index}`), space_id: c.spaceId, client_id: clientId, deal_id: null, kind: 'call', source: 'agreement',
          title: `Созвониться по договорённости: ${p.name}`, due_at: at(time.addLocalDays(today, 2), '11:00'), assignee_user_id: owner, team_id: null,
          source_key: `agreement:${callIds[callIds.length - 1]}`, created_at: last.t,
        });
      }
    }

    // --- клиент с покупкой: явка на прошедший БР и выигранная сделка ---
    if (p.kind === 'client' && last && owner) {
      const ev = c.pastEvents[(p.pastEvent ?? 0) % Math.max(1, c.pastEvents.length)];
      if (ev) {
        const dealId = id('deal', p.index);
        const wonAt = ev.startsAt + 3 * HOUR;
        const svc = c.serviceTypes[p.ordinal % c.serviceTypes.length];
        pushWon(rows, c, { p, dealId, clientId, cardId, owner, ev, wonAt, svc: svc?.key ?? '', route: svc?.routeToTeam ?? null, bookedAt: last.t });
      }
    }

    // --- не интересует с неявкой на прошедший БР ---
    if (p.pastNoShow && last && owner) {
      const callDay = time.localDayOf(last.t, c.tz);
      const list = c.pastEvents.filter((e) => e.date < callDay);
      const ev = list[p.ordinal % Math.max(1, list.length)];
      if (ev) {
        const bid = id('booking', `ns-${p.index}`);
        rows.bookings.push({
          id: bid, space_id: c.spaceId, kind: 'group', event_type_key: c.groupTypeKey, event_id: ev.id, resource_id: null, client_id: clientId, card_id: cardId,
          deal_id: null, booking_date: ev.date, start_time: ev.startTime, starts_at: ev.startsAt, duration_min: ev.durationMin, direction_key: '',
          status: 'no_show', user_id: owner, request_id: `seed:${c.seed}:booking:ns:${p.index}`, created_at: ev.startsAt - 5 * DAY,
        });
        rows.bookingHistory.push(
          { id: id('bh', `${bid}-0`), booking_id: bid, action: 'created', from_status: '', to_status: 'registered', actor_id: owner, created_at: ev.startsAt - 5 * DAY },
          { id: id('bh', `${bid}-1`), booking_id: bid, action: 'status', from_status: 'registered', to_status: 'no_show', actor_id: null, created_at: ev.startsAt + 4 * HOUR },
        );
      }
    }
  }

  // --- индивидуальные записи: консультанты и «серые» (без консультанта) ---
  const days = nextWorkdays(today, 5);
  const slots = ['10:00', '10:45', '11:30', '14:00', '14:45'];
  individualBookings.forEach((b, j) => {
    const owner = uid(opKey(b.plan) as string);
    const bid = id('booking', `ind-${b.plan.index}`);
    const res = b.grey || c.resources.length === 0 ? null : (c.resources[j % c.resources.length] as ResourceDef);
    const k = Math.floor(j / Math.max(1, c.resources.length));
    const date = days[k % days.length] as string;
    const start = slots[Math.floor(k / days.length) % slots.length] as string;
    const direction = res ? (res.directions[0] ?? '') : (c.directions[j % Math.max(1, c.directions.length)] ?? '');
    rows.bookings.push({
      id: bid, space_id: c.spaceId, kind: 'individual', event_type_key: c.individualTypeKey, event_id: null,
      resource_id: res ? uuidFor(c.seed, 'resource', res.key) : null, client_id: b.clientId, card_id: b.cardId, deal_id: b.dealId, booking_date: date,
      start_time: start, starts_at: at(date, start), duration_min: res?.slotMin ?? 45, direction_key: direction, status: 'registered', user_id: owner,
      request_id: `seed:${c.seed}:booking:ind:${b.plan.index}`, created_at: b.callAt,
    });
    rows.bookingHistory.push({ id: id('bh', `${bid}-0`), booking_id: bid, action: 'created', from_status: '', to_status: 'registered', actor_id: owner, created_at: b.callAt });
    if (res === null) {
      rows.tasks.push({
        id: id('task', `grey-${b.plan.index}`), space_id: c.spaceId, client_id: b.clientId, deal_id: b.dealId, kind: 'check', source: 'grey_unassigned',
        title: 'Назначить консультанта на запись', due_at: at(today, '17:00'), assignee_user_id: uid('rop'), team_id: null, source_key: `grey:${bid}`, created_at: b.callAt,
      });
    }
  });

  // --- ручные задачи РОПа (на клиентах из пула) ---
  MANUAL_TASK_TITLES.forEach((title, k) => {
    const clientId = poolClients[k];
    if (!clientId) return;
    rows.tasks.push({
      id: id('task', `manual-${k}`), space_id: c.spaceId, client_id: clientId, deal_id: null, kind: 'check', source: 'manual', title,
      due_at: at(time.addLocalDays(today, k % 2), '16:00'), assignee_user_id: uid('rop'), team_id: null, source_key: null, created_at: dayAt(1, 18, 0),
    });
  });

  // --- дежурный на два ближайших мероприятия ---
  for (const ev of c.futureEvents.slice(0, 2)) rows.duty.push({ event_id: ev.id, user_id: uid('duty'), created_at: c.now });

  return rows;
}

/** Явка на прошедший БР, выигранная сделка и (если услугу ведёт команда) передача в отдел. */
function pushWon(
  rows: SeedRows,
  c: BuildCtx,
  a: { p: ClientPlan; dealId: string; clientId: string; cardId: string; owner: string; ev: EventRef; wonAt: number; svc: string; route: string | null; bookedAt: number },
): void {
  const { p, dealId, clientId, cardId, owner, ev, wonAt, svc, route } = a;
  const id = (kind: string, key: string | number): string => uuidFor(c.seed, kind, key);
  const amount = [90_000, 150_000, 250_000, 400_000][p.ordinal % 4] as number;
  rows.deals.push({
    id: dealId, space_id: c.spaceId, pipeline_key: c.pipelineKey, stage_key: c.stageWon, status: 'won', client_id: clientId, card_id: cardId, owner_user_id: owner,
    service_type_key: svc, amount_kzt: amount, won_at: wonAt, stage_changed_at: wonAt, request_id: `seed:${c.seed}:deal:${p.index}`, created_at: a.bookedAt,
  });
  const bid = id('booking', `att-${p.index}`);
  rows.bookings.push({
    id: bid, space_id: c.spaceId, kind: 'group', event_type_key: c.groupTypeKey, event_id: ev.id, resource_id: null, client_id: clientId, card_id: cardId,
    deal_id: dealId, booking_date: ev.date, start_time: ev.startTime, starts_at: ev.startsAt, duration_min: ev.durationMin, direction_key: '',
    status: 'attended', user_id: owner, request_id: `seed:${c.seed}:booking:att:${p.index}`, created_at: a.bookedAt,
  });
  rows.bookingHistory.push(
    { id: id('bh', `${bid}-0`), booking_id: bid, action: 'created', from_status: '', to_status: 'registered', actor_id: owner, created_at: a.bookedAt },
    { id: id('bh', `${bid}-1`), booking_id: bid, action: 'status', from_status: 'registered', to_status: 'attended', actor_id: owner, created_at: ev.startsAt + 3 * HOUR },
  );
  const teamId = route ? c.teams[route] : undefined;
  if (route && teamId) {
    const accepted = p.ordinal % 2 === 1;
    const head = c.users.marketing_head as string;
    rows.handoffs.push({
      id: id('handoff', p.index), space_id: c.spaceId, team_id: teamId, deal_id: dealId, client_id: clientId, status: accepted ? 'accepted' : 'pending',
      assignee_user_id: accepted ? head : null, due_at: wonAt + DAY, accepted_at: accepted ? wonAt + 2 * HOUR : null, accepted_by: accepted ? head : null, created_at: wonAt,
    });
    if (!accepted) {
      rows.tasks.push({
        id: id('task', `ho-${p.index}`), space_id: c.spaceId, client_id: clientId, deal_id: dealId, kind: 'handoff', source: 'handoff',
        title: `Принять передачу: ${p.name}`, due_at: wonAt + DAY, assignee_user_id: null, team_id: teamId, source_key: `handoff:${dealId}`, created_at: wonAt,
      });
    }
  }
}
