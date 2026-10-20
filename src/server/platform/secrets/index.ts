// Секреты интеграций (INTEGRATIONS §7, D-269): ключи из окружения, AES-256-GCM, SQL integration_secrets.
export { SecretError, isSecretError, loadKeyring, hasSecretsKey, DEV_KID } from './keys';
export { sealSecret, openSecret } from './aesgcm';
export {
  putIntegrationSecret,
  getIntegrationSecret,
  deleteIntegrationSecrets,
  describeIntegrationSecrets,
  rotateSecrets,
  checkSecrets,
  last4Of,
} from './repo';
export type * from './types';
