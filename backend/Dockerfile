# Locked Swagger Parser requires Node >=22.19; better-sqlite3 requires Node >=22.
FROM node:22-bookworm-slim

# Native build dependencies for better-sqlite3
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY backend/ ./

# Starter kit data (read-only inputs) available for folder import/seed
COPY specs /app/specs
COPY consumers /app/consumers

ENV NODE_ENV=production
ENV PORT=5000
ENV DB_PATH=/data/contract-guard.db
ENV SPECS_DIR=/app/specs
ENV CONSUMERS_DIR=/app/consumers

EXPOSE 5000

CMD ["node", "src/server.js"]
