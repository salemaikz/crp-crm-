import type { ReactNode } from 'react';
import { Button } from '@/ui/kit';

type Props = { title: ReactNode; more: string; moreHref: string; children: ReactNode };

/**
 * Блок панели директора: заголовок и «Подробнее» в шапке на одной базовой линии, ссылка всегда последняя справа.
 * Своя шапка вместо kit-овской Section: у неё выравнивание по центру, а не по базовой линии. Текст ссылки встаёт
 * на правый край блока (поля кнопки уходят в минус), поэтому у всех блоков край один.
 */
export function DirectorBlock({ title, more, moreHref, children }: Props) {
  return (
    <section className="k-section" data-testid="director-block">
      <div className="k-section__head items-baseline">
        <h2 className="k-section__title">{title}</h2>
        <Button variant="quiet" size="sm" href={moreHref} className="-mr-3.5 shrink-0" data-testid="director-more">
          <span>{more}</span>
        </Button>
      </div>
      {children}
    </section>
  );
}
