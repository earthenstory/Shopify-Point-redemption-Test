import type { PrismaClient } from "@prisma/client";
import { confirmedBonDefaults, type LoyaltyRules } from "./rules";

export type LoyaltyCustomerSnapshot = {
  customerId: string | null;
  availablePoints: number;
  pendingPoints: number;
  lifetimeEarnedPoints: number;
  lifetimeRedeemedPoints: number;
  hasLedgerEntries: boolean;
  migrated: boolean;
};

export async function getCustomerSnapshot(input: {
  db: PrismaClient;
  shopDomain: string;
  shopifyCustomerId: string | null;
}): Promise<LoyaltyCustomerSnapshot> {
  if (!input.shopifyCustomerId) {
    return emptySnapshot(null);
  }

  // The snapshot only needs two booleans from the ledger, so we avoid pulling the
  // last 50 rows just to scan them in JS. Fetch a single migration marker with the
  // customer/wallet (one row, one round trip); `migrated` implies ledger entries
  // exist, so only fall back to a cheap existence check when it's absent.
  const loyaltyCustomer = await input.db.loyaltyCustomer.findUnique({
    where: {
      shopDomain_shopifyCustomerId: {
        shopDomain: input.shopDomain,
        shopifyCustomerId: input.shopifyCustomerId,
      },
    },
    include: {
      wallet: true,
      ledgerEntries: {
        where: { type: "migration_credit" },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!loyaltyCustomer?.wallet) {
    return emptySnapshot(input.shopifyCustomerId);
  }

  const migrated = loyaltyCustomer.ledgerEntries.length > 0;
  const hasLedgerEntries =
    migrated ||
    (await input.db.ledgerEntry.findFirst({
      where: { customerId: loyaltyCustomer.id },
      select: { id: true },
    })) !== null;

  return {
    customerId: loyaltyCustomer.id,
    availablePoints: loyaltyCustomer.wallet.availablePoints,
    pendingPoints: loyaltyCustomer.wallet.pendingPoints,
    lifetimeEarnedPoints: loyaltyCustomer.wallet.lifetimeEarnedPoints,
    lifetimeRedeemedPoints: loyaltyCustomer.wallet.lifetimeRedeemedPoints,
    hasLedgerEntries,
    migrated,
  };
}

export function pointsToMoney(
  points: number,
  rules: LoyaltyRules = confirmedBonDefaults,
): number {
  return points * rules.currencyValuePerPoint;
}

export function getCustomerLoyaltyMessage(
  snapshot: LoyaltyCustomerSnapshot,
  zeroPointsMessage = "You do not have Earthen Points yet. Create an account or place an order to start earning.",
): string | null {
  if (snapshot.hasLedgerEntries || snapshot.availablePoints > 0) {
    return null;
  }

  return zeroPointsMessage;
}

function emptySnapshot(
  shopifyCustomerId: string | null,
): LoyaltyCustomerSnapshot {
  return {
    customerId: shopifyCustomerId,
    availablePoints: 0,
    pendingPoints: 0,
    lifetimeEarnedPoints: 0,
    lifetimeRedeemedPoints: 0,
    hasLedgerEntries: false,
    migrated: false,
  };
}
