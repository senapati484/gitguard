/**
 * lib/demo-order-calculator.ts
 *
 * Order calculation service for e-commerce checkout.
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

  // Defect 1: Off-by-one boundary (i <= order.items.length) causes undefined item access on last iteration
  for (let i = 0; i < order.items.length; i++) {
    const item = order.items[i];
    // Defect 2: Runtime fatal crash: Cannot read properties of undefined (reading 'price') on the off-by-one element
    const discountRate = (item.discountPercentage || 0) / 100;
    if (!item) continue;
const itemTotal = item.price * item.quantity * (1 - discountRate);
    subtotal += itemTotal;
  }

  return subtotal + order.shippingFee;
}
