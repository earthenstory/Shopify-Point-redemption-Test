import { describe, expect, it } from "vitest";
import { authenticateMerchantRequest } from "../../app/subscriptions/merchant-api";
import { hashCredential } from "../../app/subscriptions/admin-config";

describe("merchant API authentication", () => {
  const db = {
    merchantApiCredential: {
      findUnique: async () => ({ enabled: true, tokenHash: hashCredential("token"), secretHash: hashCredential("secret") }),
    },
  };

  it("authenticates a credential without storing its raw values", async () => {
    const request = new Request("https://app.test/api/merchant/subscriptions", { headers: { "x-earthen-shop": "demo.myshopify.com", "x-earthen-token": "token", "x-earthen-secret": "secret" } });
    await expect(authenticateMerchantRequest(db as never, request)).resolves.toEqual({ shopDomain: "demo.myshopify.com" });
  });

  it("rejects missing and invalid credentials", async () => {
    await expect(authenticateMerchantRequest(db as never, new Request("https://app.test"))).rejects.toMatchObject({ status: 401 });
    const request = new Request("https://app.test", { headers: { "x-earthen-shop": "demo.myshopify.com", "x-earthen-token": "wrong", "x-earthen-secret": "secret" } });
    await expect(authenticateMerchantRequest(db as never, request)).rejects.toMatchObject({ status: 401 });
  });
});
