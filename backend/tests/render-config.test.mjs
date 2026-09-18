import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { prepareRender } from "../server/render-config.mjs";
import { encrypt, decrypt } from "../server/security.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "render-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    DATABASE_URL: "postgresql://fake:fake@example.invalid/test",
    DATA_DIR: dir,
    RENDER_EXTERNAL_URL: "https://example.onrender.com",
    R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    R2_BUCKET: "test-media", R2_ACCESS_KEY_ID: "fake", R2_SECRET_ACCESS_KEY: "fake",
    MASTER_KEY_BASE64: randomBytes(32).toString("base64"),
  };
}

test("Render restores the same key across restarts and defaults to paused workers", (t) => {
  const env = fixture(t);
  prepareRender(env);
  assert.equal(env.ADMIN_ORIGIN, env.RENDER_EXTERNAL_URL);
  assert.equal(env.BACKGROUND_WORKERS_ENABLED, "0");
  assert.equal(env.HOST, "0.0.0.0");
  assert.equal(env.NODE_ENV, "production");
  assert.equal(readFileSync(join(env.DATA_DIR, "master.key")).toString("base64"), env.MASTER_KEY_BASE64);
  const encrypted = encrypt("existing test secret", readFileSync(join(env.DATA_DIR, "master.key")));
  // Free Render discards local files on restart. The environment must restore
  // the identical key so existing encrypted database records remain readable.
  rmSync(env.DATA_DIR, { recursive: true });
  prepareRender(env);
  assert.equal(decrypt(encrypted, readFileSync(join(env.DATA_DIR, "master.key"))), "existing test secret");
  env.BACKGROUND_WORKERS_ENABLED = "1";
  prepareRender(env);
  assert.equal(env.BACKGROUND_WORKERS_ENABLED, "1");
});

test("Render refuses key replacement without overwriting persisted data", (t) => {
  const env = fixture(t);
  prepareRender(env);
  const original = readFileSync(join(env.DATA_DIR, "master.key"));
  env.MASTER_KEY_BASE64 = randomBytes(32).toString("base64");
  assert.throws(() => prepareRender(env), /key mismatch/);
  assert.deepEqual(readFileSync(join(env.DATA_DIR, "master.key")), original);
});

test("Render rejects incomplete settings before creating a key", (t) => {
  for (const [name, value] of [
    ["DATABASE_URL", ""], ["R2_SECRET_ACCESS_KEY", ""],
    ["MASTER_KEY_BASE64", ""], ["MASTER_KEY_BASE64", "invalid"],
    ["ADMIN_ORIGIN", "http://example.com"], ["ADMIN_ORIGIN", "https://example.com/path"],
    ["DATA_DIR", "relative"], ["BACKGROUND_WORKERS_ENABLED", "false"],
    ["MEDIA_STORAGE", "local"],
  ]) {
    const env = fixture(t);
    const path = join(env.DATA_DIR, "master.key");
    env[name] = value;
    assert.throws(() => prepareRender(env));
    assert.equal(existsSync(path), false);
  }
});
