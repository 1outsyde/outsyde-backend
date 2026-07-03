/**
 * Stripe provisioning helper tests — run with: npx tsx server/services/stripeProvisioning.test.ts
 * Mocks stripeService's Stripe-calling methods so this runs with no network/DB/Stripe key.
 */
import { stripeService } from "../stripe/stripeService";
import type { Business, VendorProduct, VendorService } from "@shared/schema";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++;
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    console.error(`  \u274c ${name}`);
  }
}

async function assertThrowsCode(fn: () => Promise<unknown>, code: string, name: string) {
  try {
    await fn();
    failed++;
    console.error(`  \u274c ${name} (did not throw)`);
  } catch (err: any) {
    assert(err?.code === code, name);
  }
}

function mockBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: "biz_1",
    ownerId: "owner_1",
    name: "Test Biz",
    category: "beauty",
    stripeAccountId: null,
    stripeOnboardingComplete: false,
    approvalStatus: "approved",
    ...overrides,
  } as Business;
}

function mockService(overrides: Partial<VendorService> = {}): VendorService {
  return {
    id: "svc_1",
    businessId: "biz_1",
    name: "Haircut",
    description: "A great haircut",
    price: 5000,
    durationMinutes: 60,
    stripeProductId: null,
    stripePriceId: null,
    status: "draft",
    ...overrides,
  } as VendorService;
}

function mockProduct(overrides: Partial<VendorProduct> = {}): VendorProduct {
  return {
    id: "prod_1",
    businessId: "biz_1",
    name: "Candle",
    description: "A great candle",
    price: 2500,
    images: [],
    imageUrl: null,
    stripeProductId: null,
    stripePriceId: null,
    status: "draft",
    ...overrides,
  } as VendorProduct;
}

let createProductCalls: any[] = [];
let createPriceCalls: any[] = [];

function installMocks() {
  createProductCalls = [];
  createPriceCalls = [];
  (stripeService as any).createStripeProduct = async (params: any) => {
    createProductCalls.push(params);
    return { id: `stripe_prod_${createProductCalls.length}` };
  };
  (stripeService as any).createStripePrice = async (params: any) => {
    createPriceCalls.push(params);
    return { id: `stripe_price_${createPriceCalls.length}` };
  };
}

async function main() {
  // Import after mocks are installed so the module under test calls our stubs.
  installMocks();
  const { provisionStripeForItem, ConnectNotReadyError, isBusinessConnectReady } = await import(
    "./stripeProvisioning"
  );

  console.log("\n=== Stripe Provisioning Helper Tests ===\n");

  console.log("Test 1: Readiness gate");
  {
    assert(isBusinessConnectReady(mockBusiness({ stripeAccountId: "acct_1", stripeOnboardingComplete: true })) === true, "ready when accountId + onboardingComplete");
    assert(isBusinessConnectReady(mockBusiness({ stripeAccountId: null, stripeOnboardingComplete: true })) === false, "not ready without accountId");
    assert(isBusinessConnectReady(mockBusiness({ stripeAccountId: "acct_1", stripeOnboardingComplete: false })) === false, "not ready without onboardingComplete");
  }

  console.log("\nTest 2: Blocks provisioning when Connect not ready (no Stripe call made)");
  {
    installMocks();
    const business = mockBusiness({ stripeAccountId: null, stripeOnboardingComplete: false });
    const service = mockService();
    await assertThrowsCode(
      () => provisionStripeForItem(service, business, "service"),
      "connect_incomplete",
      "throws ConnectNotReadyError with code connect_incomplete"
    );
    assert(createProductCalls.length === 0, "createStripeProduct NOT called");
    assert(createPriceCalls.length === 0, "createStripePrice NOT called");
  }

  console.log("\nTest 3: Provisions a fresh service on the Connect account (happy path)");
  {
    installMocks();
    const business = mockBusiness({ stripeAccountId: "acct_42", stripeOnboardingComplete: true });
    const service = mockService();
    const result = await provisionStripeForItem(service, business, "service");
    assert(result.stripeProductId === "stripe_prod_1", "returns new stripeProductId");
    assert(result.stripePriceId === "stripe_price_1", "returns new stripePriceId");
    assert(createProductCalls.length === 1, "createStripeProduct called exactly once");
    assert(createProductCalls[0].connectedAccountId === "acct_42", "createStripeProduct targets the vendor's Connect account");
    assert(createPriceCalls[0].connectedAccountId === "acct_42", "createStripePrice targets the vendor's Connect account");
    assert(createPriceCalls[0].unitAmountCents === 5000, "price passed through as cents, unconverted");
    assert(createPriceCalls[0].metadata.durationMinutes === "60", "service metadata includes durationMinutes");
  }

  console.log("\nTest 4: Provisions a fresh product on the Connect account (happy path)");
  {
    installMocks();
    const business = mockBusiness({ stripeAccountId: "acct_42", stripeOnboardingComplete: true });
    const product = mockProduct();
    const result = await provisionStripeForItem(product, business, "product");
    assert(result.stripeProductId === "stripe_prod_1", "returns new stripeProductId");
    assert(createProductCalls[0].connectedAccountId === "acct_42", "createStripeProduct targets the vendor's Connect account");
    assert(createPriceCalls[0].metadata.vendorProductId === "prod_1", "product metadata uses vendorProductId key");
  }

  console.log("\nTest 5: Idempotent reuse — never duplicates an existing Stripe Product");
  {
    installMocks();
    const business = mockBusiness({ stripeAccountId: "acct_42", stripeOnboardingComplete: true });
    const service = mockService({ stripeProductId: "stripe_prod_existing", stripePriceId: "stripe_price_existing" });
    const result = await provisionStripeForItem(service, business, "service");
    assert(result.stripeProductId === "stripe_prod_existing", "reuses existing stripeProductId");
    assert(result.stripePriceId === "stripe_price_existing", "reuses existing stripePriceId");
    assert(createProductCalls.length === 0, "createStripeProduct NOT called (no duplicate)");
    assert(createPriceCalls.length === 0, "createStripePrice NOT called (no duplicate)");
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
