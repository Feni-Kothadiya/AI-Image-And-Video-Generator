import { sqliteDriver, postgresDriver } from "./database-driver.mjs";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { configSchema, parse, fail } from "./schema.mjs";
export const defaults = JSON.parse(
  readFileSync(
    new URL("../../shared/default-config.json", import.meta.url),
    "utf8",
  ),
);
const legacyImagePrompts = new Map([
  ["p0", "Create an editorial studio portrait with a warm neutral backdrop and soft directional light. Preserve the face and natural skin texture."],
  ["p1", "Create a cinematic portrait on a neon-lit city street with blue and magenta bokeh, preserving facial identity."],
  ["p2", "Create a sunlit editorial portrait with warm golden-hour light and natural flowers."],
  ["p3", "Create a warm, realistic studio portrait of the couple with natural expressions."],
  ["p4", "Create a playful miniature-world portrait with oversized everyday objects. Keep it lighthearted and realistic."],
  ["p5", "Create a graduation portrait with a tasteful gown and cap, soft campus background, and natural lighting."],
  ["p6", "Restore this photograph with natural detail, balanced colors, and preserved identities."],
  ["p7", "Create an elegant evening portrait with formal attire and soft cinematic lighting."],
  ["p8", "Create a joyful birthday portrait with flowers and warm, festive details."],
  ["p9", "Create a romantic golden-hour portrait with natural expressions and soft greenery."],
  ["p10", "Create a professional headshot with a clean background, polished business attire, and natural facial detail."],
]);
export async function openDatabase(filename, { seed = true } = {}) {
  if (filename !== ":memory:")
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = sqliteDriver(filename);
  try {
    await db.exec(
      readFileSync(new URL("./migration.sql", import.meta.url), "utf8"),
    );
    if (
      !(await db
        .prepare("SELECT 1 FROM schema_migrations WHERE version=2")
        .get())
    ) {
      await db.transaction(async () => {
        await db.exec("ALTER TABLE uploads ADD COLUMN storage TEXT");
        await db.exec("ALTER TABLE jobs ADD COLUMN result_media TEXT");
        await db.exec(
          "CREATE TABLE pending_media(job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, url TEXT NOT NULL)",
        );
        await db
          .prepare("INSERT INTO schema_migrations VALUES(2,?)")
          .run(now());
      });
    }
    if (
      !(await db
        .prepare("SELECT 1 FROM schema_migrations WHERE version=3")
        .get())
    ) {
      await db.transaction(async () => {
        await db.exec("ALTER TABLE uploads ADD COLUMN width INTEGER");
        await db.exec("ALTER TABLE uploads ADD COLUMN height INTEGER");
        await db
          .prepare("INSERT INTO schema_migrations VALUES(3,?)")
        .run(now());
      });
    }
    if (
      !(await db
        .prepare("SELECT 1 FROM schema_migrations WHERE version=4")
        .get())
    ) {
      await db.transaction(async () => {
        await db.exec("ALTER TABLE reports ADD COLUMN job_id TEXT");
        await db.exec("CREATE INDEX IF NOT EXISTS reports_job ON reports(job_id)");
        await db
          .prepare("INSERT INTO schema_migrations VALUES(4,?)")
          .run(now());
      });
    }
    await db.exec(
      readFileSync(new URL("./fal-schema.sql", import.meta.url), "utf8"),
    );
    await db.exec(readFileSync(new URL("./billing-schema.sql", import.meta.url), "utf8"));
    if (seed) await seedDatabase(db);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
export async function openPostgresDatabase(url, { seed = true } = {}) {
  const db = postgresDriver(url);
  try {
    await db.transaction(async () => {
      await db.exec(
        readFileSync(new URL("./postgres.sql", import.meta.url), "utf8"),
      );
      await db.exec(
        readFileSync(new URL("./fal-schema.sql", import.meta.url), "utf8"),
      );
      await db.exec(readFileSync(new URL("./billing-schema.sql", import.meta.url), "utf8"));
    });
    if (seed) await seedDatabase(db);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
export async function connectDatabase(
  filename,
  { url = process.env.DATABASE_URL, seed = true } = {},
) {
  return url
    ? openPostgresDatabase(url, { seed })
    : await openDatabase(filename, { seed });
}
async function seedDatabase(db) {
  return await transaction(db, async () => {
    if (
      !(await db.prepare("SELECT 1 FROM settings WHERE key='published'").get())
    ) {
      const content = parse(configSchema, defaults);
      await setSetting(db, "draft", { version: 1, content });
      const row = await db
        .prepare(
          "INSERT INTO revisions(content,note,actor,created_at) VALUES(?,?,?,?)",
        )
        .run(JSON.stringify(content), "Initial app content", "system", now());
      await setSetting(db, "published", {
        version: Number(row.lastInsertRowid),
        content,
      });
      await setSetting(db, "integration", {
        enabled: false,
        gatewayUrl: "",
        models: { image: "", video: "", dance: "", slideshow: "" },
      });
    } else {
      // Keep existing installations compatible and replace only the original
      // pre-release placeholders. Administrator-authored content is preserved.
      for (const key of ["published", "draft"]) {
        const saved = await getSetting(db, key);
        if (!saved?.content?.features) continue;
        const content = structuredClone(saved.content);
        content.features = { ...defaults.features, ...content.features };
        if (
          content.legal?.privacy ===
          "Privacy policy is being prepared. This app is not yet available for public release."
        )
          content.legal.privacy = defaults.legal.privacy;
        if (
          content.legal?.terms ===
          "Terms of use are being prepared. Payments and rewarded advertising are not active."
        )
          content.legal.terms = defaults.legal.terms;
        if (
          content.legal?.announcement ===
          "Create something new. AI services will be available when your administrator connects a provider."
        )
          content.legal.announcement = defaults.legal.announcement;
        if (content.branding?.appName === "AI Image And Video Generator")
          content.branding.appName = defaults.branding.appName;
        const defaultTemplates = new Map(
          defaults.templates.map((template) => [template.id, template]),
        );
        content.templates = content.templates.map((template) => {
          const next = structuredClone(template);
          const replacement = defaultTemplates.get(next.id);
          if (
            replacement?.kind === "image" &&
            next.prompt === legacyImagePrompts.get(next.id)
          )
            next.prompt = replacement.prompt;
          if (!next.imageUrl && replacement?.imageUrl)
            next.imageUrl = replacement.imageUrl;
          return next;
        });
        if (JSON.stringify(content) !== JSON.stringify(saved.content))
          await setSetting(db, key, { ...saved, content });
      }
    }
  });
}
export const now = () => new Date().toISOString();
export const getSetting = async (db, key) => {
  const r = await db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return r ? JSON.parse(r.value) : null;
};
export const setSetting = async (db, key, value) =>
  await db
    .prepare(
      "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(key, JSON.stringify(value));
export function transaction(db, fn) {
  return db.transaction(fn);
}
export async function audit(db, actor, action, target, detail = {}) {
  await db
    .prepare(
      "INSERT INTO audit(actor,action,target,detail,created_at) VALUES(?,?,?,?,?)",
    )
    .run(actor, action, target, JSON.stringify(detail), now());
}
export async function credit(db, userId, amount, reason, reference) {
  const existing = await db
    .prepare("SELECT * FROM ledger WHERE user_id=? AND reference=?")
    .get(userId, reference);
  if (existing) return existing;
  const user = await db
    .prepare("SELECT coins FROM users WHERE id=?")
    .get(userId);
  if (!user) fail(404, "Account not found.");
  if (
    !Number.isSafeInteger(amount) ||
    user.coins + amount < 0 ||
    user.coins + amount > 1000000000
  )
    fail(409, "Insufficient coins or balance limit exceeded.");
  const balance = user.coins + amount;
  await db.prepare("UPDATE users SET coins=? WHERE id=?").run(balance, userId);
  const record = {
    id: randomUUID(),
    user_id: userId,
    amount,
    balance,
    reason,
    reference,
    created_at: now(),
  };
  await db
    .prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?)")
    .run(...Object.values(record));
  return record;
}
export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    coins: user.coins,
    lastClaimDate: user.last_claim,
    streak: user.streak,
    createdAt: user.created_at,
  };
}
