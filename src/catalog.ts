import type { Product } from "./types.js";

// 1 UCT = 10^18 units
const UCT = BigInt("1000000000000000000");

export const PRODUCTS: Record<string, Product> = {
  "tshirt-unicity": {
    id: "tshirt-unicity",
    name: "Unicity T-Shirt",
    description: "Premium cotton t-shirt with Unicity branding",
    category: "t-shirt",
    price: BigInt(25) * UCT, // 25 UCT
    sizes: ["S", "M", "L", "XL", "XXL"],
    image: "unicity-tshirt1.jpeg",
    inStock: true,
  },
  "mug-white": {
    id: "mug-white",
    name: "Unicity White Mug",
    description: "Ceramic mug with Unicity logo, 350ml",
    category: "mug",
    price: BigInt(15) * UCT, // 15 UCT
    image: "unicity_mug1.jpeg",
    inStock: true,
  },
  "mug-black": {
    id: "mug-black",
    name: "Unicity Black Mug",
    description: "Black ceramic mug with Unicity branding, 350ml",
    category: "mug",
    price: BigInt(15) * UCT, // 15 UCT
    image: "unicity_mug2.jpeg",
    inStock: true,
  },
};

export function formatUCT(amount: bigint): string {
  const whole = amount / UCT;
  const fraction = amount % UCT;
  if (fraction === BigInt(0)) {
    return `${whole} UCT`;
  }
  return `${whole}.${fraction.toString().padStart(18, "0").replace(/0+$/, "")} UCT`;
}
