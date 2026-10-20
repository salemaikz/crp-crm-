# Образ CRM: app и worker из одного образа (ARCHITECTURE §8.2, DEPLOY §3.1).
# Сборка: docker build -t crm-app:<версия> --build-arg BUILD_ID=<sha> .
# В образе нет исходников (src/, *.ts), карт кода и packages/core/src: проверяет scripts/check-image.sh.

ARG NODE_IMAGE=node:22-slim

# --- 1. Зависимости (слой кэшируется, пока не менялись package*.json) ---
FROM ${NODE_IMAGE} AS deps
WORKDIR /build
COPY package.json package-lock.json ./
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
# Карт кода нет: next.config.ts ставит productionBrowserSourceMaps=false, ниже это ещё и проверяется
RUN npx next build --webpack && mkdir -p public
# Скрипты migrate, crmctl, worker — один минифицированный .mjs на каждый, без исходников в образе.
# Собираем те точки входа, что уже есть в репозитории; без migrate образ не собирается.
RUN set -eu; mkdir -p dist; \
    for pair in scripts/db-migrate.ts:migrate scripts/crmctl/index.ts:crmctl scripts/worker/index.ts:worker; do \
      src="${pair%%:*}"; out="${pair##*:}"; \
      if [ -f "$src" ]; then \
        npx esbuild "$src" --bundle --platform=node --target=node22 --format=esm --minify \
          --banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" \
          --outfile="dist/$out.mjs"; \
      elif [ "$out" = migrate ]; then echo "нет $src" >&2; exit 1; \
      else echo "пропуск $out: нет $src"; fi; \
    done
# Страховка: ни одной карты кода в результатах сборки
RUN test -z "$(find .next/standalone .next/static dist -name '*.map' -print -quit)"

# --- 3. Финальный образ ---
FROM ${NODE_IMAGE} AS runtime
ARG BUILD_ID=dev
ARG CUSTOMER_ID=
LABEL org.opencontainers.image.title="crm-app" \
      org.opencontainers.image.revision="${BUILD_ID}" \
      ru.salemai.crm.customer="${CUSTOMER_ID}"
ENV NODE_ENV=production \
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
COPY migrations ./migrations
COPY presets ./presets
COPY deploy/postgres/grants.sql ./deploy/postgres/grants.sql
# standalone кладёт копии конфигов и lock-файла; исходников в нём быть не должно
RUN rm -rf /app/src /app/packages /app/tests /app/docs /app/next.config.ts /app/tsconfig.json \
    && rm -rf /var/lib/apt/lists/* /root/.npm
# npm, npx, corepack и yarn в рантайме не нужны (меньше поверхность атаки); их пакеты несут .map и .ts
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn* /usr/local/include/node
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# app: server.js; worker — та же сборка, другая команда (dist/worker.mjs); migrate — dist/migrate.mjs
CMD ["node", "server.js"]
