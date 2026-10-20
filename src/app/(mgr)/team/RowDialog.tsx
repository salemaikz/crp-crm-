'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, Field, Select, useToast } from '@/ui/kit';
import { call } from './api';
import type { DisableResult, IssuedLink, RoleOption, StaffRow } from './types';

export type RowStep = 'menu' | 'role' | 'admin' | 'reset' | 'revoke' | 'disable' | 'disabledDone';

type Props = {
  row: StaffRow;
  roles: RoleOption[];
  /** Ссылка выдана (повторное приглашение, сброс пароля): окно переключается на её показ. */
  onLink: (kind: 'invite' | 'reset', link: IssuedLink) => void;
  /** Данные изменились: обновить список. */
  onChanged: () => void;
  onClose: () => void;
};

/** Содержимое единственного окна действий над сотрудником: меню и подтверждения сменяют друг друга. */
export function RowDialog({ row, roles, onLink, onChanged, onClose }: Props) {
  const t = useTranslations('team');
  const te = useTranslations('team.errors');
  const toast = useToast();
  const [step, setStep] = useState<RowStep>('menu');
  const [roleKey, setRoleKey] = useState(row.roleKey ?? roles[0]?.key ?? '');
  const [mode, setMode] = useState<'urgent' | 'wizard'>('urgent');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoverPending, setHandoverPending] = useState(false);

  const back = () => {
    setError(null);
    setStep('menu');
  };

  async function run<T>(method: 'POST' | 'PATCH' | 'DELETE', url: string, body: unknown, ok: (data: T) => void) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await call<T>(method, url, body);
    setBusy(false);
    if (r.ok) ok(r.data);
    else setError(te(r.key as 'generic'));
  }

  const base = `/api/team/staff/${row.id}`;
  const menu = (label: string, to: RowStep) => (
    <Button key={to} variant="secondary" block onClick={() => setStep(to)}>
      {label}
    </Button>
  );
  const footer = (confirm: { label: string; onClick: () => void; danger?: boolean }) => (
    <div className="flex flex-wrap gap-3">
      <Button variant={confirm.danger ? 'danger' : 'primary'} disabled={busy} onClick={confirm.onClick}>
        {confirm.label}
      </Button>
      <Button variant="secondary" onClick={back}>
        {t('actions.back')}
      </Button>
    </div>
  );
  const err = error && <Alert tone="danger">{error}</Alert>;

  if (step === 'menu') {
    return (
      <div className="flex flex-col gap-3">
        {row.status === 'active' && (
          <>
            {menu(t('actions.changeRole'), 'role')}
            {menu(row.isAdmin ? t('actions.revokeAdmin') : t('actions.grantAdmin'), 'admin')}
            {menu(t('actions.resetPassword'), 'reset')}
            {menu(t('actions.disable'), 'disable')}
          </>
        )}
        {row.status === 'invited' && (
          <>
            <Button
              block
              disabled={busy}
              onClick={() =>
                run<IssuedLink>('POST', `${base}/invite`, {}, (link) => {
                  onChanged();
                  onLink('invite', link);
                })
              }
            >
              {t('actions.resend')}
            </Button>
            {menu(t('actions.revoke'), 'revoke')}
            {menu(t('actions.disable'), 'disable')}
          </>
        )}
        {err}
      </div>
    );
  }

  if (step === 'role') {
    return (
      <div className="flex flex-col gap-4">
        <Field label={t('role.label')} hint={t('role.hint')}>
          <Select name="role" value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        {err}
        {footer({
          label: t('role.save'),
          onClick: () =>
            run('PATCH', base, { roleKey }, () => {
              toast.show({ message: t('role.saved'), tone: 'success' });
              onChanged();
              onClose();
            }),
        })}
      </div>
    );
  }

  if (step === 'admin') {
    return (
      <div className="flex flex-col gap-4">
        <p>{row.isAdmin ? t('admin.revokeText') : t('admin.grantText')}</p>
        {err}
        {footer({
          label: row.isAdmin ? t('actions.revokeAdmin') : t('actions.grantAdmin'),
          onClick: () =>
            run('PATCH', base, { isAdmin: !row.isAdmin }, () => {
              toast.show({ message: t('admin.saved'), tone: 'success' });
              onChanged();
              onClose();
            }),
        })}
      </div>
    );
  }

  if (step === 'reset') {
    return (
      <div className="flex flex-col gap-4">
        <p>{t('reset.text')}</p>
        {err}
        {footer({ label: t('reset.submit'), onClick: () => run<IssuedLink>('POST', `${base}/password-reset`, undefined, (link) => onLink('reset', link)) })}
      </div>
    );
  }

  if (step === 'revoke') {
    return (
      <div className="flex flex-col gap-4">
        <p>{t('revoke.text')}</p>
        {err}
        {footer({
          label: t('revoke.submit'),
          danger: true,
          onClick: () =>
            run('DELETE', `${base}/invite`, undefined, () => {
              toast.show({ message: t('revoke.done'), tone: 'success' });
              onChanged();
              onClose();
            }),
        })}
      </div>
    );
  }

  if (step === 'disable') {
    return (
      <div className="flex flex-col gap-4">
        <p>{t('disable.text')}</p>
        <Field label={t('disable.mode')}>
          <Select name="mode" value={mode} onChange={(e) => setMode(e.target.value as 'urgent' | 'wizard')}>
            <option value="urgent">{t('disable.urgent')}</option>
            <option value="wizard">{t('disable.wizard')}</option>
          </Select>
        </Field>
        {err}
        {footer({
          label: t('disable.submit'),
          danger: true,
          onClick: () =>
            run<DisableResult>('POST', `${base}/disable`, { mode }, (res) => {
              setHandoverPending(res.handover.status === 'not_implemented');
              onChanged();
              setStep('disabledDone');
            }),
        })}
      </div>
    );
  }

  // disabledDone
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="success">{t('disable.done')}</Alert>
      {handoverPending && (
        <Alert tone="warning" title={t('disable.handoverPendingTitle')}>
          {t('disable.handoverPendingText')}
        </Alert>
      )}
      <div>
        <Button onClick={onClose}>{t('actions.done')}</Button>
      </div>
    </div>
  );
}
