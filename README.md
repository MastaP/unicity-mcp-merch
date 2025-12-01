# Sphere MCP Merch Server

MCP (Model Context Protocol) server for the Unicity merchandise store. Provides LLM access to browse and purchase Unicity-branded merchandise using UCT tokens via Nostr.

## Features

- **Product Catalog**: T-shirts, hoodies, mugs, caps with images
- **Order Management**: Create orders, track status
- **Nostr Integration**: Payment requests sent via Nostr protocol
- **Unicity Blockchain**: Uses nametags for identity and payment routing
- **Auto Identity**: Server creates its own blockchain identity on first run
- **HTTP Transport**: Supports both legacy SSE and modern Streamable HTTP

## Available Products

| ID | Name | Price | Sizes |
|----|------|-------|-------|
| `tshirt-black` | Unicity Black T-Shirt | 25 UCT | S, M, L, XL, XXL |
| `tshirt-white` | Unicity White T-Shirt | 25 UCT | S, M, L, XL, XXL |
| `hoodie-black` | Unicity Black Hoodie | 50 UCT | S, M, L, XL, XXL |
| `mug-classic` | Unicity Classic Mug | 15 UCT | - |
| `cap-black` | Unicity Black Cap | 20 UCT | - |

## MCP Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `list_products` | `category` (optional) | List all merchandise with prices |
| `get_product` | `product_id` | Get product details with image |
| `place_order` | `unicity_id`, `product_id`, `quantity`, `size` | Place an order (initiates payment) |
| `confirm_order` | `unicity_id`, `order_id` | Wait for payment confirmation |
| `get_orders` | `unicity_id` | Get all orders for a user |
| `get_wallet_balance` | `password` | Get MCP wallet balance (admin) |

## HTTP Endpoints

The server runs on HTTP (default port 3001) with two transport protocols:

### Legacy SSE (MCP Inspector, older clients)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sse` | GET | Establish SSE stream, returns POST endpoint |
| `/messages?sessionId=xxx` | POST | Send JSON-RPC messages |

### Streamable HTTP (modern clients)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | Send JSON-RPC requests |
| `/mcp` | GET | SSE stream for responses |

### Health Check

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Returns `{ status, sseSessions, httpSessions }` |

## Quick Start

### 1. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with required values:
```env
MCP_NAMETAG=merch-mcp
PAYMENT_COIN_ID=your_coin_id_here
```

### 2. Add Product Images

Place product images in the `assets/` directory:
- `tshirt-black.png`
- `tshirt-white.png`
- `hoodie-black.png`
- `mug-classic.png`
- `cap-black.png`

### 3. Run with Docker Compose

```bash
docker compose up -d
```

### 4. View Logs

```bash
docker compose logs -f
```

## Testing the MCP

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Then in the browser UI, select "SSE" transport and enter URL: `http://localhost:3001/sse`

### Health Check

```bash
curl http://localhost:3001/health
```

## Example Workflow

1. **User lists available products:**
   ```
   Tool: list_products
   ```

2. **User views a product with image:**
   ```
   Tool: get_product
   Args: { "product_id": "tshirt-black" }
   ```

3. **User places an order:**
   ```
   Tool: place_order
   Args: { "unicity_id": "alice", "product_id": "tshirt-black", "quantity": 1, "size": "M" }
   ```

4. **Payment request is sent.** The user receives a payment request in their Unicity wallet.

5. **User confirms payment:**
   ```
   Tool: confirm_order
   Args: { "unicity_id": "alice", "order_id": "abc123" }
   ```

6. **On successful payment, order is confirmed.**

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_NAMETAG` | Yes | - | Nametag for this MCP server |
| `PAYMENT_COIN_ID` | Yes | - | Coin ID for payments |
| `MCP_PRIVATE_KEY_HEX` | No | Auto-generated | Private key (hex) |
| `NOSTR_RELAY_URL` | No | `wss://nostr-relay.testnet.unicity.network` | Nostr relay |
| `AGGREGATOR_URL` | No | `https://goggregator-test.unicity.network` | Unicity aggregator |
| `AGGREGATOR_API_KEY` | No | (testnet key) | Aggregator API key |
| `PAYMENT_TIMEOUT_SECONDS` | No | `120` | Payment timeout |
| `DATA_DIR` | No | `./data` | Data persistence directory |
| `ASSETS_DIR` | No | `./assets` | Product images directory |
| `ADMIN_PASSWORD` | No | Auto-generated | Admin password for wallet access |
| `HTTP_PORT` | No | `3001` | HTTP server port |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally
npm start

# Watch mode
npm run dev
```

## License

MIT
