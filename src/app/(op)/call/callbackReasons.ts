// Причины перезвона для шторки (pipeline-v2 §4.1): только ручные и не архивные. Системные (`manual: false`) ставит
// сама система, сервер отклоняет их от человека (`reason_unknown`), поэтому на устройство они не уходят.
import type { ReasonOption } from '@/ui/call/types';

type RawReason = { key: string; label: { ru: string }; needsText: boolean; archived?: boolean | undefined; manual?: boolean | undefined };

export function manualCallbackReasons(list: readonly RawReason[]): ReasonOption[] {
  return list.filter((r) => r.archived !== true && r.manual !== false).map((r) => ({ key: r.key, label: r.label.ru, needsText: r.needsText }));
}
