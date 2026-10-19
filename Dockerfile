# AI Operations Studio — web paneli ve görev işleyicisi için tek imaj.
# Web:     npm run start      (Render "web" servisi)
# İşleyici: npm run worker    (Render "background worker")

FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
# ffmpeg: video kurgu · fonts: görsel derleme ve altyazı · postgresql-client-17: günlük yedek (pg_dump)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg ffmpeg fonts-dejavu-core \
 && install -d /usr/share/keyrings \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM base AS runner
ENV NODE_ENV=production \
    APP_MODE=production \
    STORAGE_DRIVER=s3 \
    PORT=3000
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
