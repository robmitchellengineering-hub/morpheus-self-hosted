# Morpheus backend — Express + Prisma/Postgres. Same image is used for the
# API server (src/index.js) and the background worker (src/worker.js); which
# one runs is chosen by CMD/command in docker-compose.yml so both scale
# independently from a single build.
FROM node:20-alpine AS base
WORKDIR /app

# Alpine's node image ships OpenSSL 3.x with no libssl.so.1.1, but without
# openssl present at all during `prisma generate`, Prisma can't detect the
# libssl version and silently defaults to the wrong musl engine target —
# it builds fine, then crash-loops at runtime with "Error loading shared
# library libssl.so.1.1: No such file or directory" (seen on first deploy,
# 2026-08-26). Installing openssl before `prisma generate` fixes detection
# for both the build and runtime environment (same base image, single stage).
RUN apk add --no-cache openssl

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY PORTING_GUIDE.md ./

ENV NODE_ENV=production
EXPOSE 4500

CMD ["node", "src/index.js"]
