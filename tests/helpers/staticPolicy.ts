// Явные списки исключений для статических тестов. Менять — осознанно и с ревью: каждое слово здесь
// ослабляет проверку. Новые публичные маршруты добавляются только вместе с publicRoute() и записью
// в tests/isolation/manifest/<модуль>.ts с perm: 'public'.
import type { WrapperPolicy } from './wrapperRules';

export const STATIC_POLICY: WrapperPolicy = {
  publicRoutes: {
    'POST /api/auth/login': 'auth',
    'POST /api/auth/invite/accept': 'invite',
    'POST /api/auth/invite/inspect': 'invite',
    'GET /api/health': 'health',
  },
  // ARCHITECTURE §5.2: единственный маршрут вне обёртки — healthcheck без данных и без БД
  unwrappedByDesign: ['GET /api/health'],
  // Вход (P3) написан до обёрток P4a и сам проверяет Origin и сессию; P3 переводит на publicRoute()/route().
  legacyUnwrapped: {
    'POST /api/auth/login': 'P3: publicRoute({ reason: auth })',
    'POST /api/auth/invite/accept': 'P3: publicRoute({ reason: invite })',
    'POST /api/auth/invite/inspect': 'P3: publicRoute({ reason: invite })',
    'POST /api/auth/logout': 'P3: route({ perm: authenticated })',
    'POST /api/auth/logout-all': 'P3: route({ perm: authenticated })',
    'POST /api/auth/password': 'P3: route({ perm: authenticated })',
    'GET /account': 'P3: page({ perm: authenticated })',
  },
};
