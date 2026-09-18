import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStorage, storageConfig } from "../server/storage.mjs";
import {
  detectMedia,
  downloadMedia,
  openMediaUrl,
} from "../server/media-download.mjs";
import { openDatabase } from "../server/db.mjs";
import { dummyEnv, fakeR2, png, mp4 } from "./helpers/r2.mjs";
test("R2 configuration is explicit, validated and never falls back on incomplete credentials", () => {
  assert.equal(storageConfig({}).mode, "local");
  assert.equal(storageConfig(dummyEnv).mode, "r2");
  assert.equal(
    storageConfig({ ...dummyEnv, MEDIA_STORAGE: "local" }).mode,
    "local",
  );
  assert.throws(
    () => storageConfig({ ...dummyEnv, R2_SECRET_ACCESS_KEY: "" }),
    /required/,
  );
  for (const endpoint of [
    "http://example.com",
    "https://127.0.0.1",
    "https://example.com",
    "https://user:secret@0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  ]) {
    assert.throws(
      () => storageConfig({ ...dummyEnv, R2_ENDPOINT: endpoint }),
      /Cloudflare/,
    );
  }
});
test("existing local files remain readable after selecting R2; database migration preserves uploads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "r2-legacy-"));
  let db;
  try {
    await mkdir(join(dir, "uploads"));
    await writeFile(join(dir, "uploads", "legacy.png"), png);
    const file = join(dir, "test.sqlite");
    const legacy = new DatabaseSync(file);
    legacy.exec(
      readFileSync(new URL("../server/migration.sql", import.meta.url), "utf8"),
    );
    legacy
      .prepare("INSERT INTO uploads VALUES(?,?,?,?,?,?,?)")
      .run(
        "legacy",
        null,
        "legacy.png",
        "image/png",
        png.length,
        1,
        new Date().toISOString(),
      );
    legacy.close();
    db = await openDatabase(file);
    const row = await db.prepare("SELECT * FROM uploads").get();
    assert.equal(row.storage, null);
    const mock = fakeR2(),
      storage = mock.storage(dir);
    assert.deepEqual(await storage.readBuffer(row), png);
    assert.equal(mock.calls.length, 0);
    await db.close();
    db = await openDatabase(file);
    assert.equal(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM schema_migrations WHERE version=2",
          )
          .get()
      ).n,
      1,
    );
    assert.equal(
      (await db.prepare("SELECT filename FROM uploads").get()).filename,
      "legacy.png",
    );
  } finally {
    await db?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("private result links are signed with limited lifetime without network requests", async () => {
  const storage = createStorage({ dataDir: tmpdir(), env: dummyEnv });
  try {
    const media = {
      bucket: "test-media",
      key: "generated/videos/user/job.mp4",
    };
    const first = await storage.resultUrl(media),
      second = await storage.resultUrl(media);
    const url = new URL(first);
    assert.equal(url.searchParams.get("X-Amz-Expires"), "3600");
    assert.equal(url.protocol, "https:");
    assert.equal(first, second);
    assert.ok(!first.includes(dummyEnv.R2_SECRET_ACCESS_KEY));
  } finally {
    storage.close();
  }
});
test("media download refuses private DNS, private redirect targets, and non-HTTPS URLs", async () => {
  let requests = 0;
  const forbiddenRequest = () => {
    requests++;
    throw new Error("must not request");
  };
  await assert.rejects(
    openMediaUrl("https://example.com/file", {
      dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
      request: forbiddenRequest,
    }),
    /not public/,
  );
  await assert.rejects(
    openMediaUrl("http://example.com/file", { request: forbiddenRequest }),
    /Invalid/,
  );
  await assert.rejects(
    openMediaUrl("https://example.com:8443/file", {
      request: forbiddenRequest,
    }),
    /port/,
  );
  assert.equal(requests, 0);
  const redirect = (url, options, callback) => {
    requests++;
    options.lookup(url.hostname, { all: false }, (_error, address) =>
      assert.equal(address, "93.184.216.34"),
    );
    const req = new EventEmitter();
    req.end = () => {
      const response = Readable.from([]);
      response.statusCode = 302;
      response.headers = { location: "https://127.0.0.1/private" };
      callback(response);
    };
    return req;
  };
  await assert.rejects(
    openMediaUrl("https://public.example/file", {
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: redirect,
    }),
    /Invalid/,
  );
  assert.equal(requests, 1);
});
test("download checks byte limits and actual media signatures including MP4", async () => {
  const dir = await mkdtemp(join(tmpdir(), "r2-download-"));
  const response =
    (bytes, headers = {}) =>
    async () =>
      Object.assign(Readable.from([bytes]), { headers });
  try {
    assert.equal(detectMedia(png).mime, "image/png");
    assert.equal(detectMedia(mp4, true).mime, "video/mp4");
    assert.throws(
      () => detectMedia(Buffer.from("<html>not an image</html>"), true),
      /Unsupported/,
    );
    assert.throws(() => detectMedia(mp4), /Unsupported/);
    const file = await downloadMedia("unused", join(dir, "valid"), "video", {
      openUrl: response(mp4),
    });
    assert.equal(file.mime, "video/mp4");
    assert.equal(file.bytes, mp4.length);
    await assert.rejects(
      downloadMedia("unused", join(dir, "big"), "image", {
        openUrl: response(png),
        maxBytes: 8,
      }),
      /limit/,
    );
    await assert.rejects(
      downloadMedia("unused", join(dir, "big-header"), "image", {
        openUrl: response(png, { "content-length": "999999" }),
        maxBytes: 100,
      }),
      /limit/,
    );
    await assert.rejects(
      downloadMedia("unused", join(dir, "html"), "image", {
        openUrl: response(Buffer.from("<html>bad</html>")),
      }),
      /Unsupported/,
    );
    await assert.rejects(
      downloadMedia("unused", join(dir, "wrong-kind"), "video", {
        openUrl: response(png),
      }),
      /wrong media/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
