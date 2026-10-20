'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Badge, BottomSheet, Button, Card, List, ListItem, useToast } from '@/ui/kit';
import { FieldsForm, type FormBody, type SubmitResult, type SystemSpec } from './FieldsForm';
import { send } from './requests';
import type { ContactView, FieldView } from './types';

type Props = {
  clientId: string;
  contacts: ContactView[];
  /** Поля контакта из настроек (для нового контакта; у существующих — свои, с их значениями). */
  contactFields: FieldView[];
  canEdit: boolean;
};

export function ContactsPanel({ clientId, contacts, contactFields, canEdit }: Props) {
  const t = useTranslations('clients');
  const router = useRouter();
  const toast = useToast();
  // null — закрыто, 'new' — новый контакт, иначе id редактируемого
  const [editing, setEditing] = useState<string | null>(null);
  const opId = useRef<string>(crypto.randomUUID());
  const current = contacts.find((c) => c.id === editing) ?? null;

  const system = (c: ContactView | null): SystemSpec[] => [
    { key: 'name', kind: 'text', label: t('contacts.name'), value: c?.name ?? '', editable: true },
    { key: 'position', kind: 'text', label: t('contacts.position'), value: c?.position ?? '', editable: true },
    { key: 'is_decision_maker', kind: 'boolean', label: t('contacts.isDecisionMaker'), value: c?.isDecisionMaker ?? false, editable: true },
    { key: 'call_hint', kind: 'text', label: t('contacts.callHint'), value: c?.callHint ?? '', editable: true },
    { key: 'note', kind: 'textarea', label: t('contacts.note'), value: c?.note ?? '', editable: true },
  ];

  async function submit(body: FormBody): Promise<SubmitResult> {
    const isNew = editing === 'new';
    const { result } = isNew
      ? await send('POST', `/api/clients/${clientId}/contacts`, { opId: opId.current, system: body.set.system, custom: body.set.custom })
      : await send('PATCH', `/api/clients/contacts/${editing}`, body);
    if (result.ok) {
      if (isNew) opId.current = crypto.randomUUID();
      setEditing(null);
      toast.show({ message: t('contacts.saved'), tone: 'success' });
      router.refresh();
    } else if (result.kind === 'conflict') {
      setEditing(null);
      toast.show({ message: t('form.failure.conflict'), tone: 'danger' });
      router.refresh();
    } else if (isNew && result.kind !== 'network') {
      opId.current = crypto.randomUUID();
    }
    return result;
  }

  async function archive() {
    if (!editing || editing === 'new') return;
    const { result } = await send('PATCH', `/api/clients/contacts/${editing}`, { archived: true });
    setEditing(null);
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
              meta={[c.position, c.callHint].filter(Boolean).join(' · ') || undefined}
              trailing={c.isDecisionMaker ? <Badge tone="brand">{t('contacts.decisionMaker')}</Badge> : undefined}
              onClick={canEdit ? () => setEditing(c.id) : undefined}
            />
          ))}
        </List>
      )}
      {canEdit && (
        <BottomSheet
          open={editing !== null}
          onClose={() => setEditing(null)}
          title={editing === 'new' ? t('contacts.newTitle') : t('contacts.editTitle')}
          closeLabel={t('form.close')}
        >
          <FieldsForm
            mode={editing === 'new' ? 'create' : 'edit'}
            systemFields={system(current)}
            customFields={current ? current.fields.fields : contactFields}
            submitLabel={t('form.save')}
            onSubmit={submit}
            onCancel={() => setEditing(null)}
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
