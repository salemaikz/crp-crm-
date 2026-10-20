'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Field, Input, Select, type BadgeTone } from '@/ui/kit';
import { call } from './api';
import type { Owner, PluginView } from './types';

const TONE: Record<string, BadgeTone> = { usable: 'success', disabled: 'neutral', crossborder_not_approved: 'warning', not_licensed: 'danger', flag_off: 'neutral' };
const today = (): string => new Date().toISOString().slice(0, 10);
const fmt = (ms: number, tz: string, time: boolean): string => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, dateStyle: 'short', ...(time ? { timeStyle: 'short' } : {}) }).format(new Date(ms));

/** Карточка Wazzup: ключ → решение о передаче за рубеж → каналы → включение. Шаги идут сверху вниз (D-270). */
export function WazzupCard({ plugin, owners, timeZone }: { plugin: PluginView; owners: Owner[]; timeZone: string }) {
  const t = useTranslations('integrations');
  const router = useRouter();
  const conn = plugin.connection;
  const [apiKey, setApiKey] = useState('');
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => ReturnType<typeof call>): Promise<void> {
    setBusy(true);
    setError(null);
    const r = await action();
    setBusy(false);
    if (!r.ok) return setError(r.key);
    router.refresh();
  }

  const connect = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await call('POST', '/api/integrations/connect', { pluginId: plugin.pluginId, apiKey });
      if (r.ok) setApiKey('');
      return r;
    });
  };
  const key = conn?.secrets.find((s) => s.name === 'apiKey');
  const state = conn ? (conn.usability.usable ? 'usable' : conn.usability.reason) : 'disabled';
  const approved = conn?.crossborderApprovedAt != null;
  const canEnable = conn !== null && approved && !conn.enabled;

  return (
    <Card as="section" aria-labelledby="wazzup-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="wazzup-title" className="text-lg font-semibold">
          {t('plugins.messenger.wazzup')}
        </h2>
        {conn && <Badge tone={TONE[state] ?? 'neutral'}>{t(`state.${state}`)}</Badge>}
      </div>
      <p className="mt-1 text-sm text-[var(--text-2)]">{t('wazzup.recommendAccount')}</p>
      {error && (
        <Alert tone="danger" className="mt-3">
          {t(`wazzup.${error}`)}
        </Alert>
      )}

      <form onSubmit={connect} className="mt-4 flex flex-col gap-2">
        <Field label={t('wazzup.apiKey')} hint={key ? (key.last4 ? t('wazzup.keySet', { last4: key.last4 }) : t('wazzup.keySetNoTail')) : t('wazzup.apiKeyHint')}>
          <Input type="password" name="apiKey" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant={conn ? 'secondary' : 'primary'} disabled={busy || apiKey.trim().length < 8}>
            {conn ? t('wazzup.replaceKey') : t('wazzup.connect')}
          </Button>
          {conn && <Badge tone={conn.status === 'ok' ? 'success' : 'warning'}>{t(`health.${conn.status}`)}</Badge>}
          {conn && (
            <Button variant="quiet" disabled={busy} onClick={() => void run(() => call('POST', `/api/integrations/${conn.id}/health`))}>
              {t('wazzup.check')}
            </Button>
          )}
        </div>
      </form>

      {conn && (
        <>
          <section className="mt-5" aria-labelledby="wazzup-cb">
            <h3 id="wazzup-cb" className="font-semibold">
              {t('wazzup.crossborder.title')}
            </h3>
            <p className="text-sm text-[var(--text-2)]">{t('wazzup.crossborder.lead')}</p>
            {approved ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone="success">{t('wazzup.crossborder.approvedAt', { date: fmt(conn.crossborderApprovedAt as number, timeZone, false) })}</Badge>
                <Button variant="quiet" disabled={busy} onClick={() => void run(() => call('POST', `/api/integrations/${conn.id}/crossborder`, { approved: false, decisionDate: today() }))}>
                  {t('wazzup.crossborder.revoke')}
                </Button>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Field label={t('wazzup.crossborder.date')}>
                  <Input type="date" name="decisionDate" value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
                <Button variant="secondary" disabled={busy || date === ''} onClick={() => void run(() => call('POST', `/api/integrations/${conn.id}/crossborder`, { approved: true, decisionDate: date }))}>
                  {t('wazzup.crossborder.approve')}
                </Button>
              </div>
            )}
          </section>

          <section className="mt-5" aria-labelledby="wazzup-ch">
            <h3 id="wazzup-ch" className="font-semibold">
              {t('wazzup.channels')}
            </h3>
            {conn.channels.length === 0 ? (
              <p className="text-[var(--text-2)]">{t('wazzup.noChannels')}</p>
            ) : (
              <ul className="mt-2 flex flex-col divide-y divide-[var(--border)]">
                {conn.channels.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-end gap-3 py-2">
                    <span className="min-w-40">
                      <strong>{c.plainId ?? c.transport}</strong>
                      <br />
                      <span className="text-sm text-[var(--text-2)]">{t('wazzup.channelState', { state: c.state })}</span>
                    </span>
                    <Field label={t('wazzup.channelOwner')}>
                      <Select
                        name={`owner-${c.id}`}
                        value={c.ownerUserId ?? ''}
                        disabled={busy}
                        onChange={(e) => void run(() => call('PATCH', `/api/integrations/${conn.id}/channels/${c.id}`, { ownerUserId: e.target.value === '' ? null : e.target.value }))}
                      >
                        <option value="">{t('wazzup.ownerPool')}</option>
                        {owners.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Checkbox
                      name={`enabled-${c.id}`}
                      label={t('wazzup.channelEnabled')}
                      checked={c.isEnabled}
                      disabled={busy}
                      onChange={(e) => void run(() => call('PATCH', `/api/integrations/${conn.id}/channels/${c.id}`, { isEnabled: e.target.checked }))}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            {conn.enabled ? (
              <Button variant="secondary" disabled={busy} onClick={() => void run(() => call('POST', `/api/integrations/${conn.id}/disable`))}>
                {t('wazzup.disable')}
              </Button>
            ) : (
              <Button disabled={busy || !canEnable} onClick={() => void run(() => call('POST', `/api/integrations/${conn.id}/enable`))}>
                {t('wazzup.enable')}
              </Button>
            )}
            {conn.enabled && (
              <Button variant="quiet" disabled={busy} onClick={() => void run(() => call('POST', `/api/integrations/${conn.id}/rotate-webhook`))}>
                {t('wazzup.rotate')}
              </Button>
            )}
            <span className="text-sm text-[var(--text-2)]">
              {conn.lastEventAt ? t('wazzup.lastEvent', { date: fmt(conn.lastEventAt, timeZone, true) }) : t('wazzup.noEvents')}
            </span>
          </div>
        </>
      )}
    </Card>
  );
}
