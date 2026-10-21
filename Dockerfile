FROM node:22.23.3-alpine AS builder

# eMudhra workaround (2026-10-21): the fixed node:22.23.4-alpine images were
# still unpublished on Docker Hub (empty manifest), so the base stays on
# 22.23.3 and TLS trust comes from the OS store instead of Node's bundled
# roots. --use-openssl-ca makes Node verify against /etc/ssl/certs, and the
# ca-certificates install below pulls Alpine's fixed release (20261020-r0).
# Revert to node:22.23.4-alpine and drop this flag once its manifest lands.
ENV NODE_OPTIONS=--use-openssl-ca

RUN apk add --no-cache python3 make g++ ca-certificates

WORKDIR /app
COPY package*.json ./
RUN npm ci
# CHANGELOG.md is baked into the frontend bundle (What's New modal).
COPY tsconfig.json vite.config.mts svelte.config.mjs CHANGELOG.md ./
COPY src ./src
COPY frontend ./frontend
RUN npm run build

FROM node:22.23.3-alpine AS runner

# Same eMudhra workaround as the builder stage: OS store instead of bundled roots.
ENV NODE_OPTIONS=--use-openssl-ca

# Runtime shared lib for the better-sqlite3 native addon (musl build links
# libstdc++/libgcc). Builder had these via g++; the runner needs them too.
# ffmpeg/ffprobe power the custom thumbnail generator (frame sampling for
# episodes Plex keeps giving blank stills).
RUN apk add --no-cache libstdc++ ffmpeg ca-certificates

WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

ENV NODE_ENV=production
EXPOSE 8282

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q -O- "http://localhost:${DASHBOARD_PORT:-8282}/api/health" || exit 1

CMD ["node", "dist/index.js"]
