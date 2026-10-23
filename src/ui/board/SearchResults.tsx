'use client';

// Результат поиска по своим (до 20 совпадений): строка — клиент и колонка, где он стоит; на доске плитка подсвечена.
import { useTranslations } from 'next-intl';
import type { BoardCardDto } from './types';

export function SearchResults({ matches, short, titleOfColumn, onOpen }: { matches: readonly BoardCardDto[]; short: boolean; titleOfColumn: (key: string | null) => string; onOpen: (c: BoardCardDto) => void }) {
  const t = useTranslations('board');
  if (short) {
    return (
      <p className="text-sm" role="status" style={{ color: 'var(--text-2)' }} data-testid="search-short">
        {t('search.short')}
      </p>
    );
  }
  if (matches.length === 0) {
    return (
      <p className="text-sm" role="status" style={{ color: 'var(--text-2)' }} data-testid="search-empty">
        {t('search.empty')}
      </p>
    );
  }
  return (
    <section aria-label={t('search.results')} className="flex flex-col gap-1" data-testid="search-results">
      <h2 className="text-sm font-semibold">{t('search.found', { n: matches.length })}</h2>
      <ul className="flex flex-col gap-1">
        {matches.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--block justify-between text-left"
              onClick={() => onOpen(c)}
              data-testid="search-match"
              data-card-id={c.id}
            >
              <span className="min-w-0 break-words">{c.name}</span>
              <span className="shrink-0 text-sm font-normal" style={{ color: 'var(--text-2)' }}>
                {c.column ? titleOfColumn(c.column) : t('search.offBoard')}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
