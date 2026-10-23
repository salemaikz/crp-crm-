// Запрос отчёта у API. Параметры — те же, что в адресе страницы.
import type { ReportData, ReportQueryState } from './types';

export type LoadFailure = 'forbidden' | 'unauthorized' | 'network' | 'generic' | 'period_invalid' | 'invalid';

/** Строка запроса отчёта (без `r`): только значимые для вида отчёта параметры. */
export function queryString(q: ReportQueryState): URLSearchParams {
  const sp = new URLSearchParams({ from: q.from, to: q.to });
  if (q.users.length > 0) sp.set('users', q.users.join(','));
  if (q.source !== '') sp.set('source', q.source);
  if (q.key === 'operators') sp.set('group', q.group);
  if (q.key === 'funnel') sp.set('by', q.funnelBy);
  if (q.key === 'attendance' && q.attendanceView === 'list') {
    sp.set('view', 'list');
    if (q.listEventType !== '') sp.set('eventType', q.listEventType);
    if (q.listStatus !== '') sp.set('status', q.listStatus);
    if (q.listConsultant !== '') sp.set('consultant', q.listConsultant);
  } else if (q.key === 'attendance') sp.set('by', q.attendanceBy);
  return sp;
}

/** `cursor` — следующая страница списка явки. */
export async function loadReport(q: ReportQueryState, cursor?: string): Promise<{ ok: true; data: ReportData } | { ok: false; key: LoadFailure }> {
  try {
    const sp = queryString(q);
    if (cursor) sp.set('cursor', cursor);
    const res = await fetch(`/api/reports/${q.key}?${sp.toString()}`, { cache: 'no-store' });
    if (res.status === 401) {
      window.location.replace('/login?next=/reports');
      return { ok: false, key: 'unauthorized' };
    }
    if (res.status === 403) return { ok: false, key: 'forbidden' };
    if (res.status === 400) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string };
      return { ok: false, key: body.detail === 'period_invalid' ? 'period_invalid' : 'invalid' };
    }
    if (!res.ok) return { ok: false, key: 'generic' };
    return { ok: true, data: (await res.json()) as ReportData };
  } catch {
    return { ok: false, key: 'network' };
  }
}
