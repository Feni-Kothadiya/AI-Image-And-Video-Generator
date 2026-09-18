import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { prepareRender } from "../server/render-config.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "render-key-validation-"));
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

test("Render diagnoses invalid key values without revealing secrets or changing the disk key", (t) => {
  const env = fixture(t);
  prepareRender(env);
  const original = readFileSync(join(env.DATA_DIR, "master.key"));
  const valid = env.MASTER_KEY_BASE64;
  for (const [value, message] of [
    ["", /missing or empty/],
    [valid + valid, /88 characters; expected exactly 44/],
    [`"${valid}"`, /46 characters; expected exactly 44/],
    [`MASTER_KEY_BASE64=${valid}`, /expected exactly 44/],
    [valid.slice(0, 10) + " " + valid.slice(11), /invalid Base64 format/],
    [valid.slice(0, 10) + "\n" + valid.slice(11), /invalid Base64 format/],
    // Non-zero padding bits decode to 32 bytes but are not canonical Base64.
    ["A".repeat(42) + "B=", /not the canonical Base64/],
  ]) {
    env.MASTER_KEY_BASE64 = value;
    assert.throws(() => prepareRender(env), (error) => {
      assert.match(error.message, message);
      if (value) assert.equal(error.message.includes(value), false);
      assert.equal(error.message.includes(valid), false);
      return true;
    });
    assert.deepEqual(readFileSync(join(env.DATA_DIR, "master.key")), original);
    rmSync(join(env.DATA_DIR, "master.key"));
    assert.throws(() => prepareRender(env), message);
    assert.equal(existsSync(join(env.DATA_DIR, "master.key")), false);
    env.MASTER_KEY_BASE64 = valid;
    prepareRender(env);
  }
});
