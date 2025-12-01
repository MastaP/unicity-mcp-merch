import { randomUUID } from "node:crypto";
import type { Order, TShirtSize } from "./types.js";
import type { Product } from "./types.js";

export class OrderService {
  private orders: Map<string, Order> = new Map();
  // Map payment event ID to order ID for matching payments
  private paymentToOrder: Map<string, string> = new Map();

  createOrder(
    unicityId: string,
    product: Product,
    quantity: number,
    size?: TShirtSize
  ): Order {
    const orderId = randomUUID().slice(0, 8);
    const order: Order = {
      orderId,
      unicityId,
      productId: product.id,
      size,
      quantity,
      totalPrice: product.price * BigInt(quantity),
      status: "pending_payment",
      createdAt: Date.now(),
    };
    this.orders.set(orderId, order);
    return order;
  }

  getOrder(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  getOrdersByUser(unicityId: string): Order[] {
    return Array.from(this.orders.values()).filter(
      (o) => o.unicityId === unicityId
    );
  }

  getPendingOrderForPayment(eventId: string): Order | undefined {
    const orderId = this.paymentToOrder.get(eventId);
    if (orderId) {
      return this.orders.get(orderId);
    }
    return undefined;
  }

  linkPaymentToOrder(eventId: string, orderId: string): void {
    this.paymentToOrder.set(eventId, orderId);
  }

  markAsPaid(orderId: string): Order | undefined {
    const order = this.orders.get(orderId);
    if (order) {
      order.status = "paid";
      order.paidAt = Date.now();
    }
    return order;
  }

  markAsShipped(orderId: string): Order | undefined {
    const order = this.orders.get(orderId);
    if (order && order.status === "paid") {
      order.status = "shipped";
    }
    return order;
  }
}
