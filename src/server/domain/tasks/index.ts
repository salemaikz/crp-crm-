// Задачи: автозадачи (D-050, tasks/auto.ts) и экран задач B7 (ручные задачи, комментарии, исполнители).
export { closeAutoTaskByKey, closeAutoTasks, ensureAutoTask, listMyOpenTasks, reassignOpenTasks } from './auto';
export {
  COMMENT_MAX,
  TITLE_MAX,
  addComment,
  cancelTask,
  completeTask,
  createTask,
  getTask,
  listAssignees,
  listClientTasks,
  listTaskStaff,
  listTasks,
  seesTeam,
  updateTask,
} from './service';
export { SOURCE_RULES, TASK_SOURCES, isClosable, type SourceRule, type TaskAction } from './sources';
export { createTaskBody, completeTaskBody, commentBody, parseListTasksQuery, updateTaskBody } from './input';
export * from './types';
