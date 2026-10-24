// Подсказка первого входа на доску (S4): ключ без ПДн, показ только оператору с доской, ссылка на якорь справки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD_TIP_PATH, boardTipKey } from '../../../src/ui/shells/boardTip';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('ключ localStorage: версия и идентификатор сотрудника', () => {
  assert.equal(boardTipKey('3f2a'), 'crm.tip.board.v1:3f2a');
  assert.equal(BOARD_TIP_PATH, '/board');
});

test('подсказка ведёт на /help#board, закрывается «Понятно», стоит над нижним меню', () => {
  const src = read('src/ui/shells/BoardTip.tsx');
  assert.match(src, /href="\/help#board"/);
  assert.match(src, /var\(--bottom-nav-h\)/);
  assert.match(src, /localStorage\.setItem\(boardTipKey\(userId\)/);
});

test('оболочка даёт подсказку только оператору с пунктом «Доска»; тексты — из локали', () => {
  const shell = read('src/ui/shells/RoleShell.tsx');
  assert.match(shell, /menu\.shell === 'operator' && menu\.items\.some\(\(i\) => i\.href === '\/board'\)/);
  const msgs = JSON.parse(read('messages/ru/shell.json')) as { tip: { board: Record<string, string> } };
  assert.equal(msgs.tip.board.ok, 'Понятно');
  assert.match(msgs.tip.board.hold ?? '', /^Удерживайте плитку/);
  assert.ok(!/['"`>][^'"`<>\n]*(Удерживайте|Понятно)/.test(read('src/ui/shells/BoardTip.tsx').replace(/\/\/.*$/gm, '')), 'в компоненте нет захардкоженных строк');
});

test('ноутбук (md+): отступ-спейсер скрыт, плашка в правом нижнем углу, а не у сетки колонок слева', () => {
  const src = read('src/ui/shells/BoardTip.tsx');
  assert.match(src, /data-testid="board-tip-spacer" className="md:hidden"/);
  assert.match(src, /md:right-\[var\(--gutter\)\] md:left-auto/);
});
