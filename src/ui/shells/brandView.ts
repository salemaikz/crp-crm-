// Чистая часть выбора «название или логотип» (D-333): без Next и БД, проверяется юнит-тестом.
import type { LogoFile } from '@/server/platform/brand';

export type BrandView = { name: string; logoSrc: string | null };

type ThemeLike = { brandMark?: 'name' | 'logo' | undefined; logo: string };
type ConfigLike = { global: { org: { productName?: { ru?: string | undefined } | undefined }; theme: ThemeLike } };

/** Название — org.productName.ru, запасное из локали. Логотип — только при brandMark='logo' и найденном файле. */
export async function brandView(config: ConfigLike | null, fallbackName: string, read: (key: string) => Promise<LogoFile | null>): Promise<BrandView> {
  const name = config?.global.org.productName?.ru?.trim() || fallbackName;
  const theme = config?.global.theme;
  if (!theme || theme.brandMark !== 'logo') return { name, logoSrc: null };
  const file = await read(theme.logo);
  return { name, logoSrc: file ? `/api/brand/logo?v=${file.hash}` : null };
}
