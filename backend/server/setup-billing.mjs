import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { connectDatabase, getSetting, setSetting, now, audit } from "./db.mjs";
import { configSchema, parse } from "./schema.mjs";
import { createRazorpay } from "./razorpay.mjs";

const dataDir = resolve(process.env.DATA_DIR || "./data");
let db;
function apply(content) {
  const next = structuredClone(content);
  next.legal.privacy = next.legal.privacy
    .replace("Purchase data: Google Play product identifiers, purchase tokens, transaction status, and entitlement information.", "Purchase data: Razorpay order, payment, and subscription identifiers, transaction status, and entitlement information.")
    .replace("Google Play service providers", "Razorpay payment service providers");
  next.legal.terms = next.legal.terms
    .replace("Coins, subscriptions, and Google Play\nWhere enabled, digital coins and subscriptions are purchased through Google Play. Prices and billing periods shown by Google Play control the transaction. Coin purchases are consumable and subscriptions renew according to the selected Play offer until cancelled. Manage cancellation through Google Play. Purchase restoration and refund handling depend on Google Play records and applicable law.", "Coins, subscriptions, and Razorpay\nWhere enabled, digital coins and subscriptions are purchased securely through Razorpay. Coin purchases are consumable. The Weekly Pro offer charges ₹1 for the first day and then renews automatically at ₹399 every 7 days until cancelled. You can cancel future renewal inside Genora; access continues through the current paid period. Payment verification, refunds, and entitlement handling depend on Razorpay records and applicable law.")
    .replace("does not cancel a Google Play subscription; cancel subscriptions separately in Google Play.", "does not by itself cancel an active Razorpay mandate; cancel future renewal in the app before deleting your account.");
  const coinPacks = [
    { id: "pack-50", coins: 50, rupees: 99, label: "₹99.00", productId: "ai_creator_coins_50", enabled: true },
    { id: "pack-150", coins: 150, rupees: 249, label: "₹249.00", productId: "ai_creator_coins_150", enabled: true },
    { id: "pack-500", coins: 500, rupees: 599, label: "₹599.00", productId: "ai_creator_coins_500", enabled: true },
  ];
  next.coinPacks = coinPacks.map((configured) => ({
    ...(next.coinPacks.find((pack) => pack.id === configured.id || pack.coins === configured.coins) || {}),
    ...configured,
  }));
  const plans = [
    {
      id: "weekly",
      label: "Weekly",
      price: "₹399.00",
      period: "week",
      saving: "",
      productId: "genora_pro_weekly",
      basePlanId: "razorpay",
      enabled: true,
    },
  ];
  next.plans = plans.map((configured) => ({
    ...(next.plans.find((plan) => plan.id === configured.id) || {}),
    ...configured,
  }));
  for (const template of next.templates)
    if (template.premium === undefined)
      template.premium = ["p1", "v2", "s1"].includes(template.id);
  return parse(configSchema, next);
}
try {
  db = await connectDatabase(join(dataDir, "studio.sqlite"), { seed: false });
  const result = await db.transaction(async () => {
    const published = await getSetting(db, "published"),
      draft = await getSetting(db, "draft");
    const content = apply(published.content),
      draftContent = apply(draft.content);
    const changed =
        JSON.stringify(content) !== JSON.stringify(published.content),
      draftChanged =
        JSON.stringify(draftContent) !== JSON.stringify(draft.content);
    if (!changed && !draftChanged)
      return { changed: false, version: published.version };
    await mkdir(join(dataDir, "backups"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(dataDir, "backups", "before-billing-" + Date.now() + ".json"),
      JSON.stringify({ published, draft }, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    let version = published.version;
    if (changed) {
      const revision = await db
        .prepare(
          "INSERT INTO revisions(content,note,actor,created_at) VALUES(?,?,?,?)",
        )
        .run(
          JSON.stringify(content),
          "Configure Razorpay coin packs, ₹1 introductory access, and ₹399 weekly Pro",
          "billing-setup",
          now(),
        );
      version = Number(revision.lastInsertRowid);
      await setSetting(db, "published", { version, content });
    }
    await setSetting(db, "draft", {
      version: draft.version + 1,
      content: draftContent,
    });
    await audit(db, "billing-setup", "content.billing", String(version));
    return { changed: true, version };
  });
  console.log(
    JSON.stringify({
      ...result,
      purchasesEnabled: createRazorpay().enabled,
      note: "Razorpay display products configured. Server environment credentials and the Razorpay plan are still required. No billing or AI API calls made.",
    }),
  );
} catch {
  console.error(
    "Billing content setup stopped. Check database access and product mappings.",
  );
  process.exitCode = 1;
} finally {
  await db?.close();
}
