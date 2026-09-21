import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { openDatabase, getSetting, setSetting, now } from "../server/db.mjs";
import {
  createBilling,
  billingAccountId,
  premiumEntitlement,
  billingDebt,
} from "../server/billing.mjs";
import { createJob } from "../server/jobs.mjs";
import { createPlayBilling } from "../server/play-billing.mjs";
import { buildApp } from "../server/app.mjs";
import { createStorage } from "../server/storage.mjs";
import { newSession } from "../server/security.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fixture(t) {
  const db = await openDatabase(":memory:");
  t.after(() => db.close());
  const user = {
    id: randomUUID(),
    email: "buyer@example.com",
    status: "active",
  };
  await db
    .prepare("INSERT INTO users(id,email,coins,created_at) VALUES(?,?,100,?)")
    .run(user.id, user.email, now());
  const published = await getSetting(db, "published");
  published.content.coinPacks[0].productId = "coins_50";
  published.content.plans[0].productId = "premium_weekly";
  published.content.plans[0].basePlanId = "weekly";
  published.content.templates.find((t) => t.id === "p1").premium = true;
  await setSetting(db, "published", published);
  const receipts = new Map();
  let consumeCalls = 0,
    ackCalls = 0,
    failConsume = false;
  const play = {
    enabled: true,
    packageName: "app.test",
    get: async (kind, token) => {
      if (!receipts.has(token)) throw new Error("Invalid token");
      return structuredClone(receipts.get(token));
    },
    consume: async (product, token) => {
      consumeCalls++;
      if (failConsume) throw new Error("Network unavailable");
      receipts.get(
        token,
      ).productLineItem[0].productOfferDetails.consumptionState =
        "CONSUMPTION_STATE_CONSUMED";
    },
    acknowledge: async (product, token) => {
      ackCalls++;
      receipts.get(token).acknowledgementState =
        "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
    },
  };
  const billing = createBilling({ db, play, key: randomBytes(32) });
  await billing.catalog(user);
  const coin = (token, overrides = {}) =>
    receipts.set(token, {
      productLineItem: [
        {
          productId: "coins_50",
          productOfferDetails: {
            quantity: 1,
            refundableQuantity: 1,
            consumptionState: "CONSUMPTION_STATE_YET_TO_BE_CONSUMED",
          },
        },
      ],
      purchaseStateContext: { purchaseState: "PURCHASED" },
      obfuscatedExternalAccountId: billingAccountId(user.id),
      ...overrides,
    });
  const sub = (token, overrides = {}) =>
    receipts.set(token, {
      lineItems: [
        {
          productId: "premium_weekly",
          expiryTime: new Date(Date.now() + 86400000).toISOString(),
          offerDetails: { basePlanId: "weekly" },
        },
      ],
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
      externalAccountIdentifiers: {
        obfuscatedExternalAccountId: billingAccountId(user.id),
      },
      ...overrides,
    });
  const verify = (token, productId = "coins_50", owner = user) =>
    billing.verify({ user: owner, token, productId });
  const balance = async () =>
    (await db.prepare("SELECT coins FROM users WHERE id=?").get(user.id)).coins;
  return {
    db,
    user,
    play,
    billing,
    coin,
    sub,
    verify,
    balance,
    receipts,
    consumeCalls: () => consumeCalls,
    ackCalls: () => ackCalls,
    setFailConsume: (v) => (failConsume = v),
  };
}
test("coin purchase is credited exactly once, including concurrent verification", async (t) => {
  const f = await fixture(t);
  f.coin("token");
  await Promise.all([f.verify("token"), f.verify("token")]);
  await f.verify("token");
  assert.equal(await f.balance(), 150);
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) AS n FROM purchases").get()).n,
    1,
  );
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM ledger WHERE reason='Google Play coin purchase'",
        )
        .get()
    ).n,
    1,
  );
});
test("automatic guest wallets can purchase without an email or sign-in", async (t) => {
  const f = await fixture(t), guest = {
    id: randomUUID(),
    email: null,
    status: "active",
  };
  await f.db
    .prepare("INSERT INTO users(id,email,coins,created_at) VALUES(?,?,100,?)")
    .run(guest.id, guest.email, now());
  const catalog = await f.billing.catalog(guest);
  assert.equal("requiresAccount" in catalog, false);
  f.coin("guest-purchase", {
    obfuscatedExternalAccountId: billingAccountId(guest.id),
  });
  await f.verify("guest-purchase", "coins_50", guest);
  assert.equal(
    (await f.db.prepare("SELECT coins FROM users WHERE id=?").get(guest.id)).coins,
    150,
  );
});
test("pending and forged purchases cannot grant coins; pending later completes", async (t) => {
  const f = await fixture(t);
  f.coin("pending", { purchaseStateContext: { purchaseState: "PENDING" } });
  assert.equal((await f.verify("pending")).pending, true);
  assert.equal(await f.balance(), 100);
  assert.equal(f.consumeCalls(), 0);
  await assert.rejects(f.verify("forged"));
  f.receipts.get("pending").purchaseStateContext.purchaseState = "PURCHASED";
  await f.verify("pending");
  assert.equal(await f.balance(), 150);
});
test("purchase account, product and type cannot be substituted", async (t) => {
  const f = await fixture(t);
  f.coin("bound");
  await assert.rejects(
    f.verify("bound", "premium_weekly"),
    /product does not match/,
  );
  await assert.rejects(
    f.verify("bound", "coins_50", { ...f.user, id: randomUUID() }),
    /another app installation/,
  );
  f.coin("unbound", { obfuscatedExternalAccountId: undefined });
  await assert.rejects(f.verify("unbound"), /missing/);
  assert.equal(await f.balance(), 100);
});
test("consumption failure retries without double credit", async (t) => {
  const f = await fixture(t);
  f.coin("retry");
  f.setFailConsume(true);
  await assert.rejects(f.verify("retry"));
  assert.equal(await f.balance(), 150);
  f.setFailConsume(false);
  await f.verify("retry");
  assert.equal(await f.balance(), 150);
  assert.equal(f.consumeCalls(), 2);
});
test("subscriptions grant premium without coins and cancellation retains only paid access", async (t) => {
  const f = await fixture(t);
  f.sub("sub");
  await f.verify("sub", "premium_weekly");
  assert.equal((await premiumEntitlement(f.db, f.user.id)).adFree, true);
  assert.equal(await f.balance(), 100);
  assert.equal(f.ackCalls(), 1);
  f.receipts.get("sub").subscriptionState = "SUBSCRIPTION_STATE_CANCELED";
  await f.verify("sub", "premium_weekly");
  assert.equal((await premiumEntitlement(f.db, f.user.id)).active, true);
  f.receipts.get("sub").subscriptionState = "SUBSCRIPTION_STATE_ON_HOLD";
  await f.verify("sub", "premium_weekly");
  assert.equal((await premiumEntitlement(f.db, f.user.id)).active, false);
});
test("expired and stale subscription snapshots cannot grant premium", async (t) => {
  const f = await fixture(t);
  f.sub("sub");
  await f.verify("sub", "premium_weekly");
  await f.db
    .prepare("UPDATE play_purchases SET verified_at=?")
    .run(Date.now() - 16 * 60000);
  assert.equal((await premiumEntitlement(f.db, f.user.id)).active, false);
  f.receipts.get("sub").lineItems[0].expiryTime = new Date(
    Date.now() - 1000,
  ).toISOString();
  await f.verify("sub", "premium_weekly");
  assert.equal((await premiumEntitlement(f.db, f.user.id)).active, false);
});
test("refunds claw back available coins, track spent debt, and never claw back twice", async (t) => {
  const f = await fixture(t);
  f.coin("refund");
  await f.verify("refund");
  await f.db.prepare("UPDATE users SET coins=10 WHERE id=?").run(f.user.id);
  f.receipts.get("refund").purchaseStateContext.purchaseState = "CANCELLED";
  await f.verify("refund");
  await f.verify("refund");
  assert.equal(await f.balance(), 0);
  assert.equal(await billingDebt(f.db, f.user.id), 40);
  f.coin("new");
  await f.verify("new");
  assert.equal(await f.balance(), 10);
  assert.equal(await billingDebt(f.db, f.user.id), 0);
});
test("partial multi-quantity refunds deduct only the refunded quantity", async (t) => {
  const f = await fixture(t);
  f.coin("multi");
  const offer = f.receipts.get("multi").productLineItem[0].productOfferDetails;
  offer.quantity = 3;
  offer.refundableQuantity = 3;
  await f.verify("multi");
  assert.equal(await f.balance(), 250);
  offer.refundableQuantity = 2;
  await f.verify("multi");
  await f.verify("multi");
  assert.equal(await f.balance(), 200);
});
test("billing notifications refetch Google state and replay without duplicate credits", async (t) => {
  const f = await fixture(t);
  f.coin("notify");
  const body = {
    message: {
      data: Buffer.from(
        JSON.stringify({
          packageName: "app.test",
          oneTimeProductNotification: {
            purchaseToken: "notify",
            sku: "coins_50",
            notificationType: 1,
          },
        }),
      ).toString("base64"),
    },
  };
  await f.billing.notification(body);
  await f.billing.notification(body);
  assert.equal(await f.balance(), 150);
  const wrong = {
    message: {
      data: Buffer.from(
        JSON.stringify({ packageName: "other.app", testNotification: {} }),
      ).toString("base64"),
    },
  };
  await assert.rejects(f.billing.notification(wrong), /Incorrect app package/);
});
test("premium subscriptions allow unlimited generation without charging coins", async (t) => {
  const f = await fixture(t),
    photo = randomUUID();
  await f.db
    .prepare(
      "INSERT INTO uploads(id,user_id,filename,mime,bytes,public,created_at) VALUES(?,?,?,?,?,0,?)",
    )
    .run(photo, f.user.id, "photo.png", "image/png", 500, now());
  const input = {
    mode: "image",
    templateId: "p1",
    prompt: "Create a neon portrait",
    uploadIds: [photo],
  };
  await assert.rejects(
    createJob(f.db, f.user, randomUUID(), input, () => true),
    /premium subscription/,
  );
  f.sub("access");
  await f.verify("access", "premium_weekly");
  const job = await createJob(f.db, f.user, randomUUID(), input, () => true);
  assert.equal(job.cost, 0);
  assert.equal(await f.balance(), 100);
});
test("unconfigured billing and unauthenticated notifications fail closed", async () => {
  const play = createPlayBilling({ env: {} });
  assert.equal(play.enabled, false);
  await assert.rejects(play.get("coins", "x"), /not configured/);
  const configured = createPlayBilling({
    env: {
      PLAY_RTDN_AUDIENCE: "https://app.example/api/billing/notifications",
      PLAY_RTDN_SERVICE_ACCOUNT: "push@example.iam.gserviceaccount.com",
    },
  });
  await assert.rejects(
    configured.authenticateNotification(""),
    /Invalid notification identity/,
  );
});
test("billing HTTP routes authenticate purchases and notifications and reject client coin amounts", async (t) => {
  const f = await fixture(t),
    dir = await mkdtemp(join(tmpdir(), "billing-http-"));
  f.play.authenticateNotification = async (header) => {
    if (header !== "Bearer trusted-push")
      throw Object.assign(new Error("Untrusted notification"), {
        statusCode: 401,
      });
  };
  const app = await buildApp({
    db: f.db,
    dataDir: dir,
    storage: createStorage({ dataDir: dir, env: { MEDIA_STORAGE: "local" } }),
    worker: false,
    falKey: "",
    logger: false,
    playBilling: f.play,
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const session = await newSession(f.db, f.user.id),
    headers = { authorization: "Bearer " + session.token };
  assert.equal((await app.inject("/api/billing/catalog")).statusCode, 401);
  assert.equal(
    (await app.inject({ url: "/api/billing/catalog", headers })).json()
      .accountId,
    billingAccountId(f.user.id),
  );
  f.coin("http");
  assert.equal(
    (
      await app.inject({
        url: "/api/billing/verify",
        method: "POST",
        headers,
        payload: { productId: "coins_50", token: "http", coins: 999999 },
      })
    ).statusCode,
    400,
  );
  const verified = await app.inject({
    url: "/api/billing/verify",
    method: "POST",
    headers,
    payload: { productId: "coins_50", token: "http" },
  });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.json().user.coins, 150);
  assert.equal(
    (
      await app.inject({
        url: "/api/billing/notifications",
        method: "POST",
        payload: {},
      })
    ).statusCode,
    401,
  );
  const testNotification = {
    message: {
      data: Buffer.from(
        JSON.stringify({ packageName: "app.test", testNotification: {} }),
      ).toString("base64"),
    },
  };
  assert.equal(
    (
      await app.inject({
        url: "/api/billing/notifications",
        method: "POST",
        headers: { authorization: "Bearer trusted-push" },
        payload: testNotification,
      })
    ).statusCode,
    204,
  );
});
