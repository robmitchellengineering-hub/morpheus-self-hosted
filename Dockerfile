# Morpheus frontend — static Vite/React SPA served by nginx, which also
# reverse-proxies /api and /uploads to the backend service so the browser
# only ever talks to one origin (see nginx.conf).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
# Don't copy the server/ or base44/ trees into the frontend image.
RUN rm -rf server base44 public/portable-morpheus/_source
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
