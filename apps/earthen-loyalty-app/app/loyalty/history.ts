import type { LedgerEntryType, PrismaClient } from "@prisma/client";

export type LoyaltyTransactionKind = "earn" | "redeem" | "adjust";

export type LoyaltyTransaction = {
  id: string;
  date: string; // ISO timestamp
  kind: LoyaltyTransactionKind;
  label: string;
  points: number; // signed: positive = earned, negative = spent/removed
  orderId: string | null;
  orderName: string | null;
  moneyValue: number | null;
};

// Ledger types that are meaningful to a customer as a "transaction". The internal
// reservation mechanics (redeem_reserve / redeem_release) are intentionally hidden:
// a cart hold that never reaches an order nets to zero, and a real redemption is
// represented cleanly by redeem_consume (which carries the order + consumed points).
const VISIBLE_TYPES: LedgerEntryType[] = [
  "order_earn",
  "signup_bonus",
  "migration_credit",
  "redeem_consume",
  "refund_reversal",
  "order_cancel_reversal",
  "expiry",
  "manual_adjustment",
];

const HISTORY_LIMIT = 25;

type LedgerRow = {
  id: string;
  type: LedgerEntryType;
  pointsDelta: number;
  moneyValue: unknown;
  shopifyOrderId: string | null;
  createdAt: Date;
  redemptionSession: { pointsConsumed: number } | null;
};

export async function getLoyaltyCustomerHistory(input: {
  db: PrismaClient;
  shopDomain: string;
  shopifyCustomerId: string;
  // Injected so the DB logic stays testable without the Shopify admin client.
  resolveOrderNames?: (orderIds: string[]) => Promise<Record<string, string>>;
}): Promise<{ transactions: LoyaltyTransaction[] }> {
  const customer = await input.db.loyaltyCustomer.findUnique({
    where: {
      shopDomain_shopifyCustomerId: {
        shopDomain: input.shopDomain,
        shopifyCustomerId: input.shopifyCustomerId,
      },
    },
    select: { id: true },
  });
  if (!customer) return { transactions: [] };

  const entries = (await input.db.ledgerEntry.findMany({
    where: { customerId: customer.id, type: { in: VISIBLE_TYPES } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: {
      id: true,
      type: true,
      pointsDelta: true,
      moneyValue: true,
      shopifyOrderId: true,
      createdAt: true,
      redemptionSession: { select: { pointsConsumed: true } },
    },
  })) as LedgerRow[];

  const transactions = entries.map(toTransaction);

  const orderIds = [
    ...new Set(
      transactions
        .map((transaction) => transaction.orderId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (orderIds.length && input.resolveOrderNames) {
    const names = await input
      .resolveOrderNames(orderIds)
      .catch((): Record<string, string> => ({}));
    for (const transaction of transactions) {
      if (transaction.orderId && names[transaction.orderId]) {
        transaction.orderName = names[transaction.orderId];
      }
    }
  }

  return { transactions };
}

export function toTransaction(entry: LedgerRow): LoyaltyTransaction {
  const base = {
    id: entry.id,
    date: entry.createdAt.toISOString(),
    orderId: entry.shopifyOrderId ?? null,
    orderName: null,
    moneyValue: entry.moneyValue != null ? Number(entry.moneyValue) : null,
  };

  switch (entry.type) {
    case "order_earn":
      return { ...base, kind: "earn", label: "Earned", points: entry.pointsDelta };
    case "signup_bonus":
      return { ...base, kind: "earn", label: "Signup bonus", points: entry.pointsDelta };
    case "migration_credit":
      return { ...base, kind: "earn", label: "Opening balance", points: entry.pointsDelta };
    case "redeem_consume": {
      // redeem_consume carries pointsDelta 0 (points already left the balance at
      // reserve time); the redeemed amount lives on the linked session.
      const consumed = entry.redemptionSession?.pointsConsumed ?? 0;
      return { ...base, kind: "redeem", label: "Redeemed", points: -Math.abs(consumed) };
    }
    case "refund_reversal":
      return { ...base, kind: "adjust", label: "Refund adjustment", points: entry.pointsDelta };
    case "order_cancel_reversal":
      return { ...base, kind: "adjust", label: "Order cancelled", points: entry.pointsDelta };
    case "expiry":
      return { ...base, kind: "adjust", label: "Points expired", points: entry.pointsDelta };
    default:
      return { ...base, kind: "adjust", label: "Adjustment", points: entry.pointsDelta };
  }
}
