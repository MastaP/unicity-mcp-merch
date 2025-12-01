FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/build ./build

# Create directories
RUN mkdir -p /app/data /app/assets

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV ASSETS_DIR=/app/assets

# Required environment variables (must be set at runtime):
# MCP_NAMETAG - The nametag for this MCP server (e.g., "merch-mcp")
# PAYMENT_COIN_ID - The coin ID for payments
#
# Optional environment variables:
# MCP_PRIVATE_KEY_HEX - Private key (generated if not provided)
# NOSTR_RELAY_URL - Nostr relay URL
# AGGREGATOR_URL - Unicity aggregator URL
# AGGREGATOR_API_KEY - Aggregator API key
# PAYMENT_TIMEOUT_SECONDS - Payment confirmation timeout
# HTTP_PORT - Port for HTTP transport (default 3001)

EXPOSE 3001

CMD ["node", "build/index.js"]
