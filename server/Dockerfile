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
#
# chromium + its runtime libs (2026-09-15, selfDevTools.js's
# screenshot_preview tool): Puppeteer's own bundled Chromium download
# doesn't work reliably on Alpine's musl libc, so the server depends on
# `puppeteer-core` (no bundled download) pointed at Alpine's own `chromium`
# package instead, via CHROMIUM_PATH below. This adds real image size and,
# transiently, real memory per screenshot call — a deliberate tradeoff, see
# selfDevTools.js's own comment for why it's still run in-process rather
# than via a GitHub Actions runner.
#
# python3 (2026-09-15, syntaxCheck.js's Python check): every build turn's
# syntax gate used to be a complete no-op for Python files (esbuild only
# parses JS/TS) — a truncated or malformed Python file sailed straight
# through to being committed, only ever caught later when a real compile
# failed or the operator hit a runtime crash. Real CPython (ast.parse) is
# the same "use the actual toolchain, don't reimplement a parser" approach
# already used for JS via esbuild.
RUN apk add --no-cache openssl chromium nss freetype harfbuzz ca-certificates font-freefont python3
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY PORTING_GUIDE.md ./

ENV NODE_ENV=production
EXPOSE 4500

CMD ["node", "src/index.js"]
