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
export async function openDatabase(filename, { seed = true } = {}) {
  if (filename !== ":memory:")
    mkdirSync(dirname(filename), { recursive: true });
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
