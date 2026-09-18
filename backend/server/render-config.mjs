import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { timingSafeEqual } from "node:crypto";

// Run before importing the app, opening the database, or starting any workers.
export function prepareRender(env = process.env) {
  if (!/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL || ""))
    throw new Error("Render requires DATABASE_URL for the existing Neon database.");
  for (const name of ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"])
    if (!env[name]?.trim()) throw new Error(`Render requires ${name}.`);
  if (env.MEDIA_STORAGE && env.MEDIA_STORAGE !== "r2")
    throw new Error("Render requires MEDIA_STORAGE=r2.");
  const origin = env.ADMIN_ORIGIN || env.RENDER_EXTERNAL_URL;
  let url;
  try { url = new URL(origin); } catch { /* Report names only, never values. */ }
  if (!url || url.protocol !== "https:" || url.username || url.password || url.origin !== origin)
    throw new Error("Set ADMIN_ORIGIN or RENDER_EXTERNAL_URL to the HTTPS origin without a trailing slash.");
  if (!env.DATA_DIR || !isAbsolute(env.DATA_DIR))
    throw new Error("Set DATA_DIR to an absolute writable directory.");
  const workers = env.BACKGROUND_WORKERS_ENABLED || "0";
  if (!["0", "1"].includes(workers))
    throw new Error("BACKGROUND_WORKERS_ENABLED must be 0 or 1.");
  const encoded = env.MASTER_KEY_BASE64?.trim() || "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded)
    throw new Error("MASTER_KEY_BASE64 must encode the existing 32-byte master.key.");
  const filename = join(env.DATA_DIR, "master.key");
  if (existsSync(filename)) {
    const stored = readFileSync(filename);
    if (stored.length !== key.length || !timingSafeEqual(stored, key))
      throw new Error("Encryption key mismatch. Restore the matching key; the disk key was not changed.");
  } else {
    mkdirSync(env.DATA_DIR, { recursive: true });
    writeFileSync(filename, key, { flag: "wx", mode: 0o600 });
  }
  env.ADMIN_ORIGIN = origin;
  env.NODE_ENV = "production";
  env.HOST = "0.0.0.0";
  env.MEDIA_STORAGE = "r2";
  env.BACKGROUND_WORKERS_ENABLED = workers;
}
