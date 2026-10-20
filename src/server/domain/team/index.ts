// Модуль «Сотрудники» (R2a): единственная точка входа для интерфейса и API.
export { listStaff, inviteStaff, resendInvite, revokeInvite, resetPassword, updateStaff, disableStaff } from './service';
export type { DisableDeps, DisableResult } from './service';
export { InviteInput, ResendInput, UpdateInput, DisableInput, UserId } from './schemas';
export type { HandoverInput, HandoverMode, HandoverResult, StaffHandover } from './handover';
export { stubHandover } from './handover';
export type { IssuedLink, InviteState, RoleOption, StaffList, StaffRow, StaffStatus } from './types';
