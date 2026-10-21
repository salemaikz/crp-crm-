'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Alert, Button, Checkbox, Field, Modal, Select, Textarea, useToast } from '@/ui/kit';
import { formatPhone } from './format';
import { send } from './requests';

type Reason = { key: string; label: string };
type Mode = 'not_target' | 'do_not_call' | 'reopen' | 'dnc_clear';
type Assignee = { userId: string; name: string };

type Props = {
  cardId: string;
  version: number;
  can: { closeFromMenu: boolean; reopen: boolean; unblock: boolean };
  phones: Array<{ id: string; e164: string; primary: boolean }>;
  reasons: { not_target: Reason[]; do_not_call: Reason[] };
  /** Кому сервер примет карточку при возврате без владельца (один источник с проверкой на сервере). */
  recipients: Assignee[];
};

/**
 * Пункты меню карточки (C9): «Не целевой», «Полный отказ», «Вернуть в обзвон», «Снять «Не звонить»». Показываются
 * по `can.*` с сервера; версия карточки уходит с запросом, устаревшая — 409 и свежие данные. `opId` живёт до
 * успешного ответа или явного отказа сервера.
 */
export function CardMenu({ cardId, version, can, phones, reasons, recipients }: Props) {
  const t = useTranslations('clients');
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<Mode | null>(null);
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [alsoPhones, setAlsoPhones] = useState<string[]>([]);
  const [assignees, setAssignees] = useState<Assignee[] | null>(null);
  const [toUserId, setToUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const opId = useRef<string>(crypto.randomUUID());

  function open(m: Mode) {
    setMode(m);
    setReason('');
    setComment('');
    setError(null);
    setAssignees(null);
    setToUserId('');
    setAlsoPhones(phones.filter((p) => p.primary).map((p) => p.id));
  }

  const close = () => setMode(null);
  const list = mode === 'not_target' || mode === 'do_not_call' ? reasons[mode] : [];
  const ready = mode === 'reopen' || mode === 'dnc_clear' ? comment.trim().length > 0 && (assignees === null || toUserId !== '') : list.length === 0 || reason !== '';

  async function submit() {
    if (!mode || busy || !ready) return;
    setBusy(true);
    setError(null);
    const base = { opId: opId.current, version };
    const { result, data } =
      mode === 'reopen'
        ? await send('POST', `/api/cards/${cardId}/reopen`, { ...base, comment: comment.trim(), ...(toUserId ? { toUserId } : {}) })
        : mode === 'dnc_clear'
          ? await send('POST', `/api/cards/${cardId}/dnc-clear`, { ...base, comment: comment.trim() })
          : await send('POST', `/api/cards/${cardId}/close`, { ...base, kind: mode, reasonCode: list.length === 0 ? 'other' : reason, alsoDncPhoneIds: mode === 'do_not_call' ? alsoPhones : [] });
    setBusy(false);
    if (result.ok) {
      opId.current = crypto.randomUUID();
      close();
      toast.show({ message: t(`menu.done.${mode}`), tone: 'success' });
      router.refresh();
      return;
    }
    // Нужен получатель: владельца нет или он отключён — выбор сотрудника и повторная отправка
    if (mode === 'reopen' && (data as { detail?: string } | null)?.detail === 'owner_required') {
      setAssignees(recipients);
      setError(t('menu.ownerRequired'));
      return;
    }
    if (result.kind !== 'network') opId.current = crypto.randomUUID();
    if (result.kind === 'conflict') router.refresh();
    setError(t(`form.failure.${result.kind === 'fields' ? 'invalid' : result.kind}`));
  }

  if (!can.closeFromMenu && !can.reopen && !can.unblock) return null;
  return (
    <>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('menu.title')}>
        {can.reopen && (
          <Button variant="secondary" onClick={() => open('reopen')}>
            {t('menu.reopen')}
          </Button>
        )}
        {can.unblock && (
          <Button variant="secondary" onClick={() => open('dnc_clear')}>
            {t('menu.dncClear')}
          </Button>
        )}
        {can.closeFromMenu && (
          <>
            <Button variant="quiet" onClick={() => open('not_target')}>
              {t('menu.notTarget')}
            </Button>
            <Button variant="danger-quiet" onClick={() => open('do_not_call')}>
              {t('menu.doNotCall')}
            </Button>
          </>
        )}
      </div>
      <Modal open={mode !== null} onClose={close} title={mode ? t(`menu.dialog.${mode}`) : ''} closeLabel={t('form.close')}>
        <div className="flex flex-col gap-3">
          {error && <Alert tone="danger">{error}</Alert>}
          {(mode === 'not_target' || mode === 'do_not_call') && (
            <>
              {list.length > 0 && (
                <Field label={t('menu.reason')}>
                  <Select name="reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                    <option value="">{t('form.notChosen')}</option>
                    {list.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {mode === 'do_not_call' && phones.length > 0 && (
                <fieldset className="flex flex-col gap-1">
                  <legend className="mb-1 text-sm text-[var(--text-2)]">{t('menu.alsoDnc')}</legend>
                  {phones.map((p) => (
                    <Checkbox
                      key={p.id}
                      label={formatPhone(p.e164)}
                      checked={alsoPhones.includes(p.id)}
                      onChange={(e) => setAlsoPhones((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id)))}
                    />
                  ))}
                </fieldset>
              )}
            </>
          )}
          {(mode === 'reopen' || mode === 'dnc_clear') && (
            <>
              {assignees !== null && (
                <Field label={t('menu.recipient')}>
                  <Select name="recipient" value={toUserId} onChange={(e) => setToUserId(e.target.value)}>
                    <option value="">{t('form.notChosen')}</option>
                    {assignees.map((a) => (
                      <option key={a.userId} value={a.userId}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label={t('menu.comment')}>
                <Textarea name="comment" rows={3} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
              </Field>
            </>
          )}
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy || !ready} onClick={() => void submit()}>
              {busy ? t('form.saving') : t('menu.confirm')}
            </Button>
            <Button variant="secondary" onClick={close}>
              {t('form.cancel')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
