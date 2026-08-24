# Base image for apps built on Chatter.
#
# Chatter is a library: it ships route factories and a server factory, not a
# runnable bot, so this image carries the built package and its production
# dependencies and stops there. An app FROMs it, adds its own config, knowledge
# and entry point, and sets the CMD that calls `createServer` — see
# docs/deployment.md for a complete app Dockerfile.
#
# The build runs on Bun; the built package itself runs on Bun or Node >= 24
# (see the runtime section of README.md).

FROM oven/bun:1.4.0 AS build

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./
COPY src/client/package.json src/client/bun.lock* ./src/client/

# Install dependencies
RUN bun install --frozen-lockfile
RUN cd src/client && bun install --frozen-lockfile

# Copy source code
COPY . .

# One build script produces everything the package publishes: the backend
# bundles, the widget, and the static assets copied alongside them.
RUN bun run build

# Production stage
FROM oven/bun:1.4.0-slim

WORKDIR /app

# Copy package files and install production dependencies only
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

# Copy built artifacts from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/client/dist ./src/client/dist

# The port app images conventionally serve on; nothing listens in this image.
EXPOSE 8181
