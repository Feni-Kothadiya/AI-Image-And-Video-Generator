import { getSetting, credit, now } from "./db.mjs";
import { hash, encrypt, decrypt } from "./security.mjs";
import { fail } from "./schema.mjs";

export const billingAccountId = (id) => hash("google-play:" + id);
const activeStates = [
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  "SUBSCRIPTION_STATE_CANCELED",
];
export async function premiumEntitlement(db, userId) {
  const row = await db
    .prepare(
      "SELECT MAX(expires_at) AS expiry FROM play_purchases WHERE user_id=? AND kind='subscription' AND status IN ('SUBSCRIPTION_STATE_ACTIVE','SUBSCRIPTION_STATE_IN_GRACE_PERIOD','SUBSCRIPTION_STATE_CANCELED') AND verified_at>?",
    )
    .get(userId, Date.now() - 15 * 60000);
  const expiresAt = Number(row?.expiry || 0);
  const active = expiresAt > Date.now();
  return {
    active,
    adFree: active,
    premiumTemplates: active,
    unlimitedGeneration: active,
    expiresAt: active ? new Date(expiresAt).toISOString() : null,
  };
}
export async function billingDebt(db, userId) {
  return (
    (
      await db
        .prepare("SELECT amount FROM billing_debts WHERE user_id=?")
        .get(userId)
    )?.amount || 0
  );
}
function configuredProducts(content) {
  return [
    ...content.coinPacks.map((p) => ({ ...p, kind: "coins" })),
    ...content.plans.map((p) => ({ ...p, kind: "subscription", coins: 0 })),
  ].filter((p) => p.productId);
}
export function createBilling({ db, play, key }) {
  async function catalog(user) {
    const products = configuredProducts(
      (await getSetting(db, "published")).content,
    );
    const accountId = billingAccountId(user.id);
    await db
      .prepare(
        "INSERT INTO billing_accounts(account_id,user_id) VALUES(?,?) ON CONFLICT(account_id) DO NOTHING",
      )
      .run(accountId, user.id);
    return {
      enabled: play.enabled,
      packageName: play.packageName,
      accountId,
      products: products
        .filter((p) => p.enabled && (p.kind !== "coins" || p.coins > 0))
        .map(({ id, productId, kind, coins, basePlanId, period, label }) => ({
          id,
          productId,
          kind,
          coins,
          basePlanId: basePlanId || "",
          period,
          label,
        })),
      premium: await premiumEntitlement(db, user.id),
      refundDebt: await billingDebt(db, user.id),
    };
  }
  async function verify({ user, productId, token, kind: suppliedKind }) {
    if (!play.enabled) fail(503, "Google Play billing is not configured yet.");
    const checkedAt = Date.now(),
      tokenHash = hash(token);
    const existing = await db
      .prepare("SELECT * FROM play_purchases WHERE token_hash=?")
      .get(tokenHash);
    if (existing && user && existing.user_id !== user.id)
      fail(403, "This purchase belongs to another app installation.");
    if (existing?.status === "REPLACED")
      return {
        verified: true,
        pending: false,
        kind: "subscription",
        premium: user ? await premiumEntitlement(db, user.id) : null,
      };
    const products = configuredProducts(
      (await getSetting(db, "published")).content,
    );
    let product = products.find((p) => p.productId === productId);
    const kind = existing?.kind || product?.kind || suppliedKind;
    if (!["coins", "subscription"].includes(kind))
      fail(400, "Unknown Google Play product.");
    const receipt = await play.get(kind, token);
    const line =
      kind === "coins" ? receipt.productLineItem?.[0] : receipt.lineItems?.[0];
    const actualProductId = line?.productId;
    if (
      !actualProductId ||
      (productId && actualProductId !== productId) ||
      (existing && existing.product_id !== actualProductId)
    )
      fail(400, "Purchase product does not match.");
    product = products.find((p) => p.productId === actualProductId);
    if (!product && !existing) fail(400, "Unknown Google Play product.");
    if (product && product.kind !== kind)
      fail(400, "Purchase type does not match.");
    if (
      (kind === "coins" ? receipt.productLineItem : receipt.lineItems)
        .length !== 1
    )
      fail(400, "Multi-item purchases are not supported.");
    const accountId =
      kind === "coins"
        ? receipt.obfuscatedExternalAccountId
        : receipt.externalAccountIdentifiers?.obfuscatedExternalAccountId;
    if (!accountId) fail(403, "Purchase is missing its app account identity.");
    if (!user) {
      const account = await db
        .prepare("SELECT user_id FROM billing_accounts WHERE account_id=?")
        .get(accountId);
      if (!account) return { ignored: true };
      user = await db
        .prepare("SELECT * FROM users WHERE id=?")
        .get(account.user_id);
    }
    if (
      !user ||
      user.status !== "active" ||
      billingAccountId(user.id) !== accountId ||
      (existing && existing.user_id !== user.id)
    )
      fail(403, "This purchase belongs to another app installation.");
    const state =
      kind === "coins"
        ? receipt.purchaseStateContext?.purchaseState
        : receipt.subscriptionState;
    if (!state) fail(400, "Purchase state is unavailable.");
    const pending =
      state === "PENDING" || state === "SUBSCRIPTION_STATE_PENDING";
    const expiry =
      kind === "subscription" ? Date.parse(line.expiryTime || "") : 0;
    if (kind === "subscription" && !pending && !Number.isFinite(expiry))
      fail(400, "Subscription expiry is unavailable.");
    if (
      kind === "subscription" &&
      product?.basePlanId &&
      line.offerDetails?.basePlanId !== product.basePlanId
    )
      fail(400, "Subscription base plan does not match.");
    const quantity =
      kind === "coins" ? (line.productOfferDetails?.quantity ?? 1) : 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100)
      fail(400, "Invalid purchase quantity.");
    const unitCoins = existing?.unit_coins ?? product.coins ?? 0;
    const consumed =
      line.productOfferDetails?.consumptionState ===
      "CONSUMPTION_STATE_CONSUMED";
    if (kind === "coins" && consumed && !existing?.granted)
      fail(
        409,
        "This purchase was already consumed. Contact support to reconcile it.",
      );
    const refundable = line.productOfferDetails?.refundableQuantity ?? quantity;
    if (
      kind === "coins" &&
      (!Number.isInteger(refundable) || refundable < 0 || refundable > quantity)
    )
      fail(400, "Invalid refundable quantity.");
    await db.transaction(async () => {
      const old = await db
        .prepare("SELECT * FROM play_purchases WHERE token_hash=?")
        .get(tokenHash);
      if (old && old.user_id !== user.id)
        fail(403, "This purchase belongs to another account.");
      if (old && old.verified_at > checkedAt) return;
      if (
        (await db.prepare("SELECT status FROM users WHERE id=?").get(user.id))
          ?.status !== "active"
      )
        fail(403, "Account unavailable.");
      let granted = old?.granted || 0,
        revoked = old?.revoked || 0;
      let debt = await billingDebt(db, user.id);
      if (kind === "coins" && state === "PURCHASED" && !granted && !revoked) {
        granted = unitCoins * quantity;
        const repaid = Math.min(debt, granted);
        debt -= repaid;
        await credit(
          db,
          user.id,
          granted - repaid,
          "Google Play coin purchase",
          "play:" + tokenHash,
        );
      }
      const revokeTotal =
        kind === "coins" && granted
          ? state === "CANCELLED"
            ? granted
            : state === "PURCHASED"
              ? unitCoins * (quantity - refundable)
              : revoked
          : 0;
      if (revokeTotal > revoked) {
        const amount = revokeTotal - revoked;
        const balance = (
          await db.prepare("SELECT coins FROM users WHERE id=?").get(user.id)
        ).coins;
        const deducted = Math.min(balance, amount);
        debt += amount - deducted;
        await credit(
          db,
          user.id,
          -deducted,
          "Google Play refund",
          "play-refund:" + tokenHash + ":" + revokeTotal,
        );
        revoked = revokeTotal;
      }
      await db
        .prepare(
          "INSERT INTO billing_debts(user_id,amount) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET amount=excluded.amount",
        )
        .run(user.id, debt);
      if (receipt.linkedPurchaseToken) {
        const linkedHash = hash(receipt.linkedPurchaseToken);
        const linked = await db
          .prepare("SELECT user_id FROM play_purchases WHERE token_hash=?")
          .get(linkedHash);
        if (linked && linked.user_id !== user.id)
          fail(403, "Linked subscription belongs to another account.");
        await db
          .prepare(
            "UPDATE play_purchases SET status='REPLACED',expires_at=0 WHERE token_hash=?",
          )
          .run(linkedHash);
      }
      await db
        .prepare(
          "INSERT INTO play_purchases(token_hash,token_cipher,user_id,account_id,product_id,kind,status,unit_coins,quantity,granted,revoked,expires_at,verified_at,finalized,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET status=excluded.status,granted=excluded.granted,revoked=excluded.revoked,expires_at=excluded.expires_at,verified_at=excluded.verified_at",
        )
        .run(
          tokenHash,
          encrypt(token, key),
          user.id,
          accountId,
          actualProductId,
          kind,
          state,
          unitCoins,
          quantity,
          granted,
          revoked,
          Number.isFinite(expiry) ? expiry : 0,
          checkedAt,
          0,
          old?.created_at || now(),
        );
      await db
        .prepare(
          "INSERT INTO purchases(id,user_id,product_id,transaction_id,status,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status",
        )
        .run(
          tokenHash,
          user.id,
          actualProductId,
          tokenHash,
          state,
          old?.created_at || now(),
        );
    });
    const paid =
      kind === "coins" ? state === "PURCHASED" : activeStates.includes(state);
    if (paid) {
      if (kind === "coins" && !consumed)
        await play.consume(actualProductId, token);
      if (
        kind === "subscription" &&
        receipt.acknowledgementState !== "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED"
      )
        await play.acknowledge(actualProductId, token);
      await db
        .prepare("UPDATE play_purchases SET finalized=1 WHERE token_hash=?")
        .run(tokenHash);
    }
    return {
      verified: !pending,
      pending,
      kind,
      premium: await premiumEntitlement(db, user.id),
      refundDebt: await billingDebt(db, user.id),
    };
  }
  async function refreshUser(user) {
    if (!play.enabled) return;
    const rows = await db
      .prepare(
        "SELECT * FROM play_purchases WHERE user_id=? AND status NOT IN ('REPLACED','CANCELLED','SUBSCRIPTION_STATE_EXPIRED') AND (expires_at>? OR finalized=0) AND verified_at<?",
      )
      .all(user.id, Date.now() - 24 * 3600000, Date.now() - 5 * 60000);
    for (const row of rows)
      await verify({
        user,
        productId: row.product_id,
        token: decrypt(row.token_cipher, key),
      });
  }
  async function reconcile() {
    if (!play.enabled) return;
    const rows = await db
      .prepare(
        "SELECT * FROM play_purchases WHERE user_id IS NOT NULL AND status NOT IN ('REPLACED','CANCELLED','SUBSCRIPTION_STATE_EXPIRED') AND (verified_at<? OR (finalized=0 AND verified_at<?)) ORDER BY CASE WHEN finalized=0 THEN 0 WHEN kind='subscription' THEN 1 ELSE 2 END, verified_at LIMIT 100",
      )
      .all(Date.now() - 5 * 60000, Date.now() - 10000);
    for (const row of rows) {
      const user = await db
        .prepare("SELECT * FROM users WHERE id=?")
        .get(row.user_id);
      if (!user || user.status !== "active") continue;
      try {
        await verify({
          user,
          productId: row.product_id,
          token: decrypt(row.token_cipher, key),
        });
      } catch {
        /* Keep the encrypted token for retries; stale subscriptions fail closed. */
      }
    }
  }
  async function notification(body) {
    let data;
    try {
      data = JSON.parse(Buffer.from(body.message.data, "base64").toString());
    } catch {
      fail(400, "Invalid billing notification.");
    }
    if (data.packageName !== play.packageName)
      fail(400, "Incorrect app package.");
    if (data.testNotification) return;
    const event =
      data.subscriptionNotification ||
      data.oneTimeProductNotification ||
      data.voidedPurchaseNotification;
    if (!event?.purchaseToken) return;
    const known = await db
      .prepare("SELECT * FROM play_purchases WHERE token_hash=?")
      .get(hash(event.purchaseToken));
    if (known && !known.user_id) return;
    const user = known
      ? await db.prepare("SELECT * FROM users WHERE id=?").get(known.user_id)
      : null;
    await verify({
      user,
      token: event.purchaseToken,
      productId: known?.product_id || event.sku,
      kind:
        data.subscriptionNotification || event.productType === 1
          ? "subscription"
          : "coins",
    });
  }
  return { catalog, verify, refreshUser, reconcile, notification };
}
