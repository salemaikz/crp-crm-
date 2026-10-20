# Вход, сессии, приглашения — дизайн P3 для builder

Нормативно для P3: решения D-091…D-095 (`docs/DECISIONS.md`). Опирается на ARCHITECTURE §5.2,
CONFIG §6.16 (`global.security`), схему v1 (`users`, `sessions`, `invites`, `memberships`), D-054
(мутации безопасности), D-066 (срочное отключение). Сигнатуры уже в коде:
`src/server/platform/auth/*.ts` — тела бросают «P3», builder их заполняет, **сигнатуры не меняет**
(нужна правка — через architect). `getSession(): Promise<SessionInfo | null>` — контракт P4a, неизменен.

Источник переноса: платформа LMS 2cd8a2b `src/lib/auth/{password,tokens,safeNext,session}.ts`
(шапка «Источник: платформа LMS 2cd8a2b <путь>»). Отличия от источника: вход по номеру, а не email;
cookie — непрозрачный токен без HMAC-подписи и без `SESSION_SECRET` (схема v1: `sessions.id` = sha256
токена); нет демо-восстановления сессий; нет писем.

## 1. Файлы

| Файл | Что | Next? |
|---|---|---|
| `src/server/platform/auth/types.ts` | типы и `DEFAULT_SECURITY_POLICY` | нет |
| `auth/session.ts` | `getSession`, `createSession`, `resolveSession`, `revokeSessionByToken`, `revokeAllSessions`, `hashSessionToken` | нет (cookie читает через `http/sessionCookie.ts`) |
| `auth/password.ts` | bcryptjs, политика пароля, список частых паролей `COMMON_PASSWORDS` (~100 строк: цифровые ряды, `password`, `qwerty…`, `йцукен…`, `11111111`) | нет |
| `auth/throttle.ts` | задержка по номеру, блок по IP (§4) | нет |
| `auth/login.ts` | `attemptLogin`, `logoutEverywhere`, `changeOwnPassword`, `loginPhoneDigits`, `maskPhone` | нет |
| `auth/invites.ts` | `issueInvite`, `issuePasswordReset`, `inspectInvite`, `acceptInvite`, `revokePendingInvites`, `inviteLink` | нет |
| `auth/csrf.ts` | `checkOrigin`, `originCheckRequired` | нет |
| `auth/cookie.ts` | `sessionCookieSpec` (имя, Secure) | нет |
| `auth/policy.ts` | `readSecurityPolicy` из `getActiveConfig()` | нет |
| `src/server/platform/http/sessionCookie.ts` (новый) | `readSessionToken()`, `setSessionCookie(s: IssuedSession)`, `clearSessionCookie()` через `cookies()` из `next/headers` | да — единственное место |
| `src/shared/safeNext.ts` (новый) | перенос `safeNext` из источника: им пользуются и форма, и сервер | нет |
| `src/proxy.ts` (новый) | первый рубеж CSRF (§6) | да |
| `src/server/platform/audit.ts` | добавить действия: `user.invite`, `user.invite_accept`, `user.password_reset_issue`, `user.password_reset`, `user.password_change` (+ `'user'` уже в `AuditEntity`) | нет |
| `messages/ru/auth.json` + `'auth'` в `NAMESPACES` | тексты (§8) | — |

Номер: `loginPhoneDigits(raw)` = `parsePhone(raw, { country: 'KZ', mobilePrefixes: [], reviewPrefixes: [],
landlinePrefixes: [] })?.digits ?? null` из `@crm/core/phone` (K1a). Та же функция обязательна там, где
пишется `users.phone_digits` / `invites.phone_digits` (R2a, `crmctl install`) — иначе «8 701…» и «+7 701…»
разойдутся.

## 2. Страницы и API

Все мутации входа — **route handlers** через `publicRoute`/`route` P4a, а не server actions: у входа
и приглашения нет сессии, а `action()` требует `Viewer`. Ответы `Cache-Control: no-store` (обёртка).
Тела — JSON, разбор Zod (`.strict()`), строки ограничены по длине до любой работы.

| Маршрут | Обёртка | Тело → ответ |
|---|---|---|
| `POST /api/auth/login` | `publicRoute({reason:'auth', origin:'check'})` | `{phone ≤32, password ≤256, next? ≤2048}` → 200 `{next}` + Set-Cookie · 400 `{error:'validation'}` · 401 `{error:'invalid', retryAfterSec?}` · 429 `{error:'rate_limited', retryAfterSec}` + `Retry-After` |
| `POST /api/auth/logout` | `publicRoute({reason:'auth', origin:'check'})` | — → 204; удаляет строку по cookie (если есть) и cookie всегда, под обоими именами |
| `POST /api/auth/logout-all` | `route({perm:'authenticated', securityMutation:'auth.logout_all'})` | — → 204; все сессии, включая текущую; cookie удаляется |
| `POST /api/auth/password` | `route({perm:'authenticated', securityMutation:'auth.change_own_password'})` | `{current, next}` → 200 + новая cookie · 400 `{error: PasswordProblem \| 'same_as_current'}` · 401 `{error:'wrong_current'}` · 429 |
| `POST /api/auth/invite/inspect` | `publicRoute({reason:'invite', origin:'check'})` | `{token}` → 200 `{kind, name, phoneMasked}` · 404 `{error:'invalid_token'}` |
| `POST /api/auth/invite/accept` | `publicRoute({reason:'invite', origin:'check'})` | `{token, password}` → 200 `{next:'/'}` + Set-Cookie · 400 `{error: PasswordProblem}` · 404 `{error:'invalid_token'}` |

Лимиты приглашений: `rateLimit('invite:<ip>', 30, 15 мин)` на inspect и accept вместе (токен 256 бит —
лимит бережёт CPU bcrypt, а не от угадывания). Токен идёт **только в теле POST**, никогда в URL и query.

Страницы (`src/app/(auth)/`, без чтения данных на сервере — обёртка `page()` не нужна; P4b учитывает):

- `login/page.tsx` — статическая; клиентская форма: поле номера `type="tel"`, `inputMode="tel"`,
  `autoComplete="username"`, маска `+7 (___) ___-__-__` (принимает и «8…», вставку с пробелами);
  пароль `autoComplete="current-password"`, кнопка «показать». `next` берётся из `?next=` и уходит в
  теле; сервер возвращает проверенный `next`, клиент делает `location.assign(next)` (полная загрузка —
  cookie уже стоит). При `retryAfterSec` кнопка неактивна с обратным отсчётом. Кнопки ≥ 44 px, без
  горизонтальной прокрутки на 360 px. Гостя на защищённую страницу отправляет `page()` P4a на
  `/login?next=<путь>`.
- `invite/page.tsx` — статическая; клиентский компонент при монтировании: `token = location.hash.slice(1)`,
  **сразу** `history.replaceState(null, '', '/invite')` (токен уходит из адресной строки и истории),
  токен — только в состоянии React (не в `localStorage`/`sessionStorage`). Затем inspect → «{name},
  задайте пароль для входа по номеру {phoneMasked}», два поля `autoComplete="new-password"`, подсказка
  правил. Нет токена или 404 — «Ссылка недействительна или устарела. Попросите новую у руководителя».
  Метаданные страницы: `referrer: 'no-referrer'`; в `next.config.ts` для `/invite` заголовки
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. На странице нет сторонних скриптов.
- `account/page.tsx` — под `page({perm:'authenticated'})`: «Сменить пароль» и «Выйти на всех
  устройствах» (подтверждение: «Выйти везде, включая этот телефон?»). Кнопку «Выйти» в оболочках
  (`OperatorShell`, `ManagerShell`) ставят их владельцы: `POST /api/auth/logout` → `/login`.

Админские действия (UI — R2a, домен `team`) зовут функции P3 в своих маршрутах:
`issueInvite`, `issuePasswordReset` (D-054 `team.reset_password`), отключение — `revokeAllSessions` +
`revokePendingInvites` в своей транзакции (D-066, `team.disable_user`). Ссылку администратор видит
**один раз** (в ответе выдачи) и копирует в мессенджер сотруднику; повторно её не показать — только
выдать новую.

## 3. Сессии (D-091, D-092)

- Токен: `randomBytes(32).toString('base64url')` (43 знака). `sessions.id = sha256(token)` hex.
  Украденная копия БД или бэкап не дают рабочих cookie.
- Создание (`createSession`, в транзакции вызывающего): `DELETE … WHERE user_id = $u AND expires_at <= now`;
  `INSERT (id, user_id, created_at=now, expires_at=now+days, last_seen_at=now)`; сверх
  `MAX_SESSIONS_PER_USER` (10) удалить самые давно не использованные; `users.last_login_at = now`;
  аудит `session.login` (entity `session`, entityId = userId, meta `{}`).
- Чтение (`resolveSession`): форма токена → `SELECT s.*, u.status, u.password_hash IS NOT NULL FROM
  sessions s JOIN users u …WHERE s.id = $hash`. Действительна, если `expires_at > now`, `last_seen_at +
  sessionDays·сутки > now` (уменьшение `sessionDays` действует сразу), `status = 'active'`, пароль задан.
  Если `now − last_seen_at ≥ 1 ч` — `UPDATE sessions SET last_seen_at = now, expires_at = now + days
  WHERE id = $hash` и `touched = true`.
- `getSession()` = `readSessionToken()` → `readSecurityPolicy()` → `resolveSession(db.sql, …)`; обёрнут
  в `cache()` React на запрос. Сбой БД пробрасывается (500), а не превращается в «гостя».
- Cookie: имя `__Host-crm_sid` (https) или `crm_sid` (http — только localhost), `HttpOnly`,
  `SameSite=Lax`, `Path=/`, без `Domain`, `Secure` = APP_ORIGIN на https, `Max-Age = sessionDays·86400`.
  Обёртки `route()`/`action()` P4a при `touched` переставляют cookie тем же значением (продление на
  устройстве); страница cookie ставить не может (Next 16) — продление идёт с ближайшим API-запросом.
- Ротация: новая сессия при входе (старая cookie этого браузера удаляется), при принятии приглашения
  или сброса (все сессии сотрудника удаляются), при смене пароля (все удаляются, этому устройству —
  новая). Права при смене роли не требуют ротации: Viewer перечитывается на каждом запросе.
- Отзыв: «выйти» — одна строка; «выйти везде» — все, включая текущую (аудит `session.logout_all`,
  meta `{revoked}`); отключение сотрудника — все сессии + ссылки в транзакции отключения; запрос, уже
  прошедший `getSession`, завершается, следующий — 401. Push-подписки отключённого удаляет `notify`
  (не P3).
- Чистка: job `purge` (03:30) — `DELETE FROM sessions WHERE expires_at < now`, `DELETE FROM invites
  WHERE expires_at < now − 30 дней` (пишет владелец `purge`, P3 только описывает).

## 4. Вход и перебор (D-093)

`attemptLogin(sql, {phone, password, next, ip}, policy, now)`; `ip = deriveClientIp(headers)` (уже в
`http/clientIp.ts`). Окно `W = windowMin`.

1. Пустые поля, пароль > 256 символов, номер не разобран → `validation` (без bcrypt и счётчиков).
2. `checkLogin`: IP — неудач за `W` ≥ `perIp` (для `unknown` — `perIp × 5`) → `rate_limited` до выхода
   старейшей неудачи из окна. Номер — `now < nextAt` → `rate_limited`, `retryAfterMs = nextAt − now`.
   Отказ на этом шаге bcrypt не считает и счётчики не трогает.
3. `SELECT id, password_hash, status FROM users WHERE phone_digits = $d`; `verifyPassword` **всегда**
   (фиктивный хеш для несуществующего номера и `password_hash IS NULL`).
4. Неудача (нет строки, пароль не тот, `status = 'disabled'`) → `recordLoginFailure`: +1 к IP и к
   номеру; при `n ≥ perPhone` неудачах номера за `W` `nextAt = now + min(1 с · 2^(n − perPhone), 30 с)`.
   Ответ `invalid` с `retryAfterMs` (null, если задержки нет) — одинаковый для всех причин.
5. Успех → `recordLoginSuccess` (сброс номера; неудачи IP остаются) → транзакция `createSession` →
   опционально перехеширование, если `bcrypt.getRounds(hash) < BCRYPT_COST`.

Неудачные входы в `audit_log` не пишутся (поток мусора, номер — ПДн). В лог процесса — одна строка
`[auth] login throttled` с причиной, без номера и IP, не чаще раза в минуту на причину.

Остаточный риск (принят, D-093): злоумышленник может держать номер жертвы в задержке 30 с; жертва
входит со второй-третьей попытки. Ценой — онлайн-перебор ограничен ~2 попытками в минуту на номер,
поэтому политика пароля режет частые пароли.

Пароль (`passwordProblem`): ≥ 8 символов; ≤ 72 байт UTF-8 (`too_long`, а не тихое усечение bcrypt);
не из `COMMON_PASSWORDS` и не одна повторённая буква или цифра (`too_common`); не равен цифрам номера
(`same_as_phone`). Стоимость bcrypt 10 (как в источнике и `crmctl`).

## 5. Приглашения и сброс (D-094)

- `invites.kind`: `invite` (новый сотрудник, может нести пространство+роль+команду) и `reset` (сброс
  администратором, без роли). Срок обоих — `security.inviteTtlHours`.
- Выдача: users → invites. `issueInvite` создаёт строку `users` (без пароля) сразу — R2a видит
  «приглашён». Роль самому себе — `self_role` (кроме первого администратора: `crmctl install` создаёт
  его без роли с `created_by` = его id, т. к. `invites.created_by NOT NULL`). Новая ссылка гасит
  прежние неиспользованные ссылки номера. Ссылка — `inviteLink(token)` = `${APP_ORIGIN}/invite#${token}`.
- Принятие: хеш пароля до транзакции; порядок блокировок users → invites (как в источнике
  `tokens.ts`: обратный порядок давал взаимоблокировку); `UPDATE … RETURNING` с `used_at IS NULL AND
  expires_at > now` — из двух параллельных принятий проходит одно. Пароль проверяется политикой с номером
  из ссылки. `memberships` — `ON CONFLICT (user_id, space_id) DO NOTHING` (правка роли администратором
  до принятия важнее ссылки). Затем `revokeAllSessions` и `createSession`.
- Ответы inspect/accept одинаковы для «нет», «использована», «истекла» (`invalid_token`).
- nginx-маска `/invite/` (O2) остаётся вторым рубежом на случай чужого клиента, который положит токен
  в путь; основной путь токена в логи не попадает вовсе.

## 6. CSRF и заголовки (D-095)

- `src/proxy.ts` (matcher — всё, кроме `/_next/static`, `/_next/image`, иконок): если
  `originCheckRequired(method, pathname)` и `checkOrigin(headers) !== 'ok'` → 403
  `{"error":"forbidden"}`. Это закрывает и server actions (POST на путь страницы), и route handlers.
- Второй рубеж — обёртки P4a: `route()` для не-GET, `publicRoute({origin:'check'})` и **`action()`**
  зовут `checkOrigin`. Встроенная проверка Next недостаточна: запрос без `Origin` Next пропускает с
  предупреждением (`docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.md`).
- GET-обработчики ничего не меняют (ревью + `wrappers.test.ts`, если P4b сможет это проверить).
- `APP_ORIGIN` обязателен в production; nginx (O2) передаёт `Host` установки и перезаписывает
  `X-Forwarded-Host`, чтобы проверка Next и наша сходились.

## 7. Тесты

Unit (`tests/unit/platform-auth-*.test.ts`, без БД):
- `hashSessionToken`, форма токена (42/44 знака, `+`, `/` — гость);
- `passwordProblem`: 7/8 символов, 72/73 байта с кириллицей, регистр в списке частых, `11111111`,
  пароль = номер и последние 10 цифр;
- `throttle`: последовательность задержек 0×4, 1, 2, 4, 8, 16, 30, 30 с; отказ до `nextAt` не
  засчитывается; выход неудач из окна снимает задержку; успех сбрасывает номер, но не IP; 30 успешных
  входов с одного IP проходят; IP-блок после `perIp` неудач и снятие по окну; `unknown` — ×5;
  вытеснение ключей не трогает номер под перебором;
- `checkOrigin`: нет, `null`, другой порт, другая схема, хвостовой `/`, верный; `Sec-Fetch-Site`
  cross-site/same-site/same-origin/none; `originCheckRequired` для GET/POST и `/api/ingest/`, `/api/hooks/`;
- `sessionCookieSpec`: https → `__Host-`+Secure; `http://localhost` → без Secure; production + http
  не-localhost и production без APP_ORIGIN → исключение;
- `inviteLink` содержит `#` и не содержит `?`; `maskPhone`; `loginPhoneDigits` на «8 (701) …»,
  «+7 701…», «701…», мусоре; `safeNext` — векторы источника.

Интеграционные (`tests/integration/platform/auth-*.test.ts`, `createTestDb()`, `TEST_DATABASE_URL`):
- сессии: создание → чтение; истечение; касание не чаще часа; уменьшение `sessionDays` гасит старые;
  отключённый и без пароля → null; 11-я сессия вытесняет самую старую; `revokeAllSessions` с
  `exceptSessionId`;
- вход: нет номера и неверный пароль дают один ответ, bcrypt вызван в обоих случаях (подмена через
  внедрение или замер ≥ стоимости); `disabled` → `invalid`; успех пишет `last_login_at` и аудит;
- приглашение: выдача → inspect → accept → пароль, членство, сессия; повтор ссылки → `invalid_token`;
  истекшая; вторая выдача гасит первую; 2 параллельных accept — один успех; параллельные выдача и
  принятие без взаимоблокировки; `reset` закрывает все прежние сессии и не трогает членства;
  `self_role`; отключённый не принимает; `revokePendingInvites`;
- смена пароля: неверный текущий, лимит 5/15 мин, успех удаляет все прежние сессии и выдаёт новую;
- аудит: в `meta` всех записей P3 нет цифр номера, имени и токена (поиск подстрок).

E2E (`tests/e2e/auth.spec.ts`, проекты `iphone-13` и `pixel-7`, синтетика `+7 701 555 01 23`, сотрудник и
ссылка — через помощник фикстур прямо в БД теста):
1. «вход по телефону»: ввод «8 701 555 01 23», пароль → главная; cookie `HttpOnly`, `SameSite=Lax`;
   неверный пароль — текст ошибки, cookie нет; поле номера открывает цифровую клавиатуру
   (`inputmode=tel`); нет горизонтальной прокрутки;
2. приглашение: `/invite#<токен>` → адрес сразу `/invite` без `#`; пароль дважды → вошёл; та же ссылка
   повторно — «Ссылка недействительна»;
3. «выйти везде»: два контекста браузера, выход в первом → второй при следующем переходе на `/login`;
4. POST `/api/auth/login` с чужим `Origin` и без `Origin` → 403.

## 8. Тексты (`messages/ru/auth.json`, нейтрально, без имени клиента)

`auth.login.{title, phone, password, show, submit, invalid, rateLimited ({sec}), validation}`,
`auth.invite.{title ({name}, {phone}), password, repeat, mismatch, rules, submit, invalid}`,
`auth.password.{tooShort, tooLong, tooCommon, sameAsPhone, sameAsCurrent, wrongCurrent}`,
`auth.account.{title, change, current, new, logoutAll, logoutAllConfirm, done}`, `auth.logout`.
Паритет `kk` — когда в `LOCALES` появится `kk`.
