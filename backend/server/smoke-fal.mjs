// Explicit paid integration test. Uses an isolated local database, never real wallets.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, setSetting, transaction, credit } from "./db.mjs";
import { createStorage } from "./storage.mjs";
import { buildApp } from "./app.mjs";
import { falSettings } from "./fal.mjs";
import { detectMedia } from "./media-download.mjs";

if (!process.argv.includes("--confirm-paid-test")) {
  console.error(
    "This test generates one image, one photo edit and one short video using paid fal credits. Pass --confirm-paid-test to run (estimated $0.075 at documented rates).",
  );
  process.exit(1);
}
const directory = resolve("data/verification/fal-" + Date.now());
let db, app, storage;
let phase = "initialization";
try {
  if (!process.env.FAL_KEY?.trim()) throw new Error("Key not configured");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  db = await openDatabase(join(directory, "studio.sqlite"));
  await setSetting(db, "integration", falSettings);
  storage = createStorage({ dataDir: directory });
  if (storage.mode !== "r2") throw new Error("R2 required");
  app = await buildApp({
    dataDir: directory,
    db,
    storage,
    logger: false,
    worker: false,
  });
  const sessionResponse = await app.inject({
    method: "POST",
    url: "/api/auth/guest",
    payload: {},
  });
  if (sessionResponse.statusCode >= 300) throw new Error("Test account failed");
  const session = sessionResponse.json();
  const headers = { authorization: "Bearer " + session.session.token };
  await transaction(db, () =>
    credit(db, session.user.id, 1000, "Isolated smoke test", "fal-smoke"),
  );
  console.log(
    "Starting three paid fal checks using an isolated test wallet; credentials and signed URLs are not printed.",
  );
  let uploadId;
  const completed = [];
  for (const [name, mode, prompt] of [
    [
      "text-image",
      "image",
      "A cinematic photograph of a small red sailboat on a calm alpine lake, pine trees and snow capped mountains at sunrise, crisp natural detail, soft golden light, no text.",
    ],
    [
      "edited-image",
      "image",
      "Change the red sail of the boat to deep blue. Preserve the boat, lake, mountains and photographic composition.",
    ],
    [
      "image-video",
      "video",
      "The sailboat glides slowly across the calm lake. Small natural ripples spread across the water. A gentle breeze moves the sail. Stable cinematic camera, smooth subtle motion.",
    ],
  ]) {
    phase = name + " submission";
    const response = await app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      payload: { mode, prompt, uploadIds: uploadId ? [uploadId] : [] },
    });
    if (response.statusCode !== 202) throw new Error("Job rejected");
    const id = response.json().id;
    await writeFile(
      join(directory, name + "-job.json"),
      JSON.stringify({ id, mode }),
      { mode: 0o600 },
    );
    phase = name + " generation";
    let row;
    const deadline = Date.now() + 20 * 60 * 1000;
    let lastReport = 0;
    while (Date.now() < deadline) {
      await app.worker.tick();
      row = await db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
      if (["succeeded", "failed", "cancelled"].includes(row.status)) break;
      if (Date.now() - lastReport > 30000) {
        console.log(name + ": " + row.status);
        lastReport = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (row.status !== "succeeded" || !row.result_media)
      throw new Error("Generation incomplete");
    phase = name + " R2 verification";
    const media = JSON.parse(row.result_media);
    const filename = name + (mode === "image" ? ".png" : ".mp4");
    await pipeline(
      await storage.read({ storage: row.result_media }),
      createWriteStream(join(directory, filename), { mode: 0o600 }),
    );
    const bytes = await readFile(join(directory, filename));
    if (
      detectMedia(bytes.subarray(0, 32), true).mime !== media.mime ||
      bytes.length !== media.bytes
    )
      throw new Error("Output mismatch");
    const jobResponse = await app.inject({ url: "/api/jobs/" + id, headers });
    if (jobResponse.statusCode !== 200) throw new Error("Job unavailable");
    const signed = await fetch(jobResponse.json().resultUrl, {
      headers: { Range: "bytes=0-31" },
      signal: AbortSignal.timeout(30000),
    });
    if (!signed.ok) throw new Error("Signed media URL failed");
    await signed.body.cancel();
    console.log(
      name + ": generated, copied to R2, and signed download verified.",
    );
    completed.push({ name, mime: media.mime, bytes: media.bytes });
    if (!uploadId) {
      phase = "R2 input upload";
      const boundary = "fal-smoke-" + randomUUID();
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const upload = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: {
          ...headers,
          "content-type": "multipart/form-data; boundary=" + boundary,
        },
        payload: body,
      });
      if (upload.statusCode !== 200) throw new Error("Upload failed");
      uploadId = upload.json().id;
    }
  }
  phase = "test object cleanup";
  for (const row of await db.prepare("SELECT * FROM uploads").all())
    await storage.deleteUpload(row);
  for (const row of await db
    .prepare("SELECT result_media FROM jobs WHERE result_media IS NOT NULL")
    .all())
    await storage.deleteObject(JSON.parse(row.result_media));
  await writeFile(
    join(directory, "verification.json"),
    JSON.stringify(
      { completed, testObjectsRemoved: true, estimatedCostBeforeRunUsd: 0.075, actualCostUsd: null },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    "All live checks passed. Test objects removed from R2; sample outputs retained at " +
      directory,
  );
} catch {
  console.error(
    "Live check stopped during " +
      phase +
      ". No automatic resubmission. Isolated job state is retained at " +
      directory,
  );
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  else storage?.close();
  await db?.close();
}
