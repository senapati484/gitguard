/**
 * lib/demo-order-calculator.ts
 *
 * Order calculation service for e-commerce checkout.
 * (Auto-patched and verified by GitGuard Autonomous Auto-Solve Engine)
 */

export interface OrderItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  discountPercentage?: number;
}

export interface CustomerOrder {
  orderId: string;
  items: OrderItem[];
  shippingFee: number;
}

/**
 * Calculates final order total including item discounts and shipping fees.
 */
export function calculateOrderTotal(order: CustomerOrder): number {
  let subtotal = 0;

  for (let i = 0; i < order.items.length; i++) {
    const item = order.items[i];
    if (!item) continue;
    const discountRate = (item.discountPercentage || 0) / 100;
    const itemTotal = item.price * item.quantity * (1 - discountRate);
    subtotal += itemTotal;
  }

  return subtotal + order.shippingFee;
}
