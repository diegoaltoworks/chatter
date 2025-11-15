# Multi-stage build for Chatter chatbot framework
FROM oven/bun:1 AS build

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./
COPY src/client/package.json src/client/bun.lock* ./src/client/

# Install dependencies
RUN bun install --frozen-lockfile
RUN cd src/client && bun install --frozen-lockfile

# Copy source code
COPY . .

# Build backend
RUN bun run build:backend

# Build client widgets
RUN bun run build:client

# Production stage
FROM oven/bun:1-slim

WORKDIR /app

# Copy package files and install production dependencies only
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

# Copy built artifacts from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/client/dist ./src/client/dist
COPY --from=build /app/public ./public

# Copy necessary runtime files
COPY --from=build /app/src/types.ts ./src/types.ts

# Expose port (default for Chatter)
EXPOSE 8181

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun --eval "fetch('http://localhost:8181/healthz').then(r => r.ok ? process.exit(0) : process.exit(1))" || exit 1

# Run the server
CMD ["bun", "run", "dist/index.js"]
