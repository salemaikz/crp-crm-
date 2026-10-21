// Явные списки исключений для статических тестов. Менять — осознанно и с ревью: каждое слово здесь
// ослабляет проверку. Новые публичные маршруты добавляются только вместе с publicRoute() и записью
// в tests/isolation/manifest/<модуль>.ts с perm: 'public'.
import type { WrapperPolicy } from './wrapperRules';

export const STATIC_POLICY: WrapperPolicy = {
  publicRoutes: {
    'GET /api/health': 'health',
    // Логотип клиента (D-333): публичный ресурс без данных, файл только из настроек и каталога ассетов
    'GET /api/brand/logo': 'asset',
    // Вход и приглашения (P3, auth-design §2): до сессии, Origin проверяет publicRoute
    'POST /api/auth/login': 'auth',
    'POST /api/auth/logout': 'auth',
    'POST /api/auth/invite/inspect': 'invite',
    'POST /api/auth/invite/accept': 'invite',
    // Приём лидов ingest/v1 (INTEGRATIONS §5): доступ по ключу источника, не по сессии; снаружи закрыт nginx
    'POST /api/ingest/v1/leads': 'ingest',
    'GET /api/ingest/v1/demand': 'ingest',
    // Вебхуки плагинов (INTEGRATIONS §4, D-268): доступ по токену пути (в БД sha256) и verify() плагина
    'POST /api/hooks/[pluginId]/[token]': 'webhook',
  },
  // ARCHITECTURE §5.2: вне обёртки — healthcheck без данных и без БД и корневой layout: он читает
  // только тему и язык из настроек (нужны и странице входа), данных клиентов в нём нет.
  unwrappedByDesign: ['GET /api/health', 'GET /layout'],
  // Код, написанный до обёрток P4a. Сейчас пусто — вход переведён на publicRoute()/route().
  legacyUnwrapped: {},
};
