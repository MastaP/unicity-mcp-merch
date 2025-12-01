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

    const identity = this.identityService.getIdentity();
    const secretKey = Buffer.from(identity.privateKeyHex, "hex");
    this.keyManager = NostrKeyManager.fromPrivateKey(secretKey);
    this.client = new NostrClient(this.keyManager);

    await this.client.connect(this.config.relayUrl);
    this.connected = true;

    this.subscribeToPayments();

    console.error(`Nostr service connected to: ${this.config.relayUrl}`);
    console.error(`MCP pubkey: ${this.keyManager.getPublicKeyHex()}`);
  }

  private subscribeToPayments(): void {
    if (!this.client || !this.keyManager) return;

    const myPubkey = this.keyManager.getPublicKeyHex();

    const filter = Filter.builder()
      .kinds(EventKinds.TOKEN_TRANSFER)
      .pTags(myPubkey)
      .build();

    this.client.subscribe(filter, {
      onEvent: (event: Event) => {
        this.handleIncomingTransfer(event).catch((err) => {
          console.error("Error handling incoming transfer:", err);
        });
      },
    });

    console.error("Subscribed to incoming token transfers");
  }

  private async handleIncomingTransfer(event: Event): Promise<void> {
    if (!this.keyManager) return;

    try {
      if (!TokenTransferProtocol.isTokenTransfer(event)) {
        return;
      }

      const senderPubkey = TokenTransferProtocol.getSender(event);
      const replyToEventId = TokenTransferProtocol.getReplyToEventId(event);

      console.error(`Received token transfer from ${senderPubkey.slice(0, 16)}... replyTo=${replyToEventId?.slice(0, 16) || "none"}`);

      let pending: PendingPayment | undefined;
      let pendingKey: string | undefined;

      if (replyToEventId) {
        pending = this.pendingPayments.get(replyToEventId);
        if (pending) {
          pendingKey = replyToEventId;
          console.error(`Matched payment for order ${pending.orderId} via replyToEventId`);
        }
      }

      if (!pending) {
        for (const [key, p] of this.pendingPayments) {
          if (p.userPubkey === senderPubkey) {
            pending = p;
            pendingKey = key;
            console.error(`Matched payment for order ${p.orderId} via sender pubkey`);
            break;
          }
        }
      }

      if (!pending || !pendingKey) {
        console.error("No matching pending payment found for this transfer");
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

  async resolvePubkey(unicityId: string): Promise<string | null> {
    if (!this.client) {
      throw new Error("Nostr client not connected");
    }
    const cleanId = unicityId.replace("@unicity", "").replace("@", "").trim();
    return this.client.queryPubkeyByNametag(cleanId);
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

    const eventId = await this.client.sendPaymentRequest(userPubkey, {
      amount,
      coinId: this.config.coinId,
      recipientNametag: this.config.nametag,
      message,
    });

    console.error(
      `Sent payment request to ${unicityId} for order ${orderId} amount ${amount} (eventId: ${eventId.slice(0, 16)}...)`
    );

    this.orderService.linkPaymentToOrder(eventId, orderId);

    const waitForPayment = (): Promise<boolean> => {
      return new Promise((resolve) => {
        const pending: PendingPayment = {
          eventId,
          unicityId,
          userPubkey,
          orderId,
          amount,
          coinId: this.config.coinId,
          createdAt: Date.now(),
          resolve,
        };

        this.pendingPayments.set(eventId, pending);

        setTimeout(() => {
          if (this.pendingPayments.has(eventId)) {
            this.pendingPayments.delete(eventId);
            resolve(false);
          }
        }, this.config.paymentTimeoutSeconds * 1000);
      });
    };

    return { eventId, waitForPayment };
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
