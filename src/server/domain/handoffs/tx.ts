// Транзакция действия над передачей: своя, с повтором при взаимной блокировке (как у сделок и записи).
// Повтор безопасен: идемпотентность — `client_events.id = opId`.
export { inDealsTx as inHandoffsTx } from '@/server/domain/deals/tx';
