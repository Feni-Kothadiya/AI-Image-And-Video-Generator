import { resolve, join } from "node:path";
import { readFile } from "node:fs/promises";
import { connectDatabase } from "./db.mjs";
import { createStorage } from "./storage.mjs";
import { migrateBundledMedia } from "./bundled-media.mjs";
// Run with the backend stopped. Original local files are kept for rollback/backup.
const dataDir = resolve(process.env.DATA_DIR || "./data");
const storage = createStorage({ dataDir });
if (storage.mode !== "r2")
  throw new Error("Configure R2 before migrating media.");
const db = await connectDatabase(join(dataDir, "studio.sqlite"));
let uploads = 0,
  results = 0;
try {
  if (
    await db
      .prepare("SELECT 1 FROM jobs WHERE status IN ('queued','processing')")
      .get()
  )
    throw new Error(
      "Finish or cancel active jobs and stop the backend before migrating media.",
    );
  for (const upload of await db
    .prepare("SELECT * FROM uploads WHERE storage IS NULL")
    .all()) {
    const bytes = await readFile(join(dataDir, "uploads", upload.filename));
    const media = await storage.putUpload(
      upload.filename,
      bytes,
      upload.mime,
      !!upload.public,
      upload.user_id,
    );
    await db
      .prepare("UPDATE uploads SET storage=? WHERE id=?")
      .run(JSON.stringify(media), upload.id);
    uploads++;
  }
  if (process.argv.includes("--results")) {
    for (const job of await db
      .prepare(
        "SELECT * FROM jobs WHERE status='succeeded' AND result_media IS NULL AND result_url IS NOT NULL",
      )
      .all()) {
      const media = await storage.saveResult(job, job.result_url);
      await db
        .prepare("UPDATE jobs SET result_media=?,result_url=NULL WHERE id=?")
        .run(JSON.stringify(media), job.id);
      results++;
    }
  }
  const bundled = process.argv.includes("--bundled")
    ? await migrateBundledMedia(db, storage)
    : 0;
  console.log(
    `Migrated ${uploads} uploads, ${results} generated results and ${bundled} bundled images to R2. Original local files were retained.`,
  );
} catch {
  console.error(
    "Media migration stopped. Verify R2 access, local files, and any provider output availability. Completed records can be resumed safely.",
  );
  process.exitCode = 1;
} finally {
  storage.close();
  await db.close();
}
