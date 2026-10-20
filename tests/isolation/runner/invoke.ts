// Вызов маршрута, страницы и server action из манифеста в процессе теста — «от лица» сотрудника.
// Обёртки route/page/action работают как в бою (Viewer собирается из БД); next/headers и next-intl
// подменяет hooks.mjs. Страница вызывается как компонент Next и отрисовывается в HTML (react-dom/static).
import { createElement, type ComponentType, type Context, type ReactElement, type ReactNode } from 'react';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { AppUnit } from '../../helpers/appScan';
import type { ManifestEntry } from '../harness/manifest';
import { actAs } from '../harness/actors';
import { HTTP_STATUS } from '../../../src/server/access/errors';
import type { Reply } from './checks';
import { withRequestScope } from './shims/nextHeaders';

export const ORIGIN = 'http://crm.test';
const ROOT = join(import.meta.dirname, '..', '..', '..');

export type Call = {
  /** Сотрудник; null — без сессии. */
  userId: string | null;
  /** Значение параметра пути с id объекта (если у записи есть idParam). */
  id?: string;
};

type Mod = Record<string, unknown>;
const modules = new Map<string, Promise<Mod>>();
const load = (file: string): Promise<Mod> => {
  let m = modules.get(file);
  if (!m) modules.set(file, (m = import(pathToFileURL(join(ROOT, file)).href) as Promise<Mod>));
  return m;
};

/** Значения параметров пути: id объекта — в idParam, остальные динамические сегменты — 'x'. */
function paramsOf(entry: ManifestEntry, call: Call): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of entry.path.matchAll(/\[(?:\[)?(?:\.\.\.)?([A-Za-z0-9_]+)\]/g)) out[m[1] ?? ''] = 'x';
  if (entry.idParam && call.id !== undefined) out[entry.idParam.name] = call.id;
  return out;
}

/** Путь запроса: группы `(g)` убраны, параметры подставлены. */
export function urlOf(entry: ManifestEntry, params: Record<string, string>): string {
  const segs = entry.path
    .split('/')
    .filter((s) => s !== '' && !/^\(.*\)$/.test(s) && s !== 'layout')
    .map((s) => {
      const m = /^\[(?:\[)?(?:\.\.\.)?([A-Za-z0-9_]+)\]/.exec(s);
      return m ? encodeURIComponent(params[m[1] ?? ''] ?? 'x') : s;
    });
  return `/${segs.join('/')}`;
}

type Thrown = { digest?: unknown; message?: unknown };

/** Управляющие исключения Next (notFound, redirect, forbidden) → ответ. Иное — пробрасывается. */
function controlReply(e: unknown): Reply | null {
  const digest = (e as Thrown | null)?.digest;
  if (typeof digest !== 'string') return null;
  const fallback = /^NEXT_HTTP_ERROR_FALLBACK;(\d{3})$/.exec(digest);
  if (fallback) return { status: Number(fallback[1]), headers: {}, body: '' };
  if (digest === 'NEXT_NOT_FOUND') return { status: 404, headers: {}, body: '' };
  if (digest.startsWith('NEXT_REDIRECT;')) {
    const [, , url, status] = digest.split(';');
    return { status: Number(status) || 307, headers: {}, body: '', ...(url ? { location: url } : {}) };
  }
  return null;
}

const failReply = (e: unknown): Reply => ({ status: 500, headers: {}, body: `исключение: ${String((e as Thrown | null)?.message ?? e).slice(0, 300)}` });

async function toReply(res: Response): Promise<Reply> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const location = headers['location'];
  return { status: res.status, headers, body: await res.text(), ...(location ? { location } : {}) };
}

function requestOf(entry: ManifestEntry, url: string): Request {
  const mutating = entry.method !== 'GET';
  const headers: Record<string, string> = { host: 'crm.test' };
  if (mutating) {
    headers['origin'] = ORIGIN;
    if (entry.sampleBody !== undefined) headers['content-type'] = 'application/json';
  }
  return new Request(`${ORIGIN}${url}`, {
    method: entry.method,
    headers,
    ...(mutating && entry.sampleBody !== undefined ? { body: JSON.stringify(entry.sampleBody) } : {}),
  });
}

async function callRoute(unit: AppUnit, entry: ManifestEntry, call: Call): Promise<Reply> {
  const handler = (await load(unit.file))[unit.exportName] as (req: Request, ctx: { params: Promise<unknown> }) => Promise<Response>;
  const params = paramsOf(entry, call);
  const req = requestOf(entry, urlOf(entry, params));
  try {
    return await toReply(await withRequestScope({ headers: req.headers }, () => handler(req, { params: Promise.resolve(params) })));
  } catch (e) {
    return controlReply(e) ?? failReply(e);
  }
}

/** Обёртки Next, без которых клиентские компоненты не отрисуются вне приложения. */
async function providers(): Promise<(children: ReactNode) => ReactElement> {
  const { NextIntlClientProvider } = await import('next-intl');
  const { loadMessages } = await import('../../../src/i18n/request');
  const { DEFAULT_LOCALE, DEFAULT_TIME_ZONE } = await import('../../../src/i18n/config');
  const messages = await loadMessages(DEFAULT_LOCALE);
  const ctx = async (file: string) => (await import(`next/dist/shared/lib/${file}`).catch(() => ({}))) as Record<string, Context<unknown> | undefined>;
  const router = await ctx('app-router-context.shared-runtime');
  const hooks = await ctx('hooks-client-context.shared-runtime');
  const noop = () => undefined;
  const stub = { push: noop, replace: noop, back: noop, forward: noop, refresh: noop, prefetch: noop };
  return (children) => {
    let tree: ReactNode = createElement(NextIntlClientProvider as ComponentType<Record<string, unknown>>, { locale: DEFAULT_LOCALE, messages: messages as never, timeZone: DEFAULT_TIME_ZONE }, children);
    const wrap = (c: Context<unknown> | undefined, value: unknown) => {
      if (c) tree = createElement(c.Provider, { value }, tree);
    };
    wrap(router['AppRouterContext'], stub);
    wrap(hooks['PathnameContext'], '/');
    wrap(hooks['SearchParamsContext'], new URLSearchParams());
    return tree as ReactElement;
  };
}

async function renderHtml(element: ReactNode): Promise<string> {
  const { prerender } = await import('react-dom/static');
  const wrap = await providers();
  const { prelude } = await prerender(wrap(element));
  const reader = prelude.getReader();
  const dec = new TextDecoder();
  let html = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
  }
  return html;
}

async function callPage(unit: AppUnit, entry: ManifestEntry, call: Call): Promise<Reply> {
  const Component = (await load(unit.file))['default'] as (props: unknown) => Promise<ReactNode> | ReactNode;
  const params = paramsOf(entry, call);
  const props = { params: Promise.resolve(params), searchParams: Promise.resolve({}), ...(unit.layout ? { children: null } : {}) };
  const headers = { host: 'crm.test' };
  try {
    return await withRequestScope({ headers }, async () => {
      const element = await Component(props);
      const html = await renderHtml(element);
      return { status: 200, headers: { 'content-type': 'text/html' }, body: html };
    });
  } catch (e) {
    return controlReply(e) ?? failReply(e);
  }
}

/** Server action: первый аргумент — id объекта (если есть idParam), затем sampleBody. Итог → тот же вид, что у route. */
async function callAction(unit: AppUnit, entry: ManifestEntry, call: Call): Promise<Reply> {
  const fn = (await load(unit.file))[unit.exportName] as (...args: unknown[]) => Promise<unknown>;
  const args: unknown[] = [];
  if (entry.idParam && call.id !== undefined) args.push(call.id);
  if (entry.sampleBody !== undefined) args.push(entry.sampleBody);
  try {
    const result = await withRequestScope({ headers: { host: 'crm.test', origin: ORIGIN } }, () => fn(...args));
    const r = result as { ok?: boolean; error?: keyof typeof HTTP_STATUS } | null;
    const status = r && r.ok === false && r.error ? HTTP_STATUS[r.error] : 200;
    return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(result ?? null) };
  } catch (e) {
    return controlReply(e) ?? failReply(e);
  }
}

/** Вызвать единицу манифеста от лица сотрудника (или без сессии). */
export async function invoke(unit: AppUnit, entry: ManifestEntry, call: Call): Promise<Reply> {
  actAs(call.userId);
  if (unit.kind === 'route') return callRoute(unit, entry, call);
  if (unit.kind === 'page') return callPage(unit, entry, call);
  return callAction(unit, entry, call);
}
