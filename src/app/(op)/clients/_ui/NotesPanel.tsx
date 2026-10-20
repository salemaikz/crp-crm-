'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Textarea, useToast } from '@/ui/kit';
import { useFeedControl } from './ClientsProviders';
import { formatDateTime } from './format';
import { send } from './requests';
import type { NoteView } from './types';

type Props = { clientId: string; pinned: NoteView[]; canWrite: boolean; timeZone: string };

const MAX = 4000;

/**
 * Заметки: закреплённые (до трёх) и форма новой. Заметка не правится и не удаляется — исправление это новая
 * заметка. `opId` живёт, пока заметка не сохранена: повтор при сбое сети не создаёт вторую.
 */
export function NotesPanel({ clientId, pinned, canWrite, timeZone }: Props) {
  const t = useTranslations('clients');
  const router = useRouter();
  const toast = useToast();
  const control = useFeedControl();
  const [list, setList] = useState(pinned);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const opId = useRef<string>(crypto.randomUUID());

  async function add(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (busy || !body) return;
    setBusy(true);
    setError(null);
    const { result } = await send('POST', `/api/clients/${clientId}/notes`, { opId: opId.current, body });
    setBusy(false);
    if (result.ok) {
      opId.current = crypto.randomUUID();
      setText('');
      toast.show({ message: t('notes.saved'), tone: 'success' });
      control.reload();
      return;
    }
    if (result.kind !== 'network') opId.current = crypto.randomUUID();
    setError(t(result.kind === 'invalid' || result.kind === 'fields' ? 'notes.invalid' : `form.failure.${result.kind}`));
  }

  async function unpin(n: NoteView) {
    const { result } = await send('PATCH', `/api/clients/notes/${n.id}`, { pinned: false });
    if (result.ok) {
      setList((cur) => cur.filter((x) => x.id !== n.id));
      control.reload();
      router.refresh();
    } else {
      toast.show({ message: t(`form.failure.${result.kind === 'fields' ? 'invalid' : result.kind}`), tone: 'danger' });
    }
  }

  return (
    <Card as="section" aria-labelledby="client-notes-title">
      <h2 id="client-notes-title" className="mb-2 text-lg font-semibold">
        {t('notes.title')}
      </h2>
      {list.length === 0 ? (
        <p className="mb-3 text-[var(--text-2)]">{t('notes.emptyPinned')}</p>
      ) : (
        <ul className="mb-3 flex flex-col divide-y divide-[var(--border)]" aria-label={t('notes.pinned')}>
          {list.map((n) => (
            <li key={n.id} className="py-2" data-testid="pinned-note">
              <p className="break-words whitespace-pre-wrap">{n.body}</p>
              <p className="text-sm text-[var(--text-2)]">
                {formatDateTime(n.createdAt, timeZone)}
                {n.authorName ? ` · ${n.authorName}` : ''}
              </p>
              {canWrite && (
                <Button variant="quiet" size="sm" onClick={() => void unpin(n)}>
                  {t('notes.unpin')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form onSubmit={add} className="flex flex-col gap-3" noValidate>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label={t('notes.add')}>
            <Textarea name="note" rows={3} maxLength={MAX} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('notes.placeholder')} />
          </Field>
          <div>
            <Button type="submit" variant="secondary" disabled={busy || text.trim().length === 0}>
              {busy ? t('form.saving') : t('notes.submit')}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
