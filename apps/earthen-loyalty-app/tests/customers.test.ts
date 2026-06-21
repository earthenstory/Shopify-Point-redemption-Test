import { describe, expect, it } from "vitest";
import {
  getCustomerLoyaltyMessage,
  pointsToMoney,
  type LoyaltyCustomerSnapshot,
} from "../app/loyalty/customers";

function snapshot(
  overrides: Partial<LoyaltyCustomerSnapshot>,
): LoyaltyCustomerSnapshot {
  return {
    customerId: "customer-1",
    availablePoints: 0,
    pendingPoints: 0,
    lifetimeEarnedPoints: 0,
    lifetimeRedeemedPoints: 0,
    hasLedgerEntries: false,
    migrated: false,
    ...overrides,
  };
}

describe("customer loyalty state", () => {
  it("converts points to their configured rupee value", () => {
    expect(pointsToMoney(220)).toBe(220);
  });

  it("does not override the balance message when a customer has points", () => {
    expect(
      getCustomerLoyaltyMessage(
        snapshot({
          availablePoints: 220,
          hasLedgerEntries: true,
          migrated: true,
        }),
      ),
    ).toBeNull();
  });

  it("shows an earning prompt for customers with zero points", () => {
    expect(getCustomerLoyaltyMessage(snapshot({ availablePoints: 0 }))).toBe(
      "You do not have Earthen Points yet. Create an account or place an order to start earning.",
    );
  });

  it("shows the same earning prompt before a new customer wallet is synced", () => {
    expect(
      getCustomerLoyaltyMessage(
        snapshot({ customerId: "gid://shopify/Customer/999999999" }),
      ),
    ).toContain("start earning");
  });
});
