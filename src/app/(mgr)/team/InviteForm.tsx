'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import type { IssuedLink, RoleOption } from './types';
import { formatPhoneInput, nationalDigits } from '@/shared/phoneMask';
import { Alert, Button, Checkbox, Field, Input, Select } from '@/ui/kit';
import { call } from './api';

type Props = { roles: RoleOption[]; onIssued: (link: IssuedLink) => void; onCancel: () => void };

export function InviteForm({ roles, onIssued, onCancel }: Props) {
  const t = useTranslations('team.invite');
  const ta = useTranslations('team.actions');
  const te = useTranslations('team.errors');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [roleKey, setRoleKey] = useState(roles[0]?.key ?? '');
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; phone?: string; role?: string }>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const fe: typeof fieldErrors = {};
    if (!name.trim()) fe.name = te('name');
    if (nationalDigits(phone).length !== 10) fe.phone = te('phone');
    const noRole = roleKey === '';
    if (noRole && !admin) fe.role = te('role_required');
    setFieldErrors(fe);
    setError(null);
    if (Object.keys(fe).length > 0) return;
    setBusy(true);
    const r = await call<IssuedLink>('POST', '/api/team/staff', {
      name: name.trim(),
      phone,
      roleKey: noRole ? null : roleKey,
      ...(admin ? { isAdmin: true } : {}),
    });
    setBusy(false);
    if (r.ok) onIssued(r.data);
    else setError(te(r.key as 'generic'));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Field label={t('name')} error={fieldErrors.name} required>
        <Input name="name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('phone')} hint={t('phoneHint')} error={fieldErrors.phone} required>
        <Input name="phone" type="tel" inputMode="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(formatPhoneInput(e.target.value))} />
      </Field>
      <Field label={t('role')} error={fieldErrors.role} required>
        <Select name="role" value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
          {roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
          <option value="">{t('adminNoRole')}</option>
        </Select>
      </Field>
      <Checkbox name="admin" label={t('admin')} checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? t('submitting') : t('submit')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {ta('cancel')}
        </Button>
      </div>
    </form>
  );
}
