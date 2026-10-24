'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Alert, Badge, BottomSheet, Button, Card, Field, Input, List, ListItem, useToast } from '@/ui/kit';
import { FieldsForm, type FormBody, type SubmitResult, type SystemSpec } from './FieldsForm';
import { formatPhone } from './format';
import { send } from './requests';
import type { ContactView, FieldView, PhoneView } from './types';

type Props = {
  clientId: string;
  contacts: ContactView[];
  /** Поля контакта из настроек (для нового контакта; у существующих — свои, с их значениями). */
  contactFields: FieldView[];
  /** Номера клиента: у контакта показываются его номера. */
  phones: PhoneView[];
  canEdit: boolean;
};

export function ContactsPanel({ clientId, contacts, contactFields, phones, canEdit }: Props) {
  const t = useTranslations('clients');
  const router = useRouter();
  const toast = useToast();
  // null — закрыто, 'new' — новый контакт, иначе id редактируемого
  const [editing, setEditing] = useState<string | null>(null);
  const opId = useRef<string>(crypto.randomUUID());
  // Контакт, уже созданный в этой форме, но с несохранённым номером: следующие отправки правят его (PATCH),
  // а не повторяют создание с прежним opId — иначе сервер молча вернул бы старые данные.
  const createdId = useRef<string | null>(null);
  // Что сервер уже хранит у созданного контакта: из него строится `expect` правки (ключи set и expect совпадают)
  const saved = useRef<FormBody['set']>({ system: {}, custom: {} });
  // Телефон нового контакта: свой opId на попытку, чтобы повтор не создал второй номер
  const phoneOpId = useRef<string>(crypto.randomUUID());
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const current = contacts.find((c) => c.id === editing) ?? null;

  const system = (c: ContactView | null): SystemSpec[] => [
    { key: 'name', kind: 'text', label: t('contacts.name'), value: c?.name ?? '', editable: true },
    { key: 'position', kind: 'text', label: t('contacts.position'), value: c?.position ?? '', editable: true },
    { key: 'is_decision_maker', kind: 'boolean', label: t('contacts.isDecisionMaker'), value: c?.isDecisionMaker ?? false, editable: true },
    { key: 'call_hint', kind: 'text', label: t('contacts.callHint'), value: c?.callHint ?? '', editable: true },
    { key: 'note', kind: 'textarea', label: t('contacts.note'), value: c?.note ?? '', editable: true },
  ];

  function closeForm() {
    createdId.current = null;
    saved.current = { system: {}, custom: {} };
    opId.current = crypto.randomUUID();
    phoneOpId.current = crypto.randomUUID();
    setEditing(null);
    setPhone('');
    setPhoneError(null);
  }

  /** Номер контакта: `false` — не добавлен (причина показана у поля). */
  async function addPhoneOf(contactId: string): Promise<boolean> {
    const { result, data } = await send('POST', `/api/clients/${clientId}/phones`, { opId: phoneOpId.current, phone: phone.trim(), contactId });
    if (result.ok) {
      phoneOpId.current = crypto.randomUUID();
      setPhone('');
      setPhoneError(null);
      return true;
    }
    if (result.kind !== 'network') phoneOpId.current = crypto.randomUUID();
    const stand = (data as { detail?: string } | null)?.detail === 'stand_phone';
    setPhoneError(`${t('contacts.phoneFailed')}. ${result.kind === 'invalid' ? t(stand ? 'phones.standPhone' : 'phones.invalid') : t(`form.failure.${result.kind === 'fields' ? 'invalid' : result.kind}`)}`);
    return false;
  }

  /** Правка созданного контакта: ожидаемое — то, что отправили при создании (для нового ключа — пустое значение). */
  function resumeBody(body: FormBody): FormBody {
    const empty = (v: unknown) => (typeof v === 'boolean' ? false : typeof v === 'string' ? '' : null);
    const expect: FormBody['expect'] = { system: {}, custom: {} };
    for (const part of ['system', 'custom'] as const) {
      for (const [k, v] of Object.entries(body.set[part])) expect[part][k] = k in saved.current[part] ? saved.current[part][k] : empty(v);
    }
    return { set: body.set, expect };
  }

  async function submit(body: FormBody): Promise<SubmitResult> {
    const isNew = editing === 'new';
    // Продолжение после сбоя номера: контакт уже есть, правим его
    const resume = isNew ? createdId.current : null;
    const { result } = resume
      ? await send('PATCH', `/api/clients/contacts/${resume}`, resumeBody(body))
      : isNew
        ? await send('POST', `/api/clients/${clientId}/contacts`, { opId: opId.current, system: body.set.system, custom: body.set.custom })
        : await send('PATCH', `/api/clients/contacts/${editing}`, body);
    if (result.ok) {
      // Номер нового контакта: сам контакт уже создан (его id — opId), номер привязывается к нему
      if (isNew && !resume) {
        createdId.current = opId.current;
        opId.current = crypto.randomUUID();
      }
      if (isNew) saved.current = { system: { ...saved.current.system, ...body.set.system }, custom: { ...saved.current.custom, ...body.set.custom } };
      if (isNew && phone.trim() && createdId.current) {
        const added = await addPhoneOf(createdId.current);
        if (!added) {
          // Контакт есть, номера нет: форма остаётся с ошибкой; повтор правит этот контакт, второй не создаётся
          router.refresh();
          return { ok: false, kind: 'invalid' };
        }
      }
      closeForm();
      toast.show({ message: t('contacts.saved'), tone: 'success' });
      router.refresh();
    } else if (result.kind === 'conflict') {
      closeForm();
      toast.show({ message: t('form.failure.conflict'), tone: 'danger' });
      router.refresh();
    } else if (isNew && !resume && result.kind !== 'network') {
      opId.current = crypto.randomUUID();
    }
    return result;
  }

  async function archive() {
    if (!editing || editing === 'new') return;
    const { result } = await send('PATCH', `/api/clients/contacts/${editing}`, { archived: true });
    closeForm();
    if (result.ok) {
      toast.show({ message: t('contacts.archived'), tone: 'success' });
      router.refresh();
    } else {
      toast.show({ message: t(`form.failure.${result.kind === 'fields' ? 'invalid' : result.kind}`), tone: 'danger' });
    }
  }

  return (
    <Card as="section" aria-labelledby="client-contacts-title">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="client-contacts-title" className="text-lg font-semibold">
          {t('contacts.title')}
        </h2>
        {canEdit && (
          <Button variant="quiet" size="sm" onClick={() => setEditing('new')}>
            {t('contacts.add')}
          </Button>
        )}
      </div>
      {contacts.length === 0 ? (
        <p className="text-[var(--text-2)]">{t('contacts.empty')}</p>
      ) : (
        <List>
          {contacts.map((c) => (
            <ListItem
              key={c.id}
              title={c.name || t('contacts.noName')}
              meta={[c.position, c.callHint, ...phones.filter((p) => p.contactId === c.id).map((p) => formatPhone(p.e164))].filter(Boolean).join(' · ') || undefined}
              trailing={c.isDecisionMaker ? <Badge tone="brand">{t('contacts.decisionMaker')}</Badge> : undefined}
              onClick={canEdit ? () => setEditing(c.id) : undefined}
            />
          ))}
        </List>
      )}
      {canEdit && (
        <BottomSheet
          open={editing !== null}
          onClose={closeForm}
          title={editing === 'new' ? t('contacts.newTitle') : t('contacts.editTitle')}
          closeLabel={t('form.close')}
        >
          <FieldsForm
            mode={editing === 'new' ? 'create' : 'edit'}
            systemFields={system(current)}
            customFields={current ? current.fields.fields : contactFields}
            submitLabel={t('form.save')}
            onSubmit={submit}
            onCancel={closeForm}
            afterFields={
              editing === 'new' ? (
                <>
                  {phoneError && <Alert tone="danger">{phoneError}</Alert>}
                  <Field label={t('contacts.phone')} hint={t('contacts.phoneHint')}>
                    <Input name="contact-phone" type="tel" inputMode="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} />
                  </Field>
                </>
              ) : undefined
            }
            extra={
              current ? (
                <Button type="button" variant="danger" onClick={archive}>
                  {t('contacts.archive')}
                </Button>
              ) : undefined
            }
          />
        </BottomSheet>
      )}
    </Card>
  );
}
