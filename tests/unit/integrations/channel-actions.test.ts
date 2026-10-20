// Действия кнопок «Позвонить» и «WhatsApp» по режиму каналов (D-268): ссылки строят только dial.ts и openChat.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChannelModes } from '../../../src/integrations/contract';
import { dialAction } from '../../../src/ui/call/dial';
import { chatAction } from '../../../src/ui/messenger/openChat';
import { DEFAULT_CHANNEL_MODES } from '../../../src/ui/channels/ChannelModesContext';
import { FALLBACK_MODES } from '../../../src/server/domain/integrations/modes';

test('запасной режим сервера и клиента совпадает: tel: и wa.me', () => {
  assert.deepEqual(DEFAULT_CHANNEL_MODES, FALLBACK_MODES);
});

test('tel: по режиму manual; провайдер — post', () => {
  assert.deepEqual(dialAction('77090000001', DEFAULT_CHANNEL_MODES), { kind: 'tel', href: 'tel:+77090000001' });
  assert.deepEqual(dialAction('', DEFAULT_CHANNEL_MODES), { kind: 'tel', href: '' });
  const provider: ChannelModes = { ...DEFAULT_CHANNEL_MODES, telephony: { pluginId: 'telephony.beeline', clickToCall: 'callback' } };
  assert.deepEqual(dialAction('77090000001', provider), { kind: 'post' });
});

test('wa.me по режиму link; окно провайдера — panel', () => {
  assert.deepEqual(chatAction('8 709 000 00 01', 'Здравствуйте', DEFAULT_CHANNEL_MODES), {
    kind: 'link',
    href: `https://wa.me/77090000001?text=${encodeURIComponent('Здравствуйте')}`,
  });
  const iframe: ChannelModes = { ...DEFAULT_CHANNEL_MODES, messenger: { pluginId: 'messenger.wazzup', chat: 'iframe' } };
  assert.deepEqual(chatAction('77090000001', '', iframe), { kind: 'panel' });
});
