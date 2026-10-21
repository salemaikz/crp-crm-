// AES-256-GCM секретов интеграций (D-269): случайный IV 12 байт, тег 16 байт, AAD = `${integrationId}|${name}|${kid}`.
// AAD привязывает шифротекст к строке: перенос в чужую интеграцию или под другое имя ломает тег (auth_failed).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecretError } from './keys';
import type { OpenSecret, SealSecret, SealedSecret, SecretKeyring } from './types';

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

const aad = (integrationId: string, name: string, kid: string): Buffer => Buffer.from(`${integrationId}|${name}|${kid}`, 'utf8');

function keyOf(ring: SecretKeyring, kid: string, missing: 'no_key' | 'unknown_kid'): Uint8Array {
  const key = ring.keys.get(kid);
  if (!key || key.length !== 32) throw new SecretError(missing);
  return key;
}

export const sealSecret: SealSecret = (ring, { integrationId, name, plaintext }): SealedSecret => {
  const kid = ring.currentKid;
  const key = keyOf(ring, kid, 'no_key');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(integrationId, name, kid));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { kid, iv: new Uint8Array(iv), ciphertext: new Uint8Array(ciphertext), tag: new Uint8Array(cipher.getAuthTag()) };
};

export const openSecret: OpenSecret = (ring, { integrationId, name, sealed }): string => {
  const key = keyOf(ring, sealed.kid, 'unknown_kid');
  if (sealed.iv.length !== IV_BYTES || sealed.tag.length !== TAG_BYTES) throw new SecretError('auth_failed');
  try {
    const decipher = createDecipheriv(ALG, key, sealed.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(integrationId, name, sealed.kid));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Тег не сошёлся: подмена строки, чужой AAD или порча. Подробности (и значение) наружу не уходят
    throw new SecretError('auth_failed');
  }
};
