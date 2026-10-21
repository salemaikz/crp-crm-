'use client';

import { useTranslations } from 'next-intl';
import type { ImportDetails } from '../types';
import { Field, FormGrid, Select } from '@/ui/kit';

type Props = {
  labels: readonly string[];
  candidates: ImportDetails['candidates'];
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled: boolean;
};

/** Карта «ярлык → сотрудник»: диапазон строк или значение колонки «оператор» → учётка (PROCESS 2.2). */
export function OwnerMapForm({ labels, candidates, value, onChange, disabled }: Props) {
  const t = useTranslations('import.owners');
  if (labels.length === 0) return <p>{t('none')}</p>;
  return (
    <FormGrid>
      {labels.map((label) => (
        <Field key={label} width="md" label={label}>
          <Select
            name={`owner-${label}`}
            value={value[label] ?? ''}
            disabled={disabled}
            onChange={(e) => {
              const next = { ...value };
              if (e.target.value) next[label] = e.target.value;
              else delete next[label];
              onChange(next);
            }}
          >
            <option value="">{t('unassigned')}</option>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      ))}
    </FormGrid>
  );
}
