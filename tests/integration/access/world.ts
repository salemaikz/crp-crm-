// Общая подготовка интеграционных тестов доступа: временная схема Postgres 16 + синтетика прогона.
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { resetAccessForTests } from '../../../src/server/access/testing';
import { seedIsolation } from '../../isolation/harness/seed';
import { enterSeedWorld } from '../../isolation/harness/actors';

export async function openWorld(): Promise<TestDb> {
  const db = await createTestDb();
  await seedIsolation(db.sql);
  enterSeedWorld();
  return db;
}

export async function closeWorld(db: TestDb): Promise<void> {
  resetAccessForTests();
  await db.close();
}
