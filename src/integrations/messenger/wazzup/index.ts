// messenger.wazzup (INTEGRATIONS §3.2, D-026, D-270): WhatsApp через Wazzup — входящие в ленту, окно чата в
// карточке. За флагом FEATURE_WAZZUP, лицензионным признаком и отметкой решения о передаче ПДн за рубеж.
// Плагин не ходит в БД и не знает домен; HTTP — только через ctx.http (хост api.wazzup24.com).
import type { MessengerPlugin } from '../../contract';
import { createWazzupApi, toHealth } from './api';
import { parseWazzup } from './parse';
import { splitWazzup } from './split';
import { verifyWazzup } from './verify';
import { wazzupConfigSchema, wazzupSecretsSchema, type WazzupConfig, type WazzupSecrets } from './types';

/** Окно чата открывается только на домене Wazzup: ссылка из ответа проверяется перед отдачей клиенту. */
export function isWazzupFrameUrl(link: string): boolean {
  try {
    const u = new URL(link);
    return u.protocol === 'https:' && u.username === '' && u.password === '' && (u.hostname === 'wazzup24.com' || u.hostname.endsWith('.wazzup24.com'));
  } catch {
    return false;
  }
}

export const wazzupMessenger: MessengerPlugin<WazzupConfig, WazzupSecrets> = {
  id: 'messenger.wazzup',
  kind: 'messenger',
  version: 1,
  flag: 'WAZZUP',
  licenseFeature: 'messenger.wazzup',
  crossBorder: true,
  needsConnection: true,
  configSchema: wazzupConfigSchema,
  secretsSchema: wazzupSecretsSchema,
  capabilities: { chat: 'iframe', inbound: true, channels: true },

  async healthCheck(ctx) {
    const api = createWazzupApi(ctx.http, (await ctx.secrets()).apiKey);
    const r = await api.getChannels();
    if (!r.ok) return { ok: false, code: toHealth(r.code) };
    return r.data.length > 0 ? { ok: true, code: 'ok' } : { ok: false, code: 'no_channels' };
  },

  async listChannels(ctx) {
    const api = createWazzupApi(ctx.http, (await ctx.secrets()).apiKey);
    const r = await api.getChannels();
    return r.ok ? { ok: true, channels: r.data } : { ok: false, code: toHealth(r.code) };
  },

  async subscribe(ctx, input) {
    const api = createWazzupApi(ctx.http, (await ctx.secrets()).apiKey);
    const r = await api.patchWebhooks(input.webhookUrl);
    return r.ok ? { ok: true } : { ok: false, code: r.code };
  },

  async syncUsers(ctx, users) {
    if (users.length === 0) return { ok: true };
    const api = createWazzupApi(ctx.http, (await ctx.secrets()).apiKey);
    const r = await api.postUsers(users);
    return r.ok ? { ok: true } : { ok: false, code: toHealth(r.code) };
  },

  async openChat(ctx, input) {
    if (input.chat.chatType !== 'whatsapp' || input.chat.chatId === '') return { kind: 'error', code: 'rejected' };
    const api = createWazzupApi(ctx.http, (await ctx.secrets()).apiKey);
    const r = await api.postIframe({ user: input.user, chatType: input.chat.chatType, chatId: input.chat.chatId, channelId: input.channelRef });
    if (!r.ok) return { kind: 'error', code: r.code };
    return isWazzupFrameUrl(r.data.link) ? { kind: 'iframe', url: r.data.link } : { kind: 'error', code: 'rejected' };
  },

  webhook: {
    verify: (_ctx, req) => verifyWazzup(req),
    split: (_ctx, req) => splitWazzup(req),
    parse: (kind, payload) => parseWazzup(kind, payload),
  },
};
