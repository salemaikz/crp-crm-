import { route } from '@/server/access';
import { setMessengerConsent } from '@/server/domain/messenger';
import ruMessenger from '../../../../../messages/ru/messenger.json';
import { ConsentBody, readJson, sha256Hex } from '../_lib';

// Отметка согласия клиента на переписку и передачу данных за рубеж: в consents идёт sha256 показанного текста
// (messages/ru/messenger.json, consent.text; казахский текст появится вместе с локалью kk и своим хэшем).
export const POST = route({ perm: 'client.edit' }, async ({ req, viewer }) => {
  const body = await readJson(req, ConsentBody);
  return setMessengerConsent(viewer, { ...body, textHash: sha256Hex(ruMessenger.consent.text) });
});
