// Общий телефон (D-291): при загрузке под B данные A удаляются или обезличиваются; итоги A остаются без названий.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foreignKeys, sanitizeForeign, type ScanStorage } from '../../../src/ui/call/deviceOwner';
import { createMemoryStore } from '../../../src/ui/call/outboxStore';

function mem(): ScanStorage & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const entry = (opId: string, userId: string, title: string) => ({
  opId, userId, notBefore: 0, attempts: 0, retryAt: 0, createdAt: 1, title, kind: 'no_answer' as const,
  request: { opId, cardId: `cd-${opId}`, outcomeKey: 'no_answer' } as never,
});

test('ключи других сотрудников: только pending и tally чужих, свои и посторонние ключи не трогаются', () => {
  const s = mem();
  for (const k of ['crm.call.pending.uA', 'crm.call.tally.uA', 'crm.call.pending.uB', 'crm.call.tally.uB', 'crm.logout.pending', 'other']) s.setItem(k, '1');
  assert.deepEqual(foreignKeys(s, 'uB').sort(), ['crm.call.pending.uA', 'crm.call.tally.uA']);
});

test('вход B после истёкшей сессии A: черновик, счётчик и отказы A удалены, итоги A — без названия, но целы', async () => {
  const storage = mem();
  storage.setItem('crm.call.pending.uA', '{"call":{"title":"ТОО Синтетик"}}');
  storage.setItem('crm.call.tally.uA', '{"day":"x","items":[]}');
  storage.setItem('crm.call.tally.uB', '{"day":"x","items":[]}');
  const store = createMemoryStore();
  await store.put(entry('a1', 'uA', 'ТОО Синтетик'));
  await store.put(entry('b1', 'uB', 'ТОО Свой'));
  await store.putRejected({ opId: 'ra', userId: 'uA', title: 'ТОО Синтетик', code: 'not_found', at: 1 });
  await store.putRejected({ opId: 'rb', userId: 'uB', title: 'ТОО Свой', code: 'not_found', at: 1 });

  await sanitizeForeign('uB', { storage, store });

  assert.deepEqual([...storage.m.keys()], ['crm.call.tally.uB']);
  const a = await store.all('uA');
  assert.equal(a.length, 1);
  assert.equal(a[0]!.title, '');
  assert.equal((a[0]!.request as { cardId: string }).cardId, 'cd-a1');
  assert.equal((await store.all('uB'))[0]!.title, 'ТОО Свой', 'свои данные B не трогаются');
  assert.equal((await store.rejected('uA')).length, 0);
  assert.equal((await store.rejected('uB')).length, 1);
});

test('нет хранилищ — уборка не бросает', async () => {
  await sanitizeForeign('uB', { storage: null, store: null });
});
