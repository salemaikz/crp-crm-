// Подключения интеграций для администратора (дизайн docs/reports-plugins-design.md §7.5, §8.3, D-270).
// Ответы и аудит — без ключа, токена и адреса вебхука: токен не показывается никогда, подписку делает сервер.
// Провайдеру до отметки решения о передаче ПДн за рубеж уходит только ключ (проверка каналов).
import { createHash, randomBytes } from 'node:crypto';
import type { AnyPlugin, Ctx, MessengerPlugin, PluginUsability } from '@/integrations/contract';
import type { Viewer } from '@/server/access';
import { writeAudit } from '@/server/platform/audit';
import { getDb, newId, type Sql } from '@/server/platform/db';
import { describeIntegrationSecrets, isSecretError, putIntegrationSecret } from '@/server/platform/secrets';
import { upsertChannels } from '../messenger/repo';
import { buildCtx, IntegrationConfigError } from './ctx';
import {
  activeStaff,
  channelsOf,
  clearWebhookTokenIf,
  defaultSpaceId,
  enableIfToken,
  getIntegrationRow,
  insertIntegration,
  isActiveMember,
  listIntegrationsOf,
  lockPluginConnections,
  patchChannelRow,
  resetIntegration,
  setCrossborder,
  setStatus,
  setWebhookToken,
  switchOff,
  type ChannelView,
} from './repo';
import { gateFor, usabilityOf } from './service';
import type { IntegrationDeps, IntegrationRow } from './types';

/** Ошибка администрирования: код и HTTP-статус; текста нет (его строит интерфейс). */
export class IntegrationAdminError extends Error {
  override name = 'IntegrationAdminError';
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const nowOf = (deps: IntegrationDeps): number => (deps.now ?? Date.now)();
const newToken = (): string => randomBytes(32).toString('base64url');

/** Аудит действия администратора: коды, id и числа — без ключа, токена, адреса вебхука и ссылок. */
async function audit(sql: Sql, viewer: Viewer, deps: IntegrationDeps, action: 'integration.connect' | 'integration.crossborder' | 'integration.enable' | 'integration.disable' | 'integration.revoke_webhook' | 'integration.channel', id: string, meta: Record<string, unknown>): Promise<void> {
  await writeAudit(sql, { actorId: viewer.userId, action, entity: 'integration', entityId: id, spaceId: viewer.spaceId, meta, createdAt: nowOf(deps) });
}

export interface ConnectionView {
  id: string;
  enabled: boolean;
  status: string;
  lastEventAt: number | null;
  crossborderApprovedAt: number | null;
  secrets: { name: string; last4: string }[];
  channels: ChannelView[];
  usability: PluginUsability;
}

export interface PluginView {
  pluginId: string;
  kind: string;
  flagOn: boolean;
  licensed: boolean;
  crossBorder: boolean;
  needsConnection: boolean;
  usability: PluginUsability;
  connection: ConnectionView | null;
}

/** Плагин, который можно подключить ключом: мессенджер с подключением, каналами и подпиской на вебхук. */
function connectableOrNull(deps: IntegrationDeps, pluginId: string): MessengerPlugin | null {
  const p: AnyPlugin | undefined = deps.registry.all().find((x) => x.id === pluginId);
  return p && p.kind === 'messenger' && p.needsConnection && p.listChannels && p.subscribe ? p : null;
}

function connectable(deps: IntegrationDeps, pluginId: string): MessengerPlugin {
  const p = connectableOrNull(deps, pluginId);
  if (!p) throw new IntegrationAdminError('not_found', 404);
  return p;
}

/** Флаг выключен — как несуществующий (404); нет признака в лицензии — 403. */
async function requireAllowed(deps: IntegrationDeps, plugin: AnyPlugin): Promise<void> {
  const gate = await gateFor(deps, plugin, null, { ignoreEnabled: true });
  if (!gate.flagOn) throw new IntegrationAdminError('not_found', 404);
  if (!gate.licensed) throw new IntegrationAdminError('not_licensed', 403);
}

async function loadRow(sql: Sql, deps: IntegrationDeps, id: string): Promise<{ row: IntegrationRow; plugin: MessengerPlugin }> {
  const row = await getIntegrationRow(sql, id);
  if (!row) throw new IntegrationAdminError('not_found', 404);
  const plugin = connectable(deps, row.pluginId);
  await requireAllowed(deps, plugin);
  return { row, plugin };
}

function ctxOf(deps: IntegrationDeps, plugin: AnyPlugin, row: IntegrationRow): Ctx<unknown, unknown> {
  try {
    return buildCtx(deps, plugin, row);
  } catch (e) {
    if (e instanceof IntegrationConfigError) throw new IntegrationAdminError('invalid_settings', 409);
    throw e;
  }
}

const spaceOf = async (sql: Sql, row: IntegrationRow): Promise<string> => {
  const id = row.spaceId ?? (await defaultSpaceId(sql));
  if (!id) throw new IntegrationAdminError('no_space', 409);
  return id;
};

/** Ошибка плагина или секретов → понятный код ответа; сеть и ключи наружу не уходят. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof IntegrationAdminError) throw e;
    if (isSecretError(e)) throw new IntegrationAdminError('no_secrets_key', 503);
    if (e instanceof IntegrationConfigError) throw new IntegrationAdminError('invalid_settings', 409);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

async function connectionView(deps: IntegrationDeps, sql: Sql, plugin: AnyPlugin, row: IntegrationRow): Promise<ConnectionView> {
  return {
    id: row.id,
    enabled: row.enabled,
    status: row.status,
    lastEventAt: row.lastEventAt,
    crossborderApprovedAt: row.crossborderApprovedAt,
    secrets: (await describeIntegrationSecrets(sql, row.id)).map((s) => ({ name: s.name, last4: s.last4 })),
    channels: await channelsOf(sql, row.id),
    usability: await usabilityOf(deps, plugin, row),
  };
}

/** Плагины с подключением и их состояние. Блоки с выключенным флагом интерфейс скрывает (`flagOn: false`). */
export async function listIntegrations(_viewer: Viewer, deps: IntegrationDeps): Promise<PluginView[]> {
  const sql = (await getDb()).sql;
  const out: PluginView[] = [];
  for (const plugin of deps.registry.all()) {
    if (!plugin.needsConnection) continue;
    const row = (await listIntegrationsOf(sql, plugin.id))[0] ?? null;
    const gate = await gateFor(deps, plugin, row);
    out.push({
      pluginId: plugin.id,
      kind: plugin.kind,
      flagOn: gate.flagOn,
      licensed: gate.licensed,
      crossBorder: plugin.crossBorder,
      needsConnection: plugin.needsConnection,
      usability: deps.usability(plugin, gate),
      connection: row && gate.flagOn ? await connectionView(deps, sql, plugin, row) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Подключить ключом
// ---------------------------------------------------------------------------

export interface ConnectResult {
  id: string;
  status: string;
  channels: number;
}

/**
 * Ключ → подключение (выключено) + зашифрованный секрет; вне транзакции — проверка у провайдера и каналы.
 * Одно подключение на плагин: транзакция под блокировкой плагина, параллельный вызов ждёт и находит строку (D-298).
 * Повторный вызов с другим ключом меняет секрет, выключает подключение и все его каналы (аккаунт мог смениться).
 */
export async function connectIntegration(viewer: Viewer, deps: IntegrationDeps, input: { pluginId: string; apiKey: string }): Promise<ConnectResult> {
  const plugin = connectable(deps, input.pluginId);
  await requireAllowed(deps, plugin);
  const db = await getDb();
  const now = nowOf(deps);
  const id = await guarded(() =>
    db.tx(async (tx) => {
      await lockPluginConnections(tx, plugin.id);
      const existing = (await listIntegrationsOf(tx, plugin.id))[0];
      const spaceId = await defaultSpaceId(tx);
      const id = existing?.id ?? newId();
      if (existing) await resetIntegration(tx, id, now);
      else await insertIntegration(tx, { id, pluginId: plugin.id, spaceId, now });
      await putIntegrationSecret(tx, { integrationId: id, name: 'apiKey', plaintext: input.apiKey, now });
      return id;
    }),
  );
  const { status, channels } = await guarded(() => refreshFromProvider(deps, db.sql, id));
  await audit(db.sql, viewer, deps, 'integration.connect', id, { pluginId: plugin.id, status, channels });
  return { id, status, channels };
}

/** Проверка ключа и список каналов компании у провайдера → статус подключения и таблица каналов. */
async function refreshFromProvider(deps: IntegrationDeps, sql: Sql, id: string): Promise<{ status: string; channels: number }> {
  const { row, plugin } = await loadRow(sql, deps, id);
  const ctx = ctxOf(deps, plugin, row);
  const now = nowOf(deps);
  const health = await plugin.healthCheck(ctx);
  let channels = 0;
  if (health.code === 'ok' || health.code === 'no_channels') {
    const list = await plugin.listChannels!(ctx);
    // Новые каналы приходят выключенными (D-298): администратор видит их на этом же экране и включает сам
    if (list.ok) channels = (await upsertChannels(sql, { integrationId: id, spaceId: await spaceOf(sql, row), channels: list.channels, now })).total;
  }
  await setStatus(sql, id, health.code, now);
  return { status: health.code, channels };
}

export async function checkIntegration(_viewer: Viewer, deps: IntegrationDeps, id: string): Promise<ConnectResult> {
  const sql = (await getDb()).sql;
  return guarded(async () => {
    const { status, channels } = await refreshFromProvider(deps, sql, id);
    return { id, status, channels };
  });
}

// ---------------------------------------------------------------------------
// Решение о передаче за рубеж, включение, выключение, адрес вебхука
// ---------------------------------------------------------------------------

export async function setIntegrationCrossborder(viewer: Viewer, deps: IntegrationDeps, id: string, input: { approved: boolean; decisionDate: string }): Promise<{ id: string; approved: boolean }> {
  const sql = (await getDb()).sql;
  const { plugin } = await loadRow(sql, deps, id);
  const approved = input.approved;
  const now = nowOf(deps);
  await setCrossborder(sql, { id, approvedAt: approved ? now : null, by: approved ? viewer.userId : null, now });
  await audit(sql, viewer, deps, 'integration.crossborder', id, { pluginId: plugin.id, approved, decisionDate: input.decisionDate });
  return { id, approved };
}

function hookUrl(ctx: Ctx<unknown, unknown>, pluginId: string, token: string): string {
  if (!ctx.appOrigin) throw new IntegrationAdminError('no_origin', 503);
  return `${ctx.appOrigin}/api/hooks/${pluginId}/${token}`;
}

/**
 * Включить: пригодность без учёта самого переключателя → новый адрес вебхука (в БД только sha256; сначала БД —
 * провайдер сразу присылает тест `{"test":true}`) → подписка → сотрудники → `enabled` только при своём токене
 * (D-298: «Выключить» или снятие отметки во время подписки сбрасывают токен — включение не состоится, 409
 * state_changed). Ошибка провайдера → 502, подключение остаётся выключенным, свой адрес сбрасывается.
 */
export async function enableIntegration(viewer: Viewer, deps: IntegrationDeps, id: string): Promise<{ id: string; enabled: true }> {
  const db = await getDb();
  return guarded(async () => {
    const { row, plugin } = await loadRow(db.sql, deps, id);
    const usable = await usabilityOf(deps, plugin, row, { ignoreEnabled: true });
    if (!usable.usable) throw new IntegrationAdminError(usable.reason, 409);
    const ctx = ctxOf(deps, plugin, row);
    const token = newToken();
    const tokenHash = sha256(token);
    const url = hookUrl(ctx, plugin.id, token);
    await setWebhookToken(db.sql, id, tokenHash, nowOf(deps));
    const failed = async (): Promise<never> => {
      await clearWebhookTokenIf(db.sql, { id, tokenHash, now: nowOf(deps) });
      throw new IntegrationAdminError('provider_error', 502);
    };
    const sub = await plugin.subscribe!(ctx, { webhookUrl: url });
    if (!sub.ok) return failed();
    if (plugin.syncUsers) {
      const sync = await plugin.syncUsers(ctx, await activeStaff(db.sql, { spaceId: await spaceOf(db.sql, row) }));
      if (!sync.ok) return failed();
    }
    if (!(await enableIfToken(db.sql, { id, tokenHash, now: nowOf(deps) }))) throw new IntegrationAdminError('state_changed', 409);
    await audit(db.sql, viewer, deps, 'integration.enable', id, { pluginId: plugin.id });
    return { id, enabled: true as const };
  });
}

/**
 * Выключить (мутация безопасности D-054: работает и в «только чтение»). Вебхуки перестают приниматься сразу: адрес
 * отзывается, при включении выдаётся новый.
 */
export async function disableIntegration(viewer: Viewer, deps: IntegrationDeps, id: string): Promise<{ id: string; enabled: false }> {
  const sql = (await getDb()).sql;
  const row = await getIntegrationRow(sql, id);
  if (!row) throw new IntegrationAdminError('not_found', 404);
  await switchOff(sql, id, nowOf(deps));
  await audit(sql, viewer, deps, 'integration.disable', id, { pluginId: row.pluginId });
  return { id, enabled: false };
}

/**
 * Перевыпустить адрес вебхука — мутация безопасности (D-054, D-298): старый адрес перестаёт работать в любом случае.
 * Переподписка — только у включённого подключения с флагом и лицензией; иначе (выключено, флаг, лицензия «только
 * чтение») или при любой ошибке переподписки адрес просто обнуляется, а подключение остаётся выключенным: новый
 * адрес выдаст следующее «Включить».
 */
export async function rotateIntegrationWebhook(viewer: Viewer, deps: IntegrationDeps, id: string): Promise<{ id: string }> {
  const db = await getDb();
  const row = await getIntegrationRow(db.sql, id);
  if (!row) throw new IntegrationAdminError('not_found', 404);
  const revoke = async (reason: string): Promise<void> => {
    await switchOff(db.sql, id, nowOf(deps));
    await audit(db.sql, viewer, deps, 'integration.revoke_webhook', id, { pluginId: row.pluginId, resubscribed: false, reason });
  };

  const plugin = connectableOrNull(deps, row.pluginId);
  const gate = plugin ? await gateFor(deps, plugin, null, { ignoreEnabled: true }) : null;
  const skip = !row.enabled ? 'disabled' : !plugin || !gate?.flagOn ? 'flag_off' : !gate.licensed ? 'not_licensed' : null;
  if (skip || !plugin) {
    await revoke(skip ?? 'flag_off');
    return { id };
  }

  const token = newToken();
  await setWebhookToken(db.sql, id, sha256(token), nowOf(deps));
  try {
    const ctx = ctxOf(deps, plugin, row);
    const sub = await guarded(() => plugin.subscribe!(ctx, { webhookUrl: hookUrl(ctx, plugin.id, token) }));
    if (!sub.ok) throw new IntegrationAdminError('provider_error', 502);
  } catch (e) {
    await revoke(e instanceof IntegrationAdminError ? e.code : 'error');
    throw e;
  }
  await audit(db.sql, viewer, deps, 'integration.revoke_webhook', id, { pluginId: plugin.id, resubscribed: true });
  return { id };
}

// ---------------------------------------------------------------------------
// Каналы
// ---------------------------------------------------------------------------

/** Владелец канала — активный сотрудник пространства канала; `null` — общий канал; `isEnabled` — включить/выключить. */
export async function patchIntegrationChannel(
  viewer: Viewer,
  deps: IntegrationDeps,
  a: { integrationId: string; channelId: string; ownerUserId?: string | null; isEnabled?: boolean },
): Promise<ChannelView> {
  const sql = (await getDb()).sql;
  const channel = (await channelsOf(sql, a.integrationId)).find((c) => c.id === a.channelId);
  if (!channel) throw new IntegrationAdminError('not_found', 404);
  if (a.ownerUserId && !(await isActiveMember(sql, { spaceId: channel.spaceId, userId: a.ownerUserId }))) throw new IntegrationAdminError('bad_owner', 400);
  const updated = await patchChannelRow(sql, { integrationId: a.integrationId, channelId: a.channelId, ownerUserId: a.ownerUserId, isEnabled: a.isEnabled, now: nowOf(deps) });
  if (!updated) throw new IntegrationAdminError('not_found', 404);
  await audit(sql, viewer, deps, 'integration.channel', a.integrationId, { channelId: a.channelId, ownerSet: a.ownerUserId !== undefined ? a.ownerUserId !== null : null, isEnabled: a.isEnabled ?? null });
  return updated;
}
