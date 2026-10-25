# Multi-stage production Dockerfile for Cloud Mail Ingestion Worker
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./
RUN npm ci

# Copy application source
COPY . .

# Build application if needed
RUN npm run build || true

# Production runner image
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# Install tini for proper signal forwarding and zombie reaper
RUN apk add --no-cache tini

# Copy dependencies and application from builder
COPY --from=builder /app /app

# Expose health check port
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "node_modules/.bin/tsx", "src/mail/worker.ts"]
