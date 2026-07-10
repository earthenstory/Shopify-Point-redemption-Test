import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { PrismaClient, RewardDefinition } from "@prisma/client";
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
      // Never release a hold that is pinned to a placed order: the discount
      // was already spent at checkout and the order webhooks (create/paid to
      // consume, cancel/refund to return) are the only authority over it.
      // Releasing here — e.g. the storefront's orphan recovery firing right
      // after checkout, before the consume webhook lands — would hand the
      // points back on top of the discount (double credit).
      shopifyOrderId: null,
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
      // Order-pinned holds are excluded: their discount was spent on a placed
      // order and only the order webhooks may settle or return them (see
      // releaseRedemption). This keeps every reconciliation caller — expiry
      // self-heal, orphan recovery, re-redeem pre-release — from double
      // crediting a customer whose consume webhook hasn't landed yet.
      shopifyOrderId: null,
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

/**
 * Claim a catalog reward (fixed amount off, percent off, or free shipping) for
 * a fixed points cost. Mirrors createRedemption's reserve-then-create-discount
 * flow, sharing the same safety nets: any prior active reservation is released
 * first (idempotent apply, no stranded points) and a failed discount creation
 * rolls the reservation back.
 */
export async function claimReward(input: {
  db: PrismaClient;
  admin: AdminApiContext;
  shopDomain: string;
  shopifyCustomerId: string;
  rewardId: string;
  cart: CartSnapshot;
}): Promise<{
  sessionId: string;
  discountCode: string;
  pointsReserved: number;
  discountAmount: number;
  rewardType: RewardDefinition["type"];
  rewardTitle: string;
  expiresAt: string;
}> {
  const reward = await input.db.rewardDefinition.findFirst({
    where: {
      id: input.rewardId,
      shopDomain: input.shopDomain,
      enabled: true,
    },
  });
  if (!reward) {
    throw new Error("This reward is not available right now.");
  }

  const settings = await getLoyaltyRuntimeSettings({
    db: input.db,
    shopDomain: input.shopDomain,
  });
  if (!settings.redemptionEnabled) {
    throw new Error("Earthen Points redemption is currently paused.");
  }

  const minSubtotal = reward.minSubtotal ? Number(reward.minSubtotal) : 0;
  if (input.cart.subtotal <= 0) {
    throw new Error("Add items to your cart before redeeming this reward.");
  }
  if (minSubtotal > 0 && input.cart.subtotal < minSubtotal) {
    throw new Error(
      `This reward needs a cart of at least INR ${minSubtotal}.`,
    );
  }

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

  await releaseActiveRedemptions({
    db: input.db,
    admin: input.admin,
    shopDomain: input.shopDomain,
    shopifyCustomerId: input.shopifyCustomerId,
    reason: "Replaced by a reward claim",
  });

  const wallet = await input.db.wallet.findUnique({
    where: { id: loyaltyCustomer.wallet.id },
    select: { availablePoints: true },
  });
  if ((wallet?.availablePoints ?? 0) < reward.pointsCost) {
    throw new Error(
      `You need ${reward.pointsCost} points for this reward.`,
    );
  }

  const rewardValue = reward.value ? Number(reward.value) : 0;
  const discountAmount = reward.type === "fixed_amount" ? rewardValue : 0;
  const discountCode = buildDiscountCode(input.shopifyCustomerId);
  const expiresAt = new Date(
    Date.now() + settings.discountCodeTtlMinutes * 60 * 1000,
  );

  const session = await input.db.$transaction(async (tx) => {
    const walletUpdate = await tx.wallet.updateMany({
      where: {
        id: loyaltyCustomer.wallet?.id,
        availablePoints: { gte: reward.pointsCost },
      },
      data: {
        availablePoints: { decrement: reward.pointsCost },
        pendingPoints: { increment: reward.pointsCost },
      },
    });
    if (walletUpdate.count !== 1) {
      throw new Error("Your points balance changed. Please try again.");
    }

    const redemptionSession = await tx.redemptionSession.create({
      data: {
        customerId: loyaltyCustomer.id,
        cartToken: input.cart.token,
        pointsReserved: reward.pointsCost,
        discountAmount,
        currency: settings.rules.currency,
        discountCode,
        rewardType: reward.type,
        rewardTitle: reward.title,
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
        pointsDelta: -reward.pointsCost,
        moneyValue: rewardValue || null,
        currency: settings.rules.currency,
        description: `Reserved points for reward: ${reward.title}`,
        metadata: {
          rewardId: reward.id,
          rewardType: reward.type,
          cartToken: input.cart.token,
          expiresAt: expiresAt.toISOString(),
        },
      },
    });

    return redemptionSession;
  });

  try {
    let discountNodeId: string;
    if (reward.type === "free_shipping") {
      discountNodeId = await createFreeShippingDiscountCode({
        admin: input.admin,
        shopifyCustomerId: input.shopifyCustomerId,
        code: discountCode,
        title: `Earthen reward: ${reward.title}`,
        minimumSubtotal: minSubtotal,
        expiresAt,
        allowDiscountStacking: settings.rules.allowDiscountStacking,
      });
    } else {
      discountNodeId = await createShopifyDiscountCode({
        admin: input.admin,
        shopifyCustomerId: input.shopifyCustomerId,
        code: discountCode,
        points: reward.pointsCost,
        discountAmount: reward.type === "fixed_amount" ? rewardValue : 0,
        percentOff: reward.type === "percent_off" ? rewardValue : null,
        minimumSubtotal: minSubtotal,
        expiresAt,
        allowDiscountStacking: settings.rules.allowDiscountStacking,
        title: `Earthen reward: ${reward.title}`,
      });
    }

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
      reason: "Reward discount creation failed",
    });
    throw error;
  }

  return {
    sessionId: session.id,
    discountCode,
    pointsReserved: reward.pointsCost,
    discountAmount,
    rewardType: reward.type,
    rewardTitle: reward.title,
    expiresAt: expiresAt.toISOString(),
  };
}

async function createFreeShippingDiscountCode(input: {
  admin: AdminApiContext;
  shopifyCustomerId: string;
  code: string;
  title: string;
  minimumSubtotal: number;
  expiresAt: Date;
  allowDiscountStacking: boolean;
}): Promise<string> {
  const response = await input.admin.graphql(
    `#graphql
    mutation LoyaltyFreeShippingCreate($freeShippingCodeDiscount: DiscountCodeFreeShippingInput!) {
      discountCodeFreeShippingCreate(freeShippingCodeDiscount: $freeShippingCodeDiscount) {
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
        freeShippingCodeDiscount: {
          title: input.title,
          code: input.code,
          startsAt: new Date().toISOString(),
          endsAt: input.expiresAt.toISOString(),
          usageLimit: 1,
          appliesOncePerCustomer: true,
          combinesWith: {
            orderDiscounts: input.allowDiscountStacking,
            productDiscounts: input.allowDiscountStacking,
            shippingDiscounts: false,
          },
          // All-customers, not customer-locked — see createShopifyDiscountCode:
          // Razorpay Magic Checkout drops customer-restricted codes at checkout.
          // Safe: random, single-use, ~60-min TTL, bound to one reward claim.
          customerSelection: { all: true },
          destination: { all: true },
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
      discountCodeFreeShippingCreate?: {
        codeDiscountNode?: { id?: string };
        userErrors?: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  const result = json.data?.discountCodeFreeShippingCreate;
  const errors = result?.userErrors ?? json.errors;
  if (errors?.length) {
    throw new Error(errors.map((error) => error.message).join("; "));
  }
  const discountNodeId = result?.codeDiscountNode?.id;
  if (!discountNodeId) {
    throw new Error("Shopify did not return a discount ID.");
  }
  return discountNodeId;
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
  percentOff?: number | null;
  minimumSubtotal: number;
  expiresAt: Date;
  allowDiscountStacking: boolean;
  title?: string;
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
          title: input.title ?? `Earthen loyalty ${input.points} points`,
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
          // Do NOT lock the code to a single customer. Razorpay Magic Checkout
          // re-creates the order server-side and re-validates each discount code
          // against the customer it identifies at checkout (by phone); a code
          // restricted to a specific Shopify customer is dropped whenever that
          // identity doesn't match, so points silently vanish at payment. An
          // all-customers code survives. Safety is preserved without the lock:
          // the code is random and unguessable, single-use (usageLimit: 1),
          // expires in ~60 minutes, and is bound to one reserved redemption
          // session on our side.
          customerSelection: { all: true },
          customerGets: {
            value:
              input.percentOff != null
                ? { percentage: Math.min(100, input.percentOff) / 100 }
                : {
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
