// Логотип над заголовком экранов входа и приглашения (D-333). В режиме «название» ничего не рисует.
import { BrandMark } from './BrandMark';
import { loadBrand } from './loadBrand';

export async function AuthBrand() {
  const { name, logoSrc } = await loadBrand();
  if (!logoSrc) return null;
  return (
    <div className="mb-4">
      <BrandMark name={name} logoSrc={logoSrc} size="auth" />
    </div>
  );
}
