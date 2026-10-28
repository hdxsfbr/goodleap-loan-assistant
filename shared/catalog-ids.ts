// The product ids of the loan catalog. Read by the application schema, the payment tools and the
// catalog itself, so a product is added in one place.
export const PRODUCT_IDS = ["fixed_10y", "zero_intro_18m", "deferred_12m"] as const;

export type ProductId = (typeof PRODUCT_IDS)[number];
