import { describe, expect, it } from "vitest";
import { toTransaction } from "../app/loyalty/history";

const baseRow = {
  id: "ledger-1",
  pointsDelta: 0,
  moneyValue: null as unknown,
  shopifyOrderId: null as string | null,
  createdAt: new Date("2026-06-01T10:00:00.000Z"),
  redemptionSession: null as { pointsConsumed: number } | null,
};

describe("loyalty history mapping", () => {
  it("maps an order earn into a positive earn transaction with its order", () => {
    const txn = toTransaction({
      ...baseRow,
      type: "order_earn",
      pointsDelta: 40,
      shopifyOrderId: "12345",
    } as never);
    expect(txn).toMatchObject({
      kind: "earn",
      label: "Earned",
      points: 40,
      orderId: "12345",
      date: "2026-06-01T10:00:00.000Z",
    });
  });

  it("maps a redeem_consume to a negative redeem using the session's consumed points", () => {
    const txn = toTransaction({
      ...baseRow,
      type: "redeem_consume",
      pointsDelta: 0,
      moneyValue: 50,
      shopifyOrderId: "67890",
      redemptionSession: { pointsConsumed: 50 },
    } as never);
    expect(txn).toMatchObject({
      kind: "redeem",
      label: "Redeemed",
      points: -50,
      orderId: "67890",
      moneyValue: 50,
    });
  });

  it("labels a migration credit as the opening balance", () => {
    const txn = toTransaction({
      ...baseRow,
      type: "migration_credit",
      pointsDelta: 110,
    } as never);
    expect(txn).toMatchObject({ kind: "earn", label: "Opening balance", points: 110 });
  });
});
