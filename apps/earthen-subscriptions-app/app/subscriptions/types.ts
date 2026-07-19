export const INTERVALS = [
  "weekly",
  "fortnightly",
  "monthly",
  "bimonthly",
  "quarterly",
  "half_yearly",
] as const;

export type IntervalCode = (typeof INTERVALS)[number];

export type RequestedLine = {
  productId: string;
  variantId: string;
  sku?: string | null;
  productTitle: string;
  variantTitle?: string | null;
  quantity: number;
  unitPricePaise: number;
};

export type Address = {
  address1: string;
  address2?: string | null;
  city: string;
  province?: string | null;
  provinceCode?: string | null;
  country?: string | null;
  countryCode?: string | null;
  zip: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  company?: string | null;
};

export type VariantSnapshot = {
  variantId: string;
  productId: string;
  sku?: string | null;
  productTitle: string;
  variantTitle?: string | null;
  currentUnitPricePaise: number;
  availableQuantity: number;
  taxable: boolean;
  active: boolean;
};

export type RenewalLineInput = VariantSnapshot & {
  subscriptionLineId: string;
  requestedQuantity: number;
};
