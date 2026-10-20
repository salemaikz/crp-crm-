// «Можно использовать» плагин (CONFIG §8, D-268): флаг ∧ лицензия ∧ подключение включено ∧ (зарубежный → решение).
// Чистая функция; порядок проверок задаёт причину отказа, которую видит администратор.
import type { PluginUsabilityOf } from './contract';

export const pluginUsability: PluginUsabilityOf = (plugin, gate) => {
  if (plugin.flag && !gate.flagOn) return { usable: false, reason: 'flag_off' };
  if (plugin.licenseFeature && !gate.licensed) return { usable: false, reason: 'not_licensed' };
  if (plugin.needsConnection && !gate.enabled) return { usable: false, reason: 'disabled' };
  if (plugin.crossBorder && !gate.crossBorderApproved) return { usable: false, reason: 'crossborder_not_approved' };
  return { usable: true };
};
