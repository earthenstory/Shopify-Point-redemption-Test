import { z } from "zod";

export const bonBalanceRowSchema = z.object({
  shopifyCustomerId: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(3).optional(),
  points: z.number().int().min(0),
});

export type BonBalanceRow = z.infer<typeof bonBalanceRowSchema>;

export type MigrationValidationResult = {
  validRows: BonBalanceRow[];
  invalidRows: Array<{ rowIndex: number; reason: string }>;
  totalPoints: number;
};

export function validateBonBalanceRows(
  rows: unknown[],
): MigrationValidationResult {
  const validRows: BonBalanceRow[] = [];
  const invalidRows: Array<{ rowIndex: number; reason: string }> = [];

  rows.forEach((row, index) => {
    const parsed = bonBalanceRowSchema.safeParse(row);
    if (!parsed.success) {
      invalidRows.push({
        rowIndex: index,
        reason: parsed.error.issues.map((issue) => issue.message).join("; "),
      });
      return;
    }

    if (
      !parsed.data.shopifyCustomerId &&
      !parsed.data.email &&
      !parsed.data.phone
    ) {
      invalidRows.push({
        rowIndex: index,
        reason: "At least one customer identifier is required",
      });
      return;
    }

    validRows.push(parsed.data);
  });

  return {
    validRows,
    invalidRows,
    totalPoints: validRows.reduce((sum, row) => sum + row.points, 0),
  };
}

export function buildMigrationLedgerDescription(batchId: string): string {
  return `BON Loyalty migration credit from batch ${batchId}`;
}
