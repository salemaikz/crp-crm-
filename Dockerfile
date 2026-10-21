# Образ CRM: app и worker из одного образа (ARCHITECTURE §8.2, DEPLOY §3.1).
# Сборка: docker build -t crm-app:<версия> --build-arg BUILD_ID=<sha> .
# В образе нет исходников (src/, *.ts), карт кода и packages/core/src: проверяет scripts/check-image.sh.

ARG NODE_IMAGE=node:22-slim

# --- 1. Зависимости (слой кэшируется, пока не менялись package*.json) ---
FROM ${NODE_IMAGE} AS deps
WORKDIR /build
COPY package.json package-lock.json ./
# Рабочее пространство ядра: без его package.json npm ci не создаст ссылку node_modules/@crm/core
COPY packages/core/package.json ./packages/core/package.json
# Секрет npmca (необязателен): корневой сертификат корпоративного прокси —
#   docker build --secret id=npmca,src=/path/ca.pem .
RUN --mount=type=secret,id=npmca,required=false \
    if [ -f /run/secrets/npmca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npmca; fi; \
    npm ci --no-audit --no-fund

# --- 2. Сборка Next (standalone) и CLI-пакетов ---
FROM ${NODE_IMAGE} AS build
WORKDIR /build
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /build/node_modules ./node_modules
COPY . .
# Ядро (D-028, D-101): esbuild + обфускация → packages/core/dist/index.cjs, ДО next build. Сборка клиента:
#   docker build --build-arg CUSTOMER_ID=<клиент> --build-arg BUILD_ID=<id> --build-arg BUILT_AT=$(date +%s%3N) \
#     --secret id=license_keys,src=<keys.json> .
# BUILT_AT (epoch-мс) — время сборки в водяном знаке: лицензия прежней сборки работает в льготе не дольше
# 7 суток от него (D-290). Пусто — build.mjs берёт момент сборки слоя.
# keys.json — JSON { "<kid>": "<открытый ключ Ed25519 base64>" } (только открытые половины; D-211). С CUSTOMER_ID
# без ключей build.mjs падает: образ клиента без ключей не проверил бы ни одну лицензию. Без CUSTOMER_ID —
# общая сборка (стенд, CI): водяного знака нет, лицензии проверяются тестовым ключом репозитория.
ARG CUSTOMER_ID=
ARG BUILD_ID=dev
ARG BUILT_AT=
RUN --mount=type=secret,id=license_keys,required=false \
    set -eu; set --; \
    if [ -n "$CUSTOMER_ID" ]; then set -- --customer "$CUSTOMER_ID" --build-id "$BUILD_ID"; fi; \
    if [ -n "$CUSTOMER_ID" ] && [ -n "$BUILT_AT" ]; then set -- "$@" --built-at "$BUILT_AT"; fi; \
    if [ -s /run/secrets/license_keys ]; then set -- "$@" --license-keys /run/secrets/license_keys; fi; \
    node packages/core/build.mjs "$@"
# Карт кода нет: next.config.ts ставит productionBrowserSourceMaps=false, ниже это ещё и проверяется
RUN npx next build --webpack && mkdir -p public
# Скрипты migrate, crmctl, worker — один минифицированный .mjs на каждый, без исходников в образе.
# Ядро @crm/core в них не вшивается (build-cli.mjs): берётся из образа, тот же обфусцированный dist,
# что у приложения, — лицензия проверяется ключами образа. Без migrate образ не собирается.
RUN node scripts/crmctl/build-cli.mjs --outdir dist
# Страховка: ни одной карты кода в результатах сборки
RUN test -z "$(find .next/standalone .next/static dist -name '*.map' -print -quit)"

# --- 3. Финальный образ ---
FROM ${NODE_IMAGE} AS runtime
ARG BUILD_ID=dev
ARG CUSTOMER_ID=
LABEL org.opencontainers.image.title="crm-app" \
      org.opencontainers.image.revision="${BUILD_ID}" \
      ru.salemai.crm.customer="${CUSTOMER_ID}"
# Отпечаток предпросмотра импорта: «та же версия» = тот же образ (D-113, import-design §6)
ENV CRM_BUILD_ID=${BUILD_ID} \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TZ=UTC
WORKDIR /app
# Всё принадлежит root и только читается: пользователь node (uid 1000) ничего в образе не меняет
COPY --from=build /build/.next/standalone ./
COPY --from=build /build/.next/static ./.next/static
COPY --from=build /build/public ./public
COPY --from=build /build/dist ./dist
# Ядро: только package.json и обфусцированный dist; ссылку node_modules/@crm/core ставит standalone-трассировка,
# её копия ниже страхует случай, когда трассировка её не положила
COPY --from=build /build/packages/core/package.json ./packages/core/package.json
COPY --from=build /build/packages/core/dist ./packages/core/dist
RUN mkdir -p node_modules/@crm && ln -sfn ../../packages/core node_modules/@crm/core
COPY migrations ./migrations
COPY presets ./presets
COPY deploy/postgres/grants.sql ./deploy/postgres/grants.sql
# standalone кладёт копии конфигов и lock-файла; исходников в нём быть не должно
RUN rm -rf /app/src /app/packages/core/src /app/packages/core/build.mjs /app/tests /app/docs /app/next.config.ts /app/tsconfig.json \
    && rm -rf /var/lib/apt/lists/* /root/.npm
# npm, npx, corepack и yarn в рантайме не нужны (меньше поверхность атаки); их пакеты несут .map и .ts
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn* /usr/local/include/node
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# app: server.js; worker — та же сборка, другая команда (dist/worker.mjs); migrate — dist/migrate.mjs.
# --disable-sigusr1: инспектор не открывается сигналом; сборка клиента без него не стартует (D-312)
CMD ["node", "--disable-sigusr1", "server.js"]
