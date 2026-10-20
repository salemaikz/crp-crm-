// «Предложить контакт» (docs/tasks-team-design.md §5.4, D-040, D-258). Оператор присылает номер и название;
// ответ всегда один — «принято», какой бы ни была причина (номер есть у другого клиента, в стоп-листе, лимит
// проверок исчерпан): иначе кнопка стала бы оракулом «номер есть в базе». Подробности видит только РОП.
import { fields, names, phone as phoneCore } from '@crm/core';
import { BadRequestError, NotFoundError, type Viewer } from '@/server/access';
import { resolveLead } from '@/server/domain/cards';
import { loadClientsConfig, type ClientsConfig } from '@/server/domain/clients/config';
import { getDb, newId, type Sql } from '@/server/platform/db';
import { getActiveConfig } from '@/server/platform/config/active';
import { phoneHmac } from '@/server/platform/hmac';
import * as repo from './repo';

export interface ProposeInput {
  opId: string;
  phone: string;
  name: string;
}

export interface ProposeResult {
  status: 'accepted';
}

/** Режим раздачи пространства зрителя: «авто» — `auto_even`/`top_up`; нет настроек — не авто (fail closed). */
async function autoMode(viewer: Viewer): Promise<boolean> {
  const cfg = await getActiveConfig();
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === viewer.spaceId);
  const mode = (space?.doc as { distribution?: { mode?: string } } | undefined)?.distribution?.mode;
  return mode === 'auto_even' || mode === 'top_up';
}

export interface NewProposalClient {
  spaceId: string;
  /** Автор событий ленты: предложивший. */
  actorId: string;
  now: number;
  name: string;
  digits: string;
  phoneKind: string;
  ext: string;
}

/**
 * Клиент, номер и карточка `new` без владельца в пространстве (источник `proposal`) + события ленты.
 * Вызывается внутри транзакции под блокировкой приёма: из `proposeContact` и из разбора РОП.
 */
export async function createProposalClient(sql: Sql, cfg: ClientsConfig, p: NewProposalClient): Promise<{ clientId: string; cardId: string }> {
  const clientId = newId();
  const cardId = newId();
  await repo.insertClient(sql, {
    id: clientId,
    kind: 'company',
    name: p.name,
    nameNorm: names.normalizeCompanyName(p.name, cfg.namesForms),
    legalForm: '',
    orgId: '',
    iinHmac: null,
    region: '',
    address: '',
    email: '',
    website: '',
    custom: {},
    searchNorm: fields.buildSearchNorm({ name: p.name, orgId: '', phones: [p.digits], custom: {}, searchable: cfg.searchable }),
    sourceKey: '',
    sourceKind: 'proposal',
    now: p.now,
  });
  await repo.addPhones(sql, clientId, [{ id: newId(), digits: p.digits, kind: p.phoneKind, ext: p.ext, isPrimary: true }], p.now);
  await repo.insertCard(sql, { id: cardId, spaceId: p.spaceId, clientId, holdReason: '', holdCode: '', now: p.now });
  const ev = (kind: string, data: Record<string, unknown>) =>
    repo.insertClientEventRow(sql, { id: newId(), clientId, spaceId: p.spaceId, kind, actorId: p.actorId, now: p.now, data });
  await ev('client.created', { sourceKind: 'proposal' });
  await ev('card.created', { sourceKey: '' });
  return { clientId, cardId };
}

/**
 * Предложение контакта. Порядок: общая блокировка приёма (D-022) → повтор opId → разбор номера (формат, а не
 * наличие в базе: плохой номер — 400 и проверку не тратит) → общий счётчик проверок (тот же, что у «добавить
 * номер», D-040) → создание клиента сразу или предложение на разбор РОП.
 */
export async function proposeContact(viewer: Viewer, input: ProposeInput): Promise<ProposeResult> {
  if (viewer.spaceId === null) throw new NotFoundError();
  const spaceId = viewer.spaceId;
  const cfg = await loadClientsConfig(viewer);
  const auto = await autoMode(viewer);
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (name.length === 0 || name.length > 200) throw new BadRequestError('invalid');
  const db = await getDb();
  return db.tx(async (sql: Sql): Promise<ProposeResult> => {
    await repo.lockIntake(sql);
    const prior = await repo.findProposal(sql, input.opId);
    if (prior) {
      if (prior.userId === viewer.userId) return { status: 'accepted' };
      throw new BadRequestError('op_id');
    }
    const parsed = phoneCore.parsePhone(input.phone, cfg.phoneRules);
    if (!parsed || !parsed.working || !parsed.digits) throw new BadRequestError('phone_invalid');
    const digits = parsed.digits;

    const used = await repo.countProbesOnDay(sql, viewer.userId, viewer.today);
    const stopped = await repo.phoneInStopList(sql, phoneHmac(digits));
    const matchedClientId = await repo.firstClientByPhone(sql, digits);
    const taken = matchedClientId !== null;
    await repo.insertProbeRow(sql, { id: newId(), userId: viewer.userId, day: viewer.today, path: 'proposal', matched: stopped || taken, now: viewer.now });

    const overLimit = used >= cfg.probesPerDay;
    if (!auto || overLimit || stopped || taken) {
      await repo.insertProposal(sql, { id: input.opId, spaceId, userId: viewer.userId, digits, name, status: 'review', matchedClientId, clientId: null, now: viewer.now });
      if (overLimit) {
        const lead = await resolveLead(sql, { spaceId, ownerUserId: null, at: viewer.now });
        if (lead) {
          await repo.insertNotificationRow(sql, {
            id: newId(),
            userId: lead,
            kind: 'probe_limit',
            params: { count: used + 1 },
            dedupeKey: `probe_limit:${viewer.userId}:${viewer.today}`,
            now: viewer.now,
          });
        }
      }
      return { status: 'accepted' };
    }
    const created = await createProposalClient(sql, cfg, { spaceId, actorId: viewer.userId, now: viewer.now, name, digits, phoneKind: parsed.kind, ext: parsed.ext });
    await repo.insertProposal(sql, { id: input.opId, spaceId, userId: viewer.userId, digits, name, status: 'created', matchedClientId: null, clientId: created.clientId, now: viewer.now });
    return { status: 'accepted' };
  });
}
