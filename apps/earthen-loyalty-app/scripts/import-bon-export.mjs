#!/usr/bin/env node
import { basename, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const SHOP_DOMAIN = "701031-e7.myshopify.com";
const EXPECTED_FIELDS = [
  "shopify_id",
  "first_name",
  "last_name",
  "email",
  "points",
  "status",
  "birthday",
  "created_at",
  "profile_full_name",
  "profile_gender",
  "profile_birthday",
  "profile_phone_number",
  "total_spending",
  "total_orders",
  "predicted_spend_tier",
];

const args = parseArgs(process.argv.slice(2));

if (!args.file) {
  printUsageAndExit();
}

const filePath = resolve(args.file);
const sourceFileName = basename(filePath);
const csv = await readFile(filePath, "utf8");
const parsed = parseBonExport(csv);
const summary = summarizeRows(parsed.rows, parsed.repairs, parsed.invalidRows);

if (!args.import) {
  printJson({
    mode: "dry-run",
    sourceFileName,
    ...summary,
  });
  process.exit(summary.invalidRows.length > 0 ? 1 : 0);
}

if (summary.invalidRows.length > 0) {
  printJson({
    mode: "import",
    sourceFileName,
    error: "Refusing to import while invalid rows remain.",
    ...summary,
  });
  process.exit(1);
}

const prisma = new PrismaClient();

try {
  const result = await importRows({
    prisma,
    rows: parsed.rows,
    sourceFileName,
    sourceFilePath: filePath,
    createdBy: args.createdBy ?? "codex",
  });
  printJson({
    mode: "import",
    sourceFileName,
    ...summary,
    ...result,
  });
} finally {
  await prisma.$disconnect();
}

export function parseBonExport(csvText) {
  const records = parseCsv(csvText);
  const header = records.shift() ?? [];

  if (header.join(",") !== EXPECTED_FIELDS.join(",")) {
    throw new Error(
      `Unexpected BON export header. Expected ${EXPECTED_FIELDS.join(",")}`,
    );
  }

  const repairs = [];
  const invalidRows = [];
  const rows = records
    .filter((row) => row.length > 0 && row.some((value) => value.trim()))
    .map((row, index) => {
      const lineNumber = index + 2;
      const normalized = normalizeRow(row, lineNumber, repairs);

      if (normalized.length !== EXPECTED_FIELDS.length) {
        invalidRows.push({
          line: lineNumber,
          reason: `Expected ${EXPECTED_FIELDS.length} columns, found ${normalized.length}`,
          raw: row,
        });
        return null;
      }

      const raw = Object.fromEntries(
        EXPECTED_FIELDS.map((field, fieldIndex) => [
          field,
          normalized[fieldIndex]?.trim() ?? "",
        ]),
      );
      const points = parseInteger(raw.points);

      if (!Number.isInteger(points) || points < 0) {
        invalidRows.push({
          line: lineNumber,
          reason: "Points must be a non-negative integer",
          raw,
        });
        return null;
      }

      if (!raw.shopify_id && !raw.email && !raw.profile_phone_number) {
        invalidRows.push({
          line: lineNumber,
          reason: "At least one customer identifier is required",
          raw,
        });
        return null;
      }

      return {
        rowIndex: lineNumber - 1,
        shopifyCustomerId: raw.shopify_id,
        email: raw.email || null,
        phone: raw.profile_phone_number || null,
        firstName: raw.first_name || null,
        lastName: raw.last_name || null,
        points,
        raw,
      };
    })
    .filter(Boolean);

  return { rows, repairs, invalidRows };
}

export function summarizeRows(rows, repairs = [], invalidRows = []) {
  const totalPoints = rows.reduce((sum, row) => sum + row.points, 0);
  const nonzeroRows = rows.filter((row) => row.points > 0);
  const zeroRows = rows.filter((row) => row.points === 0);
  const topRows = [...nonzeroRows]
    .sort((left, right) => right.points - left.points)
    .slice(0, 10)
    .map((row) => ({
      rowIndex: row.rowIndex,
      shopifyCustomerId: row.shopifyCustomerId,
      email: row.email,
      points: row.points,
    }));

  return {
    sourceRowCount: rows.length + invalidRows.length,
    validRowCount: rows.length,
    invalidRowCount: invalidRows.length,
    zeroPointRowCount: zeroRows.length,
    nonzeroPointRowCount: nonzeroRows.length,
    totalSourcePoints: totalPoints,
    repairs,
    invalidRows,
    topRows,
  };
}

async function importRows({
  prisma,
  rows,
  sourceFileName,
  sourceFilePath,
  createdBy,
}) {
  const existingBatch = await prisma.bonMigrationBatch.findFirst({
    where: {
      shopDomain: SHOP_DOMAIN,
      sourceFileName,
      status: "processed",
    },
    select: { id: true, totalImportedPoints: true, validRowCount: true },
  });

  if (existingBatch) {
    return {
      skipped: true,
      reason: "This source file has already been imported.",
      existingBatch,
    };
  }

  const summary = summarizeRows(rows);
  const batch = await prisma.bonMigrationBatch.create({
    data: {
      shopDomain: SHOP_DOMAIN,
      sourceFileName,
      rawExportUri: sourceFilePath,
      sourceRowCount: summary.sourceRowCount,
      validRowCount: summary.validRowCount,
      invalidRowCount: summary.invalidRowCount,
      totalSourcePoints: summary.totalSourcePoints,
      totalImportedPoints: 0,
      status: "received",
      createdBy,
    },
  });

  let importedPoints = 0;
  let createdLedgerEntries = 0;
  let skippedExistingCredits = 0;

  try {
    for (const row of rows) {
      const imported = await prisma.$transaction(async (tx) => {
        const customer = await tx.loyaltyCustomer.upsert({
          where: {
            shopDomain_shopifyCustomerId: {
              shopDomain: SHOP_DOMAIN,
              shopifyCustomerId: row.shopifyCustomerId,
            },
          },
          create: {
            shopDomain: SHOP_DOMAIN,
            shopifyCustomerId: row.shopifyCustomerId,
            email: row.email,
            phone: row.phone,
            firstName: row.firstName,
            lastName: row.lastName,
            status: "active",
            wallet: { create: {} },
          },
          update: {
            email: row.email,
            phone: row.phone,
            firstName: row.firstName,
            lastName: row.lastName,
            status: "active",
            wallet: { upsert: { create: {}, update: {} } },
          },
          include: { wallet: true },
        });

        const existingCredit = await tx.ledgerEntry.findFirst({
          where: {
            customerId: customer.id,
            type: "migration_credit",
            metadata: {
              path: ["sourceFileName"],
              equals: sourceFileName,
            },
          },
          select: { id: true },
        });

        if (existingCredit) {
          await tx.bonMigrationRow.create({
            data: {
              batchId: batch.id,
              rowIndex: row.rowIndex,
              shopifyCustomerId: row.shopifyCustomerId,
              email: row.email,
              phone: row.phone,
              points: row.points,
              matchedCustomerId: customer.id,
              ledgerEntryId: existingCredit.id,
              error: "Skipped: migration credit already exists for this source file",
              raw: row.raw,
            },
          });
          return { points: 0, ledgerCreated: false, skipped: true };
        }

        const ledger = await tx.ledgerEntry.create({
          data: {
            customerId: customer.id,
            walletId: customer.wallet.id,
            type: "migration_credit",
            pointsDelta: row.points,
            moneyValue: row.points,
            currency: "INR",
            description: `BON Loyalty migration credit from ${sourceFileName}`,
            metadata: {
              source: "bon_loyalty_export",
              sourceFileName,
              rowIndex: row.rowIndex,
              sourceStatus: row.raw.status,
              sourceCreatedAt: row.raw.created_at,
            },
          },
        });

        await tx.wallet.update({
          where: { id: customer.wallet.id },
          data: {
            availablePoints: { increment: row.points },
            lifetimeEarnedPoints: { increment: row.points },
          },
        });

        await tx.pointLot.create({
          data: {
            customerId: customer.id,
            sourceLedgerEntryId: ledger.id,
            originalPoints: row.points,
            remainingPoints: row.points,
          },
        });

        await tx.bonMigrationRow.create({
          data: {
            batchId: batch.id,
            rowIndex: row.rowIndex,
            shopifyCustomerId: row.shopifyCustomerId,
            email: row.email,
            phone: row.phone,
            points: row.points,
            matchedCustomerId: customer.id,
            ledgerEntryId: ledger.id,
            raw: row.raw,
          },
        });

        return { points: row.points, ledgerCreated: true, skipped: false };
      });

      importedPoints += imported.points;
      createdLedgerEntries += imported.ledgerCreated ? 1 : 0;
      skippedExistingCredits += imported.skipped ? 1 : 0;
    }

    await prisma.bonMigrationBatch.update({
      where: { id: batch.id },
      data: {
        totalImportedPoints: importedPoints,
        status: "processed",
        importedAt: new Date(),
      },
    });

    return {
      skipped: false,
      batchId: batch.id,
      importedPoints,
      createdLedgerEntries,
      skippedExistingCredits,
    };
  } catch (error) {
    await prisma.bonMigrationBatch.update({
      where: { id: batch.id },
      data: {
        totalImportedPoints: importedPoints,
        status: "failed",
      },
    });
    throw error;
  }
}

function normalizeRow(row, lineNumber, repairs) {
  if (
    row.length === EXPECTED_FIELDS.length + 1 &&
    row[3] === "" &&
    looksLikeEmail(row[4]) &&
    Number.isInteger(parseInteger(row[5]))
  ) {
    repairs.push({
      line: lineNumber,
      reason: "Removed extra blank email column before shifted BON email/points fields",
      shopifyCustomerId: row[0],
      email: row[4],
      points: parseInteger(row[5]),
    });
    return [...row.slice(0, 3), ...row.slice(4)];
  }

  return row;
}

function parseCsv(csvText) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    const next = csvText[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function parseInteger(value) {
  if (typeof value !== "string") return Number.NaN;
  if (!/^\d+$/.test(value.trim())) return Number.NaN;
  return Number(value.trim());
}

function looksLikeEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") parsed.file = argv[++index];
    else if (arg === "--import") parsed.import = true;
    else if (arg === "--dry-run") parsed.import = false;
    else if (arg === "--created-by") parsed.createdBy = argv[++index];
    else if (!arg.startsWith("--") && !parsed.file) parsed.file = arg;
  }

  return parsed;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printUsageAndExit() {
  console.error(
    "Usage: node scripts/import-bon-export.mjs --file /path/to/export.csv [--dry-run|--import] [--created-by name]",
  );
  process.exit(1);
}
