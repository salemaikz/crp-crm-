'use client';

// Плитка сделки на доске (B8): клиент, контакт и номер (по проекции роли), до двух полей, следующий шаг, значки.
// Перетаскивание — только на широком экране; «Переместить в…» есть всегда (клавиатура, телефон).
import { Clock, MoveRight, RotateCcw } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { Badge, Button } from '@/ui/kit';
import type { DealTile as Tile } from './types';

type Props = {
  tile: Tile;
  timeZone: string;
  draggable: boolean;
  /** Плитка уже переехала локально и ждёт отправки: приглушена. */
  waiting: boolean;
  onMove: (tile: Tile) => void;
  onDragStart: (tile: Tile) => void;
  onDragEnd: () => void;
};

const text = (v: unknown): string => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? '✓' : '') : '');

export function DealTile({ tile, timeZone, draggable, waiting, onMove, onDragStart, onDragEnd }: Props) {
  const t = useTranslations('deals.board');
  const f = useFormatter();
  return (
    <li
      className="rounded-lg border bg-[var(--surface)] p-3 shadow-sm"
      style={{ borderColor: 'var(--border)', opacity: waiting ? 0.6 : 1 }}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', tile.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(tile);
      }}
      onDragEnd={onDragEnd}
      data-testid="deal-tile"
      data-deal-id={tile.id}
    >
      <div className="flex items-start justify-between gap-2">
        <Link href={`/clients/${tile.clientId}`} className="font-semibold leading-tight hover:underline">
          {tile.clientName}
        </Link>
      </div>
      {(tile.contactName || tile.phone) && (
        <p className="mt-1 text-sm" style={{ color: 'var(--text-2)' }}>
          {[tile.contactName, tile.phone].filter(Boolean).join(' · ')}
        </p>
      )}
      {tile.fields.length > 0 && (
        <dl className="mt-1 flex flex-col text-sm" style={{ color: 'var(--text-2)' }}>
          {tile.fields.map((x) => (
            <div key={x.key} className="flex gap-1">
              <dt>{x.label}:</dt>
              <dd className="font-medium">{text(x.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {tile.nextTask && (
        <p className="mt-1 flex items-center gap-1 text-sm" style={{ color: 'var(--text-2)' }}>
          <Clock aria-hidden="true" size={14} />
          {tile.nextTask.dueAt !== null ? f.dateTime(tile.nextTask.dueAt, { dateStyle: 'short', timeStyle: 'short', timeZone }) : t('tile.noDue')}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {tile.badges.staleDays !== null && (
          <Badge tone="warning" icon={<Clock />}>
            {t('tile.stale', { days: tile.badges.staleDays })}
          </Badge>
        )}
        {tile.badges.needsRebook && (
          <Badge tone="info" icon={<RotateCcw />}>
            {t('tile.needsRebook')}
          </Badge>
        )}
        {tile.ownerName && (
          <span className="text-xs" style={{ color: 'var(--text-3)' }}>
            {tile.ownerName}
          </span>
        )}
      </div>
      <div className="mt-2">
        <Button variant="quiet" size="sm" onClick={() => onMove(tile)} data-testid="deal-move">
          <MoveRight aria-hidden="true" size={16} />
          {t('actions.move')}
        </Button>
      </div>
    </li>
  );
}
