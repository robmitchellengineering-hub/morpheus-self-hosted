# Morpheus backend — Express + Prisma/Postgres. Same image is used for the
# API server (src/index.js) and the background worker (src/worker.js); which
# one runs is chosen by CMD/command in docker-compose.yml so both scale
# independently from a single build.
FROM node:20-alpine AS base
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY PORTING_GUIDE.md ./

ENV NODE_ENV=production
EXPOSE 4500

CMD ["node", "src/index.js"]
