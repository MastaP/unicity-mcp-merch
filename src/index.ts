import "dotenv/config";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import { loadConfig, type Config } from "./config.js";
import { IdentityService } from "./identity-service.js";
import { NostrService } from "./nostr-service.js";
import { OrderService } from "./order-service.js";
import { WalletService } from "./wallet-service.js";
import { PRODUCTS, formatUCT } from "./catalog.js";
import type { TShirtSize } from "./types.js";

// Cache for resolved pubkeys (unicity_id -> pubkey)
const pubkeyCache: Map<string, { pubkey: string; timestamp: number }> = new Map();
const PUBKEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let config: Config;
let identityService: IdentityService;
let nostrService: NostrService;
let orderService: OrderService;
let walletService: WalletService;

// Helper: Resolve and cache pubkey for a unicity_id
async function resolvePubkey(unicityId: string): Promise<string | null> {
  const cleanId = unicityId.replace("@unicity", "").replace("@", "").trim();

  const cached = pubkeyCache.get(cleanId);
  if (cached && Date.now() - cached.timestamp < PUBKEY_CACHE_TTL_MS) {
    return cached.pubkey;
  }

  const pubkey = await nostrService.resolvePubkey(cleanId);
  if (pubkey) {
    pubkeyCache.set(cleanId, { pubkey, timestamp: Date.now() });
  }

  return pubkey;
}

// Helper: Clean unicity_id
function cleanUnicityId(unicityId: string): string {
  return unicityId.replace("@unicity", "").replace("@", "").trim();
}

// Helper: Load product image as base64
function loadProductImage(imageName: string): string | null {
  try {
    const imagePath = path.join(config.assetsDir, imageName);
    if (!fs.existsSync(imagePath)) {
      return null;
    }
    const imageBuffer = fs.readFileSync(imagePath);
    const ext = path.extname(imageName).toLowerCase();
    const mimeType = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
    return `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
  } catch {
    return null;
  }
}

// Register all tools on an MCP server
function registerTools(server: McpServer): void {
  // Tool: List all products with images
  server.tool(
    "list_products",
    "List all available merchandise with prices, details, and images",
    {
      category: z
        .enum(["t-shirt", "mug", "hoodie", "cap"])
        .optional()
        .describe("Optional: Filter by category"),
    },
    async ({ category }) => {
      let products = Object.values(PRODUCTS);

      if (category) {
        products = products.filter((p) => p.category === category);
      }

      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

      for (const p of products) {
        content.push({
          type: "text" as const,
          text: `**${p.name}** (${p.id})\n${p.description}\nPrice: ${formatUCT(p.price)}${p.sizes ? `\nSizes: ${p.sizes.join(", ")}` : ""}\nIn Stock: ${p.inStock ? "Yes" : "No"}\n`,
        });

        const imageBase64 = loadProductImage(p.image);
        if (imageBase64) {
          const ext = p.image.toLowerCase();
          const mimeType = ext.endsWith(".png") ? "image/png" : "image/jpeg";
          content.push({
            type: "image" as const,
            data: imageBase64.split(",")[1],
            mimeType,
          });
        }
      }

      content.push({
        type: "text" as const,
        text: "\nUse place_order to purchase.",
      });

      return { content };
    }
  );

  // Tool: Get product details with image
  server.tool(
    "get_product",
    "Get detailed product information including image",
    {
      product_id: z.string().describe("Product ID (e.g., 'tshirt-black', 'mug-classic')"),
    },
    async ({ product_id }) => {
      const product = PRODUCTS[product_id];

      if (!product) {
        const availableIds = Object.keys(PRODUCTS).join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Product "${product_id}" not found. Available products: ${availableIds}`,
            },
          ],
          isError: true,
        };
      }

      const imageBase64 = loadProductImage(product.image);

      const productInfo = {
        id: product.id,
        name: product.name,
        description: product.description,
        category: product.category,
        price: formatUCT(product.price),
        sizes: product.sizes || null,
        inStock: product.inStock,
      };

      if (imageBase64) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(productInfo, null, 2),
            },
            {
              type: "image" as const,
              data: imageBase64.split(",")[1],
              mimeType: "image/png",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(productInfo, null, 2),
          },
        ],
      };
    }
  );

  // Tool: Place an order
  server.tool(
    "place_order",
    "Place an order for merchandise. Creates an order and initiates payment request.",
    {
      unicity_id: z.string().describe("Your Unicity ID (nametag)"),
      product_id: z.string().describe("Product ID to order"),
      quantity: z.number().int().min(1).max(10).default(1).describe("Quantity (1-10)"),
      size: z
        .enum(["S", "M", "L", "XL", "XXL"])
        .optional()
        .describe("Size (required for apparel: S, M, L, XL, XXL)"),
    },
    async ({ unicity_id, product_id, quantity, size }) => {
      const unicityId = cleanUnicityId(unicity_id);

      const pubkey = await resolvePubkey(unicityId);
      if (!pubkey) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not find Unicity ID "${unicity_id}". Make sure the nametag is minted and has a Nostr binding.`,
            },
          ],
          isError: true,
        };
      }

      const product = PRODUCTS[product_id];
      if (!product) {
        const availableIds = Object.keys(PRODUCTS).join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Product "${product_id}" not found. Available products: ${availableIds}`,
            },
          ],
          isError: true,
        };
      }

      if (!product.inStock) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Sorry, "${product.name}" is currently out of stock.`,
            },
          ],
          isError: true,
        };
      }

      // Check if size is required
      if (product.sizes && !size) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Size is required for ${product.name}. Available sizes: ${product.sizes.join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      if (product.sizes && size && !product.sizes.includes(size)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Size "${size}" not available. Available sizes: ${product.sizes.join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      // Create order
      const order = orderService.createOrder(unicityId, product, quantity, size as TShirtSize | undefined);

      // Send payment request
      const message = `Order #${order.orderId}: ${quantity}x ${product.name}${size ? ` (${size})` : ""}`;
      const { eventId } = await nostrService.sendPaymentRequest(
        unicityId,
        pubkey,
        order.orderId,
        order.totalPrice,
        message
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "payment_required",
                orderId: order.orderId,
                product: product.name,
                quantity,
                size: size || null,
                totalPrice: formatUCT(order.totalPrice),
                message: `Payment request sent to your wallet (@${unicityId}). Please approve the payment.`,
                paymentRequestEventId: eventId,
                timeoutSeconds: config.paymentTimeoutSeconds,
                nextStep: `Use confirm_order with order_id "${order.orderId}" to wait for payment confirmation.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool: Confirm order payment
  server.tool(
    "confirm_order",
    "Wait for payment confirmation for an order",
    {
      unicity_id: z.string().describe("Your Unicity ID (nametag)"),
      order_id: z.string().describe("Order ID from place_order"),
    },
    async ({ unicity_id, order_id }) => {
      const unicityId = cleanUnicityId(unicity_id);

      const pubkey = await resolvePubkey(unicityId);
      if (!pubkey) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not find Unicity ID "${unicity_id}".`,
            },
          ],
          isError: true,
        };
      }

      const order = orderService.getOrder(order_id);
      if (!order) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Order "${order_id}" not found.`,
            },
          ],
          isError: true,
        };
      }

      if (order.unicityId !== unicityId) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Order "${order_id}" does not belong to @${unicityId}.`,
            },
          ],
          isError: true,
        };
      }

      if (order.status === "paid" || order.status === "shipped" || order.status === "delivered") {
        const product = PRODUCTS[order.productId];
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: order.status,
                  orderId: order.orderId,
                  product: product?.name || order.productId,
                  quantity: order.quantity,
                  size: order.size || null,
                  totalPrice: formatUCT(order.totalPrice),
                  paidAt: order.paidAt ? new Date(order.paidAt).toISOString() : null,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Resend payment request and wait
      const product = PRODUCTS[order.productId];
      const message = `Order #${order.orderId}: ${order.quantity}x ${product?.name || order.productId}`;
      const { waitForPayment } = await nostrService.sendPaymentRequest(
        unicityId,
        pubkey,
        order.orderId,
        order.totalPrice,
        message
      );

      const paymentReceived = await waitForPayment();

      if (paymentReceived) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "paid",
                  orderId: order.orderId,
                  product: product?.name || order.productId,
                  quantity: order.quantity,
                  size: order.size || null,
                  totalPrice: formatUCT(order.totalPrice),
                  message: "Payment received! Your order is confirmed.",
                  note: "We'll process your order and ship it soon.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "payment_timeout",
                orderId: order.orderId,
                message: "Payment not received within timeout. Please try again.",
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  );

  // Tool: Get user's orders
  server.tool(
    "get_orders",
    "Get all orders for a Unicity ID",
    {
      unicity_id: z.string().describe("Your Unicity ID (nametag)"),
    },
    async ({ unicity_id }) => {
      const unicityId = cleanUnicityId(unicity_id);

      const orders = orderService.getOrdersByUser(unicityId);

      if (orders.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  orders: [],
                  message: `No orders found for @${unicityId}.`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const orderList = orders.map((o) => {
        const product = PRODUCTS[o.productId];
        return {
          orderId: o.orderId,
          product: product?.name || o.productId,
          quantity: o.quantity,
          size: o.size || null,
          totalPrice: formatUCT(o.totalPrice),
          status: o.status,
          createdAt: new Date(o.createdAt).toISOString(),
          paidAt: o.paidAt ? new Date(o.paidAt).toISOString() : null,
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ orders: orderList }, null, 2),
          },
        ],
      };
    }
  );

  // Tool: Get wallet balance (admin)
  server.tool(
    "get_wallet_balance",
    "Get the total token balance in the MCP wallet (requires admin password)",
    {
      password: z.string().describe("Admin password for authentication"),
    },
    async ({ password }) => {
      if (password !== config.adminPassword) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Invalid admin password.",
            },
          ],
          isError: true,
        };
      }

      try {
        const summary = await walletService.getWalletSummary();

        const balanceInfo = summary.balances.map((b) => ({
          coinId: b.coinId,
          amount: b.amount.toString(),
          tokenCount: b.tokenCount,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  totalTokenFiles: summary.totalTokens,
                  balances: balanceInfo,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error reading wallet: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

async function main() {
  console.error("Starting Sphere Merch MCP Server...");

  config = loadConfig();

  console.error("Initializing identity...");
  identityService = new IdentityService(config);
  await identityService.initialize();

  orderService = new OrderService();
  walletService = new WalletService(config);

  console.error("Connecting to Nostr...");
  nostrService = new NostrService(config, identityService, orderService);
  await nostrService.connect();

  await startHttpServer(config.httpPort);

  console.error("=".repeat(60));
  console.error("Sphere Merch MCP Server is ready!");
  console.error(`  Nametag: @${config.nametag}`);
  console.error(`  Relay: ${config.relayUrl}`);
  console.error(`  Products: ${Object.keys(PRODUCTS).length}`);
  console.error(`  HTTP port: ${config.httpPort}`);
  console.error("=".repeat(60));
}

// Legacy SSE transports (for MCP Inspector and older clients)
const sseTransports = new Map<string, SSEServerTransport>();

// Streamable HTTP transports (modern MCP clients)
const httpTransports = new Map<string, StreamableHTTPServerTransport>();

async function startHttpServer(port: number): Promise<void> {
  const app = express();

  // CORS middleware
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json());

  // ===========================================
  // Legacy SSE Transport (for MCP Inspector)
  // ===========================================

  app.get("/sse", async (req: Request, res: Response) => {
    const transport = new SSEServerTransport("/messages", res);
    sseTransports.set(transport.sessionId, transport);

    const server = new McpServer({
      name: "sphere-merch",
      version: "1.0.0",
    });
    registerTools(server);

    res.on("close", () => {
      sseTransports.delete(transport.sessionId);
      console.error(`SSE session closed: ${transport.sessionId}`);
    });

    await server.connect(transport);
    console.error(`SSE session created: ${transport.sessionId}`);
  });

  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const transport = sseTransports.get(sessionId);

    if (!transport) {
      res.status(404).json({ error: "SSE session not found" });
      return;
    }

    await transport.handlePostMessage(req, res, req.body);
  });

  // ===========================================
  // Streamable HTTP Transport (modern clients)
  // ===========================================

  app.all("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !httpTransports.has(sessionId)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          httpTransports.set(newSessionId, transport);
          console.error(`HTTP session created: ${newSessionId}`);
        },
        onsessionclosed: (closedSessionId) => {
          httpTransports.delete(closedSessionId);
          console.error(`HTTP session closed: ${closedSessionId}`);
        },
      });

      const server = new McpServer({
        name: "sphere-merch",
        version: "1.0.0",
      });
      registerTools(server);

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const transport = httpTransports.get(sessionId);
    if (transport) {
      await transport.handleRequest(req, res, req.body);
    } else {
      res.status(404).json({ error: "Session not found" });
    }
  });

  // ===========================================
  // Health check
  // ===========================================

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      sseSessions: sseTransports.size,
      httpSessions: httpTransports.size,
    });
  });

  app.listen(port, () => {
    console.error(`HTTP server listening on port ${port}`);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
