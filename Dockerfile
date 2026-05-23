# Multi-stage build for poker-server.
# The poker-engine sibling dependency is copied in at build time so the
# `file:../poker-engine` reference in package.json resolves inside the image.

# -- Stage 1: install all deps and build TypeScript --
FROM node:20-alpine AS builder
WORKDIR /build

# Copy the sibling engine first so `file:../poker-engine` resolves.
COPY poker-engine /build/poker-engine
COPY poker-server/package.json poker-server/package-lock.json* /build/poker-server/
WORKDIR /build/poker-server
RUN npm install --no-audit --no-fund
COPY poker-server/tsconfig.json /build/poker-server/
COPY poker-server/src /build/poker-server/src
RUN npm run build

# -- Stage 2: prod deps only --
FROM node:20-alpine AS deps
WORKDIR /build
COPY poker-engine /build/poker-engine
COPY poker-server/package.json poker-server/package-lock.json* /build/poker-server/
WORKDIR /build/poker-server
RUN npm install --omit=dev --no-audit --no-fund

# -- Stage 3: runtime --
FROM node:20-alpine AS runtime
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

# Engine dist (poker-engine's package.json points main to dist/index.js).
COPY --from=builder /build/poker-engine /app/poker-engine

# Server app
COPY --from=builder /build/poker-server/dist /app/poker-server/dist
COPY --from=builder /build/poker-server/package.json /app/poker-server/package.json
COPY --from=deps    /build/poker-server/node_modules /app/poker-server/node_modules

WORKDIR /app/poker-server
USER app
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

CMD ["node", "dist/index.js"]
