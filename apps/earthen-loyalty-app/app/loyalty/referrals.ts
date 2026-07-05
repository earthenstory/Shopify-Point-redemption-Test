import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

// Refer-a-friend program. Fraud guards, in order of defense:
// - one attribution per referee, enforced by a DB unique constraint
// - self-referral blocked (same customer, and same email when both known)
// - referees only qualify while they have no prior order activity
// - rewards fire once via a status transition (pending -> rewarded) guarded by
//   an updateMany count check, so concurrent order webhooks can't double-pay
// - optional minimum order subtotal before anyone is rewarded

const REFERRAL_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export async function getReferralSettings(db: PrismaClient, shopDomain: string) {
  return db.referralProgramSettings.upsert({
    where: { shopDomain },
    create: { shopDomain },
    update: {},
  });
}

function generateReferralCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += REFERRAL_CODE_ALPHABET[bytes[index] % REFERRAL_CODE_ALPHABET.length];
  }
  return `ESR-${code}`;
}

export async function getOrCreateReferralCode(
  db: PrismaClient,
  customerId: string,
): Promise<string> {
  const existing = await db.referralCode.findUnique({
    where: { customerId },
    select: { code: true },
  });
  if (existing) return existing.code;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const created = await db.referralCode.create({
        data: { customerId, code: generateReferralCode() },
      });
      return created.code;
    } catch (error) {
      // P2002 on code collision -> retry with a fresh code; on customerId it
      // means a concurrent request already created one -> return it.
      if (
        error &&
        typeof error === "object" &&
        (error as { code?: string }).code === "P2002"
      ) {
        const race = await db.referralCode.findUnique({
          where: { customerId },
          select: { code: true },
        });
        if (race) return race.code;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not generate a referral code.");
}

export async function attachReferral(input: {
  db: PrismaClient;
  shopDomain: string;
  refereeShopifyCustomerId: string;
  code: string;
}): Promise<{ attached: boolean; reason?: string }> {
  const settings = await getReferralSettings(input.db, input.shopDomain);
  if (!settings.enabled) {
    return { attached: false, reason: "Referral program is not active." };
  }

  const normalizedCode = input.code.trim().toUpperCase();
  const referralCode = await input.db.referralCode.findUnique({
    where: { code: normalizedCode },
  });
  if (!referralCode) {
    return { attached: false, reason: "Unknown referral code." };
  }

  const referee = await input.db.loyaltyCustomer.findUnique({
    where: {
      shopDomain_shopifyCustomerId: {
        shopDomain: input.shopDomain,
        shopifyCustomerId: input.refereeShopifyCustomerId,
      },
    },
    select: { id: true, email: true },
  });
  if (!referee) {
    return { attached: false, reason: "Your account is still being prepared." };
  }

  if (referee.id === referralCode.customerId) {
    return { attached: false, reason: "You cannot refer yourself." };
  }

  const referrer = await input.db.loyaltyCustomer.findUnique({
    where: { id: referralCode.customerId },
    select: { id: true, email: true, shopDomain: true },
  });
  if (!referrer || referrer.shopDomain !== input.shopDomain) {
    return { attached: false, reason: "Unknown referral code." };
  }
  if (
    referrer.email &&
    referee.email &&
    referrer.email.toLowerCase() === referee.email.toLowerCase()
  ) {
    return { attached: false, reason: "You cannot refer yourself." };
  }

  const priorOrderActivity = await input.db.ledgerEntry.findFirst({
    where: { customerId: referee.id, type: "order_earn" },
    select: { id: true },
  });
  if (priorOrderActivity) {
    return {
      attached: false,
      reason: "Referrals only apply to first-time customers.",
    };
  }

  try {
    await input.db.referralAttribution.create({
      data: {
        shopDomain: input.shopDomain,
        code: normalizedCode,
        referrerCustomerId: referrer.id,
        refereeCustomerId: referee.id,
        status: "pending",
      },
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: string }).code === "P2002"
    ) {
      return { attached: false, reason: "A referral is already linked." };
    }
    throw error;
  }

  return { attached: true };
}

/**
 * Called from the order webhooks: rewards a pending referral once the referee
 * places their first qualifying order. Idempotent under concurrent webhook
 * delivery via the guarded status transition.
 */
export async function rewardReferralForOrder(input: {
  db: PrismaClient;
  shopDomain: string;
  refereeCustomerId: string;
  orderId: string;
  orderSubtotal: number;
}): Promise<{ rewarded: boolean }> {
  const attribution = await input.db.referralAttribution.findUnique({
    where: { refereeCustomerId: input.refereeCustomerId },
  });
  if (!attribution || attribution.status !== "pending") {
    return { rewarded: false };
  }

  const settings = await getReferralSettings(input.db, input.shopDomain);
  if (!settings.enabled) return { rewarded: false };

  const minSubtotal = settings.minOrderSubtotal
    ? Number(settings.minOrderSubtotal)
    : 0;
  if (minSubtotal > 0 && input.orderSubtotal < minSubtotal) {
    return { rewarded: false };
  }

  const [referrer, referee] = await Promise.all([
    input.db.loyaltyCustomer.findUnique({
      where: { id: attribution.referrerCustomerId },
      include: { wallet: true },
    }),
    input.db.loyaltyCustomer.findUnique({
      where: { id: attribution.refereeCustomerId },
      include: { wallet: true },
    }),
  ]);

  let rewarded = false;
  await input.db.$transaction(async (tx) => {
    // Claim the attribution inside the payout transaction: only the caller
    // that wins the pending -> rewarded transition pays out, and a crash
    // mid-payout rolls the claim back with it.
    const claimed = await tx.referralAttribution.updateMany({
      where: { id: attribution.id, status: "pending" },
      data: {
        status: "rewarded",
        shopifyOrderId: input.orderId,
        rewardedAt: new Date(),
      },
    });
    if (claimed.count !== 1) return;
    rewarded = true;

    if (referrer?.wallet && settings.referrerPoints > 0) {
      await tx.wallet.update({
        where: { id: referrer.wallet.id },
        data: {
          availablePoints: { increment: settings.referrerPoints },
          lifetimeEarnedPoints: { increment: settings.referrerPoints },
        },
      });
      await tx.ledgerEntry.create({
        data: {
          customerId: referrer.id,
          walletId: referrer.wallet.id,
          shopifyOrderId: input.orderId,
          type: "manual_adjustment",
          pointsDelta: settings.referrerPoints,
          currency: "INR",
          description: "Referral reward: your friend placed their first order",
          metadata: { referralAttributionId: attribution.id, role: "referrer" },
        },
      });
    }

    if (referee?.wallet && settings.refereePoints > 0) {
      await tx.wallet.update({
        where: { id: referee.wallet.id },
        data: {
          availablePoints: { increment: settings.refereePoints },
          lifetimeEarnedPoints: { increment: settings.refereePoints },
        },
      });
      await tx.ledgerEntry.create({
        data: {
          customerId: referee.id,
          walletId: referee.wallet.id,
          shopifyOrderId: input.orderId,
          type: "manual_adjustment",
          pointsDelta: settings.refereePoints,
          currency: "INR",
          description: "Referral bonus: welcome from your friend",
          metadata: { referralAttributionId: attribution.id, role: "referee" },
        },
      });
    }
  });

  return { rewarded };
}

/**
 * Claw back a referral payout when the qualifying order is cancelled (e.g. a
 * rejected COD first order — otherwise refer-a-friend + reject-at-doorstep
 * would farm free points). Reverses exactly what the payout ledger recorded,
 * once, via the rewarded -> blocked transition. Balances may go negative by
 * design: a clawback is a debt, clamping it would let the abuse through.
 */
export async function reverseReferralForCancelledOrder(input: {
  db: PrismaClient;
  shopDomain: string;
  orderId: string;
}): Promise<{ reversed: boolean }> {
  const attribution = await input.db.referralAttribution.findFirst({
    where: {
      shopDomain: input.shopDomain,
      shopifyOrderId: input.orderId,
      status: "rewarded",
    },
  });
  if (!attribution) return { reversed: false };

  // The exact paid amounts live on the payout ledger entries.
  const payoutEntries = await input.db.ledgerEntry.findMany({
    where: {
      type: "manual_adjustment",
      pointsDelta: { gt: 0 },
      metadata: { path: ["referralAttributionId"], equals: attribution.id },
    },
    include: { customer: { include: { wallet: true } } },
  });

  let reversed = false;
  await input.db.$transaction(async (tx) => {
    const claimed = await tx.referralAttribution.updateMany({
      where: { id: attribution.id, status: "rewarded" },
      data: {
        status: "blocked",
        blockedReason: "Qualifying order was cancelled",
      },
    });
    if (claimed.count !== 1) return;
    reversed = true;

    for (const entry of payoutEntries) {
      if (!entry.customer.wallet) continue;
      await tx.wallet.update({
        where: { id: entry.customer.wallet.id },
        data: {
          availablePoints: { decrement: entry.pointsDelta },
          lifetimeEarnedPoints: { decrement: entry.pointsDelta },
        },
      });
      await tx.ledgerEntry.create({
        data: {
          customerId: entry.customerId,
          walletId: entry.walletId,
          shopifyOrderId: input.orderId,
          type: "order_cancel_reversal",
          pointsDelta: -entry.pointsDelta,
          currency: entry.currency,
          description: "Reversed referral reward: order was cancelled",
          metadata: {
            referralAttributionId: attribution.id,
            reversedLedgerEntryId: entry.id,
          },
        },
      });
    }
  });

  return { reversed };
}
