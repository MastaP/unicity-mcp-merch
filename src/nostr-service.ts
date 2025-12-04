import {
  NostrClient,
  NostrKeyManager,
  Filter,
  EventKinds,
  TokenTransferProtocol,
} from "@unicitylabs/nostr-js-sdk";
import type { Event } from "@unicitylabs/nostr-js-sdk";
import { Token } from "@unicitylabs/state-transition-sdk/lib/token/Token.js";
import { TransferTransaction } from "@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction.js";
import { AddressScheme } from "@unicitylabs/state-transition-sdk/lib/address/AddressScheme.js";
import { UnmaskedPredicate } from "@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js";
import { HashAlgorithm } from "@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js";
import { TokenState } from "@unicitylabs/state-transition-sdk/lib/token/TokenState.js";
import type { Config } from "./config.js";
import type { IdentityService } from "./identity-service.js";
import type { OrderService } from "./order-service.js";
import * as fs from "fs";
import * as path from "path";

export interface PendingPayment {
  eventId: string;
  unicityId: string;
  userPubkey: string;
  orderId: string;
  amount: bigint;
  coinId: string;
  createdAt: number;
  resolve: (success: boolean) => void;
}

export class NostrService {
  private client: NostrClient | null = null;
  private keyManager: NostrKeyManager | null = null;
  private config: Config;
  private identityService: IdentityService;
  private orderService: OrderService;
  private pendingPayments: Map<string, PendingPayment> = new Map();
  private connected = false;

  constructor(config: Config, identityService: IdentityService, orderService: OrderService) {
    this.config = config;
    this.identityService = identityService;
    this.orderService = orderService;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    console.error(`[NostrService] Initializing connection to ${this.config.relayUrl}...`);

    const identity = this.identityService.getIdentity();
    const secretKey = Buffer.from(identity.privateKeyHex, "hex");
    this.keyManager = NostrKeyManager.fromPrivateKey(secretKey);
    console.error(`[NostrService] KeyManager created, pubkey: ${this.keyManager.getPublicKeyHex()}`);

    this.client = new NostrClient(this.keyManager, {
      queryTimeoutMs: 15000,
      autoReconnect: true,
      pingIntervalMs: 30000,
    });

    // Monitor connection state
    this.client.addConnectionListener({
      onConnect: (url) => console.error(`[NostrService] Connected to ${url}`),
      onDisconnect: (url, reason) => console.error(`[NostrService] Disconnected from ${url}: ${reason}`),
      onReconnecting: (url, attempt) => console.error(`[NostrService] Reconnecting to ${url} (attempt ${attempt})...`),
      onReconnected: (url) => {
        console.error(`[NostrService] Reconnected to ${url}`);
        // Re-subscribe to payments after reconnect
        this.subscribeToPayments();
      },
    });

    console.error(`[NostrService] NostrClient created (queryTimeout: 15s, autoReconnect: on), connecting...`);

    await this.client.connect(this.config.relayUrl);
    this.connected = true;
    console.error(`[NostrService] Connected to relay: ${this.config.relayUrl}`);

    this.subscribeToPayments();

    console.error(`[NostrService] ========================================`);
    console.error(`[NostrService] Nostr service READY`);
    console.error(`[NostrService] Relay: ${this.config.relayUrl}`);
    console.error(`[NostrService] MCP pubkey: ${this.keyManager.getPublicKeyHex()}`);
    console.error(`[NostrService] ========================================`);
  }

  private subscribeToPayments(): void {
    if (!this.client || !this.keyManager) return;

    const myPubkey = this.keyManager.getPublicKeyHex();
    console.error(`[NostrService] Setting up payment subscription for pubkey: ${myPubkey}`);

    const filter = Filter.builder()
      .kinds(EventKinds.TOKEN_TRANSFER)
      .pTags(myPubkey)
      .build();

    console.error(`[NostrService] Payment filter: ${JSON.stringify(filter.toJSON())}`);

    this.client.subscribe(filter, {
      onEvent: (event: Event) => {
        console.error(`[NostrService] Received event kind=${event.kind} id=${event.id.slice(0, 16)}...`);
        this.handleIncomingTransfer(event).catch((err) => {
          console.error("[NostrService] Error handling incoming transfer:", err);
        });
      },
      onEndOfStoredEvents: (subId) => {
        console.error(`[NostrService] EOSE received for payment subscription ${subId}`);
      },
    });

    console.error("[NostrService] Subscribed to incoming token transfers");
  }

  private async handleIncomingTransfer(event: Event): Promise<void> {
    if (!this.keyManager) return;

    console.error(`[NostrService] ========================================`);
    console.error(`[NostrService] INCOMING TRANSFER EVENT`);
    console.error(`[NostrService]   - Event ID: ${event.id}`);
    console.error(`[NostrService]   - Kind: ${event.kind}`);
    console.error(`[NostrService]   - Created: ${new Date(event.created_at * 1000).toISOString()}`);

    try {
      if (!TokenTransferProtocol.isTokenTransfer(event)) {
        console.error(`[NostrService] Not a valid token transfer, skipping`);
        return;
      }

      const senderPubkey = TokenTransferProtocol.getSender(event);
      const replyToEventId = TokenTransferProtocol.getReplyToEventId(event);

      console.error(`[NostrService]   - Sender: ${senderPubkey}`);
      console.error(`[NostrService]   - ReplyTo: ${replyToEventId || "none"}`);
      console.error(`[NostrService]   - Pending payments count: ${this.pendingPayments.size}`);

      let pending: PendingPayment | undefined;
      let pendingKey: string | undefined;

      // List all pending payments for debugging
      if (this.pendingPayments.size > 0) {
        console.error(`[NostrService] Current pending payments:`);
        for (const [eventId, p] of this.pendingPayments) {
          console.error(`[NostrService]     - ${eventId}: order=${p.orderId}, user=${p.unicityId}, pubkey=${p.userPubkey.slice(0, 16)}...`);
        }
      }

      if (replyToEventId) {
        console.error(`[NostrService] Trying to match by replyToEventId: ${replyToEventId}`);
        pending = this.pendingPayments.get(replyToEventId);
        if (pending) {
          pendingKey = replyToEventId;
          console.error(`[NostrService] MATCHED via replyToEventId for order ${pending.orderId}`);
        } else {
          console.error(`[NostrService] No match by replyToEventId`);
        }
      }

      if (!pending) {
        console.error(`[NostrService] Trying to match by sender pubkey: ${senderPubkey}`);
        for (const [key, p] of this.pendingPayments) {
          if (p.userPubkey === senderPubkey) {
            pending = p;
            pendingKey = key;
            console.error(`[NostrService] MATCHED via sender pubkey for order ${p.orderId}`);
            break;
          }
        }
        if (!pending) {
          console.error(`[NostrService] No match by sender pubkey`);
        }
      }

      if (!pending || !pendingKey) {
        console.error("[NostrService] No matching pending payment found for this transfer");
        console.error(`[NostrService] ========================================`);
        return;
      }

      console.error("Decrypting token transfer...");
      const tokenJson = await TokenTransferProtocol.parseTokenTransfer(
        event,
        this.keyManager
      );

      if (!tokenJson.startsWith("{") || !tokenJson.includes("sourceToken")) {
        console.error("Invalid token transfer format");
        pending.resolve(false);
        this.pendingPayments.delete(pendingKey);
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let payloadObj: Record<string, any>;
      try {
        payloadObj = JSON.parse(tokenJson);
      } catch (error) {
        console.error("Failed to parse token JSON:", error);
        pending.resolve(false);
        this.pendingPayments.delete(pendingKey);
        return;
      }

      const success = await this.processTokenTransfer(payloadObj);

      if (success) {
        console.error(`Payment confirmed for order ${pending.orderId}!`);
        this.orderService.markAsPaid(pending.orderId);
        pending.resolve(true);
      } else {
        console.error(`Failed to process token for order ${pending.orderId}`);
        pending.resolve(false);
      }

      this.pendingPayments.delete(pendingKey);
    } catch (err) {
      console.error("Error processing transfer:", err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async processTokenTransfer(payloadObj: Record<string, any>): Promise<boolean> {
    try {
      let sourceTokenInput = payloadObj["sourceToken"];
      let transferTxInput = payloadObj["transferTx"];

      if (typeof sourceTokenInput === "string") {
        sourceTokenInput = JSON.parse(sourceTokenInput);
      }
      if (typeof transferTxInput === "string") {
        transferTxInput = JSON.parse(transferTxInput);
      }

      if (!sourceTokenInput || !transferTxInput) {
        console.error("Missing sourceToken or transferTx in payload");
        return false;
      }

      const sourceToken = await Token.fromJSON(sourceTokenInput);
      const transferTx = await TransferTransaction.fromJSON(transferTxInput);

      return await this.finalizeTransfer(sourceToken, transferTx);
    } catch (error) {
      console.error("Error processing token transfer:", error);
      return false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async finalizeTransfer(
    sourceToken: Token<any>,
    transferTx: TransferTransaction
  ): Promise<boolean> {
    try {
      const recipientAddress = transferTx.data.recipient;
      const addressScheme = recipientAddress.scheme;

      console.error(`Recipient address scheme: ${addressScheme}`);

      if (addressScheme === AddressScheme.PROXY) {
        console.error("Transfer to PROXY address - finalizing...");

        const nametagToken = this.identityService.getNametagToken();
        if (!nametagToken) {
          console.error("No nametag token available for finalization");
          return false;
        }

        const signingService = this.identityService.getSigningService();
        const transferSalt = transferTx.data.salt;

        const recipientPredicate = await UnmaskedPredicate.create(
          sourceToken.id,
          sourceToken.type,
          signingService,
          HashAlgorithm.SHA256,
          transferSalt
        );

        const recipientState = new TokenState(recipientPredicate, null);

        const client = this.identityService.getStateTransitionClient();
        const rootTrustBase = this.identityService.getRootTrustBase();

        const finalizedToken = await client.finalizeTransaction(
          rootTrustBase,
          sourceToken,
          recipientState,
          transferTx,
          [nametagToken]
        );

        console.error("Token finalized successfully!");
        this.saveReceivedToken(finalizedToken);
        return true;
      } else {
        console.error("Transfer to DIRECT address - saving...");
        this.saveReceivedToken(sourceToken);
        return true;
      }
    } catch (error) {
      console.error("Error finalizing transfer:", error);
      return false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private saveReceivedToken(token: Token<any>): void {
    try {
      const tokensDir = path.join(this.config.dataDir, "tokens");
      if (!fs.existsSync(tokensDir)) {
        fs.mkdirSync(tokensDir, { recursive: true });
      }

      const tokenIdHex = Buffer.from(token.id.bytes).toString("hex").slice(0, 16);
      const filename = `token-${tokenIdHex}-${Date.now()}.json`;
      const tokenPath = path.join(tokensDir, filename);

      const tokenData = {
        token: token.toJSON(),
        receivedAt: Date.now(),
      };

      fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2));
      console.error(`Token saved to ${tokenPath}`);
    } catch (error) {
      console.error("Error saving token:", error);
    }
  }

  async resolvePubkey(unicityId: string, maxRetries: number = 3): Promise<string | null> {
    if (!this.client) {
      throw new Error("Nostr client not connected");
    }
    const cleanId = unicityId.replace("@unicity", "").replace("@", "").trim();
    console.error(`[NostrService] ----------------------------------------`);
    console.error(`[NostrService] Resolving pubkey for nametag: "${cleanId}"`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      console.error(`[NostrService] Attempt ${attempt}/${maxRetries}: queryPubkeyByNametag("${cleanId}")...`);

      const pubkey = await this.client.queryPubkeyByNametag(cleanId);
      const elapsed = Date.now() - startTime;

      if (pubkey) {
        console.error(`[NostrService] SUCCESS: Found pubkey for ${cleanId}: ${pubkey.slice(0, 16)}... (took ${elapsed}ms, attempt ${attempt})`);
        console.error(`[NostrService] ----------------------------------------`);
        return pubkey;
      }

      const isTimeout = elapsed >= 14900;
      console.error(`[NostrService] Attempt ${attempt} failed: ${isTimeout ? 'TIMEOUT (15s)' : 'No matching events'} (${elapsed}ms)`);

      if (attempt < maxRetries) {
        const delay = 1000 * attempt;
        console.error(`[NostrService] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    console.error(`[NostrService] FAILED: No pubkey found for nametag "${cleanId}" after ${maxRetries} attempts`);
    console.error(`[NostrService] ----------------------------------------`);
    return null;
  }

  async sendPaymentRequest(
    unicityId: string,
    userPubkey: string,
    orderId: string,
    amount: bigint,
    message: string
  ): Promise<{ eventId: string; waitForPayment: () => Promise<boolean> }> {
    if (!this.client) {
      throw new Error("Nostr client not connected");
    }

    console.error(`[NostrService] ----------------------------------------`);
    console.error(`[NostrService] Sending payment request`);
    console.error(`[NostrService]   - To: ${unicityId} (${userPubkey.slice(0, 16)}...)`);
    console.error(`[NostrService]   - Order: ${orderId}`);
    console.error(`[NostrService]   - Amount: ${amount}`);
    console.error(`[NostrService]   - CoinId: ${this.config.coinId}`);
    console.error(`[NostrService]   - Recipient nametag: ${this.config.nametag}`);
    console.error(`[NostrService]   - Message: ${message}`);

    const eventId = await this.client.sendPaymentRequest(userPubkey, {
      amount,
      coinId: this.config.coinId,
      recipientNametag: this.config.nametag,
      message,
    });

    console.error(`[NostrService] Payment request sent! EventId: ${eventId}`);

    this.orderService.linkPaymentToOrder(eventId, orderId);

    // Create a deferred promise that can be resolved later
    let resolvePayment: (success: boolean) => void;
    const paymentPromise = new Promise<boolean>((resolve) => {
      resolvePayment = resolve;
    });

    // Register pending payment IMMEDIATELY so incoming transfers can be matched
    const pending: PendingPayment = {
      eventId,
      unicityId,
      userPubkey,
      orderId,
      amount,
      coinId: this.config.coinId,
      createdAt: Date.now(),
      resolve: resolvePayment!,
    };
    this.pendingPayments.set(eventId, pending);
    console.error(`[NostrService] Registered pending payment for eventId ${eventId.slice(0, 16)}...`);
    console.error(`[NostrService] Total pending payments: ${this.pendingPayments.size}`);
    console.error(`[NostrService] ----------------------------------------`);

    // Set up timeout
    const timeoutId = setTimeout(() => {
      if (this.pendingPayments.has(eventId)) {
        console.error(`Payment timeout for eventId ${eventId.slice(0, 16)}...`);
        this.pendingPayments.delete(eventId);
        resolvePayment!(false);
      }
    }, this.config.paymentTimeoutSeconds * 1000);

    const waitForPayment = (): Promise<boolean> => {
      return paymentPromise.then((result) => {
        clearTimeout(timeoutId);
        return result;
      });
    };

    return { eventId, waitForPayment };
  }

  /**
   * Check if there's an existing pending payment for an order.
   * Returns the eventId if found, null otherwise.
   */
  getPendingPaymentForOrder(orderId: string): string | null {
    for (const [eventId, pending] of this.pendingPayments) {
      if (pending.orderId === orderId) {
        return eventId;
      }
    }
    return null;
  }

  /**
   * Wait for an existing pending payment by eventId.
   * Returns a promise that resolves when payment is received or times out.
   */
  waitForExistingPayment(eventId: string): Promise<boolean> | null {
    const pending = this.pendingPayments.get(eventId);
    if (!pending) {
      return null;
    }

    // Create a new promise that resolves when the pending payment resolves
    return new Promise((resolve) => {
      const originalResolve = pending.resolve;
      pending.resolve = (success: boolean) => {
        originalResolve(success);
        resolve(success);
      };
    });
  }

  getPublicKey(): string {
    if (!this.keyManager) {
      throw new Error("Key manager not initialized");
    }
    return this.keyManager.getPublicKeyHex();
  }

  disconnect(): void {
    if (this.client) {
      this.client.disconnect();
    }
    this.connected = false;
  }
}
