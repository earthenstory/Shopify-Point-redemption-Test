import { verifyHmacHex } from "./crypto";

export type RazorpayRegistration = {
  customerId: string;
  registrationOrderId: string;
  checkoutKey: string;
};

export interface RazorpayGateway {
  createRegistration(input: {
    name: string;
    email: string;
    contact: string;
    mandateMaxPaise: number;
    expireAt: Date;
    intervalCode: string;
    groupId: string;
  }): Promise<RazorpayRegistration>;
  createRecurringPayment(input: {
    customerId: string;
    tokenId: string;
    amountPaise: number;
    receipt: string;
    email: string;
    contact: string;
    groupId: string;
    cycleId: string;
  }): Promise<{ orderId: string; paymentId?: string; status: string }>;
  refundPayment(paymentId: string, amountPaise?: number): Promise<{ id: string; status: string }>;
  cancelToken(tokenId: string): Promise<void>;
}

export class RazorpayHttpGateway implements RazorpayGateway {
  private keyId: string;
  private keySecret: string;

  constructor(keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET) {
    if (!keyId || !keySecret) throw new Error("Razorpay credentials are not configured");
    this.keyId = keyId;
    this.keySecret = keySecret;
  }

  async createRegistration(input: Parameters<RazorpayGateway["createRegistration"]>[0]) {
    const customer = await this.request<{ id: string }>("/customers", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        email: input.email || undefined,
        contact: input.contact || undefined,
        fail_existing: "0",
        notes: { subscription_group_id: input.groupId },
      }),
    });
    const order = await this.request<{ id: string }>("/orders", {
      method: "POST",
      body: JSON.stringify({
        amount: 0,
        currency: "INR",
        customer_id: customer.id,
        method: "upi",
        token: {
          max_amount: input.mandateMaxPaise,
          expire_at: Math.floor(input.expireAt.getTime() / 1000),
          frequency: input.intervalCode,
          recurring_value: "variable",
        },
        receipt: `sub-reg-${input.groupId}`.slice(0, 40),
        notes: { subscription_group_id: input.groupId, purpose: "mandate_registration" },
      }),
    });
    return {
      customerId: customer.id,
      registrationOrderId: order.id,
      checkoutKey: this.keyId,
    };
  }

  async createRecurringPayment(input: Parameters<RazorpayGateway["createRecurringPayment"]>[0]) {
    const order = await this.request<{ id: string }>("/orders", {
      method: "POST",
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: "INR",
        receipt: input.receipt.slice(0, 40),
        notes: { subscription_group_id: input.groupId, billing_cycle_id: input.cycleId },
      }),
    });
    const payment = await this.request<{ razorpay_payment_id?: string; id?: string; status?: string }>(
      "/payments/create/recurring",
      {
        method: "POST",
        body: JSON.stringify({
          email: input.email,
          contact: input.contact,
          amount: input.amountPaise,
          currency: "INR",
          order_id: order.id,
          customer_id: input.customerId,
          token: input.tokenId,
          recurring: "1",
          description: "Earthen subscription renewal",
          notes: { subscription_group_id: input.groupId, billing_cycle_id: input.cycleId },
        }),
      },
    );
    return {
      orderId: order.id,
      paymentId: payment.razorpay_payment_id ?? payment.id,
      status: payment.status ?? "created",
    };
  }

  async refundPayment(paymentId: string, amountPaise?: number) {
    return this.request<{ id: string; status: string }>(`/payments/${paymentId}/refund`, {
      method: "POST",
      body: JSON.stringify(amountPaise ? { amount: amountPaise } : {}),
    });
  }

  async cancelToken(tokenId: string) {
    await this.request(`/tokens/${tokenId}/cancel`, { method: "POST", body: "{}" });
  }

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`https://api.razorpay.com/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const description = (payload as { error?: { description?: string } }).error?.description;
      throw new Error(`Razorpay ${response.status}: ${description ?? "request failed"}`);
    }
    return payload as T;
  }
}

export function verifyRazorpayWebhook(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new Error("RAZORPAY_WEBHOOK_SECRET is not configured");
  return verifyHmacHex(rawBody, signature, secret);
}
