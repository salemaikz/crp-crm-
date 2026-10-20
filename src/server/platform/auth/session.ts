// Контракт сессии между входом (P3) и ядром доступа (P4a).
// Реализацию пишет P3: cookie + bcryptjs, без JWT. До влития P3 вызов падает.

export type SessionInfo = {
  userId: string;
  sessionId: string;
  issuedAt: number; // epoch-мс
};

export async function getSession(): Promise<SessionInfo | null> {
  throw new Error('getSession: не реализовано (задача P3)');
}
