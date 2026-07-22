# Multi-stage production image for Fly.io / Docker
FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime ---
FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV DATA_DIR=/data

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Persistent volume is mounted at /data by fly.toml
RUN mkdir -p /data

EXPOSE 8080

# Health: GET /health (configured in fly.toml)
CMD ["node", "dist/index.js"]
