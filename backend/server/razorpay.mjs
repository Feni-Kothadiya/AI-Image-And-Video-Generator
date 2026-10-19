import { createHmac, timingSafeEqual } from "node:crypto";
import { fail } from "./schema.mjs";

const apiRoot = "https://api.razorpay.com/v1";

function positiveInteger(value, fallback, name, maximum = 1000000000) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function secureEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual, "utf8"),
    right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createRazorpay({ env = process.env, fetchImpl = fetch } = {}) {
  const keyId = env.RAZORPAY_KEY_ID?.trim() || "";
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim() || "";
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET?.trim() || "";
  const planId = env.RAZORPAY_PLAN_ID?.trim() || "";
  const settings = {
    currency: "INR",
    introAmount: positiveInteger(
      env.RAZORPAY_INTRO_AMOUNT_PAISE,
      100,
      "RAZORPAY_INTRO_AMOUNT_PAISE",
    ),
    introDays: positiveInteger(
      env.RAZORPAY_INTRO_DAYS,
      1,
      "RAZORPAY_INTRO_DAYS",
      30,
    ),
    renewalAmount: positiveInteger(
      env.RAZORPAY_RENEWAL_AMOUNT_PAISE,
      39900,
      "RAZORPAY_RENEWAL_AMOUNT_PAISE",
    ),
    renewalPeriod: "weekly",
    totalCount: positiveInteger(
      env.RAZORPAY_TOTAL_COUNT,
      520,
      "RAZORPAY_TOTAL_COUNT",
      5200,
    ),
  };
  const enabled =
    env.RAZORPAY_ENABLED === "1" &&
    !!keyId &&
    !!keySecret &&
    !!webhookSecret &&
    !!planId;

  async function request(path, { method = "GET", body } = {}) {
    if (!enabled) fail(503, "Razorpay billing is not configured yet.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetchImpl(apiRoot + path, {
        method,
        signal: controller.signal,
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64"),
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const status = response.status >= 500 || response.status === 429 ? 503 : 400;
        fail(
          status,
          status === 503
            ? "Razorpay is temporarily unavailable. No payment was created."
            : result?.error?.description || "Razorpay rejected the payment request.",
        );
      }
      return result;
    } catch (error) {
      if (error.statusCode) throw error;
      fail(503, "Razorpay is temporarily unavailable. No payment was created.");
    } finally {
      clearTimeout(timer);
    }
  }

  function digest(value, secret = keySecret) {
    return createHmac("sha256", secret).update(value).digest("hex");
  }

  return {
    enabled,
    keyId,
    planId,
    settings,
    testMode: keyId.startsWith("rzp_test_"),
    createOrder: (body) => request("/orders", { method: "POST", body }),
    createSubscription: (body) =>
      request("/subscriptions", { method: "POST", body }),
    getOrder: (id) => request(`/orders/${encodeURIComponent(id)}`),
    getPayment: (id) => request(`/payments/${encodeURIComponent(id)}`),
    getSubscription: (id) =>
      request(`/subscriptions/${encodeURIComponent(id)}`),
    getPlan: (id = planId) => request(`/plans/${encodeURIComponent(id)}`),
    cancelSubscription: (id, atCycleEnd = true) =>
      request(`/subscriptions/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        body: { cancel_at_cycle_end: atCycleEnd ? 1 : 0 },
      }),
    verifyCheckout(kind, checkoutId, paymentId, signature) {
      const message =
        kind === "subscription"
          ? `${paymentId}|${checkoutId}`
          : `${checkoutId}|${paymentId}`;
      return secureEqual(signature, digest(message));
    },
    verifyWebhook(rawBody, signature) {
      return secureEqual(signature, digest(rawBody, webhookSecret));
    },
  };
}
