import { describe, expect, it } from "vitest";
import {
  buildMigrationLedgerDescription,
  validateBonBalanceRows,
} from "../app/loyalty/migration";

describe("BON balance migration validation", () => {
  it("requires at least one customer identifier", () => {
    const result = validateBonBalanceRows([{ points: 100 }]);

    expect(result.validRows).toHaveLength(0);
    expect(result.invalidRows).toEqual([
      {
        rowIndex: 0,
        reason: "At least one customer identifier is required",
      },
    ]);
  });

  it("keeps a reconciliation total for valid rows", () => {
    const result = validateBonBalanceRows([
      { shopifyCustomerId: "123", points: 250 },
      { email: "customer@example.com", points: 40 },
      { phone: "+919999999999", points: 10 },
    ]);

    expect(result.invalidRows).toHaveLength(0);
    expect(result.totalPoints).toBe(300);
  });

  it("accepts zero-balance migrated customers and includes them in valid rows", () => {
    const result = validateBonBalanceRows([
      { shopifyCustomerId: "123", email: "zero@example.com", points: 0 },
      { shopifyCustomerId: "456", email: "points@example.com", points: 75 },
    ]);

    expect(result.invalidRows).toHaveLength(0);
    expect(result.validRows).toHaveLength(2);
    expect(result.validRows[0]).toMatchObject({
      shopifyCustomerId: "123",
      points: 0,
    });
    expect(result.totalPoints).toBe(75);
  });

  it("rejects negative or fractional point balances", () => {
    const result = validateBonBalanceRows([
      { email: "a@example.com", points: -1 },
      { email: "b@example.com", points: 1.5 },
    ]);

    expect(result.validRows).toHaveLength(0);
    expect(result.invalidRows).toHaveLength(2);
  });

  it("labels imported points as BON migration credits", () => {
    expect(buildMigrationLedgerDescription("batch_123")).toContain(
      "BON Loyalty migration credit",
    );
  });
});
