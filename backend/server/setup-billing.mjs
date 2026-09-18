import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { connectDatabase, getSetting, setSetting, now, audit } from "./db.mjs";
import { configSchema, parse } from "./schema.mjs";
import { createPlayBilling } from "./play-billing.mjs";

const dataDir = resolve(process.env.DATA_DIR || "./data");
let db;
function apply(content) {
  const next = structuredClone(content);
  for (const pack of next.coinPacks)
    if (!pack.productId && [50, 150, 500].includes(pack.coins))
      pack.productId = "ai_creator_coins_" + pack.coins;
  for (const plan of next.plans)
    if (["weekly", "yearly"].includes(plan.id)) {
      if (!plan.productId) plan.productId = "ai_creator_premium_" + plan.id;
      if (!plan.basePlanId) plan.basePlanId = plan.id;
    }
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
    await mkdir(join(dataDir, "backups"), { recursive: true });
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
          "Configure Google Play product IDs and premium templates",
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
      purchasesEnabled: createPlayBilling().enabled,
      note: "Product IDs configured; Play Console products and server credentials still required. No billing or AI API calls made.",
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
