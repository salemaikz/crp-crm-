'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button, BottomSheet, Card, useToast } from '@/ui/kit';
import { FieldsForm, type FormBody, type SubmitResult, type SystemSpec } from './FieldsForm';
import { formatDay, formatNumber, labelOf } from './format';
import { send } from './requests';
import type { ClientFieldsView, FieldView, LegalFormOption } from './types';

/** Значение поля настроек для показа. Ссылка и почта — только готовый href из DTO. */
function FieldValueView({ f, yes, no }: { f: FieldView; yes: string; no: string }) {
  const v = f.value;
  if (v === null) return <span className="text-[var(--text-2)]">—</span>;
  const optionLabel = (key: string) => {
    const o = f.options.find((x) => x.key === key);
    return o ? labelOf(o.label) : key;
  };
  switch (f.type) {
    case 'boolean':
      return <>{v === true ? yes : no}</>;
    case 'select':
      return <>{optionLabel(String(v))}</>;
    case 'multiselect':
      return <>{(Array.isArray(v) ? v : []).map(optionLabel).join(', ')}</>;
    case 'money':
      return <>{typeof v === 'number' ? `${formatNumber(v)} ₸` : String(v)}</>;
    case 'number':
      return <>{typeof v === 'number' ? formatNumber(v) : String(v)}</>;
    case 'date':
      return <>{formatDay(String(v))}</>;
    case 'url':
    case 'email':
      return f.href ? (
        <a className="k-link" href={f.href} {...(f.type === 'url' ? { target: '_blank', rel: 'noopener noreferrer' } : { rel: 'noopener noreferrer' })}>
          {String(v)}
        </a>
      ) : (
        <>{String(v)}</>
      );
    default:
      return <>{String(v)}</>;
  }
}

type Props = { client: ClientFieldsView; legalForms: LegalFormOption[] };

export function FieldsPanel({ client, legalForms }: Props) {
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
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            {t('fields.edit')}
          </Button>
        )}
      </div>
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
