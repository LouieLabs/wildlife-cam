# Multi-stage build for the Next.js dashboard on Cloud Run.
# syntax=docker/dockerfile:1

# ---- deps: install node_modules from the lockfile ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile the standalone Next.js server ----
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* come from .env.production (committed, public). Server secrets are
# injected at runtime by Cloud Run, not baked in.
RUN npm run build

# ---- runtime: tiny image, just the standalone output ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Cloud Run sends requests to $PORT (8080); Next's standalone server honors it.
ENV PORT=8080
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 8080
CMD ["node", "server.js"]
