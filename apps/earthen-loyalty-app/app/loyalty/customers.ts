import type { PrismaClient } from "@prisma/client";
import { confirmedBonDefaults } from "./rules";

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
        select: { type: true },
        take: 50,
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!loyaltyCustomer?.wallet) {
    return emptySnapshot(input.shopifyCustomerId);
  }

  return {
    customerId: loyaltyCustomer.id,
    availablePoints: loyaltyCustomer.wallet.availablePoints,
    pendingPoints: loyaltyCustomer.wallet.pendingPoints,
    lifetimeEarnedPoints: loyaltyCustomer.wallet.lifetimeEarnedPoints,
    lifetimeRedeemedPoints: loyaltyCustomer.wallet.lifetimeRedeemedPoints,
    hasLedgerEntries: loyaltyCustomer.ledgerEntries.length > 0,
    migrated: loyaltyCustomer.ledgerEntries.some(
      (entry) => entry.type === "migration_credit",
    ),
  };
}

export function pointsToMoney(points: number): number {
  return points * confirmedBonDefaults.currencyValuePerPoint;
}

export function getCustomerLoyaltyMessage(
  snapshot: LoyaltyCustomerSnapshot,
): string | null {
  if (snapshot.hasLedgerEntries || snapshot.availablePoints > 0) {
    return null;
  }

  return "You do not have Earthen Points yet. Create an account or place an order to start earning.";
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
