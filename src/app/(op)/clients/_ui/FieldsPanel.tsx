'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button, BottomSheet, Card, useToast } from '@/ui/kit';
import { isInlineType } from '@/ui/fields/inline';
import { InlineRows, type InlineRow } from './InlineRows';
import { saveInline } from './inlineSave';
import { FieldsForm, type FormBody, type SubmitResult, type SystemSpec } from './FieldsForm';
import { labelOf } from './format';
import { FieldValueView } from './FieldValueView';
import { send } from './requests';
import type { ClientFieldsView, LegalFormOption } from './types';

/** `inline` — ввод на месте (флаг CALLBACK_V2); без него прежний список и «Изменить». */
type Props = { client: ClientFieldsView; legalForms: LegalFormOption[]; inline?: boolean };

export function FieldsPanel({ client, legalForms, inline = false }: Props) {
  const t = useTranslations('clients');
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const legalLabel = legalForms.find((f) => f.key === client.legalForm);
  const shown = client.fields.fields.filter((f) => f.showOn.card);

  const system: SystemSpec[] = [
    { key: 'name', kind: 'text', label: t('fields.name'), value: client.name, editable: client.can.editIdentity },
    { key: 'legal_form', kind: 'legal_form', label: t('fields.legalForm'), value: client.legalForm, editable: client.can.editIdentity },
    { key: 'org_id', kind: 'bin', label: t('fields.orgId'), value: client.orgId, editable: client.can.editIdentity },
    { key: 'region', kind: 'text', label: t('fields.region'), value: client.region, editable: client.can.edit },
    { key: 'address', kind: 'text', label: t('fields.address'), value: client.address, editable: client.can.edit },
    { key: 'email', kind: 'email', label: t('fields.email'), value: client.email, editable: client.can.edit },
    { key: 'website', kind: 'url', label: t('fields.website'), value: client.website, editable: client.can.edit },
  ];

  async function submit(body: FormBody): Promise<SubmitResult> {
    const { result } = await send('PATCH', `/api/clients/${client.id}`, body);
    if (result.ok) {
      setOpen(false);
      toast.show({ message: t('fields.saved'), tone: 'success' });
      router.refresh();
    } else if (result.kind === 'conflict') {
      // Данные изменили в другом окне: закрываем форму и показываем свежие
      setOpen(false);
      toast.show({ message: t('form.failure.conflict'), tone: 'danger' });
      router.refresh();
    }
    return result;
  }

  const link = (href: string | null, text: string, external: boolean) =>
    href ? (
      <a className="k-link" href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        {text}
      </a>
    ) : (
      text
    );
  const sys = (key: string, type: string, label: string, value: string, editable: boolean, extra?: { options?: InlineRow['field']['options']; readView?: React.ReactNode }): InlineRow => ({
    field: { object: 'client', key, type, label, options: extra?.options ?? [], editable },
    value,
    save: async (next, prev) => {
      const r = await saveInline({ object: 'client', scope: 'system', key, clientId: client.id }, next, prev);
      // Смена формы очищает БИН личной формы, БИН меняет шапку «форма · БИН»: перечитываем карточку
      if (r.ok && (key === 'legal_form' || key === 'org_id')) router.refresh();
      return r;
    },
    ...(extra?.readView ? { readView: extra.readView } : {}),
  });
  const inlineRows: InlineRow[] = [
    sys('legal_form', 'select', t('fields.legalForm'), client.legalForm, client.can.editIdentity, { options: legalForms.map((f) => ({ key: f.key, label: labelOf(f.label) })) }),
    sys('org_id', 'text', t('fields.orgId'), client.orgId, client.can.editIdentity),
    sys('region', 'text', t('fields.region'), client.region, client.can.edit),
    sys('address', 'text', t('fields.address'), client.address, client.can.edit),
    sys('email', 'email', t('fields.email'), client.email, client.can.edit, { readView: link(client.emailHref, client.email, false) }),
    sys('website', 'url', t('fields.website'), client.website, client.can.edit, { readView: link(client.websiteHref, client.website, true) }),
    ...shown.map(
      (f): InlineRow => ({
        field: {
          object: 'client',
          key: f.key,
          type: f.type,
          label: labelOf(f.label),
          options: f.options.map((o) => ({ key: o.key, label: labelOf(o.label), archived: o.archived })),
          editable: f.access === 'edit' && !f.archived && client.can.edit && isInlineType(f.type),
        },
        value: f.value,
        save: (next, prev) => saveInline({ object: 'client', scope: 'custom', key: f.key, clientId: client.id }, next, prev),
        readView: <FieldValueView f={f} yes={t('fields.yes')} no={t('fields.no')} />,
      }),
    ),
  ];

  const row = (label: string, value: React.ReactNode) => (
    <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-2 py-1.5 sm:grid-cols-[12rem_minmax(0,1fr)]" key={label}>
      <dt className="text-[var(--text-2)]">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
  const empty = <span className="text-[var(--text-2)]">—</span>;

  return (
    <Card as="section" aria-labelledby="client-fields-title">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="client-fields-title" className="text-lg font-semibold">
          {t('fields.title')}
        </h2>
        {client.can.edit && (
          <Button variant={inline ? 'quiet' : 'secondary'} size="sm" onClick={() => setOpen(true)} data-testid="fields-edit-all">
            {inline ? t('fields.inline.editAll') : t('fields.edit')}
          </Button>
        )}
      </div>
      {inline ? (
        <InlineRows rows={inlineRows} onRefresh={() => router.refresh()} />
      ) : (
      <dl>
        {row(t('fields.legalForm'), legalLabel ? labelOf(legalLabel.label) : empty)}
        {row(t('fields.orgId'), client.orgId || empty)}
        {row(t('fields.region'), client.region || empty)}
        {row(t('fields.address'), client.address || empty)}
        {row(
          t('fields.email'),
          client.email ? client.emailHref ? <a className="k-link" href={client.emailHref}>{client.email}</a> : client.email : empty,
        )}
        {row(
          t('fields.website'),
          client.website ? (
            client.websiteHref ? (
              <a className="k-link" href={client.websiteHref} target="_blank" rel="noopener noreferrer">
                {client.website}
              </a>
            ) : (
              client.website
            )
          ) : (
            empty
          ),
        )}
        {shown.map((f) => row(labelOf(f.label), <FieldValueView f={f} yes={t('fields.yes')} no={t('fields.no')} />))}
      </dl>
      )}
      {client.can.edit && (
        <BottomSheet open={open} onClose={() => setOpen(false)} title={t('fields.editTitle')} closeLabel={t('form.close')}>
          <FieldsForm
            mode="edit"
            systemFields={system}
            customFields={client.fields.fields}
            legalForms={legalForms}
            submitLabel={t('form.save')}
            onSubmit={submit}
            onCancel={() => setOpen(false)}
          />
        </BottomSheet>
      )}
    </Card>
  );
}
