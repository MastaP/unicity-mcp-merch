export type ProductCategory = "t-shirt" | "mug" | "hoodie" | "cap";

export type TShirtSize = "S" | "M" | "L" | "XL" | "XXL";

export interface Product {
  id: string;
  name: string;
  description: string;
  category: ProductCategory;
  price: bigint; // in UCT (18 decimals)
  sizes?: TShirtSize[]; // for apparel
  image: string; // filename in assets directory
  inStock: boolean;
}

export interface Order {
  orderId: string;
  unicityId: string;
  productId: string;
  size?: TShirtSize;
  quantity: number;
  totalPrice: bigint;
  status: "pending_payment" | "paid" | "shipped" | "delivered";
  createdAt: number;
  paidAt?: number;
}

export interface PaymentRequest {
  requestId: string;
  unicityId: string;
  orderId: string;
  amount: bigint;
  createdAt: number;
}
