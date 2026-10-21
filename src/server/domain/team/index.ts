// Модуль «Сотрудники» (R2a): единственная точка входа для интерфейса и API.
export { listStaff, inviteStaff, resendInvite, revokeInvite, resetPassword, updateStaff, disableStaff } from './service';
export type { DisableDeps, DisableResult } from './service';
export { InviteInput, ResendInput, UpdateInput, DisableInput, UserId, TransferBulkInput, TransferOneInput, TransferPreviewQuery, TransferTo } from './schemas';
export type { HandoverInput, HandoverMode, HandoverPreview, HandoverResult, HandoverSpaceResult, StaffHandover } from './handover';
export { handoverPreview, staffHandover } from './handover';
export { listTransferStaff, previewBulk, requireBulkFeature, transferBulk, transferOne } from './transfer';
export type { TransferBulkResult, TransferOneResult, TransferPreview, TransferStaffItem, TransferStaffList } from './transfer';
export { purgeChangeSnapshots } from './purge';
export { planEven, groupFamilies } from './plan';
export type { IssuedLink, InviteState, RoleOption, StaffList, StaffRow, StaffStatus } from './types';
