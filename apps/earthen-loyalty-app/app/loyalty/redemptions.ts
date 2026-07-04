import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { PrismaClient } from "@prisma/client";
import {
  calculateDiscountAmount,
  calculateMaxRedeemablePoints,
  calculateMinimumSubtotalForDiscount,
  confirmedBonDefaults,
  type LoyaltyRules,
  normalizeRedeemPoints,
} from "./rules";
import { getLoyaltyRuntimeSettings } from "./settings";

const CODE_PREFIX = "ESPOINTS";

export type CartSnapshot = {
  token?: string | null;
  subtotal: number;
};

export type RedemptionPreview = {
  maxRedeemablePoints: number;
  discountAmount: number;
  minimumSubtotal: number;
  currency: string;
};

export function previewRedemption(input: {
  availablePoints: number;
  cart: CartSnapshot;
  rules?: LoyaltyRules;
}): RedemptionPreview {
  const rules = input.rules ?? confirmedBonDefaults;
  const maxRedeemablePoints = calculateMaxRedeemablePoints({
    availablePoints: input.availablePoints,
    eligibleCartSubtotal: input.cart.subtotal,
    rules,
  });

  return {
    maxRedeemablePoints,
    discountAmount: calculateDiscountAmount(maxRedeemablePoints, rules),
    minimumSubtotal: calculateMinimumSubtotalForDiscount(maxRedeemablePoints, rules),
    currency: rules.currency,
  };
}

export async function createRedemption(input: {
  db: PrismaClient;
  admin: AdminApiContext;
  shopDomain: string;
  shopifyCustomerId: string;
  requestedPoints: number;
  cart: CartSnapshot;
}): Promise<{
  sessionId: string;
  discountCode: string;
  pointsReserved: number;
  discountAmount: number;
  expiresAt: string;
}> {
  const loyaltyCustomer = await input.db.loyaltyCustomer.findUnique({
    where: {
      shopDomain_shopifyCustomerId: {
        shopDomain: input.shopDomain,
        shopifyCustomerId: input.shopifyCustomerId,
      },
    },
    include: { wallet: true },
  });

  if (!loyaltyCustomer?.wallet) {
    throw new Error("Your points are still being prepared.");
  }

  const settings = await getLoyaltyRuntimeSettings({
    db: input.db,
    shopDomain: input.shopDomain,
  });
  if (!settings.redemptionEnabled) {
    throw new Error("Earthen Points redemption is currently paused.");
  }

  // Release any prior active reservation for this customer before reserving again.
  // A customer should only ever hold one live reservation; releasing first keeps
  // "Apply" idempotent and, crucially, un-strands points from a previous hold whose
  // discount was dropped by a coupon or whose client-side record was lost (the bug
  // that left points stuck in `pending` with 0 available). Returns those points to
  // the wallet, so we re-read the balance before sizing the new reservation.
  await releaseActiveRedemptions({
    db: input.db,
    admin: input.admin,
    shopDomain: input.shopDomain,
    shopifyCustomerId: input.shopifyCustomerId,
    reason: "Replaced by a new redemption",
  });

  const reconciledWallet = await input.db.wallet.findUnique({
    where: { id: loyaltyCustomer.wallet.id },
    select: { availablePoints: true },
  });
  const availablePoints =
    reconciledWallet?.availablePoints ?? loyaltyCustomer.wallet.availablePoints;

  const pointsToReserve = normalizeRedeemPoints(
    Math.min(
      input.requestedPoints,
      calculateMaxRedeemablePoints({
        availablePoints,
        eligibleCartSubtotal: input.cart.subtotal,
        rules: settings.rules,
      }),
    ),
    settings.rules,
  );

  if (pointsToReserve <= 0) {
    throw new Error("No redeemable points are available for this cart.");
  }

  const discountAmount = calculateDiscountAmount(
    pointsToReserve,
    settings.rules,
  );
  const minimumSubtotal = calculateMinimumSubtotalForDiscount(
    pointsToReserve,
    settings.rules,
  );
  const discountCode = buildDiscountCode(input.shopifyCustomerId);
  const expiresAt = new Date(
    Date.now() + settings.discountCodeTtlMinutes * 60 * 1000,
  );

  const session = await input.db.$transaction(async (tx) => {
    const walletUpdate = await tx.wallet.updateMany({
      where: {
        id: loyaltyCustomer.wallet?.id,
        availablePoints: { gte: pointsToReserve },
      },
      data: {
        availablePoints: { decrement: pointsToReserve },
        pendingPoints: { increment: pointsToReserve },
      },
    });

    if (walletUpdate.count !== 1) {
      throw new Error("Your points balance changed. Please try again.");
    }

    const redemptionSession = await tx.redemptionSession.create({
      data: {
        customerId: loyaltyCustomer.id,
        cartToken: input.cart.token,
        pointsReserved: pointsToReserve,
        discountAmount,
        currency: settings.rules.currency,
        discountCode,
        status: "pending",
        expiresAt,
      },
    });

    await tx.ledgerEntry.create({
      data: {
        customerId: loyaltyCustomer.id,
        walletId: loyaltyCustomer.wallet!.id,
        redemptionSessionId: redemptionSession.id,
        type: "redeem_reserve",
        pointsDelta: -pointsToReserve,
        moneyValue: discountAmount,
        currency: settings.rules.currency,
        description: "Reserved points for cart redemption",
        metadata: {
          cartToken: input.cart.token,
          minimumSubtotal,
          expiresAt: expiresAt.toISOString(),
        },
      },
    });

    return redemptionSession;
  });

  try {
    const discountNodeId = await createShopifyDiscountCode({
      admin: input.admin,
      shopifyCustomerId: input.shopifyCustomerId,
      code: discountCode,
      points: pointsToReserve,
      discountAmount,
      minimumSubtotal,
      expiresAt,
      allowDiscountStacking: settings.rules.allowDiscountStacking,
    });

    await input.db.redemptionSession.update({
      where: { id: session.id },
      data: {
        shopifyDiscountNodeId: discountNodeId,
        status: "applied",
      },
    });
  } catch (error) {
    await releaseRedemption({
      db: input.db,
      shopDomain: input.shopDomain,
      shopifyCustomerId: input.shopifyCustomerId,
      sessionId: session.id,
      reason: "Discount code creation failed",
    });
    throw error;
  }

  return {
    sessionId: session.id,
    discountCode,
    pointsReserved: pointsToReserve,
    discountAmount,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function releaseRedemption(input: {
  db: PrismaClient;
  admin?: AdminApiContext;
  shopDomain: string;
  shopifyCustomerId: string;
  sessionId?: string | null;
  discountCode?: string | null;
  reason?: string;
}): Promise<{ released: boolean }> {
  const session = await input.db.redemptionSession.findFirst({
    where: {
      ...(input.sessionId ? { id: input.sessionId } : {}),
      ...(input.discountCode ? { discountCode: input.discountCode } : {}),
      customer: {
        shopDomain: input.shopDomain,
        shopifyCustomerId: input.shopifyCustomerId,
      },
      status: { in: ["pending", "applied"] },
    },
    include: {
      customer: { include: { wallet: true } },
    },
  });

  if (!session?.customer.wallet) {
    return { released: false };
  }

  const pointsToRelease = session.pointsReserved - session.pointsConsumed;
  if (pointsToRelease <= 0) {
    return { released: false };
  }

  if (input.admin && session.shopifyDiscountNodeId) {
    await deactivateShopifyDiscountCode({
      admin: input.admin,
      discountNodeId: session.shopifyDiscountNodeId,
    });
  }

  await input.db.$transaction(async (tx) => {
    await tx.wallet.update({
      where: { id: session.customer.wallet!.id },
      data: {
        availablePoints: { increment: pointsToRelease },
        pendingPoints: { decrement: pointsToRelease },
      },
    });

    await tx.redemptionSession.update({
      where: { id: session.id },
      data: {
        pointsReleased: { increment: pointsToRelease },
        status: "released",
      },
    });

    await tx.ledgerEntry.create({
      data: {
        customerId: session.customerId,
        walletId: session.customer.wallet!.id,
        redemptionSessionId: session.id,
        type: "redeem_release",
        pointsDelta: pointsToRelease,
        moneyValue: session.discountAmount,
        currency: session.currency,
        description: input.reason ?? "Released cart redemption reservation",
      },
    });
  });

  return { released: true };
}

/**
 * Release a customer's active (pending/applied) reservations and return the points
 * to their wallet. This is the reconciliation safety net for the "stuck points" bug:
 * a reservation can be orphaned if its Shopify discount is dropped from the cart (by a
 * non-combinable coupon, an emptied cart, or a lost client-side record) yet the hold
 * lives on. Any code path that observes a cart with no loyalty discount applied can
 * call this to free the points.
 *
 * - `onlyExpired`: only release reservations whose hold has already lapsed. Safe and
 *   cheap to run on every balance read — no admin call is needed because Shopify has
 *   already expired the code (release runs DB-only when `admin` is omitted).
 * - `exceptDiscountCode`: keep this one live (the code currently applied to the cart).
 */
export async function releaseActiveRedemptions(input: {
  db: PrismaClient;
  admin?: AdminApiContext;
  shopDomain: string;
  shopifyCustomerId: string;
  onlyExpired?: boolean;
  exceptDiscountCode?: string | null;
  reason?: string;
}): Promise<{ released: number }> {
  const sessions = await input.db.redemptionSession.findMany({
    where: {
      customer: {
        shopDomain: input.shopDomain,
        shopifyCustomerId: input.shopifyCustomerId,
      },
      status: { in: ["pending", "applied"] },
      ...(input.onlyExpired ? { expiresAt: { lte: new Date() } } : {}),
      ...(input.exceptDiscountCode
        ? { discountCode: { not: input.exceptDiscountCode } }
        : {}),
    },
    select: { id: true },
  });

  let released = 0;
  for (const session of sessions) {
    const result = await releaseRedemption({
      db: input.db,
      admin: input.admin,
      shopDomain: input.shopDomain,
      shopifyCustomerId: input.shopifyCustomerId,
      sessionId: session.id,
      reason: input.reason ?? "Reconciled stale reservation",
    });
    if (result.released) released += 1;
  }

  return { released };
}

async function deactivateShopifyDiscountCode(input: {
  admin: AdminApiContext;
  discountNodeId: string;
}): Promise<void> {
  const response = await input.admin.graphql(
    `#graphql
    mutation LoyaltyDiscountCodeDeactivate($id: ID!) {
      discountCodeDeactivate(id: $id) {
        codeDiscountNode {
          id
        }
        userErrors {
          field
          code
          message
        }
      }
    }`,
    {
      variables: {
        id: input.discountNodeId,
      },
    },
  );

  const json = (await response.json()) as {
    data?: {
      discountCodeDeactivate?: {
        codeDiscountNode?: { id?: string };
        userErrors?: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  const result = json.data?.discountCodeDeactivate;
  const errors = result?.userErrors ?? json.errors;

  if (errors?.length) {
    throw new Error(
      errors.map((error: { message: string }) => error.message).join("; "),
    );
  }
}

async function createShopifyDiscountCode(input: {
  admin: AdminApiContext;
  shopifyCustomerId: string;
  code: string;
  points: number;
  discountAmount: number;
  minimumSubtotal: number;
  expiresAt: Date;
  allowDiscountStacking: boolean;
}): Promise<string> {
  const response = await input.admin.graphql(
    `#graphql
    mutation LoyaltyDiscountCodeCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
        }
        userErrors {
          field
          code
          message
        }
      }
    }`,
    {
      variables: {
        basicCodeDiscount: {
          title: `Earthen loyalty ${input.points} points`,
          code: input.code,
          startsAt: new Date().toISOString(),
          endsAt: input.expiresAt.toISOString(),
          usageLimit: 1,
          appliesOncePerCustomer: true,
          // The loyalty discount is an order-class (amount off order) discount.
          // We let it combine with PRODUCT- and shipping-class discounts but NOT
          // other order discounts. This is what lets a customer stack their points
          // with a single product-class coupon (e.g. an "amount off products"
          // code) while keeping order-class coupons mutually exclusive with each
          // other and with the points discount.
          combinesWith: {
            orderDiscounts: false,
            productDiscounts: input.allowDiscountStacking,
            shippingDiscounts: input.allowDiscountStacking,
          },
          customerSelection: {
            customers: {
              add: [`gid://shopify/Customer/${input.shopifyCustomerId}`],
            },
          },
          customerGets: {
            value: {
              discountAmount: {
                amount: input.discountAmount.toFixed(2),
                appliesOnEachItem: false,
              },
            },
            items: {
              all: true,
            },
          },
          minimumRequirement:
            input.minimumSubtotal > 0
              ? {
                  subtotal: {
                    greaterThanOrEqualToSubtotal:
                      input.minimumSubtotal.toFixed(2),
                  },
                }
              : null,
        },
      },
    },
  );

  const json = (await response.json()) as {
    data?: {
      discountCodeBasicCreate?: {
        codeDiscountNode?: { id?: string };
        userErrors?: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  const result = json.data?.discountCodeBasicCreate;
  const errors = result?.userErrors ?? json.errors;

  if (errors?.length) {
    throw new Error(
      errors.map((error: { message: string }) => error.message).join("; "),
    );
  }

  const discountNodeId = result?.codeDiscountNode?.id;
  if (!discountNodeId) {
    throw new Error("Shopify did not return a discount ID.");
  }

  return discountNodeId;
}

function buildDiscountCode(shopifyCustomerId: string): string {
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${CODE_PREFIX}-${shopifyCustomerId}-${Date.now().toString(36).toUpperCase()}-${random}`;
}
