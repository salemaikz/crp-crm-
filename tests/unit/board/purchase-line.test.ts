// Подпись покупки на плитке «Покупка» и в «Моих покупках» (D-357): «{услуга} · {вариант}» и «{сумма} · {дата}».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purchaseAmountLine, serviceLine, type ServiceLabels } from '@/ui/board/purchase';

const LABELS: ServiceLabels = {
  svc_a: { label: 'Услуга А', variants: { online: 'Онлайн', offline: 'Офлайн' } },
  svc_b: { label: 'Услуга Б', variants: {} },
};

test('услуга с вариантом: «Услуга А · Онлайн»', () => {
  assert.equal(serviceLine('svc_a', 'online', LABELS), 'Услуга А · Онлайн');
});

test('без варианта и с неизвестным вариантом — только услуга, сырой ключ не показываем', () => {
  assert.equal(serviceLine('svc_a', null, LABELS), 'Услуга А');
  assert.equal(serviceLine('svc_a', 'gone', LABELS), 'Услуга А');
  assert.equal(serviceLine('svc_b', 'online', LABELS), 'Услуга Б');
});

test('неизвестная услуга и пустой ключ — пустая строка (без сырого ключа)', () => {
  assert.equal(serviceLine('unknown', 'online', LABELS), '');
  assert.equal(serviceLine(null, null, LABELS), '');
  assert.equal(serviceLine(undefined, 'online', LABELS), '');
});

test('строка суммы: «сумма · дата», части по одной, ничего лишнего', () => {
  assert.equal(purchaseAmountLine('1 250 000 ₸', '24.10'), '1 250 000 ₸ · 24.10');
  assert.equal(purchaseAmountLine('1 250 000 ₸', ''), '1 250 000 ₸');
  assert.equal(purchaseAmountLine('', '24.10'), '24.10');
  assert.equal(purchaseAmountLine('', ''), '');
});
