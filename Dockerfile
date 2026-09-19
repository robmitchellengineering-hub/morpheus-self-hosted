# Morpheus frontend — static Vite/React SPA served by nginx, which also
# reverse-proxies /api and /uploads to the backend service so the browser
# only ever talks to one origin (see nginx.conf).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
# Keep the frontend image free of the server/ tree and the large base44/
# reference bodies — but NOT all of base44/: `src/components/matrix/
# BackendPanel.jsx` imports `base44/shared/infrastructureComponents.ts` at
# BUILD time, so removing the whole tree fails `npm run build` with
# "Could not resolve ../../../base44/shared/infrastructureComponents".
# That made `docker compose up --build` — the documented self-host path in
# AGENTS.md — unable to build the frontend at all.
#
# So: drop everything under base44/ except shared/, which is what the build
# actually needs. (Moving the file into src/ instead would also mean updating
# scripts/sync-portable-morpheus.mjs, which mirrors base44/ into
# public/portable-morpheus/_source — worth doing, but its own change.)
RUN rm -rf server public/portable-morpheus/_source \
 && find base44 -mindepth 1 -maxdepth 1 ! -name shared -exec rm -rf {} +
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
