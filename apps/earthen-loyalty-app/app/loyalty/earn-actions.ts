import type { PrismaClient } from "@prisma/client";

// "Ways to earn" beyond orders: configurable actions (social follows, custom
// links) a signed-in customer can claim points for. The unique
// (actionId, customerId) constraint is the fraud guard for once-per-customer
// actions — a double claim races into the constraint and is rejected.

export async function listEarnActions(input: {
  db: PrismaClient;
  shopDomain: string;
  customerId?: string | null;
}) {
  const actions = await input.db.earnAction.findMany({
    where: { shopDomain: input.shopDomain, enabled: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  if (!input.customerId || actions.length === 0) {
    return actions.map((action) => ({
      id: action.id,
      title: action.title,
      url: action.url,
      points: action.points,
      claimed: false,
    }));
  }

  const claims = await input.db.earnActionClaim.findMany({
    where: {
      customerId: input.customerId,
      actionId: { in: actions.map((action) => action.id) },
    },
    select: { actionId: true },
  });
  const claimedIds = new Set(claims.map((claim) => claim.actionId));

  return actions.map((action) => ({
    id: action.id,
    title: action.title,
    url: action.url,
    points: action.points,
    claimed: action.oncePerCustomer && claimedIds.has(action.id),
  }));
}

export async function claimEarnAction(input: {
  db: PrismaClient;
  shopDomain: string;
  shopifyCustomerId: string;
  actionId: string;
}): Promise<{ awarded: number; alreadyClaimed: boolean }> {
  const action = await input.db.earnAction.findFirst({
    where: {
      id: input.actionId,
      shopDomain: input.shopDomain,
      enabled: true,
    },
  });
  if (!action || action.points <= 0) {
    throw new Error("This earning action is not available.");
  }

  const customer = await input.db.loyaltyCustomer.findUnique({
    where: {
      shopDomain_shopifyCustomerId: {
        shopDomain: input.shopDomain,
        shopifyCustomerId: input.shopifyCustomerId,
      },
    },
    include: { wallet: true },
  });
  if (!customer?.wallet) {
    throw new Error("Your points are still being prepared.");
  }

  if (action.oncePerCustomer) {
    const existing = await input.db.earnActionClaim.findUnique({
      where: {
        actionId_customerId: {
          actionId: action.id,
          customerId: customer.id,
        },
      },
      select: { id: true },
    });
    if (existing) {
      return { awarded: 0, alreadyClaimed: true };
    }
  }

  try {
    await input.db.$transaction(async (tx) => {
      if (action.oncePerCustomer) {
        // Insert first: the unique constraint turns a concurrent double claim
        // into a P2002 instead of a double award.
        await tx.earnActionClaim.create({
          data: { actionId: action.id, customerId: customer.id },
        });
      }

      await tx.wallet.update({
        where: { id: customer.wallet!.id },
        data: {
          availablePoints: { increment: action.points },
          lifetimeEarnedPoints: { increment: action.points },
        },
      });

      await tx.ledgerEntry.create({
        data: {
          customerId: customer.id,
          walletId: customer.wallet!.id,
          type: "manual_adjustment",
          pointsDelta: action.points,
          currency: "INR",
          description: `Earned points: ${action.title}`,
          metadata: { earnActionId: action.id, source: "earn_action" },
        },
      });
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: string }).code === "P2002"
    ) {
      return { awarded: 0, alreadyClaimed: true };
    }
    throw error;
  }

  return { awarded: action.points, alreadyClaimed: false };
}
