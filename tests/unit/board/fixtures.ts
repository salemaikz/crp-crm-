// Синтетические плитки и настройки доски для юнит-тестов. Названия выдуманные, номера +7 709 …
import type { BoardCardDto, BoardColumnConfig, BoardConfig } from '@/ui/board/types';
import type { CallConfig, OutcomeButton } from '@/ui/call/types';

export function card(over: Partial<BoardCardDto> = {}): BoardCardDto {
  return {
    id: 'card-1',
    clientId: 'client-1',
    name: 'ТОО Синтетика 1',
    state: 'new',
    version: 1,
    column: 'new',
    nextCallAt: null,
    nextCallPrecision: 'time',
    fire: null,
    callbackReason: '',
    callbackTouches: 0,
    attempts: 0,
    lpr: '',
    isTarget: '',
    lprName: '',
    phone: { id: 'ph-1', masked: '+7 709 ••• •• 67', digits: '77091234567' },
    flags: { attendedGroup: false, attendedIndividual: false, noShow: false },
    event: null,
    closedAt: null,
    closeReasonCode: '',
    values: {},
    ...over,
  };
}

export const COLUMNS: BoardColumnConfig[] = [
  { key: 'new', label: 'Новые', role: 'new', states: ['new'], drop: [], dropMore: false },
  { key: 'callback', label: 'Перезвон', role: 'callback', states: ['retry', 'callback'], drop: [], dropMore: false },
  { key: 'meet', label: 'Встреча', role: 'agreed', states: ['agreed'], drop: [], dropMore: false },
  { key: 'paid', label: 'Покупка', role: 'client', states: ['client'], drop: [], dropMore: false },
  {
    key: 'trash',
    label: 'Мусор',
    role: 'trash',
    states: ['not_interested', 'not_target', 'do_not_call', 'written_off'],
    drop: [
      { kind: 'not_target', reason: 'closed', label: 'Закрыл компанию' },
      { kind: 'not_interested', reason: 'no_need', label: 'Не нужны услуги' },
      { kind: 'written_off', reason: 'unreachable', label: 'Не отвечает' },
    ],
    dropMore: true,
  },
];

const requires = { lpr: false, reason: false, callbackAt: false, contact: false, agreement: false, fields: [] as string[] };

export const OUTCOMES: OutcomeButton[] = [
  { key: 'no_answer', kind: 'no_answer', label: 'Не берёт', color: 'x', requires, reasons: [] },
  { key: 'callback', kind: 'callback', label: 'Перезвонить', color: 'x', requires: { ...requires, reason: true, callbackAt: true }, reasons: [{ key: 'think', label: 'Подумает', needsText: false }] },
  { key: 'agreed', kind: 'agreed', label: 'Договорились', color: 'x', requires: { ...requires, agreement: true }, reasons: [] },
  {
    key: 'not_interested',
    kind: 'not_interested',
    label: 'Не интересует',
    color: 'x',
    requires: { ...requires, reason: true },
    reasons: [
      { key: 'no_need', label: 'Не нужны услуги', needsText: false },
      { key: 'later', label: 'Позже', needsText: false },
      { key: 'other', label: 'Другое', needsText: true },
    ],
  },
  { key: 'not_target', kind: 'not_target', label: 'Не целевой', color: 'x', requires: { ...requires, reason: true }, reasons: [{ key: 'closed', label: 'Закрыл компанию', needsText: false }] },
];

export const CALL: CallConfig = {
  userId: 'u1',
  outcomes: OUTCOMES,
  undoMs: 5000,
  lprNoRequiresInfo: false,
  lprRequiredOnContact: true,
  outcomeFields: {},
  callbackPresets: [],
  callbackV2: true,
  callbackSchedule: null,
  callWindowStart: '09:00',
  callsPerHourTarget: null,
  timeZone: 'Asia/Almaty',
  calendar: { workdays: [1, 2, 3, 4, 5], holidays: [] },
  cardFields: [],
};

export const CONFIG: BoardConfig = {
  call: CALL,
  columns: COLUMNS,
  writeOffReasons: [
    { key: 'unreachable', label: 'Не отвечает', needsText: false },
    { key: 'other', label: 'Другое', needsText: true },
  ],
  reasonLabels: { think: 'Подумает' },
  eventLabels: {},
  attendLabels: { attendedGroup: 'БР', attendedIndividual: 'БК' },
  canMove: true,
  scope: 'own',
  canPurchases: true,
  undoMs: 5000,
  canAttend: false,
  eventBehaviors: { meet: 'group', consult: 'individual' },
  agreedExit: { enabled: true, noShowReasons: { meet: 'no_show_meet', consult: 'no_show_consult' }, attendedReason: 'attended_no_buy', noShowCallback: { kind: 'nextWorkday', time: '10:00' } },
};
