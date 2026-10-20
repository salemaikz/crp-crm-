// Часть ночной сверки `invariants` (D-066): рабочие карточки без владельца. Только число, без id и ПДн.
import { getDb } from '@/server/platform/db';
import { countOwnerlessWorking } from './repo';
import type { CountOwnerlessWorkingCards } from './types';

export const countOwnerlessWorkingCards: CountOwnerlessWorkingCards = async () => countOwnerlessWorking((await getDb()).sql);
