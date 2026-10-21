// Что показать в шапке и на входе: название установки и, если настроено, адрес логотипа (D-333).
// Серверная функция: читает настройки и файл логотипа; без сессии (нужна и экрану входа).
import { getTranslations } from 'next-intl/server';
import { getActiveConfigOrNull } from '@/server/platform/config/active';
import { readLogo } from '@/server/platform/brand';
import { brandView, type BrandView } from './brandView';

export type { BrandView };

export async function loadBrand(): Promise<BrandView> {
  const [tc, config] = await Promise.all([getTranslations('common.app'), getActiveConfigOrNull()]);
  return brandView(config, tc('name'), (key) => readLogo(key));
}
