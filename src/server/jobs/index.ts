// Фоновые задачи: реестр, воркер, зависимости прогона. Здесь допустим SystemActor.
export { createWorker, type Worker, type WorkerOptions } from './worker';
export { instancesFor, jobDefinitions, queueSpecs, invariantParts, purgeParts } from './registry';
export { makeRunnerDeps, consoleJobLogger } from './deps';
export { calendarFromConfig } from './calendar';
