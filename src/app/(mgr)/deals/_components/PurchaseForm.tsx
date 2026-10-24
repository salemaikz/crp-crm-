'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, Card, Chip, ChipGroup, Field, Input, Select } from '@/ui/kit';
import type { PurchaseVariant } from './variants';
import { call, newKey } from '@/app/(mgr)/bookings/api';

interface Props {
  cardId: string;
  deals: { id: string; label: string }[];
  defaultDealId: string | null;
  services: { key: string; label: string; routesToTeam: boolean }[];
  today: string;
  /** Плитки вариантов услуги (D-348); пусто — прежняя форма. */
  variants?: PurchaseVariant[];
}

const NEW = '__new';

/** Только цифры; показываем с пробелами разрядов (ru-RU), на сервер уходит целое число тенге. */
const digitsOf = (s: string): string => s.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 13);
const grouped = (d: string): string => (d === '' ? '' : new Intl.NumberFormat('ru-RU').format(Number(d)));

// Форма покупки (B6): ключ запроса живёт до успеха (D-205) — двойное нажатие и повтор после обрыва
// дают одну сделку. После успеха — переход на страницу сделки.
export function PurchaseForm({ cardId, deals, defaultDealId, services, today, variants = [] }: Props) {
  const t = useTranslations('deals');
  const router = useRouter();
  const [requestId] = useState(newKey);
  const [dealId, setDealId] = useState<string>(defaultDealId ?? NEW);
  const [service, setService] = useState('');
  const [amount, setAmount] = useState('');
  const [day, setDay] = useState(today);
  // Выбранная плитка: `услуга/вариант`; null — «Другая услуга» или ручной выбор
  const [variant, setVariant] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = (code: string) => setError(t.has(`errors.${code}`) ? t(`errors.${code}`) : t('errors.conflict'));

  const pickVariant = (v: PurchaseVariant) => {
    setVariant(`${v.serviceKey}/${v.variantKey}`);
    setService(v.serviceKey);
    setAmount(digitsOf(String(v.amountKzt))); // сумму можно поправить вручную (скидка)
  };
  const price = (n: number) => new Intl.NumberFormat('ru-RU').format(n);

  const submit = async () => {
    if (busy) return;
    if (service === '') return problem('service_type_unknown');
    if (amount === '') return problem('amount_invalid');
    setBusy(true);
    setError(null);
    const r = await call<{ deal: { id: string } }>('POST', '/api/deals/purchase', {
      requestId,
      cardId,
      dealId: dealId === NEW ? null : dealId,
      serviceTypeKey: service,
      amountKzt: Number(amount),
      wonDay: day,
    });
    if (!r.ok) {
      setBusy(false);
      return problem(r.code);
    }
    router.push(`/deals/${encodeURIComponent(r.data.deal.id)}`);
  };

  return (
    <Card as="section" data-testid="purchase-form">
      <div className="flex flex-col gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t('purchase.deal')}>
          <Select name="purchase-deal" value={dealId} onChange={(e) => setDealId(e.target.value)}>
            {deals.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
            <option value={NEW}>{t('purchase.newDeal')}</option>
          </Select>
        </Field>
        {variants.length > 0 && (
          <div className="k-field">
            <span className="k-field__label">{t('purchase.variantsLabel')}</span>
            <ChipGroup label={t('purchase.variantsLabel')} data-testid="purchase-variants">
              {variants.map((v) => (
                <Chip key={`${v.serviceKey}/${v.variantKey}`} active={variant === `${v.serviceKey}/${v.variantKey}`} onClick={() => pickVariant(v)} data-testid={`purchase-variant-${v.serviceKey}-${v.variantKey}`}>
                  {t('purchase.variantTile', { service: v.serviceLabel, variant: v.variantLabel, price: price(v.amountKzt) })}
                </Chip>
              ))}
              <Chip active={variant === null} onClick={() => setVariant(null)} data-testid="purchase-variant-other">
                {t('purchase.otherService')}
              </Chip>
            </ChipGroup>
            {variant !== null && <span className="k-field__hint">{t('purchase.variantHint')}</span>}
          </div>
        )}
        <Field label={t('purchase.service')}>
          <Select
            name="purchase-service"
            value={service}
            onChange={(e) => {
              setService(e.target.value);
              // ручной выбор другой услуги снимает плитку (сумма остаётся, её правят вручную)
              if (variant !== null && !variant.startsWith(`${e.target.value}/`)) setVariant(null);
            }}
          >
            <option value="">{t('purchase.servicePick')}</option>
            {services.map((s) => (
              <option key={s.key} value={s.key}>
                {s.routesToTeam ? `${s.label} · ${t('purchase.toTeam')}` : s.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('purchase.amount')} hint={t('purchase.amountHint')}>
          <Input name="purchase-amount" inputMode="numeric" autoComplete="off" value={grouped(amount)} onChange={(e) => setAmount(digitsOf(e.target.value))} />
        </Field>
        <Field label={t('purchase.date')}>
          <Input name="purchase-date" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Button variant="primary" size="lg" block disabled={busy} onClick={() => void submit()}>
          {t('purchase.submit')}
        </Button>
      </div>
    </Card>
  );
}
