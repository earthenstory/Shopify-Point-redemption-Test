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

const REDEMPTION_TTL_MINUTES = 60;
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

  const activeSession = await input.db.redemptionSession.findFirst({
    where: {
      customerId: loyaltyCustomer.id,
      cartToken: input.cart.token,
      status: { in: ["pending", "applied"] },
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });

  if (activeSession) {
    throw new Error(
      "You already have points applied to this cart. Remove them before applying again.",
    );
  }

  const pointsToReserve = normalizeRedeemPoints(
    Math.min(
      input.requestedPoints,
      calculateMaxRedeemablePoints({
        availablePoints: loyaltyCustomer.wallet.availablePoints,
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
          combinesWith: {
            orderDiscounts: input.allowDiscountStacking,
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
