// Типы экрана задач: DTO сервера (только типы) и то, что страница передаёт клиентским компонентам.
import type { TaskAssignee, TaskBucket, TaskCommentDto, TaskDetail, TaskList, TaskRow, TaskView } from '@/server/domain/tasks';

export type { TaskAssignee, TaskBucket, TaskCommentDto, TaskDetail, TaskList, TaskRow, TaskView };

export type StaffOption = { userId: string; name: string };

/** Что можно зрителю на экране (считает сервер страницы). */
export type ScreenCan = {
  /** Вкладки «Команда» и «Без исполнителя». */
  team: boolean;
  /** «+ Задача». */
  create: boolean;
  /** Ссылки над списком: «Мои перезвоны», «Записи → Напомнить». */
  callbacks: boolean;
  remind: boolean;
};
