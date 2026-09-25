# syntax=docker/dockerfile:1.7
# TuneX unified application image.
#
# One immutable image contains both application runtimes:
#   - Backend / Worker / DB migration: Bun + Prisma
#   - Web: Next.js standalone on Node 24
#
# Compose still runs one process per container. MySQL, Redis, Caddy and Agent
# remain separate artifacts with independent lifecycles.

FROM node:24-bookworm-slim AS web-deps
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci

FROM web-deps AS web-builder
WORKDIR /build/web
COPY web/tsconfig.json ./
COPY web/next.config.ts ./
COPY web/postcss.config.mjs ./
COPY web/next-env.d.ts ./
COPY web/src ./src
COPY web/public ./public

ARG NEXT_PUBLIC_API_BASE=
ARG NEXT_PUBLIC_API_MOCK=0
ARG NEXT_PUBLIC_PAYMENTS_ENABLED=false
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE} \
    NEXT_PUBLIC_API_MOCK=${NEXT_PUBLIC_API_MOCK} \
    NEXT_PUBLIC_PAYMENTS_ENABLED=${NEXT_PUBLIC_PAYMENTS_ENABLED}
RUN npm run build

FROM oven/bun:1-debian AS backend-builder
WORKDIR /build/backend
COPY backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile
COPY backend/prisma ./prisma
RUN bunx prisma generate
COPY backend/tsconfig.json ./
COPY backend/src ./src

# Source Node from the official image so Next.js standalone always runs on the
# same major version CI validates. The final base remains Bun's Debian image.
FROM node:24-bookworm-slim AS node-runtime

FROM oven/bun:1-debian AS runtime
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

# Backend keeps Prisma CLI because db-migrate is a runtime role of this image.
COPY --from=backend-builder /build/backend /app/backend

# Next standalone includes the minimal server/runtime dependency graph. Static
# and public assets are copied separately per Next.js standalone requirements.
COPY --from=web-builder /build/web/.next/standalone /app/web
COPY --from=web-builder /build/web/.next/static /app/web/.next/static
COPY --from=web-builder /build/web/public /app/web/public

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app/backend
EXPOSE 3000 3001

# Default role is the API. Compose overrides command/working_dir for worker,
# db-migrate and web while reusing this exact image digest.
CMD ["bun", "src/index.ts"]
