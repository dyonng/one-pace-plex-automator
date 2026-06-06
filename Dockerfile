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
RUN apk add --no-cache libstdc++

WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

ENV NODE_ENV=production
EXPOSE 8282

CMD ["node", "dist/index.js"]
