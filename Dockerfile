FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.mts svelte.config.mjs ./
COPY src ./src
COPY frontend ./frontend
RUN npm run build

FROM node:22-alpine AS runner

# Runtime shared lib for the better-sqlite3 native addon (musl build links
# libstdc++/libgcc). Builder had these via g++; the runner needs them too.
# ffmpeg/ffprobe power the custom thumbnail generator (frame sampling for
# episodes Plex keeps giving blank stills).
RUN apk add --no-cache libstdc++ ffmpeg

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
