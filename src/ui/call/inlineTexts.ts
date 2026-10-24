'use client';

// Тексты ввода поля на месте для шторки лида и карточки обзвона (из `call.card.field.inline`).
// Шаблоны с `{label}` и `{value}` подставляет сам InlineField, поэтому берём их сырыми.
import { useTranslations } from 'next-intl';
import type { InlineTexts } from '@/ui/fields/InlineField';

const CODES = ['type', 'url', 'email', 'phone', 'date', 'range', 'too_long', 'option', 'required', 'forbidden', 'unknown_field', 'archived'] as const;

export function useInlineTexts(): InlineTexts {
  const t = useTranslations('call');
  const raw = (k: string) => String(t.raw(`card.field.inline.${k}`));
  return {
    add: raw('add'),
    editAria: raw('editAria'),
    addAria: raw('addAria'),
    save: raw('save'),
    cancel: raw('cancel'),
    retry: raw('retry'),
    notChosen: t('card.field.notChosen'),
    yes: t('card.field.yes'),
    no: t('card.field.no'),
    conflict: raw('conflict'),
    conflictUnknown: raw('conflictUnknown'),
    keepNew: raw('keepNew'),
    writeMine: raw('writeMine'),
    errors: {
      fields: Object.fromEntries(CODES.map((c) => [c, raw(`errors.fields.${c}`)])),
      fieldsDefault: raw('errors.fieldsDefault'),
      money: raw('errors.money'),
      number: raw('errors.number'),
      phone: raw('errors.phone'),
      invalid: raw('errors.invalid'),
      forbidden: raw('errors.forbidden'),
      readonly: raw('errors.readonly'),
      network: raw('errors.network'),
    },
  };
}
