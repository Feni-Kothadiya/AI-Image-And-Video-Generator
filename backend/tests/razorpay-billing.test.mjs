import test from "node:test";
import assert from "node:assert/strict";
import { getSetting, openDatabase, setSetting, now } from "../server/db.mjs";
import { createRazorpayBilling } from "../server/razorpay-billing.mjs";

function mockRazorpay() {
  const created = { orders: [], subscriptions: [], cancellations: [] };
  const settings = {
    currency: "INR",
    introAmount: 100,
    introDays: 1,
    renewalAmount: 39900,
    renewalPeriod: "weekly",
    totalCount: 520,
  };
  const api = {
    enabled: true,
    keyId: "rzp_test_public",
    planId: "plan_weekly",
    settings,
    testMode: true,
    created,
    verifyCheckout: () => true,
    verifyWebhook: () => true,
    getPlan: async () => ({
      id: "plan_weekly",
      period: "weekly",
      interval: 1,
      item: { amount: 39900, currency: "INR" },
    }),
    createOrder: async (body) => {
      created.orders.push(body);
      return { id: "order_test", amount: body.amount, currency: body.currency, status: "created" };
    },
    getOrder: async () => ({ id: "order_test", amount: 9900, currency: "INR", status: "paid" }),
    getPayment: async (id) => ({ id, order_id: "order_test", status: "captured", amount: 9900, currency: "INR" }),
    createSubscription: async (body) => {
      created.subscriptions.push(body);
      return { id: "sub_test", plan_id: body.plan_id, start_at: body.start_at, status: "created" };
    },
    getSubscription: async () => ({
      id: "sub_test",
      plan_id: "plan_weekly",
      status: "authenticated",
      start_at: Math.floor(Date.now() / 1000) + 86400,
      current_start: 0,
      current_end: 0,
    }),
    cancelSubscription: async (id, atCycleEnd) => {
      created.cancellations.push({ id, atCycleEnd });
      return {
        id,
        plan_id: "plan_weekly",
        status: "cancelled",
        start_at: Math.floor(Date.now() / 1000),
        current_start: Math.floor(Date.now() / 1000),
        current_end: Math.floor(Date.now() / 1000) + 7 * 86400,
      };
    },
  };
  return api;
}

async function fixture(t) {
  const db = await openDatabase(":memory:");
  t.after(() => db.close());
  const user = { id: "buyer", email: "buyer@example.com", status: "active" };
  await db
    .prepare("INSERT INTO users(id,email,created_at) VALUES(?,?,?)")
    .run(user.id, user.email, now());
  const razorpay = mockRazorpay();
  return { db, user, razorpay, billing: createRazorpayBilling({ db, razorpay }) };
}

test("Razorpay coin orders use server prices and credit exactly once", async (t) => {
  const { db, user, razorpay, billing } = await fixture(t);
  const checkout = await billing.createCheckout(user, "pack-50");
  assert.equal(checkout.amount, 9900);
  assert.equal(razorpay.created.orders[0].amount, 9900);
  assert.equal(razorpay.created.orders[0].notes.user_id, user.id);
  const request = {
    user,
    kind: "coins",
    checkoutId: checkout.checkoutId,
    paymentId: "pay_test",
    signature: "valid",
  };
  await Promise.all([billing.verify(request), billing.verify(request)]);
  assert.equal((await db.prepare("SELECT coins FROM users WHERE id=?").get(user.id)).coins, 50);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM ledger WHERE user_id=?").get(user.id)).n, 1);
});

test("automatic guest wallets can purchase without email authentication", async (t) => {
  const { db, razorpay, billing } = await fixture(t);
  const guest = { id: "guest-buyer", email: null, status: "active" };
  await db
    .prepare("INSERT INTO users(id,email,created_at) VALUES(?,?,?)")
    .run(guest.id, guest.email, now());
  const catalog = await billing.catalog(guest);
  assert.equal(catalog.enabled, true);
  assert.equal(catalog.requiresAccount, false);
  const checkout = await billing.createCheckout(guest, "pack-50");
  assert.equal(checkout.checkoutId, "order_test");
  assert.equal(checkout.email, null);
  assert.equal(razorpay.created.orders[0].notes.user_id, guest.id);
});

test("admin purchase switch hides products and blocks checkout", async (t) => {
  const { db, user, billing } = await fixture(t);
  const published = await getSetting(db, "published");
  published.content.features.purchases = false;
  await setSetting(db, "published", published);
  const catalog = await billing.catalog(user);
  assert.equal(catalog.enabled, false);
  assert.deepEqual(catalog.products, []);
  await assert.rejects(
    billing.createCheckout(user, "pack-50"),
    /Purchases are currently disabled/,
  );
});

test("weekly checkout creates ₹1 one-day access followed by ₹399 weekly", async (t) => {
  const { db, user, razorpay, billing } = await fixture(t);
  const before = Math.floor(Date.now() / 1000);
  const checkout = await billing.createCheckout(user, "weekly");
  const request = razorpay.created.subscriptions[0];
  assert.equal(checkout.checkoutId, "sub_test");
  assert.equal("description" in checkout, false);
  assert.equal(request.plan_id, "plan_weekly");
  assert.equal(request.addons[0].item.amount, 100);
  assert.equal(request.total_count, 520);
  assert.ok(request.start_at >= before + 86400);
  razorpay.getPayment = async (id) => ({
    id,
    subscription_id: "sub_test",
    status: "captured",
    amount: 100,
    currency: "INR",
    created_at: Math.floor(Date.now() / 1000),
  });
  const verified = await billing.verify({
    user,
    kind: "subscription",
    checkoutId: "sub_test",
    paymentId: "pay_auth",
    signature: "valid",
  });
  assert.equal(verified.premium.active, true);
  assert.equal(verified.premium.renews, true);
  const trialExpiry = Date.parse(verified.premium.expiresAt);
  assert.ok(trialExpiry >= Date.now() + 86400000 - 5000);
  assert.ok(trialExpiry <= Date.now() + 86400000 + 5000);
  await billing.cancel(user);
  assert.deepEqual(razorpay.created.cancellations, [{ id: "sub_test", atCycleEnd: true }]);
  assert.equal((await db.prepare("SELECT status FROM razorpay_subscriptions WHERE subscription_id='sub_test'").get()).status, "cancelled");
  const cancelled = await billing.catalog(user);
  assert.equal(cancelled.premium.active, true);
  assert.equal(cancelled.premium.renews, false);
  assert.equal(Date.parse(cancelled.premium.expiresAt), trialExpiry);
});

test("a cancelled mandate without a captured payment never grants premium", async (t) => {
  const { db, user, billing } = await fixture(t);
  await billing.createCheckout(user, "weekly");
  await db
    .prepare(
      "UPDATE razorpay_subscriptions SET status='cancelled',expires_at=? WHERE subscription_id='sub_test'",
    )
    .run(Date.now() + 7 * 86400000);
  const catalog = await billing.catalog(user);
  assert.equal(catalog.premium.active, false);
  assert.equal(catalog.premium.expiresAt, null);
});

test("webhook replay is idempotent", async (t) => {
  const { db, user, billing } = await fixture(t);
  await billing.createCheckout(user, "pack-50");
  const raw = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: "pay_webhook",
          order_id: "order_test",
          status: "captured",
          amount: 9900,
          currency: "INR",
        },
      },
    },
  });
  await billing.notification(raw, "valid", "event_one");
  await billing.notification(raw, "valid", "event_one");
  assert.equal((await db.prepare("SELECT coins FROM users WHERE id=?").get(user.id)).coins, 50);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM razorpay_events").get()).n, 1);
});
