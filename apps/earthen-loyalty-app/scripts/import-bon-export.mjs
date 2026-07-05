#!/usr/bin/env node
import { basename, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const SHOP_DOMAIN = "701031-e7.myshopify.com";
// BON has shipped (at least) two export layouts; both are supported. The
// header row is matched exactly to pick the right field mapping.
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
const LIST_EXPORT_FIELDS = [
  "email",
  "shopify_id",
  "last_name",
  "first_name",
  "points",
  "status",
  "phone_number",
  "date_of_birth",
  "created_at",
];

const args = parseArgs(process.argv.slice(2));

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));

if (isMain) {
  if (!args.file) {
    printUsageAndExit();
  }

  const filePath = resolve(args.file);
  const sourceFileName = basename(filePath);
  const csv = await readFile(filePath, "utf8");
  const parsed = parseBonExport(csv);
  const summary = summarizeRows(parsed.rows, parsed.repairs, parsed.invalidRows);

  if (!args.import && !args.sync && !args.syncApply) {
    printJson({
      mode: "dry-run",
      sourceFileName,
      ...summary,
    });
    process.exit(summary.invalidRows.length > 0 ? 1 : 0);
  }

  if (summary.invalidRows.length > 0) {
    printJson({
      mode: args.import ? "import" : "sync",
      sourceFileName,
      error: "Refusing to proceed while invalid rows remain.",
      ...summary,
    });
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    if (args.sync || args.syncApply) {
      const result = await syncRows({
        prisma,
        rows: parsed.rows,
        sourceFileName,
        apply: Boolean(args.syncApply),
        createdBy: args.createdBy ?? "sync-script",
      });
      printJson({
        mode: args.syncApply ? "sync-apply" : "sync-dry-run",
        sourceFileName,
        sourceRowCount: summary.sourceRowCount,
        ...result,
      });
    } else {
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
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Pure delta computation for --sync mode. The goal state is
 * available == bonPoints for every exported customer:
 *  - positive delta -> credit (customer earned in BON since last sync)
 *  - negative delta -> debit, clamped so available never goes below zero
 *  - wallets holding an active reservation are skipped for manual review
 */
export function computeSyncAdjustment({ bonPoints, availablePoints, pendingPoints }) {
  if (pendingPoints > 0) {
    return { action: "skip_pending", delta: 0 };
  }
  const delta = bonPoints - availablePoints;
  if (delta === 0) {
    return { action: "in_sync", delta: 0 };
  }
  if (delta < 0 && availablePoints + delta < 0) {
    return { action: "adjust", delta: -availablePoints };
  }
  return { action: "adjust", delta };
}

async function syncRows({ prisma, rows, sourceFileName, apply, createdBy }) {
  const syncFileName = `sync:${sourceFileName}`;

  const existingBatch = await prisma.bonMigrationBatch.findFirst({
    where: {
      shopDomain: SHOP_DOMAIN,
      sourceFileName: syncFileName,
      status: "processed",
    },
    select: { id: true },
  });
  if (existingBatch && apply) {
    return { skipped: true, reason: "This export has already been synced.", existingBatch };
  }

  const stats = {
    rows: rows.length,
    newCustomers: 0,
    inSync: 0,
    credited: 0,
    creditedPoints: 0,
    debited: 0,
    debitedPoints: 0,
    skippedPending: 0,
    clampedNegative: 0,
  };
  const topDeltas = [];

  let batch = null;
  if (apply) {
    batch = await prisma.bonMigrationBatch.create({
      data: {
        shopDomain: SHOP_DOMAIN,
        sourceFileName: syncFileName,
        rawExportUri: sourceFileName,
        sourceRowCount: rows.length,
        validRowCount: rows.length,
        invalidRowCount: 0,
        totalSourcePoints: rows.reduce((sum, row) => sum + row.points, 0),
        totalImportedPoints: 0,
        status: "received",
        createdBy,
      },
    });
  }

  let netApplied = 0;

  for (const row of rows) {
    const existing = await prisma.loyaltyCustomer.findUnique({
      where: {
        shopDomain_shopifyCustomerId: {
          shopDomain: SHOP_DOMAIN,
          shopifyCustomerId: row.shopifyCustomerId,
        },
      },
      include: { wallet: true },
    });

    const availablePoints = existing?.wallet?.availablePoints ?? 0;
    const pendingPoints = existing?.wallet?.pendingPoints ?? 0;
    const adjustment = computeSyncAdjustment({
      bonPoints: row.points,
      availablePoints,
      pendingPoints,
    });

    if (!existing) stats.newCustomers += 1;
    if (adjustment.action === "skip_pending") {
      stats.skippedPending += 1;
      continue;
    }
    if (adjustment.action === "in_sync") {
      stats.inSync += 1;
      continue;
    }

    if (adjustment.delta > 0) {
      stats.credited += 1;
      stats.creditedPoints += adjustment.delta;
    } else {
      stats.debited += 1;
      stats.debitedPoints += -adjustment.delta;
      if (row.points - availablePoints !== adjustment.delta) stats.clampedNegative += 1;
    }
    if (topDeltas.length < 15) {
      topDeltas.push({
        who: row.email ?? row.phone ?? row.shopifyCustomerId,
        bon: row.points,
        db: availablePoints,
        delta: adjustment.delta,
      });
    }

    if (!apply) continue;

    await prisma.$transaction(async (tx) => {
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
          wallet: { upsert: { create: {}, update: {} } },
        },
        include: { wallet: true },
      });

      // Idempotency inside a single file: skip if this file already adjusted
      // this customer (belt-and-braces on top of the delta converging to 0).
      const already = await tx.ledgerEntry.findFirst({
        where: {
          customerId: customer.id,
          type: "manual_adjustment",
          metadata: { path: ["sourceFileName"], equals: syncFileName },
        },
        select: { id: true },
      });
      if (already) return;

      const ledger = await tx.ledgerEntry.create({
        data: {
          customerId: customer.id,
          walletId: customer.wallet.id,
          type: existing ? "manual_adjustment" : "migration_credit",
          pointsDelta: adjustment.delta,
          moneyValue: Math.abs(adjustment.delta),
          currency: "INR",
          description: `BON Loyalty balance sync from ${sourceFileName}`,
          metadata: {
            source: "bon_balance_sync",
            sourceFileName: syncFileName,
            rowIndex: row.rowIndex,
            bonPoints: row.points,
            previousAvailable: availablePoints,
          },
        },
      });

      await tx.wallet.update({
        where: { id: customer.wallet.id },
        data: {
          availablePoints: { increment: adjustment.delta },
          ...(adjustment.delta > 0
            ? { lifetimeEarnedPoints: { increment: adjustment.delta } }
            : { lifetimeRedeemedPoints: { increment: -adjustment.delta } }),
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

      netApplied += adjustment.delta;
    });
  }

  if (apply) {
    await prisma.bonMigrationBatch.update({
      where: { id: batch.id },
      data: {
        totalImportedPoints: netApplied,
        status: "processed",
        importedAt: new Date(),
      },
    });
  }

  return { ...stats, netDelta: stats.creditedPoints - stats.debitedPoints, netApplied: apply ? netApplied : null, batchId: batch?.id ?? null, topDeltas };
}

export function parseBonExport(csvText) {
  // Strip a UTF-8 BOM if present (the "list-customer" exports carry one).
  const records = parseCsv(csvText.replace(/^﻿/, ""));
  const header = records.shift() ?? [];
  const headerKey = header.map((cell) => cell.trim()).join(",");

  let fields;
  let phoneField;
  if (headerKey === EXPECTED_FIELDS.join(",")) {
    fields = EXPECTED_FIELDS;
    phoneField = "profile_phone_number";
  } else if (headerKey === LIST_EXPORT_FIELDS.join(",")) {
    fields = LIST_EXPORT_FIELDS;
    phoneField = "phone_number";
  } else {
    throw new Error(
      `Unexpected BON export header. Got: ${headerKey.slice(0, 200)}`,
    );
  }
  const EXPECTED = fields;

  const repairs = [];
  const invalidRows = [];
  const rows = records
    .filter((row) => row.length > 0 && row.some((value) => value.trim()))
    .map((row, index) => {
      const lineNumber = index + 2;
      const normalized =
        fields === EXPECTED_FIELDS
          ? normalizeRow(row, lineNumber, repairs)
          : row;

      if (normalized.length !== EXPECTED.length) {
        invalidRows.push({
          line: lineNumber,
          reason: `Expected ${EXPECTED.length} columns, found ${normalized.length}`,
          raw: row,
        });
        return null;
      }

      const raw = Object.fromEntries(
        EXPECTED.map((field, fieldIndex) => [
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

      if (!raw.shopify_id && !raw.email && !raw[phoneField]) {
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
        phone: raw[phoneField] || null,
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
    else if (arg === "--sync") parsed.sync = true;
    else if (arg === "--sync-apply") parsed.syncApply = true;
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
    "Usage: node scripts/import-bon-export.mjs --file /path/to/export.csv [--dry-run|--import|--sync|--sync-apply] [--created-by name]",
  );
  process.exit(1);
}
