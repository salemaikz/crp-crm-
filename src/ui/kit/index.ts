// UI-кит CRM (перенесён из платформы LMS 2cd8a2b, адаптирован). Стили — kit.css, токены — ../tokens.css.
// Правила: одна главная (primary) кнопка на экран · цели нажатия ≥ 44 px · не больше одного слоя
// модалок · состояние = цвет + значок + текст · у пустого списка есть EmptyState.
// Клиентские: Overlay, Modal, BottomSheet, Toast, Tabs, PasswordInput, SubmitButton.
export { cn } from './cn';
export { Button, buttonClass, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { SubmitButton } from './SubmitButton';
export { TextLink } from './TextLink';
export { Card } from './Card';
export { Badge, type BadgeTone } from './Badge';
export { Chip, ChipGroup } from './Chip';
export { Container } from './Container';
export { Field } from './Field';
export { Input, Select, Textarea } from './Input';
export { Checkbox } from './Checkbox';
export { PasswordInput } from './PasswordInput';
export { Alert } from './Alert';
export { ProgressBar } from './ProgressBar';
export { EmptyState } from './EmptyState';
export { Tabs, type TabItem } from './Tabs';
export { Table, type TableColumn } from './Table';
export { List, ListItem } from './List';
export { Avatar, initials } from './Avatar';
export { Stat } from './Stat';
export { Breadcrumbs, type Crumb } from './Breadcrumbs';
export { PageHeader } from './PageHeader';
export { Modal } from './Modal';
export { BottomSheet } from './BottomSheet';
export type { OverlayProps } from './Overlay';
export { ToastProvider, useOptionalToast, useToast } from './Toast';
export type { ToastInput, ToastTone } from './toastState';
