import { randomUUID } from "node:crypto";
import { getSetting, credit, now } from "./db.mjs";
import { hash } from "./security.mjs";
import { fail } from "./schema.mjs";
import { billingDebt, premiumEntitlement } from "./billing.mjs";

const entitlementStatuses = new Set([
  "authenticated",
  "active",
  "pending",
  "cancelled",
]);

function unixMilliseconds(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number * 1000 : 0;
}

function subscriptionExpiry(subscription) {
  if (!entitlementStatuses.has(subscription.status)) return 0;
  return Math.max(
    unixMilliseconds(subscription.current_end),
    unixMilliseconds(subscription.start_at),
  );
}

function coinProducts(content) {
  return content.coinPacks.filter(
    (product) =>
      product.enabled &&
      product.productId &&
      Number.isInteger(product.coins) &&
      product.coins > 0 &&
      Number.isFinite(product.rupees) &&
      product.rupees > 0,
  );
}

function paymentEntity(payload) {
  return payload?.payload?.payment?.entity || null;
}

function subscriptionEntity(payload) {
  return payload?.payload?.subscription?.entity || null;
}

export function createRazorpayBilling({ db, razorpay }) {
  async function configuredContent() {
    return (await getSetting(db, "published")).content;
  }

  async function validatedPlan() {
    const plan = await razorpay.getPlan();
    if (
      plan?.id !== razorpay.planId ||
      plan?.period !== "weekly" ||
      Number(plan?.interval) !== 1 ||
      plan?.item?.currency !== razorpay.settings.currency ||
      Number(plan?.item?.amount) !== razorpay.settings.renewalAmount
    )
      fail(
        503,
        "The configured Razorpay plan does not match ₹399 weekly billing. Purchases are paused.",
      );
    return plan;
  }

  async function catalog(user) {
    const content = await configuredContent();
    const purchasesEnabled = content.features.purchases !== false;
    const weekly = content.plans.find((plan) => plan.id === "weekly" && plan.enabled);
    return {
      provider: "razorpay",
      enabled: razorpay.enabled && purchasesEnabled,
      requiresAccount: false,
      testMode: razorpay.testMode,
      products: purchasesEnabled ? [
        ...coinProducts(content).map((product) => ({
          id: product.id,
          productId: product.productId,
          kind: "coins",
          coins: product.coins,
          amount: Math.round(product.rupees * 100),
          currency: razorpay.settings.currency,
          price: product.label || `₹${product.rupees.toFixed(2)}`,
          label: `${product.coins} coins`,
        })),
        ...(weekly ? [{
          id: "weekly",
          productId: "genora_pro_weekly",
          kind: "subscription",
          coins: 0,
          amount: razorpay.settings.renewalAmount,
          currency: razorpay.settings.currency,
          price: "₹399.00",
          label: weekly.label || "Weekly Pro",
          period: "week",
          introPrice: "₹1.00",
          introDays: razorpay.settings.introDays,
        }] : []),
      ] : [],
      premium: await premiumEntitlement(db, user.id),
      refundDebt: await billingDebt(db, user.id),
    };
  }

  async function createCheckout(user, productId) {
    if (!razorpay.enabled)
      fail(503, "Razorpay billing is not configured yet. No payment was created.");
    const content = await configuredContent();
    if (content.features.purchases === false)
      fail(503, "Purchases are currently disabled. No payment was created.");
    const coin = coinProducts(content).find((product) => product.id === productId);
    if (coin) {
      const recent = await db
        .prepare(
          "SELECT * FROM razorpay_orders WHERE user_id=? AND product_id=? AND status='created' AND created_at>? ORDER BY created_at DESC LIMIT 1",
        )
        .get(user.id, coin.id, new Date(Date.now() - 10 * 60000).toISOString());
      if (recent)
        return {
          kind: "coins",
          key: razorpay.keyId,
          checkoutId: recent.order_id,
          amount: recent.amount,
          currency: recent.currency,
          name: "Genora AI",
          description: `${recent.coins} AI coins`,
          email: user.email,
        };
      const amount = Math.round(coin.rupees * 100);
      const order = await razorpay.createOrder({
        amount,
        currency: razorpay.settings.currency,
        receipt: `coins_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        payment_capture: 1,
        notes: { user_id: user.id, product_id: coin.id },
      });
      if (
        !order?.id ||
        Number(order.amount) !== amount ||
        order.currency !== razorpay.settings.currency
      )
        fail(503, "Razorpay returned an invalid order. No coins were credited.");
      await db
        .prepare(
          "INSERT INTO razorpay_orders(order_id,user_id,product_id,amount,currency,coins,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          order.id,
          user.id,
          coin.id,
          amount,
          razorpay.settings.currency,
          coin.coins,
          order.status || "created",
          now(),
          now(),
        );
      return {
        kind: "coins",
        key: razorpay.keyId,
        checkoutId: order.id,
        amount,
        currency: razorpay.settings.currency,
        name: "Genora AI",
        description: `${coin.coins} AI coins`,
        email: user.email,
      };
    }
    const weekly = content.plans.find((plan) => plan.id === "weekly" && plan.enabled);
    if (productId !== "weekly" || !weekly) fail(404, "Purchase option not found.");
    const current = await db
      .prepare(
        "SELECT * FROM razorpay_subscriptions WHERE user_id=? AND status IN ('created','authenticated','active','pending','paused','halted') ORDER BY created_at DESC LIMIT 1",
      )
      .get(user.id);
    if (current && ["authenticated", "active", "pending", "paused", "halted"].includes(current.status))
      fail(409, "You already have a subscription. Refresh or cancel it before starting another.");
    if (current?.status === "created" && Date.parse(current.created_at) > Date.now() - 10 * 60000)
      return {
        kind: "subscription",
        key: razorpay.keyId,
        checkoutId: current.subscription_id,
        name: "Genora AI Pro",
        description: "₹1 for 1 day, then ₹399 every week",
        email: user.email,
      };
    await validatedPlan();
    const startAt = Math.floor(Date.now() / 1000) + razorpay.settings.introDays * 86400;
    const subscription = await razorpay.createSubscription({
      plan_id: razorpay.planId,
      total_count: razorpay.settings.totalCount,
      quantity: 1,
      customer_notify: true,
      start_at: startAt,
      expire_by: Math.floor(Date.now() / 1000) + 30 * 60,
      addons: [
        {
          item: {
            name: "One-day introductory access",
            amount: razorpay.settings.introAmount,
            currency: razorpay.settings.currency,
          },
        },
      ],
      notes: { user_id: user.id, product_id: "weekly" },
    });
    if (
      !subscription?.id ||
      subscription.plan_id !== razorpay.planId ||
      Number(subscription.start_at) !== startAt
    )
      fail(503, "Razorpay returned an invalid subscription. No payment was taken.");
    await db
      .prepare(
        "INSERT INTO razorpay_subscriptions(subscription_id,user_id,plan_id,status,start_at,current_start,current_end,expires_at,verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        subscription.id,
        user.id,
        razorpay.planId,
        subscription.status || "created",
        startAt,
        Number(subscription.current_start || 0),
        Number(subscription.current_end || 0),
        0,
        0,
        now(),
        now(),
      );
    return {
      kind: "subscription",
      key: razorpay.keyId,
      checkoutId: subscription.id,
      name: "Genora AI Pro",
      description: "₹1 for 1 day, then ₹399 every week",
      email: user.email,
    };
  }

  async function applyCoinPayment(order, payment) {
    if (!order || !payment) fail(400, "Payment record was not found.");
    if (
      payment.order_id !== order.order_id ||
      payment.status !== "captured" ||
      Number(payment.amount) !== Number(order.amount) ||
      payment.currency !== order.currency
    )
      fail(409, "Payment is not captured or does not match this order.");
    await db.transaction(async () => {
      const saved = await db
        .prepare("SELECT * FROM razorpay_orders WHERE order_id=?")
        .get(order.order_id);
      if (!saved || saved.user_id !== order.user_id)
        fail(403, "This payment belongs to another account.");
      let granted = Number(saved.granted || 0);
      if (!granted) {
        let debt = await billingDebt(db, saved.user_id);
        granted = saved.coins;
        const repaid = Math.min(debt, granted);
        debt -= repaid;
        await credit(
          db,
          saved.user_id,
          granted - repaid,
          "Razorpay coin purchase",
          `razorpay:${saved.order_id}`,
        );
        await db
          .prepare(
            "INSERT INTO billing_debts(user_id,amount) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET amount=excluded.amount",
          )
          .run(saved.user_id, debt);
      }
      await db
        .prepare(
          "UPDATE razorpay_orders SET payment_id=?,status='paid',granted=?,updated_at=? WHERE order_id=?",
        )
        .run(payment.id, granted, now(), saved.order_id);
      await db
        .prepare(
          "INSERT INTO purchases(id,user_id,product_id,transaction_id,status,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status",
        )
        .run(saved.order_id, saved.user_id, saved.product_id, payment.id, "paid", saved.created_at);
    });
  }

  async function saveSubscription(subscription, { userId, payment } = {}) {
    const saved = await db
      .prepare("SELECT * FROM razorpay_subscriptions WHERE subscription_id=?")
      .get(subscription.id);
    const owner = userId || saved?.user_id || subscription.notes?.user_id;
    if (!saved || !owner) fail(404, "Subscription record was not found.");
    if (saved.user_id && owner !== saved.user_id)
      fail(403, "This subscription belongs to another account.");
    if (subscription.plan_id !== razorpay.planId)
      fail(400, "Subscription plan does not match.");
    const expiresAt = subscriptionExpiry(subscription);
    await db
      .prepare(
        "UPDATE razorpay_subscriptions SET status=?,auth_payment_id=coalesce(auth_payment_id,?),start_at=?,current_start=?,current_end=?,expires_at=?,verified_at=?,updated_at=? WHERE subscription_id=?",
      )
      .run(
        subscription.status,
        payment?.id || null,
        Number(subscription.start_at || saved.start_at || 0),
        Number(subscription.current_start || 0),
        Number(subscription.current_end || 0),
        expiresAt,
        Date.now(),
        now(),
        subscription.id,
      );
    if (payment?.id)
      await db
        .prepare(
          "INSERT INTO razorpay_subscription_payments(payment_id,subscription_id,amount,status,created_at) VALUES(?,?,?,?,?) ON CONFLICT(payment_id) DO UPDATE SET status=excluded.status",
        )
        .run(
          payment.id,
          subscription.id,
          Number(payment.amount || 0),
          payment.status || "captured",
          now(),
        );
    await db
      .prepare(
        "INSERT INTO purchases(id,user_id,product_id,transaction_id,status,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status",
      )
      .run(
        subscription.id,
        owner,
        "genora_pro_weekly",
        payment?.id || subscription.id,
        subscription.status,
        saved.created_at,
      );
  }

  async function verify({ user, kind, checkoutId, paymentId, signature }) {
    if (!razorpay.enabled)
      fail(503, "Razorpay billing is not configured yet.");
    if (!razorpay.verifyCheckout(kind, checkoutId, paymentId, signature))
      fail(400, "Payment signature verification failed.");
    const payment = await razorpay.getPayment(paymentId);
    if (kind === "coins") {
      const order = await db
        .prepare("SELECT * FROM razorpay_orders WHERE order_id=?")
        .get(checkoutId);
      if (!order || order.user_id !== user.id)
        fail(403, "This order belongs to another account.");
      const remoteOrder = await razorpay.getOrder(checkoutId);
      if (
        remoteOrder?.id !== order.order_id ||
        Number(remoteOrder.amount) !== order.amount ||
        remoteOrder.currency !== order.currency
      )
        fail(409, "Order verification failed.");
      await applyCoinPayment(order, payment);
    } else if (kind === "subscription") {
      const saved = await db
        .prepare("SELECT * FROM razorpay_subscriptions WHERE subscription_id=?")
        .get(checkoutId);
      if (!saved || saved.user_id !== user.id)
        fail(403, "This subscription belongs to another account.");
      if (
        payment.status !== "captured" ||
        payment.subscription_id !== checkoutId ||
        Number(payment.amount) !== razorpay.settings.introAmount ||
        payment.currency !== razorpay.settings.currency
      )
        fail(409, "Introductory payment is not captured or does not match.");
      const subscription = await razorpay.getSubscription(checkoutId);
      if (!entitlementStatuses.has(subscription.status))
        fail(409, "Subscription authorization is still pending.");
      await saveSubscription(subscription, { userId: user.id, payment });
    } else fail(400, "Unknown purchase type.");
    return {
      verified: true,
      pending: false,
      kind,
      premium: await premiumEntitlement(db, user.id),
      refundDebt: await billingDebt(db, user.id),
    };
  }

  async function refreshUser(user) {
    if (!razorpay.enabled) return;
    const rows = await db
      .prepare(
        "SELECT * FROM razorpay_subscriptions WHERE user_id=? AND status NOT IN ('completed','expired') AND verified_at<? ORDER BY updated_at DESC LIMIT 5",
      )
      .all(user.id, Date.now() - 5 * 60000);
    for (const row of rows) {
      try {
        const remote = await razorpay.getSubscription(row.subscription_id);
        await saveSubscription(remote, { userId: user.id });
      } catch {
        /* Keep the last verified entitlement and retry through the next refresh/webhook. */
      }
    }
  }

  async function cancel(user) {
    if (!razorpay.enabled) fail(503, "Razorpay billing is not configured yet.");
    const row = await db
      .prepare(
        "SELECT * FROM razorpay_subscriptions WHERE user_id=? AND status IN ('authenticated','active','pending','paused','halted') ORDER BY created_at DESC LIMIT 1",
      )
      .get(user.id);
    if (!row) fail(404, "No renewable subscription was found.");
    const remote = await razorpay.cancelSubscription(row.subscription_id, true);
    await saveSubscription(remote, { userId: user.id });
    return { premium: await premiumEntitlement(db, user.id) };
  }

  async function revokeRefund(orderId, payment) {
    const order = await db
      .prepare("SELECT * FROM razorpay_orders WHERE order_id=?")
      .get(orderId);
    if (!order?.granted || !payment) return;
    const paid = Number(payment.amount || order.amount),
      refunded = Number(payment.amount_refunded || payment.amount || 0);
    const target = Math.min(
      order.granted,
      Math.ceil((order.granted * refunded) / Math.max(1, paid)),
    );
    if (target <= order.revoked) return;
    const amount = target - order.revoked;
    const user = await db.prepare("SELECT coins FROM users WHERE id=?").get(order.user_id);
    if (!user) return;
    const deducted = Math.min(user.coins, amount);
    const debt = (await billingDebt(db, order.user_id)) + amount - deducted;
    await credit(
      db,
      order.user_id,
      -deducted,
      "Razorpay refund",
      `razorpay-refund:${order.order_id}:${target}`,
    );
    await db
      .prepare(
        "INSERT INTO billing_debts(user_id,amount) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET amount=excluded.amount",
      )
      .run(order.user_id, debt);
    await db
      .prepare("UPDATE razorpay_orders SET revoked=?,status='refunded',updated_at=? WHERE order_id=?")
      .run(target, now(), order.order_id);
  }

  async function notification(rawBody, signature, suppliedEventId) {
    if (!razorpay.enabled || !razorpay.verifyWebhook(rawBody, signature))
      fail(401, "Invalid Razorpay webhook signature.");
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      fail(400, "Invalid webhook payload.");
    }
    const eventType = String(payload.event || "");
    if (!eventType || eventType.length > 100) fail(400, "Invalid webhook event.");
    const eventId = String(suppliedEventId || hash(rawBody));
    if (eventId.length > 200) fail(400, "Invalid webhook event ID.");
    if (await db.prepare("SELECT 1 FROM razorpay_events WHERE event_id=?").get(eventId))
      return;
    const payment = paymentEntity(payload);
    const subscription = subscriptionEntity(payload);
    if (["payment.captured", "order.paid"].includes(eventType) && payment?.order_id) {
      const order = await db
        .prepare("SELECT * FROM razorpay_orders WHERE order_id=?")
        .get(payment.order_id);
      if (order) await applyCoinPayment(order, payment);
    } else if (eventType === "payment.refunded" && payment?.order_id) {
      const order = await db
        .prepare("SELECT * FROM razorpay_orders WHERE order_id=?")
        .get(payment.order_id);
      if (order) await db.transaction(() => revokeRefund(order.order_id, payment));
    } else if (eventType.startsWith("subscription.") && subscription?.id) {
      const saved = await db
        .prepare("SELECT * FROM razorpay_subscriptions WHERE subscription_id=?")
        .get(subscription.id);
      if (saved) {
        const remote = await razorpay.getSubscription(subscription.id);
        await saveSubscription(remote, { payment });
      }
    }
    await db
      .prepare(
        "INSERT INTO razorpay_events(event_id,event_type,created_at) VALUES(?,?,?) ON CONFLICT(event_id) DO NOTHING",
      )
      .run(eventId, eventType, now());
  }

  async function reconcile() {
    if (!razorpay.enabled) return;
    const rows = await db
      .prepare(
        "SELECT * FROM razorpay_subscriptions WHERE status NOT IN ('completed','expired') AND verified_at<? ORDER BY verified_at LIMIT 100",
      )
      .all(Date.now() - 5 * 60000);
    for (const row of rows) {
      try {
        const remote = await razorpay.getSubscription(row.subscription_id);
        await saveSubscription(remote, { userId: row.user_id });
      } catch {
        /* A later webhook or reconciliation pass will retry this record. */
      }
    }
  }

  return {
    enabled: razorpay.enabled,
    provider: "razorpay",
    catalog,
    createCheckout,
    verify,
    refreshUser,
    cancel,
    notification,
    reconcile,
  };
}
