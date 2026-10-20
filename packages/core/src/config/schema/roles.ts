// Раздел ролей `global.roles[]` (CONFIG §6.10, D-016).
// P4a подключит: схему роли (`grants {perm, scope}`, `relations`, `readOnly`, `fieldAccessDefault`, `menu`)
// из packages/core/src/access и `roleValidator`. До этого здесь только конверт — `key` и `label`
// проверяются, остальные поля роли не проверяются (тип unknown). Это единственное место схемы, где
// неизвестные поля пропускаются; после P4a — `.strict()` как везде (D-060 отвергает passthrough).
import { z } from 'zod';
import { Archived, I18n, Key } from './primitives.js';

export const RoleSlot = z
  .object({
    key: Key,
    label: I18n,
    archived: Archived,
  })
  .catchall(z.unknown());
export type RoleSlotV1 = z.infer<typeof RoleSlot>;
