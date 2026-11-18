# Build stage
# Rollup's native parser hits its stack guard on Alpine/musl with the locked
# dependencies. Use glibc for the build; the nginx runtime stays independent.
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Runtime stage
FROM nginx:alpine

# SPA routing + API proxy to backend service
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
