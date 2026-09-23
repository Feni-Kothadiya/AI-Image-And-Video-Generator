import {
  randomBytes,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./schema.mjs";
const scrypt = promisify(scryptCallback);
export const token = () => randomBytes(32).toString("base64url");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64);
  return salt + ":" + key.toString("hex");
}
export async function verifyPassword(password, encoded) {
  const [salt, key] = (
    encoded || "00000000000000000000000000000000:" + "0".repeat(128)
  ).split(":");
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(key, "hex");
  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}
export function masterKey(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filename = join(dataDir, "master.key");
  if (!existsSync(filename))
    writeFileSync(filename, randomBytes(32), { flag: "wx", mode: 0o600 });
  const key = readFileSync(filename);
  if (key.length !== 32)
    throw new Error(
      "Invalid encryption key. Restore data/master.key from backup.",
    );
  return key;
}
export function encrypt(secret, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString("base64"))
    .join(".");
}
export function decrypt(value, key) {
  if (!value) return "";
  const [iv, tag, data] = value.split(".").map((v) => Buffer.from(v, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}
export async function authenticate(db, req, admin = false) {
  const raw = admin
    ? req.cookies.admin_session
    : req.headers.authorization?.replace(/^Bearer /, "");
  if (!raw || typeof raw !== "string") fail(401, "Please sign in.");
  const user = await db
    .prepare(
      "SELECT u.*,s.csrf,s.hash AS session_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?",
    )
    .get(hash(raw), Date.now());
  if (!user || user.status !== "active")
    fail(401, "Session expired or account suspended. Please sign in.");
  if (admin && user.role !== "admin")
    fail(403, "Administrator access is required.");
  if (
    admin &&
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers["x-csrf-token"] !== user.csrf
  )
    fail(403, "Reload the dashboard before saving.");
  return user;
}
export async function newSession(db, userId, admin = false) {
  const raw = token(),
    csrf = admin ? token() : null,
    expiresAt =
      Date.now() + (admin ? 12 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000);
  await db.prepare("DELETE FROM sessions WHERE expires_at<?").run(Date.now());
  await db
    .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
    .run(hash(raw), userId, csrf, expiresAt);
  return { token: raw, csrf, expiresAt };
}
