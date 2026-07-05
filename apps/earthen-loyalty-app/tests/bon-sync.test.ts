import { describe, expect, it } from "vitest";
// eslint-disable-next-line -- plain mjs module
// @ts-ignore
import { computeSyncAdjustment } from "../scripts/import-bon-export.mjs";

describe("BON balance sync deltas", () => {
  it("credits customers who earned in BON since the last sync", () => {
    expect(
      computeSyncAdjustment({ bonPoints: 400, availablePoints: 250, pendingPoints: 0 }),
    ).toEqual({ action: "adjust", delta: 150 });
  });

  it("debits customers who redeemed in BON since the last sync", () => {
    expect(
      computeSyncAdjustment({ bonPoints: 150, availablePoints: 250, pendingPoints: 0 }),
    ).toEqual({ action: "adjust", delta: -100 });
  });

  it("leaves matching balances untouched", () => {
    expect(
      computeSyncAdjustment({ bonPoints: 250, availablePoints: 250, pendingPoints: 0 }),
    ).toEqual({ action: "in_sync", delta: 0 });
  });

  it("clamps negative deltas so available never goes below zero", () => {
    expect(
      computeSyncAdjustment({ bonPoints: 0, availablePoints: 40, pendingPoints: 0 }),
    ).toEqual({ action: "adjust", delta: -40 });
    // even if BON is somehow lower than a negative-capable delta
    expect(
      computeSyncAdjustment({ bonPoints: 10, availablePoints: 5, pendingPoints: 0 }),
    ).toEqual({ action: "adjust", delta: 5 });
  });

  it("skips wallets holding an active reservation", () => {
    expect(
      computeSyncAdjustment({ bonPoints: 100, availablePoints: 40, pendingPoints: 160 }),
    ).toEqual({ action: "skip_pending", delta: 0 });
  });
});
