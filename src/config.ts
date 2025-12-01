export interface Config {
  // Nostr relay
  relayUrl: string;

  // Aggregator settings
  aggregatorUrl: string;
  aggregatorApiKey: string;

  // MCP server identity
  privateKeyHex: string | null;
  nametag: string;

  // Payment settings
  coinId: string;

  // Payment confirmation timeout in seconds
  paymentTimeoutSeconds: number;

  // Data directory for persistence
  dataDir: string;

  // Assets directory for product images
  assetsDir: string;

  // Admin password for sensitive operations
  adminPassword: string;

  // HTTP port for MCP transport
  httpPort: number;
}

function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let password = "";
  for (let i = 0; i < 16; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

export function loadConfig(): Config {
  // Private key is optional - will be auto-generated and saved to file if not provided
  const privateKeyHex = process.env.MCP_PRIVATE_KEY_HEX || null;

  const nametag = process.env.MCP_NAMETAG;
  if (!nametag) {
    throw new Error("MCP_NAMETAG environment variable is required (e.g., 'merch-mcp')");
  }

  const coinId = process.env.PAYMENT_COIN_ID;
  if (!coinId) {
    throw new Error("PAYMENT_COIN_ID environment variable is required");
  }

  const cleanNametag = nametag.replace("@unicity", "").replace("@", "").trim();

  // Admin password - use env var or generate one
  let adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    adminPassword = generatePassword();
    console.error(`Generated admin password: ${adminPassword}`);
  }

  return {
    relayUrl: process.env.NOSTR_RELAY_URL || "wss://nostr-relay.testnet.unicity.network",
    aggregatorUrl: process.env.AGGREGATOR_URL || "https://goggregator-test.unicity.network",
    aggregatorApiKey: process.env.AGGREGATOR_API_KEY || "sk_06365a9c44654841a366068bcfc68986",
    privateKeyHex,
    nametag: cleanNametag,
    coinId,
    paymentTimeoutSeconds: parseInt(process.env.PAYMENT_TIMEOUT_SECONDS || "120", 10),
    dataDir: process.env.DATA_DIR || "./data",
    assetsDir: process.env.ASSETS_DIR || "./assets",
    adminPassword,
    httpPort: parseInt(process.env.HTTP_PORT || "3001", 10),
  };
}
