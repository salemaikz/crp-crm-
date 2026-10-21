// Место полосы лицензии в оболочке (D-327, D-319): под шапкой, над страницей. Отступы — те же линии, что у Page:
// --gutter по бокам и --page-top сверху; ширина — не больше широкой страницы. В боковой оболочке прижата влево, как
// Page, в нижней — по центру колонки. Зазор до заголовка страницы даёт верхний отступ самой Page.
import { LicenseBannerBar, type BannerView } from './LicenseBannerBar';

export function ShellBanner({ banner, side }: { banner: BannerView | null; side: boolean }) {
  if (!banner) return null;
  return (
    <div data-testid="shell-banner" className="px-[var(--gutter)] pt-[var(--page-top)]">
      <div className={side ? 'mx-auto max-w-[var(--page-w-wide)] md:ms-0' : 'mx-auto max-w-[var(--page-w-wide)]'}>
        <LicenseBannerBar banner={banner} />
      </div>
    </div>
  );
}
