'use client';

import { CircleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Field, Modal, Select } from '@/ui/kit';
import { call } from './api';
import type { MergePreview, PairRow } from './types';

type Survivor = 'a' | 'b';
type OwnerPick = 'auto' | 'a' | 'b';

/** Выбор «чей владелец» в терминах сторон → параметр API в терминах выжившего. */
const ownerParam = (survivor: Survivor, owner: OwnerPick): 'auto' | 'survivor' | 'other' => (owner === 'auto' ? 'auto' : owner === survivor ? 'survivor' : 'other');

/**
 * «Объединить…» (B9b, D-257): кто остаётся, чей владелец, предпросмотр — итог карточки, что переедет, заполняемые
 * поля и конфликты красным текстом со значком. «Объединить» активна только без конфликтов и с актуальным предпросмотром;
 * отпечаток уходит с запросом, устаревший даёт 409 `changed` и предпросмотр перечитывается.
 */
export function MergeDialog({ pair, onClose, onDone }: { pair: PairRow; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('pairs');
  const tm = useTranslations('pairs.merge');
  const te = useTranslations('pairs.errors');
  const tc = useTranslations('clients.states');
  const [survivor, setSurvivor] = useState<Survivor>('a');
  const [owner, setOwner] = useState<OwnerPick>('auto');
  const [tick, setTick] = useState(0);
  const key = `${survivor}|${owner}|${tick}`;
  const [loaded, setLoaded] = useState<{ key: string; preview: MergePreview | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const opId = useRef(crypto.randomUUID());

  useEffect(() => {
    let alive = true;
    const q = `survivor=${survivor}&owner=${ownerParam(survivor, owner)}`;
    void call<MergePreview>('GET', `/api/distribution/pairs/${encodeURIComponent(pair.id)}/merge-preview?${q}`).then((r) => {
      if (alive) setLoaded({ key, preview: r.ok ? r.data : null, error: r.ok ? null : r.key });
    });
    return () => {
      alive = false;
    };
  }, [pair.id, survivor, owner, key]);

  const current = loaded?.key === key ? loaded : null;
  const preview = current?.preview ?? null;
  const error = actionError ?? current?.error ?? null;
  const ready = preview !== null && preview.conflicts.length === 0 && !busy;

  async function submit() {
    if (!ready || !preview) return;
    setBusy(true);
    setActionError(null);
    const r = await call<{ survivorClientId: string }>('POST', `/api/distribution/pairs/${encodeURIComponent(pair.id)}/merge`, {
      opId: opId.current,
      survivor,
      owner: ownerParam(survivor, owner),
      fingerprint: preview.fingerprint,
    });
    setBusy(false);
    if (!r.ok) {
      // сеть — тот же opId (повтор безопасен); отказ сервера — новая операция и свежий предпросмотр
      if (r.key !== 'network') {
        opId.current = crypto.randomUUID();
        setTick((n) => n + 1);
      }
      return setActionError(r.key);
    }
    onDone();
  }

  const name = (s: Survivor) => (s === 'a' ? pair.a?.name : pair.b?.name) ?? '';
  const moves = preview ? Object.entries(preview.moves).filter(([, n]) => (n ?? 0) > 0) : [];

  return (
    <Modal open onClose={onClose} title={tm('title')} closeLabel={tm('cancel')}>
      <div className="flex flex-col gap-3">
        <Field label={tm('survivor')}>
          <Select name="merge-survivor" value={survivor} onChange={(e) => setSurvivor(e.target.value as Survivor)}>
            <option value="a">
              {t('side.a')}: {name('a')}
            </option>
            <option value="b">
              {t('side.b')}: {name('b')}
            </option>
          </Select>
        </Field>
        <Field label={tm('ownerLabel')}>
          <Select name="merge-owner" value={owner} onChange={(e) => setOwner(e.target.value as OwnerPick)}>
            <option value="auto">{tm('owner.auto')}</option>
            <option value="a">{tm('owner.a')}</option>
            <option value="b">{tm('owner.b')}</option>
          </Select>
        </Field>
        <section aria-live="polite" aria-label={tm('moves')} className="flex flex-col gap-2 text-sm">
          {current === null && <p>{tm('loading')}</p>}
          {preview?.result && (
            <p className="font-semibold">
              {preview.result.ownerName
                ? tm('result', { state: tc(preview.result.state as 'new'), owner: preview.result.ownerName })
                : tm('resultNoOwner', { state: tc(preview.result.state as 'new') })}
            </p>
          )}
          {preview && (
            <>
              <h3 className="font-semibold">{tm('moves')}</h3>
              {moves.length === 0 ? (
                <p>{tm('noMoves')}</p>
              ) : (
                <table className="w-full">
                  <tbody>
                    {moves.map(([table, n]) => (
                      <tr key={table}>
                        <td>{tm(`tables.${table}` as 'tables.calls')}</td>
                        <td className="text-right tabular-nums">{n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {preview.phones.duplicates > 0 && <p>{tm('duplicates', { count: preview.phones.duplicates })}</p>}
              {preview.fills.length > 0 && <p>{tm('fills', { fields: preview.fills.map((f) => tm(`fields.${f}` as 'fields.region')).join(', ') })}</p>}
              {preview.conflicts.map((c) => (
                <p key={c} role="alert" className="flex items-start gap-2 text-[var(--danger)]">
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{tm(`conflict.${c}`)}</span>
                </p>
              ))}
            </>
          )}
        </section>
        {error && <Alert tone="danger">{te(error as 'generic')}</Alert>}
        <p className="text-sm text-[var(--text-2)]">{tm('warning')}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={!ready} onClick={() => void submit()}>
            {tm('submit')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {tm('cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
